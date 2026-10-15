import json

from fastapi.testclient import TestClient

from backend.main import create_app
from backend.prompt_tests import EXAMPLES
from test_prompt_tests import Client, GOOD_OUTPUTS


def sign_in(client, directory, username):
    credentials = json.loads((directory / 'login.json').read_text())
    assert client.post('/api/login', json={
        'username': username, 'password': credentials[username]['password']}).status_code == 200


def test_prompt_test_routes_authenticate_preserve_results_and_isolate_accounts(tmp_path):
    model = Client(GOOD_OUTPUTS['understanding'])
    app = create_app(tmp_path, model)
    alice, bob = TestClient(app), TestClient(app)
    for path in ('/api/prompt-tests', '/api/prompt-tests/catalog', '/api/prompt-tests/' + 'a' * 32):
        assert alice.get(path).status_code == 401
    assert alice.post('/api/prompt-tests', json={}).status_code == 401
    sign_in(alice, tmp_path, 'alice')
    sign_in(bob, tmp_path, 'bob')
    before = alice.get('/api/memories').json()
    assert len(alice.get('/api/prompt-tests/catalog').json()['modules']) == 7
    record = alice.post('/api/prompt-tests', json={
        'module': 'understanding', 'input': EXAMPLES['understanding']}).json()
    assert record['status'] == 'success'
    assert alice.get('/api/prompt-tests').json()['runs'][0]['id'] == record['id']
    assert alice.get('/api/prompt-tests/' + record['id']).json() == record
    assert bob.get('/api/prompt-tests').json() == {'runs': []}
    assert bob.get('/api/prompt-tests/' + record['id']).status_code == 401
    assert alice.get('/api/memories').json() == before


def test_large_chinese_prompt_reaches_validation_with_bounded_request_size(tmp_path):
    model = Client(GOOD_OUTPUTS['summary'])
    app = create_app(tmp_path, model)
    client = TestClient(app)
    sign_in(client, tmp_path, 'alice')
    prompt = '只总结本轮明确内容。' * 800
    payload = {'module': 'summary', 'prompt_mode': 'draft', 'prompt': prompt, 'input': EXAMPLES['summary']}
    assert len(json.dumps(payload, ensure_ascii=False).encode()) > 20000
    response = client.post('/api/prompt-tests', json=payload)
    assert response.status_code == 200 and response.json()['status'] == 'success'
    assert response.json()['prompt']['content'] == prompt
    assert client.post('/api/prompt-tests', content='x' * 200001).status_code == 413
