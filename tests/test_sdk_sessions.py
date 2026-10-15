"""Native SDK session lifecycle, isolation and controlled compression contracts."""
import json
import stat
from pathlib import Path
from uuid import uuid4

import claude_agent_sdk as sdk
import pytest

from backend.errors import ModelError
from backend.executors import ClaudeSDKExecutor, CompactionPolicy, ExecutionRequest, validate_runtime
from backend.sdk_sessions import SDKSessionStore


class Model:
    key = 'synthetic-key'
    def sdk_config(self):
        return self.key, 'https://api.deepseek.com/anthropic', 'test-model'


class Tools:
    definitions = [{'type': 'function', 'function': {'name': 'get_entry', 'description': 'read',
                   'parameters': {'type': 'object', 'properties': {'guide_id': {'type': 'string'}},
                                  'required': ['guide_id']}}}]
    handlers = {'get_entry': object()}

    def __init__(self, run_id):
        self.run_id = run_id
        self.trace = []
        self.failure = None
        self.calls = 0

    def invoke(self, name, args):
        self.calls += 1
        self.trace.append({'run_id': self.run_id, 'guide_id': args['guide_id']})
        return {'complete': True, 'current_run': self.run_id}


@pytest.fixture
def transport(monkeypatch):
    state = {'tools': {}, 'options': [], 'queries': [], 'mode': 'success', 'usage_calls': 0}

    def server(**kwargs):
        state['tools'] = {item.name: item for item in kwargs['tools']}
        return {'type': 'sdk', 'name': 'guide', 'instance': object()}

    class Client:
        def __init__(self, options):
            self.options = options
            self.tools = dict(state['tools'])
            self.session_id = options.resume or str(uuid4())
            self.payload = None
            state['options'].append(options)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            if state['mode'] != 'no-transcript':
                transcript = Path(self.options.env['CLAUDE_CONFIG_DIR']) / 'projects' / 'session' / (self.session_id + '.jsonl')
                transcript.parent.mkdir(parents=True, exist_ok=True)
                with transcript.open('a') as stream:
                    stream.write(json.dumps({'type': 'user', 'text': self.payload}) + '\n')
            return False

        async def query(self, payload):
            self.payload = payload
            state['queries'].append(payload)

        async def get_context_usage(self):
            state['usage_calls'] += 1
            if state['mode'] == 'usage-error':
                raise RuntimeError('provider private headers')
            return {'totalTokens': 800, 'maxTokens': 1000, 'percentage': 80,
                    'memoryFiles': [{'path': 'synthetic-private-path'}], 'arbitrary': 'synthetic-private-body'}

        async def receive_response(self):
            yield sdk.SystemMessage(subtype='init', data={
                'tools': ['Bash'] if state['mode'] == 'exposed-builtin' else ['mcp__guide__get_entry']})
            if state['mode'] == 'provider-error':
                raise RuntimeError('provider private headers')
            if self.payload.startswith('/compact '):
                await self.options.hooks['PreCompact'][0].hooks[0]({'trigger': 'manual'}, None, {})
                yield sdk.SystemMessage(subtype='compact_boundary', data={'summary': 'synthetic-private-summary'})
            else:
                await self.tools['get_entry'].handler({'guide_id': '03-01'})
            yield sdk.ResultMessage(subtype='success', duration_ms=10, duration_api_ms=5,
                                    is_error=False, num_turns=2, session_id=self.session_id,
                                    result='{"status":"acknowledged","cards":[]}',
                                    usage={'input_tokens': 100, 'output_tokens': 10})

    monkeypatch.setattr(sdk, 'ClaudeSDKClient', Client)
    monkeypatch.setattr(sdk, 'create_sdk_mcp_server', server)
    monkeypatch.delenv('AGENT_SDK_CONTEXT_USAGE', raising=False)
    return state


def request(tmp_path, cid='initial', revision=0, owner='alice', run_id='run-1', **kwargs):
    return ExecutionRequest('trusted-system', [{'role': 'system', 'content': 'trusted-system'},
        {'role': 'user', 'content': json.dumps({'query': '现在的问题', 'run_id': run_id,
                                              'memory_revision': revision})}],
        Tools(run_id), tmp_path / owner, owner=owner, conversation_id=cid,
        memory_revision=revision, context_binding={'prompt': 'p1', 'guide': 'g1'}, **kwargs)


def execute_and_commit(executor, req, revision=None):
    result = executor.execute(req)
    result.session.commit(req.memory_revision if revision is None else revision)
    return result


def test_resume_uses_committed_session_and_fresh_tool_binding(tmp_path, transport):
    executor = ClaudeSDKExecutor(Model())
    first_req = request(tmp_path)
    first = execute_and_commit(executor, first_req, revision=1)
    second_req = request(tmp_path, first.session.conversation_id, revision=1, run_id='run-2')
    second = execute_and_commit(ClaudeSDKExecutor(Model()), second_req)
    assert transport['options'][0].resume is None
    assert transport['options'][1].resume == first.session.session_id
    assert second.session.conversation_id == first.session.conversation_id
    assert second.metadata['session_resumed'] is True
    assert first_req.tools.trace == [{'run_id': 'run-1', 'guide_id': '03-01'}]
    assert second_req.tools.trace == [{'run_id': 'run-2', 'guide_id': '03-01'}]
    assert all('conversation' not in json.loads(payload) for payload in transport['queries'])
    assert json.loads(transport['queries'][-1])['current']['run_id'] == 'run-2'
    assert transport['usage_calls'] == 0
    assert second.metadata['context_usage']['after'] == {'status': 'unknown'}


@pytest.mark.parametrize('change', ['revision', 'prompt', 'credential', 'owner'])
def test_incompatible_or_other_owner_context_starts_new_session(tmp_path, transport, change):
    model = Model()
    executor = ClaudeSDKExecutor(model)
    first = execute_and_commit(executor, request(tmp_path))
    req = request(tmp_path, first.session.conversation_id)
    if change == 'revision': req.memory_revision = 1
    if change == 'prompt': req.context_binding = {'prompt': 'p2', 'guide': 'g1'}
    if change == 'credential': model.key = 'new-synthetic-key'
    if change == 'owner': req.owner = 'bob'
    second = execute_and_commit(executor, req)
    assert transport['options'][-1].resume is None
    assert second.session.conversation_id == first.session.conversation_id
    assert second.metadata['context_reset'] is True


def test_unvalidated_sdk_output_is_not_resumable(tmp_path, transport):
    executor = ClaudeSDKExecutor(Model())
    first = executor.execute(request(tmp_path))
    cid = first.session.conversation_id
    directory = first.session.directory
    first.session.discard()
    assert not directory.exists()
    second = execute_and_commit(executor, request(tmp_path, cid))
    assert not second.metadata['session_resumed']
    assert second.session.conversation_id == cid


def test_provider_failure_drops_only_failed_conversation(tmp_path, transport):
    executor = ClaudeSDKExecutor(Model())
    first = execute_and_commit(executor, request(tmp_path))
    other = execute_and_commit(executor, request(tmp_path, 'other'))
    transport['mode'] = 'provider-error'
    with pytest.raises(ModelError) as error:
        executor.execute(request(tmp_path, first.session.conversation_id))
    assert 'private headers' not in str(error.value)
    assert not first.session.directory.exists()
    assert other.session.directory.exists()


def test_missing_transcript_is_not_reported_as_resumable(tmp_path, transport):
    transport['mode'] = 'no-transcript'
    with pytest.raises(ModelError, match='未保存'):
        ClaudeSDKExecutor(Model()).execute(request(tmp_path))
    assert list((tmp_path / 'alice' / 'sdk-sessions').iterdir()) == []


def test_exposed_builtin_tools_are_rejected_even_on_resume(tmp_path, transport):
    executor = ClaudeSDKExecutor(Model())
    first = execute_and_commit(executor, request(tmp_path))
    transport['mode'] = 'exposed-builtin'
    with pytest.raises(ModelError, match='未授权工具'):
        executor.execute(request(tmp_path, first.session.conversation_id))
    assert not first.session.directory.exists()


def test_compression_defaults_and_disabled_mode_preserve_tool_isolation(tmp_path, transport, monkeypatch):
    executor = ClaudeSDKExecutor(Model())
    first = execute_and_commit(executor, request(tmp_path))
    options = transport['options'][0]
    assert options.env['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'] == '60'
    assert options.env['DISABLE_AUTO_COMPACT'] == '0'
    assert options.env['CLAUDE_CODE_SKIP_PROMPT_HISTORY'] == '0'
    assert options.env['CLAUDE_CODE_PROJECT_DIR_NAME'] == 'session'
    assert options.tools == [] and options.setting_sources == [] and options.strict_mcp_config
    assert not options.continue_conversation
    assert '本轮 get_entry' in options.system_prompt
    monkeypatch.setenv('AGENT_SDK_AUTO_COMPACT', 'false')
    second = execute_and_commit(executor, request(tmp_path, first.session.conversation_id))
    assert transport['options'][-1].env['DISABLE_AUTO_COMPACT'] == '1'
    assert transport['options'][-1].env['DISABLE_COMPACT'] == '0'
    assert not second.metadata['session_resumed']


def test_controlled_compaction_is_fixed_command_before_current_query(tmp_path, transport):
    executor = ClaudeSDKExecutor(Model())
    first = execute_and_commit(executor, request(tmp_path))
    second = execute_and_commit(executor, request(tmp_path, first.session.conversation_id, compact_context=True))
    assert transport['queries'][-2].startswith('/compact ')
    assert '保留用户明确说过的事实' in transport['queries'][-2]
    assert json.loads(transport['queries'][-1])['current']['query'] == '现在的问题'
    assert second.metadata['compaction']['manual_before_turn']
    assert second.metadata['compaction']['events'] == ['manual']
    assert second.metadata['compaction']['boundaries'] == 1
    assert 'synthetic-private-summary' not in json.dumps(second.metadata)


def test_context_usage_is_opt_in_numeric_only_and_can_trigger_earlier_compaction(tmp_path, transport, monkeypatch):
    monkeypatch.setenv('AGENT_SDK_CONTEXT_USAGE', 'true')
    executor = ClaudeSDKExecutor(Model())
    first = execute_and_commit(executor, request(tmp_path))
    second = execute_and_commit(executor, request(tmp_path, first.session.conversation_id))
    assert second.metadata['context_usage']['before']['percentage'] == 80
    assert second.metadata['compaction']['manual_before_turn']
    assert 'synthetic-private' not in json.dumps(second.metadata)


def test_unsupported_token_count_remains_unknown(tmp_path, transport, monkeypatch):
    monkeypatch.setenv('AGENT_SDK_CONTEXT_USAGE', 'true')
    transport['mode'] = 'usage-error'
    result = execute_and_commit(ClaudeSDKExecutor(Model()), request(tmp_path))
    assert result.metadata['context_usage']['after'] == {'status': 'unknown'}


@pytest.mark.parametrize('value', ['0', '101', 'bad'])
def test_invalid_compression_percentage_is_rejected(monkeypatch, value):
    monkeypatch.setenv('AGENT_SDK_COMPACT_PCT', value)
    with pytest.raises(ModelError, match='1—100'):
        CompactionPolicy.from_environment()


def test_invalidate_prevents_pending_commit_and_keeps_business_files(tmp_path, transport):
    req = request(tmp_path)
    req.directory.mkdir()
    business_file = req.directory / 'business-state.txt'
    business_file.write_text('keep')
    executor = ClaudeSDKExecutor(Model())
    result = executor.execute(req)
    executor.invalidate(req.directory)
    with pytest.raises(ValueError, match='已失效'):
        result.session.commit(0)
    result.session.discard()
    assert business_file.read_text() == 'keep'
    assert not (req.directory / 'sdk-sessions').exists()


def test_expiration_and_per_owner_session_limit(tmp_path, transport, monkeypatch):
    monkeypatch.setenv('AGENT_SDK_MAX_SESSIONS', '2')
    executor = ClaudeSDKExecutor(Model())
    first = execute_and_commit(executor, request(tmp_path))
    execute_and_commit(executor, request(tmp_path, 'two'))
    execute_and_commit(executor, request(tmp_path, 'three'))
    assert len(list((tmp_path / 'alice' / 'sdk-sessions').iterdir())) == 2
    assert not first.session.directory.exists()
    last = execute_and_commit(executor, request(tmp_path, 'four'))
    marker = last.session.directory / 'committed.json'
    record = json.loads(marker.read_text())
    record['updated'] = 0
    marker.write_text(json.dumps(record))
    fresh = execute_and_commit(executor, request(tmp_path, last.session.conversation_id))
    assert not fresh.metadata['session_resumed']
    assert fresh.session.conversation_id == last.session.conversation_id


def test_crash_pending_history_is_never_resumed(tmp_path, transport):
    executor = ClaudeSDKExecutor(Model())
    first = execute_and_commit(executor, request(tmp_path))
    pending = executor.execute(request(tmp_path, first.session.conversation_id))
    # Simulate process loss before business commit; only the pending marker survives.
    new = execute_and_commit(ClaudeSDKExecutor(Model()), request(tmp_path, first.session.conversation_id))
    assert not new.metadata['session_resumed']
    pending.session.discard()
    assert new.session.directory.exists()


def test_private_session_permissions(tmp_path, transport):
    result = execute_and_commit(ClaudeSDKExecutor(Model()), request(tmp_path))
    for path in (result.session.directory, *result.session.directory.rglob('*')):
        assert stat.S_IMODE(path.stat().st_mode) == (0o700 if path.is_dir() else 0o600)


def test_sdk_only_runtime_validation():
    assert validate_runtime() == validate_runtime('') == validate_runtime('claude-sdk') == 'claude-sdk'
    for value in ('native', 'other', False, 1):
        with pytest.raises(ValueError):
            validate_runtime(value)


def test_expired_business_context_cannot_restore_history(tmp_path, transport, monkeypatch):
    import backend.sdk_sessions as sessions
    executor = ClaudeSDKExecutor(Model())
    req = request(tmp_path)
    now = sessions.time.time()
    req.context_binding['expires_at'] = now + 10
    first = execute_and_commit(executor, req)
    monkeypatch.setattr(sessions.time, 'time', lambda: now + 20)
    second_req = request(tmp_path, first.session.conversation_id)
    second_req.context_binding['expires_at'] = now + 10
    second = execute_and_commit(executor, second_req)
    assert not second.metadata['session_resumed']
    assert second.session.conversation_id == first.session.conversation_id


def test_invalidated_live_cli_cannot_leave_recreated_raw_history(tmp_path, transport):
    executor = ClaudeSDKExecutor(Model())
    result = executor.execute(request(tmp_path))
    executor.invalidate(tmp_path / 'alice')
    # The subprocess may finish a buffered write after the management action.
    transcript = result.session.transcript()
    transcript.parent.mkdir(parents=True)
    transcript.write_text('synthetic-private-transcript')
    result.session.discard()
    assert not result.session.directory.exists()


def test_discard_does_not_remove_another_active_lease(tmp_path, transport):
    executor = ClaudeSDKExecutor(Model())
    result = executor.execute(request(tmp_path))
    marker = result.session.directory / 'pending.json'
    marker.write_text(json.dumps({'token': 'different-active-lease'}))
    result.session.discard()
    assert marker.exists()


def test_delete_conversation_is_owner_scoped_and_preserves_other_history(tmp_path, transport):
    executor = ClaudeSDKExecutor(Model())
    first = execute_and_commit(executor, request(tmp_path))
    same_owner = execute_and_commit(executor, request(tmp_path, 'another'))
    other_owner = execute_and_commit(executor, request(tmp_path, owner='bob'))
    # A mismatched identity never selects Alice's transcript even in her root.
    SDKSessionStore(tmp_path / 'alice').delete('bob', first.session.conversation_id)
    assert first.session.directory.exists()
    executor.delete_conversation(tmp_path / 'alice', 'alice', first.session.conversation_id)
    executor.delete_conversation(tmp_path / 'alice', 'alice', first.session.conversation_id)
    assert not first.session.directory.exists()
    assert same_owner.session.directory.exists()
    assert other_owner.session.directory.exists()


def test_delete_inflight_conversation_blocks_commit_and_cleans_late_write(tmp_path, transport):
    executor = ClaudeSDKExecutor(Model())
    pending = executor.execute(request(tmp_path))
    other = execute_and_commit(executor, request(tmp_path, 'other'))
    executor.delete_conversation(tmp_path / 'alice', 'alice', pending.session.conversation_id)
    transcript = pending.session.transcript()
    transcript.parent.mkdir(parents=True)
    transcript.write_text('synthetic-late-private-history')
    with pytest.raises(ModelError, match='已失效'):
        pending.session.commit(0)
    pending.session.discard()
    assert not pending.session.directory.exists()
    assert other.session.directory.exists()


@pytest.mark.parametrize('owner,cid', [('', 'cid'), ('alice', ''), (None, 'cid'), ('alice', None)])
def test_delete_requires_valid_identity(tmp_path, owner, cid):
    with pytest.raises(ValueError, match='有效用户和会话编号'):
        SDKSessionStore(tmp_path).delete(owner, cid)


def test_first_turn_preserves_application_assigned_conversation_id(tmp_path, transport):
    result = execute_and_commit(ClaudeSDKExecutor(Model()), request(tmp_path, 'client-assigned-id'))
    assert result.session.conversation_id == 'client-assigned-id'
    assert result.session.resume is None


def test_deleted_before_begin_cannot_create_native_history(tmp_path):
    store = SDKSessionStore(tmp_path / 'alice')
    store.delete('alice', 'not-started-yet')
    with pytest.raises(ModelError, match='对话已删除'):
        store.begin('alice', 'not-started-yet', 0, {})
    assert not store.root.exists()
    markers = list(store.revoked_root.glob('*.json'))
    assert len(markers) == 1
    assert set(json.loads(markers[0].read_text())) == {'revoked_at'}
    assert stat.S_IMODE(store.revoked_root.stat().st_mode) == 0o700
    assert stat.S_IMODE(markers[0].stat().st_mode) == 0o600


def test_deletion_revocation_survives_invalidate_and_process_restart(tmp_path, transport):
    executor = ClaudeSDKExecutor(Model())
    result = execute_and_commit(executor, request(tmp_path, 'persistently-deleted'))
    executor.delete_conversation(tmp_path / 'alice', 'alice', result.session.conversation_id)
    executor.invalidate(tmp_path / 'alice')
    with pytest.raises(ModelError, match='对话已删除'):
        SDKSessionStore(tmp_path / 'alice').begin('alice', result.session.conversation_id, 0, {})
    assert list((tmp_path / 'alice' / 'sdk-revoked').glob('*.json'))


def test_same_application_id_restarts_native_history_when_binding_changes(tmp_path, transport):
    executor = ClaudeSDKExecutor(Model())
    first = execute_and_commit(executor, request(tmp_path, 'stable-id'))
    next_req = request(tmp_path, 'stable-id', revision=1)
    next_req.context_binding['prompt'] = 'new-version'
    next_result = execute_and_commit(executor, next_req)
    assert next_result.session.conversation_id == 'stable-id'
    assert next_result.session.session_id != first.session.session_id
    assert next_result.session.history_reset and next_result.session.resume is None
