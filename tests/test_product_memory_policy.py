import json

from fastapi.testclient import TestClient

from backend.main import create_app
from backend.store import Store
from test_api_agent import FakeModel


def logged_in(app, directory):
    client = TestClient(app)
    credentials = json.loads((directory / 'login.json').read_text())
    assert client.post('/api/login', json={
        'username': 'alice', 'password': credentials['alice']['password']}).status_code == 200
    return client


def test_product_policy_migrates_existing_account_once_and_preserves_sources(tmp_path):
    old = Store(tmp_path)
    old.change('alice', 'settings', {'enabled': True})
    old.change('alice', 'save', {'id': 'source', 'text': '我每天通勤两小时', 'confirmed': True})
    old.change('alice', 'settings', {'enabled': False})
    revision = old.state('alice')['revision']
    app = create_app(tmp_path, FakeModel([]))
    client = logged_in(app, tmp_path)
    state = client.get('/api/memories').json()
    assert state['enabled'] and state['policy'] == 'automatic_delete_only'
    assert state['revision'] == revision + 1
    assert state['topics'][0]['sources'][0]['text'] == '我每天通勤两小时'
    auth_before = (tmp_path / 'auth.json').read_bytes()
    restarted = create_app(tmp_path, FakeModel([]))
    assert restarted.state.store.state('alice')['revision'] == state['revision']
    assert (tmp_path / 'auth.json').read_bytes() == auth_before


def test_product_rejects_edit_and_settings_but_allows_deletion(tmp_path):
    app = create_app(tmp_path, FakeModel([]))
    client = logged_in(app, tmp_path)
    store = app.state.store
    store.change('alice', 'save', {'id': 'source', 'text': '我的租房预算三千元', 'confirmed': True})
    before = client.get('/api/memories').json()
    for action in ('settings', 'correct_summary', 'save'):
        assert client.post('/api/memory-action', json={
            'action': action, 'enabled': False, 'id': 'source', 'text': '修改内容'}).status_code == 400
    assert client.get('/api/memories').json() == before
    tid = before['topics'][0]['id']
    deleted = client.post('/api/memory-action', json={'action': 'delete_topic', 'id': tid})
    assert deleted.status_code == 200
    assert deleted.json()['topics'] == [] and deleted.json()['enabled']


def test_product_defaults_do_not_change_isolated_test_memory_switch(tmp_path):
    app = create_app(tmp_path, FakeModel([]))
    client = logged_in(app, tmp_path)
    record = client.post('/api/test-sessions', json={'memory_enabled': False}).json()
    assert record['memory_enabled'] is False
    assert client.get('/api/memories').json()['enabled']
