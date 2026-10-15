import json
from fastapi.testclient import TestClient
from backend.accounts import initialize_accounts, TEST_ACCOUNTS
from backend.main import create_app
from backend.store import Store
from test_api_agent import FakeModel


def test_all_ten_accounts_login_and_access_test_workbench(tmp_path, monkeypatch):
    monkeypatch.setenv('TEST_ACCOUNT_PASSWORD', '000')
    app = create_app(tmp_path, FakeModel([]))
    for username in TEST_ACCOUNTS:
        client = TestClient(app)
        response = client.post('/api/login', json={'username': username, 'password': '000'})
        assert response.status_code == 200 and response.json()['user']['id'] == username
        assert client.get('/api/me').json()['user']['id'] == username
        assert client.get('/api/runtimes').status_code == 200
        assert client.get('/api/test-runs').json()['runs'] == []
    auth = json.loads((tmp_path / 'auth.json').read_text())
    assert len({auth[username]['salt'] for username in TEST_ACCOUNTS}) == 10


def test_provisioning_preserves_old_accounts_memories_and_is_idempotent(tmp_path):
    store = Store(tmp_path)
    old = initialize_accounts(store)
    old_profiles = dict(store.profiles)
    store.change('alice', 'settings', {'enabled': True})
    store.change('alice', 'save', {'confirmed': True, 'kind': 'condition', 'text': '历史数据要保留'})
    old_memory = store.state('alice')
    auth = initialize_accounts(store, 'synthetic-test-password')
    assert all(auth[username] == old[username] for username in old)
    assert all(store.profiles[username] == old_profiles[username] for username in old_profiles)
    assert store.state('alice') == old_memory
    assert not store.state('test1')['memories'] and not store.state('test10')['memories']
    first = (tmp_path / 'auth.json').read_bytes()
    assert initialize_accounts(Store(tmp_path), 'synthetic-test-password') == auth
    assert (tmp_path / 'auth.json').read_bytes() == first
    assert ((tmp_path / 'auth.json').stat().st_mode & 0o777) == 0o600


def test_configured_password_update_preserves_test_user_identity(tmp_path, monkeypatch):
    store = Store(tmp_path)
    initialize_accounts(store, 'old-synthetic-password')
    profiles = dict(store.profiles)
    store.change('test1', 'settings', {'enabled': True})
    store.change('test1', 'save', {'confirmed': True, 'kind': 'condition', 'text': '测试账号的已有数据'})
    state = store.state('test1')
    monkeypatch.setenv('TEST_ACCOUNT_PASSWORD', '000')
    app = create_app(tmp_path, FakeModel([]))
    assert app.state.store.profiles == profiles and app.state.store.state('test1') == state
    client = TestClient(app)
    assert client.post('/api/login', json={'username': 'test1', 'password': 0}).status_code == 401
    assert client.post('/api/login', json={'username': 'test1', 'password': '000'}).status_code == 200
    other = TestClient(app)
    assert other.post('/api/login', json={'username': 'test2', 'password': '000'}).status_code == 200
    assert client.get('/api/memories').json()['memories']
    assert not other.get('/api/memories').json()['memories']
