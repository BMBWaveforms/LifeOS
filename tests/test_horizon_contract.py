"""Exercise the actual API boundary with an isolated synthetic model and account store."""
import importlib.util
import json
from pathlib import Path
from fastapi.testclient import TestClient
from backend.main import create_app
from test_api_agent import ScriptedSDKExecutor

ROOT = Path(__file__).resolve().parents[1]


class SyntheticModel:
    def __init__(self):
        self.sessions = {}
        self.responses = [
            {'role': 'assistant', 'content': '', 'tool_calls': [
                {'id': 'test-read', 'type': 'function', 'function': {'name': 'get_entry', 'arguments': '{"guide_id":"03-01"}'}}]},
            {'role': 'assistant', 'content': json.dumps({'status': 'answer', 'cards': [{'guide_id': '03-01'}]})},
            {'role': 'assistant', 'content': json.dumps({'summary': '手机打断工作。', 'user_state': '', 'state_evidence': '', 'problem': '手机打断工作', 'problem_status': 'unresolved', 'status_evidence': '', 'followup_of': '', 'guide_ids': ['03-01']})},
        ]

    def ready(self):
        return {'configured': True, 'model': 'synthetic-only'}

    def complete(self, messages, **kwargs):
        return self.responses.pop(0)


def test_horizon_real_json_uses_sdk_and_automatic_deletion_only_memory(tmp_path):
    model = SyntheticModel()
    app = create_app(tmp_path, model, {'claude-sdk': ScriptedSDKExecutor(model)})
    client = TestClient(app)
    # Only freshly generated temporary test credentials; never read deployment data.
    credentials = json.loads((tmp_path / 'login.json').read_text())
    assert client.post('/api/login', json={'username': 'alice', 'password': credentials['alice']['password']}).status_code == 200
    assert client.get('/api/memories').json()['enabled'] is True
    assert client.get('/api/memories').json()['policy'] == 'automatic_delete_only'
    for action in ('settings', 'correct_summary', 'save'):
        assert client.post('/api/memory-action', json={'action': action, 'enabled': False}).status_code == 400
    assert client.get('/health').json()['model']['configured'] is True
    conversation_id = 'horizon-browser-conversation-0001'
    answer = client.post('/api/run', json={'mode': 'chat', 'query': '手机打断工作', 'conversation_id': conversation_id, 'followup_memory_id': ''})
    assert answer.status_code == 200, answer.text
    data = answer.json()
    assert data['conversation_id'] == conversation_id
    assert data['result']['status'] == 'answer'
    card = data['result']['cards'][0]
    original = app.state.store.entries['03-01']
    for field, value in original.items():
        assert card[field] == value
    assert data['summary']['saved'] is True
    memory = client.get('/api/memories').json()['effective'][0]
    assert memory['id'] == data['summary']['memory_id']
    assert memory['origin'] == 'model_summary'
    topic = client.get('/api/memories').json()['topics'][0]
    assert topic['current_memory_id'] == memory['id']
    assert topic['sources'][0]['query'] == '手机打断工作'
    assert 'source_conversation_id' not in memory  # Documented gap, not a fabricated API.
    assert client.post('/api/memory-action', json={'action': 'delete', 'id': memory['id']}).status_code == 200
    assert client.get('/api/memories').json()['memories'] == []
    assert client.get('/api/guide-entry', params={'guide_id': '03-01'}).json() == original
    client.post('/api/logout', json={})
    assert client.get('/api/memories').status_code == 401


def test_horizon_preview_is_allowlisted_and_cannot_select_real_api(tmp_path):
    spec = importlib.util.spec_from_file_location('horizon_builder', ROOT / 'scripts/build_horizon_preview.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    target = tmp_path / 'public'
    module.build_horizon(target)
    assert json.loads((target / 'runtime.json').read_text()) == {'real_api_enabled': False}
    assert (target / 'assets/guide.json').read_bytes() == (ROOT / 'data/guide.json').read_bytes()
    assert len(list((target / 'assets/scenes').glob('*.mp4'))) == 4
    assert not (target / 'AGENTS.md').exists()
    assert (target / 'app.mjs').exists()
    assert (target / 'memory-topics.mjs').exists()
    assert 'app.mjs' in (target / 'index.html').read_text()
    for obsolete in ('horizon', 'app.js', 'api.js', 'services.js', 'mock-service.js', 'workbench.html', 'evaluation.js'):
        assert not (target / obsolete).exists()
    assert not any(p.name in {'backend', '.runtime', 'login.json', 'auth.json', 'api.json', '.env'} for p in target.rglob('*'))
