"""Exercise the actual API boundary with an isolated synthetic model and account store."""
import importlib.util
import json
from pathlib import Path
from fastapi.testclient import TestClient
from backend.main import create_app

ROOT = Path(__file__).resolve().parents[1]


class SyntheticModel:
    def __init__(self):
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


def test_horizon_real_json_matches_current_api_without_changing_account_defaults(tmp_path):
    app = create_app(tmp_path, SyntheticModel())
    client = TestClient(app)
    # Only freshly generated temporary test credentials; never read deployment data.
    credentials = json.loads((tmp_path / 'login.json').read_text())
    assert client.post('/api/login', json={'username': 'alice', 'password': credentials['alice']['password']}).status_code == 200
    assert client.get('/api/memories').json()['enabled'] is False
    assert client.get('/health').json()['model']['configured'] is True
    # Fixture setup explicitly enables only the temporary store; Horizon never does this.
    app.state.store.change('alice', 'settings', {'enabled': True})
    answer = client.post('/api/run', json={'mode': 'chat', 'query': '手机打断工作', 'conversation_id': 'browser-local', 'followup_memory_id': '', 'runtime': 'native'})
    assert answer.status_code == 200, answer.text
    data = answer.json()
    assert data['conversation_id'] and data['conversation_id'] != 'browser-local'
    assert data['result']['status'] == 'answer'
    card = data['result']['cards'][0]
    original = app.state.store.entries['03-01']
    for field, value in original.items():
        assert card[field] == value
    assert data['summary']['saved'] is True
    memory = client.get('/api/memories').json()['effective'][0]
    assert memory['id'] == data['summary']['memory_id']
    assert memory['origin'] == 'model_summary'
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
    assert not any(p.name in {'backend', '.runtime', 'login.json', 'auth.json', 'api.json', '.env'} for p in target.rglob('*'))
