import json
import stat
from pathlib import Path

import anyio
import claude_agent_sdk as sdk
import pytest

from backend.completion import complete_json
from backend.errors import ModelError


class FakeConfig:
    def sdk_config(self):
        return 'synthetic-private-key', 'https://provider.example/anthropic', 'synthetic-model'


def result(**values):
    data = {'subtype': 'success', 'duration_ms': 1, 'duration_api_ms': 1,
            'is_error': False, 'num_turns': 1, 'session_id': 'synthetic-ephemeral-session',
            'result': '{"ok":true}'}
    return sdk.ResultMessage(**{**data, **values})


@pytest.fixture
def completion_transport(monkeypatch):
    state = {'options': [], 'inputs': [], 'closed': [],
             'events': [sdk.SystemMessage(subtype='init', data={'tools': []}), result()]}

    class Client:
        def __init__(self, options):
            self.options = options
            state['options'].append(options)
        async def __aenter__(self):
            root = Path(self.options.cwd)
            assert stat.S_IMODE(root.stat().st_mode) == 0o700
            config = Path(self.options.env['CLAUDE_CONFIG_DIR'])
            assert stat.S_IMODE(config.stat().st_mode) == 0o700
            # Emulate the CLI writing a raw transcript. Cleanup must remove it.
            (config / 'private-transcript.jsonl').write_text('synthetic-sensitive-transcript')
            return self
        async def __aexit__(self, *args):
            state['closed'].append(self.options.cwd)
            if state.get('exit_error'):
                raise RuntimeError('synthetic-private-key in SDK cleanup error')
            return False
        async def query(self, payload):
            state['inputs'].append(payload)
        async def receive_response(self):
            for event in state['events']:
                if isinstance(event, Exception):
                    raise event
                if callable(event):
                    await event(self.options)
                else:
                    yield event

    monkeypatch.setattr(sdk, 'ClaudeSDKClient', Client)
    return state


def assert_clean(state):
    assert state['options']
    assert all(not Path(options.cwd).exists() for options in state['options'])


def test_sdk_completion_is_tool_free_ephemeral_and_has_no_history(completion_transport):
    messages = [{'role': 'system', 'content': 'Return only JSON.'},
                {'role': 'user', 'content': '{"question":"synthetic"}'}]
    first = complete_json(FakeConfig(), messages)
    second = complete_json(FakeConfig(), messages)
    assert first == second == {'role': 'assistant', 'content': '{"ok":true}'}
    assert completion_transport['inputs'] == [messages[-1]['content']] * 2
    assert len({o.cwd for o in completion_transport['options']}) == 2
    for options in completion_transport['options']:
        assert options.system_prompt == messages[0]['content']
        assert options.tools == options.allowed_tools == options.skills == options.plugins == []
        assert options.mcp_servers == options.agents == {} and options.strict_mcp_config
        assert options.setting_sources == [] and options.permission_mode == 'default'
        assert not options.resume and not options.continue_conversation
        assert options.max_turns == 2 and options.thinking == {'type': 'disabled'}
        assert options.env['CLAUDE_CODE_DISABLE_AUTO_MEMORY'] == '1'
        assert options.env['CLAUDE_CODE_DISABLE_CLAUDE_MDS'] == '1'
        assert options.env['ENABLE_CLAUDEAI_MCP_SERVERS'] == 'false'
        assert options.env['ANTHROPIC_AUTH_TOKEN'] == 'synthetic-private-key'
    assert len(completion_transport['closed']) == 2
    assert_clean(completion_transport)


@pytest.mark.parametrize('mode', ['init', 'hook', 'permission', 'block', 'server_block', 'denials', 'deferred'])
def test_tools_cannot_be_used_even_if_terminal_result_says_success(completion_transport, mode):
    async def hook(options):
        gate = await options.hooks['PreToolUse'][0].hooks[0]({'tool_name': 'Bash'}, None, {})
        assert gate['hookSpecificOutput']['permissionDecision'] == 'deny'
    async def permission(options):
        denied = await options.can_use_tool('Bash', {'command': 'secret'}, {})
        assert isinstance(denied, sdk.PermissionResultDeny)
    event = {
        'init': sdk.SystemMessage(subtype='init', data={'tools': ['Bash']}),
        'hook': hook,
        'permission': permission,
        'block': sdk.AssistantMessage(content=[sdk.ToolUseBlock(id='x', name='Bash', input={})], model='test'),
        'server_block': sdk.AssistantMessage(content=[{'type': 'server_tool_use'}], model='test'),
        'denials': result(permission_denials=[{'tool_name': 'Bash'}]),
        'deferred': result(deferred_tool_use={'name': 'Bash'}),
    }[mode]
    completion_transport['events'] = [event, result()]
    with pytest.raises(ModelError, match='未授权工具'):
        complete_json(FakeConfig(), [{'role': 'user', 'content': 'Return JSON.'}])
    assert_clean(completion_transport)


@pytest.mark.parametrize('events,expected', [
    ([], '完成状态'),
    ([result(result='')], '有效文本'),
    ([result(result=None)], '有效文本'),
    ([result(), result()], '重复完成'),
    ([result(subtype='error_max_turns', is_error=True, result='private-provider-output')], '执行失败'),
])
def test_incomplete_or_error_result_is_rejected_and_cleaned(completion_transport, events, expected):
    completion_transport['events'] = events
    with pytest.raises(ModelError, match=expected) as caught:
        complete_json(FakeConfig(), [{'role': 'user', 'content': 'Return JSON.'}])
    assert 'private-provider-output' not in str(caught.value)
    assert_clean(completion_transport)


def test_timeout_disconnects_and_cleans_transcript(completion_transport):
    async def stall(options):
        await anyio.sleep_forever()
    completion_transport['events'] = [stall]
    with pytest.raises(ModelError, match='超时'):
        complete_json(FakeConfig(), [{'role': 'user', 'content': 'Return JSON.'}], timeout=0.01)
    assert completion_transport['closed']
    assert_clean(completion_transport)


def test_cleanup_exception_is_redacted_and_temp_tree_removed(completion_transport):
    completion_transport['exit_error'] = True
    with pytest.raises(ModelError) as caught:
        complete_json(FakeConfig(), [{'role': 'user', 'content': 'Return JSON.'}])
    assert 'synthetic-private-key' not in str(caught.value)
    assert_clean(completion_transport)


@pytest.mark.parametrize('messages', [[], [{'role': 'tool', 'content': 'x'}],
    [{'role': 'user', 'content': 'x', 'tool_calls': []}], [{'role': 'user', 'content': []}],
    [{'role': 'system', 'content': 'x'}]])
def test_only_explicit_text_messages_are_accepted_before_sdk(completion_transport, messages):
    with pytest.raises(ValueError):
        complete_json(FakeConfig(), messages)
    assert not completion_transport['options']


def test_explicit_multimessage_input_is_passed_only_in_this_call(completion_transport):
    messages = [{'role': 'system', 'content': 'JSON'}, {'role': 'user', 'content': 'one'},
                {'role': 'assistant', 'content': 'two'}, {'role': 'user', 'content': 'three'}]
    complete_json(FakeConfig(), messages)
    assert json.loads(completion_transport['inputs'][0]) == {'messages': messages[1:]}
    assert_clean(completion_transport)
