import json
from fastapi.testclient import TestClient
from backend.main import create_app
from backend.workbench import Workbench
from test_api_agent import FakeModel, read_call, summary, text


def login(client, directory, owner='alice'):
    credentials = json.loads((directory / 'login.json').read_text())
    assert client.post('/api/login', json={'username': owner, 'password': credentials[owner]['password']}).status_code == 200


def test_workbench_requires_login(tmp_path):
    client = TestClient(create_app(tmp_path, FakeModel([])))
    assert client.get('/api/runtimes').status_code == 401
    assert client.get('/api/test-runs').status_code == 401
    assert client.post('/api/test-sessions', json={'runtime': 'native'}).status_code == 401


def test_selected_engine_is_recorded_and_testing_does_not_mutate_product(tmp_path, monkeypatch):
    monkeypatch.setenv('AGENT_RUNTIME', 'claude-sdk')
    model = FakeModel([read_call(), text({'status': 'answer', 'cards': [{'guide_id': '03-01'}]}), summary()])
    app = create_app(tmp_path, model)
    client = TestClient(app)
    login(client, tmp_path)
    original = client.get('/api/memories').json()
    session = client.post('/api/test-sessions', json={'runtime': 'native'}).json()
    record = client.post('/api/test-run', json={**session, 'query': '我被手机通知打断'}).json()
    assert record['status'] == 'success' and record['runtime'] == 'native'
    assert record['prompt_versions']['chat'] and record['trace'][0]['tool'] == 'get_entry'
    assert record['memories_after']['effective'][0]['guide_ids'] == ['03-01']
    assert client.get('/api/memories').json() == original
    assert app.state.service.default_runtime == 'claude-sdk'
    assert client.get('/api/test-runs/'+record['id']).json() == record


def test_workbench_accounts_and_sessions_are_isolated(tmp_path):
    app = create_app(tmp_path, FakeModel([text({'status': 'acknowledged', 'cards': []})]))
    alice, bob = TestClient(app), TestClient(app)
    login(alice, tmp_path)
    login(bob, tmp_path, 'bob')
    session = alice.post('/api/test-sessions', json={'runtime': 'native', 'memory_enabled': False}).json()
    record = alice.post('/api/test-run', json={**session, 'query': '你好'}).json()
    assert bob.get('/api/test-runs').json()['runs'] == []
    assert bob.get('/api/test-runs/'+record['id']).status_code == 401
    assert bob.post('/api/test-run', json={**session, 'query': '你好'}).status_code == 401


def test_test_session_cannot_silently_change_engine(tmp_path):
    client = TestClient(create_app(tmp_path, FakeModel([])))
    login(client, tmp_path)
    assert client.post('/api/test-sessions', json={'runtime': 'typo'}).status_code == 400
    assert client.post('/api/test-sessions', json={'runtime': ['native']}).status_code == 400
    session = client.post('/api/test-sessions', json={'runtime': 'native'}).json()
    response = client.post('/api/test-run', json={**session, 'runtime': 'claude-sdk', 'query': '你好'})
    assert response.status_code == 400 and '切换' in response.json()['message']
    assert client.get('/api/test-runs').json()['runs'] == []


def test_failed_test_is_persisted_as_failure(tmp_path):
    client = TestClient(create_app(tmp_path, FakeModel([text({'status': 'answer', 'cards': [{'guide_id': '03-01'}]})])))
    login(client, tmp_path)
    session = client.post('/api/test-sessions', json={'runtime': 'native'}).json()
    record = client.post('/api/test-run', json={**session, 'query': '手机通知'}).json()
    assert record['status'] == 'error' and '全文回读' in record['message']
    assert not record['memories_after']['memories']
    assert client.get('/api/test-runs').json()['runs'][0]['status'] == 'error'


def test_test_history_can_resume_after_service_restart(tmp_path):
    model = FakeModel([text({'status': 'acknowledged', 'cards': []}), text({'status': 'acknowledged', 'cards': []})])
    workbench = Workbench(tmp_path, model)
    session = workbench.create_session('alice', 'native', False)
    first = workbench.run('alice', {**session, 'query': '我刚才说了苹果'})
    resumed = Workbench(tmp_path, model)
    second = resumed.run('alice', {**session, 'query': '我刚才说了什么？'})
    assert second['result']['conversation_id'] == first['result']['conversation_id']
    assert any(message['content'] == '我刚才说了苹果' for message in model.inputs[-1])


def test_each_test_session_has_its_own_memory(tmp_path):
    model = FakeModel([read_call(), text({'status': 'answer', 'cards': [{'guide_id': '03-01'}]}), summary(),
                       text({'status': 'acknowledged', 'cards': []})])
    workbench = Workbench(tmp_path, model)
    first = workbench.create_session('alice', 'native', True)
    record = workbench.run('alice', {**first, 'query': '我被手机通知打断'})
    assert record['memories_after']['memories']
    second = workbench.create_session('alice', 'native', False)
    other = workbench.run('alice', {**second, 'query': '你好'})
    assert not other['memories_before']['memories'] and not other['memories_after']['memories']
    assert '手机通知' not in json.dumps(model.inputs[-1], ensure_ascii=False)
