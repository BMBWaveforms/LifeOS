import json
import pytest
import claude_agent_sdk as sdk
from backend.errors import ModelError
from backend.model import AgentService, ModelClient
from backend.store import Store
from test_api_agent import FakeModel, read_call, summary, text


@pytest.fixture
def sdk_transport(monkeypatch):
    state = {'tools': {}, 'options': [], 'inputs': [], 'mode': 'read'}

    def server(**kwargs):
        state['tools'] = {tool.name: tool for tool in kwargs['tools']}
        return {'type': 'sdk', 'name': kwargs['name'], 'instance': object()}

    class Client:
        def __init__(self, options):
            self.options = options
            state['options'].append(options)
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return False
        async def query(self, payload): state['inputs'].append(json.loads(payload))
        async def receive_response(self):
            yield sdk.SystemMessage(subtype='init', data={'tools': ['mcp__guide__'+name for name in state['tools']]})
            if state['mode'] == 'provider-error':
                raise RuntimeError('provider headers contain synthetic-private-key')
            if state['mode'] == 'unauthorized':
                await self.options.hooks['PreToolUse'][0].hooks[0]({'tool_name': 'Bash'}, None, {})
            if state['mode'] == 'read':
                await state['tools']['get_entry'].handler({'guide_id': '03-01'})
                output = {'status': 'answer', 'cards': [{'guide_id': '03-01'}]}
            else:
                output = {'status': 'acknowledged', 'cards': []}
            yield sdk.ResultMessage(subtype='success', duration_ms=10, duration_api_ms=5,
                                    is_error=False, num_turns=2, session_id='test-only',
                                    result=json.dumps(output), usage={'input_tokens': 1, 'output_tokens': 1})

    monkeypatch.setattr(sdk, 'create_sdk_mcp_server', server)
    monkeypatch.setattr(sdk, 'ClaudeSDKClient', Client)
    return state


def sdk_service(tmp_path, responses=()):
    client = FakeModel(responses)
    client.sdk_config = lambda: ('synthetic-key', 'https://api.deepseek.com/anthropic', 'test-deepseek')
    return AgentService(Store(tmp_path), client)


def test_unset_runtime_defaults_to_sdk_and_receives_selected_situation(tmp_path, monkeypatch, sdk_transport):
    monkeypatch.delenv('AGENT_RUNTIME', raising=False)
    service = sdk_service(tmp_path)
    result = service.chat('alice', {'query': '我被手机通知打断', 'guide_id': '03-01'})
    assert service.default_runtime == service.runtime_status()['default'] == 'claude-sdk'
    assert result['execution']['runtime'] == 'claude-sdk'
    current = sdk_transport['inputs'][0]['current']
    assert current['query'] == '我被手机通知打断'
    assert current['selected_guide']['guide_id'] == '03-01'
    assert current['candidate_titles'][0]['guide_id'] == '03-01'
    assert result['result']['cards'][0]['guide_id'] == '03-01'


def test_explicit_native_default_is_preserved(tmp_path, monkeypatch, sdk_transport):
    monkeypatch.setenv('AGENT_RUNTIME', 'native')
    service = sdk_service(tmp_path, [text({'status': 'acknowledged', 'cards': []})])
    result = service.chat('alice', {'query': '你好'})
    assert service.default_runtime == result['execution']['runtime'] == 'native'
    assert not sdk_transport['options']


def test_sdk_and_native_share_source_and_memory_contract(tmp_path, sdk_transport):
    service = sdk_service(tmp_path, [summary()])
    service.store.change('alice', 'settings', {'enabled': True})
    result = service.chat('alice', {'runtime': 'claude-sdk', 'query': '我被手机通知打断'}, include_trace=True)
    assert result['summary']['saved']
    assert result['result']['cards'][0]['guide_id'] == '03-01'
    assert result['trace'][0]['output']['complete']
    assert result['execution']['runtime'] == 'claude-sdk'
    assert service.store.state('alice')['effective'][0]['guide_ids'] == ['03-01']
    options = sdk_transport['options'][0]
    assert options.tools == [] and options.strict_mcp_config and options.setting_sources == []
    assert not options.resume and not options.continue_conversation
    assert options.env['ANTHROPIC_AUTH_TOKEN'] == 'synthetic-key'


def test_sdk_failure_cannot_be_hidden_by_successful_model_output(tmp_path, sdk_transport):
    service = sdk_service(tmp_path)
    service.store.entries['03-01']['complete'] = False
    with pytest.raises(ModelError, match='正文不完整'):
        service.chat('alice', {'runtime': 'claude-sdk', 'query': '手机通知'})
    assert not service.store.state('alice')['memories']


def test_sdk_unregistered_tool_blocks_whole_run(tmp_path, sdk_transport):
    sdk_transport['mode'] = 'unauthorized'
    with pytest.raises(ModelError, match='未授权工具'):
        sdk_service(tmp_path).chat('alice', {'runtime': 'claude-sdk', 'query': '你好'})


def test_sdk_provider_error_is_redacted(tmp_path, sdk_transport):
    sdk_transport['mode'] = 'provider-error'
    with pytest.raises(ModelError) as error:
        sdk_service(tmp_path).chat('alice', {'runtime': 'claude-sdk', 'query': '你好'})
    assert 'synthetic-private-key' not in str(error.value)


def test_sdk_does_not_accept_unread_citations(tmp_path, sdk_transport):
    sdk_transport['mode'] = 'read'
    service = sdk_service(tmp_path)
    # A missing entry returns no valid read; successful-looking JSON must still fail.
    service.store.entries.pop('03-01')
    with pytest.raises(ValueError):
        service.chat('alice', {'runtime': 'claude-sdk', 'query': '手机通知'})


def test_switching_runtime_does_not_reuse_other_runtime_history(tmp_path, sdk_transport):
    client = FakeModel([text({'status': 'acknowledged', 'cards': []})])
    client.sdk_config = lambda: ('fake', 'https://api.deepseek.com/anthropic', 'test-deepseek')
    service = AgentService(Store(tmp_path), client)
    first = service.chat('alice', {'runtime': 'native', 'query': '你好'})
    sdk_transport['mode'] = 'acknowledged'
    second = service.chat('alice', {'runtime': 'claude-sdk', 'query': '谢谢', 'conversation_id': first['conversation_id']})
    assert second['conversation_id'] != first['conversation_id']
    assert sdk_transport['inputs'][-1]['conversation'] == []


def test_sdk_deletion_discards_old_history_and_memory(tmp_path, sdk_transport):
    service = sdk_service(tmp_path, [summary()])
    service.store.change('alice', 'settings', {'enabled': True})
    first = service.chat('alice', {'runtime': 'claude-sdk', 'query': '我被手机通知打断'})
    service.store.change('alice', 'delete', {'id': first['summary']['memory_id']})
    sdk_transport['mode'] = 'acknowledged'
    service.client.responses = [text({'summary': '用户打了招呼。', 'user_state': '', 'state_evidence': '',
                                     'problem': '', 'problem_status': 'unknown', 'guide_ids': []})]
    second = service.chat('alice', {'runtime': 'claude-sdk', 'query': '你好', 'conversation_id': first['conversation_id']})
    assert second['conversation_id'] != first['conversation_id']
    assert '手机通知' not in json.dumps(sdk_transport['inputs'][-1], ensure_ascii=False)


def test_sdk_model_mapping_requires_explicit_compatible_base(monkeypatch):
    client = ModelClient()
    monkeypatch.delenv('AGENT_SDK_BASE_URL', raising=False)
    client.config = lambda: ('fake', 'https://api.deepseek.com/v1', 'chosen-model')
    assert client.sdk_config() == ('fake', 'https://api.deepseek.com/anthropic', 'chosen-model')
    client.config = lambda: ('fake', 'https://other.example/v1', 'chosen-model')
    with pytest.raises(ModelError, match='显式配置'):
        client.sdk_config()
    monkeypatch.setenv('AGENT_SDK_BASE_URL', 'http://other.example/anthropic')
    with pytest.raises(ModelError, match='HTTPS'):
        client.sdk_config()
