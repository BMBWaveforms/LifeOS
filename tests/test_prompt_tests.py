import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.errors import ModelError
from backend.executors import ExecutionResult, SESSION_RULES
from backend.completion import _messages
from backend.memory_selection import estimate_tokens
from backend.prompt_tests import EXAMPLES, PromptTests, STAGES
from backend.prompts import PromptRegistry, digest
from backend.store import Store


class Client:
    def __init__(self, response=None, configured=True):
        self.response = response
        self.configured = configured
        self.calls = []

    def ready(self):
        return {'configured': self.configured, 'model': 'synthetic-test-model'}

    def complete(self, messages, **kwargs):
        self.calls.append((copy.deepcopy(messages), kwargs))
        if isinstance(self.response, Exception):
            raise self.response
        return {'content': self.response if isinstance(self.response, str) else json.dumps(self.response, ensure_ascii=False)}


@pytest.fixture
def harness(tmp_path):
    store = Store(tmp_path / 'product')
    registry = PromptRegistry(tmp_path / 'product')
    client = Client()
    tests = PromptTests(tmp_path, store, client, registry)
    return tests, client, store, registry


def invoke(tests, module, **kwargs):
    return tests.run('alice', {'module': module, 'input': copy.deepcopy(EXAMPLES[module]), **kwargs})


def test_catalog_has_seven_current_versions_editable_content_examples_and_honest_boundaries(harness):
    tests, _, _, registry = harness
    catalog = tests.catalog('alice')
    assert {item['id'] for item in catalog['modules']} == set(EXAMPLES)
    for item in catalog['modules']:
        assert item['current_version_id'] == registry.snapshot()['versions'][item['id']]
        assert digest(item['current_prompt']['content']) == item['current_prompt']['sha256']
        assert item['input_example']
        assert item['production_boundary']
        assert any(version['active'] for version in item['versions'])
        assert item['tools'] == (['search_entries', 'get_entry'] if item['id'] == 'retrieval' else [])
    assert catalog['isolation']['quality_verdict'] == 'pending'
    catalog['modules'][0]['input_example']['query'] = 'changed copy'
    assert tests.catalog('alice')['modules'][0]['input_example']['query'] != 'changed copy'


GOOD_OUTPUTS = {
    'understanding': {'intent': '减少手机打断', 'explicit_facts': ['手机通知经常打断我'], 'unknowns': [], 'scope': 'guide'},
    'reply': {'status': 'answer', 'clarification': '', 'cards': [{'guide_id': '03-01', 'memory_ids': []}]},
    'memory': {'user_state': '改善了一点，但还没解决', 'state_evidence': '改善了一点，但还没解决',
               'problem': '手机通知打断', 'problem_status': 'unresolved', 'status_evidence': '',
               'followup_of': 'sample-memory', 'guide_ids': ['03-01']},
    'summary': {'summary': '关闭手机通知后略有改善，问题仍未解决。'},
    'home': {'followups': [{'memory_id': 'sample-memory'}]},
    'judge': {'assessments': {stage: {'verdict': 'pending', 'reason': '缺少该项直接观察证据。', 'evidence': []} for stage in STAGES}},
}


@pytest.mark.parametrize('module', list(GOOD_OUTPUTS))
def test_non_retrieval_modules_use_tool_free_fresh_task_and_do_not_write_product_memory(harness, module):
    tests, client, store, _ = harness
    before = copy.deepcopy(store.state('alice'))
    client.response = GOOD_OUTPUTS[module]
    record = invoke(tests, module)
    assert record['status'] == 'success'
    assert record['execution_status'] == 'succeeded'
    assert record['validation']['status'] == 'passed'
    assert record['quality_verdict'] == 'pending'
    assert record['model_call']['attempted'] and record['model_call']['succeeded']
    assert client.calls[0][1] == {'timeout': 75}  # No guide/system tools passed.
    assert record['prompt']['effective_content'] == client.calls[0][0][0]['content']
    assert record['prompt']['effective_sha256'] == digest(client.calls[0][0][0]['content'])
    assert record['model_input'] == json.loads(client.calls[0][0][1]['content'])
    assert record['transport_input'] == record['model_input']
    actual_system, actual_user = _messages(client.calls[0][0])
    assert record['transport_user_content'] == actual_user
    assert record['transport_user_sha256'] == digest(actual_user)
    assert record['input_budget']['estimated_tokens'] == estimate_tokens([
        {'role': 'system', 'content': actual_system}, {'role': 'user', 'content': actual_user}])
    assert store.state('alice') == before
    assert record['tools'] == []


def test_reply_hydrates_fixed_ids_from_authoritative_guide_without_claiming_new_tool_reads(harness):
    tests, client, store, _ = harness
    client.response = GOOD_OUTPUTS['reply']
    result = invoke(tests, 'reply')
    model_input = json.loads(client.calls[0][0][1]['content'])
    assert model_input['guides'] == [store.entries['03-01']]
    assert result['tools'] == []
    assert '不测试检索' in result['production_boundary']


def test_summary_checks_do_not_claim_fact_or_source_validation(harness):
    tests, client, _, _ = harness
    # This intentionally unfaithful content satisfies the structural contract;
    # it must stay pending for semantic review, without claiming source checks.
    client.response = {'summary': '用户已确定明天购买一座城堡。'}
    result = invoke(tests, 'summary')
    assert result['status'] == 'success'
    assert result['quality_verdict'] == 'pending'
    assert result['validation']['checks'] == ['摘要字段与150字长度限制通过', '本环节未自动验证事实忠实度或遗漏情况，需人工复核']
    assert not any('来源/ID/状态约束通过' in check for check in result['validation']['checks'])


def test_judge_checks_only_claim_schema_and_evidence_key_validation(harness):
    tests, client, _, _ = harness
    client.response = GOOD_OUTPUTS['judge']
    result = invoke(tests, 'judge')
    assert '不代表判定结论正确' in result['validation']['checks'][-1]
    assert result['quality_verdict'] == 'pending'


def test_current_saved_version_and_draft_preserve_exact_prompt_without_activating(harness):
    tests, client, _, registry = harness
    client.response = GOOD_OUTPUTS['summary']
    original = registry.active_id()
    current = invoke(tests, 'summary', prompt_mode='current')
    saved = registry.save('alice', {'module': 'summary', 'content': '只整理用户明确表达的内容。'})
    version = invoke(tests, 'summary', prompt_mode='version', version_id=saved['id'])
    draft = invoke(tests, 'summary', prompt_mode='draft', prompt=' 草稿保留首尾空格。 ')
    assert current['prompt']['version_id'] != saved['id']
    assert version['prompt']['version_id'] == saved['id']
    assert draft['prompt']['content'] == ' 草稿保留首尾空格。 '
    assert draft['prompt']['sha256'] == digest(' 草稿保留首尾空格。 ')
    assert draft['prompt']['version_id'] == ''
    assert registry.active_id() == original
    assert len(registry.catalog()['versions']) == 8  # No silent draft save.


def test_wrong_module_version_is_rejected_before_any_model_call(harness):
    tests, client, _, registry = harness
    wrong = registry.snapshot()['versions']['home']
    with pytest.raises(ValueError, match='不属于'):
        invoke(tests, 'summary', prompt_mode='version', version_id=wrong)
    assert client.calls == []


def test_current_mode_rejects_version_changed_since_ui_loaded(harness):
    tests, client, _, registry = harness
    snapshot = registry.snapshot()
    displayed = snapshot['versions']['summary']
    saved = registry.save('bob', {'module': 'summary', 'content': '新的摘要规则'})
    versions = {**snapshot['versions'], 'summary': saved['id']}
    bundle = registry.create_bundle('bob', {'name': '新的产品组合', 'versions': versions})
    registry.activate('bob', {'bundle_id': bundle['id'], 'expected_active': snapshot['id'], 'note': '合成并行更新'})
    with pytest.raises(ValueError, match='当前版本已变更'):
        invoke(tests, 'summary', prompt_mode='current', version_id=displayed)
    assert client.calls == []
    client.response = GOOD_OUTPUTS['summary']
    record = invoke(tests, 'summary', prompt_mode='version', version_id=displayed)
    assert record['prompt']['version_id'] == displayed  # Explicit old version remains testable.


def test_input_failure_is_retained_with_no_fake_model_success(harness):
    tests, client, _, _ = harness
    result = tests.run('alice', {'module': 'understanding', 'input': {'query': ''}})
    assert result['status'] == 'failed'
    assert result['execution_status'] == 'not_started'
    assert result['validation']['stage'] == 'input'
    assert result['model_call']['attempted'] is False
    assert tests.result('alice', result['id']) == result
    assert client.calls == []


def test_history_detail_and_restart_are_owner_scoped(harness, tmp_path):
    tests, client, store, registry = harness
    client.response = GOOD_OUTPUTS['summary']
    result = invoke(tests, 'summary')
    history = tests.history('alice')['runs']
    assert history[0]['id'] == result['id']
    assert history[0]['prompt']['sha256'] == result['prompt']['sha256']
    assert 'content' not in history[0]['prompt']
    assert tests.history('bob')['runs'] == []
    with pytest.raises(PermissionError):
        tests.result('bob', result['id'])
    reopened = PromptTests(tmp_path, store, client, registry)
    assert reopened.result('alice', result['id']) == result
    with pytest.raises(ValueError):
        tests.result('alice', '../results.sqlite')


def test_missing_model_configuration_is_not_a_successful_test(harness):
    tests, client, _, _ = harness
    client.configured = False
    result = invoke(tests, 'summary')
    assert result['status'] == 'failed'
    assert result['model_call']['attempted'] is False
    assert result['model_call']['succeeded'] is False
    assert result['validation']['status'] == 'not_run'
    assert client.calls == []


def test_provider_failure_preserves_structured_status_but_no_private_error_text(harness):
    tests, client, _, _ = harness
    client.response = ModelError('Authorization: synthetic-secret-key', http_status=402)
    result = invoke(tests, 'home')
    assert result['status'] == 'failed'
    assert result['execution_status'] == 'failed'
    assert result['model_call']['attempted'] is True
    assert result['model_call']['succeeded'] is False
    assert result['model_call']['provider_http_status'] == 402
    assert 'synthetic-secret' not in json.dumps(result)
    assert tests.result('alice', result['id']) == result


@pytest.mark.parametrize('output', ['not JSON', {'summary': ''}, {'summary': '长' * 151}, {'summary': '短摘要', 'extra': '不符合契约'}])
def test_output_contract_failure_is_saved_separately_from_successful_model_call(harness, output):
    tests, client, _, _ = harness
    client.response = output
    record = invoke(tests, 'summary')
    assert record['status'] == 'failed'
    assert record['execution_status'] == 'succeeded'
    assert record['model_call']['succeeded'] is True
    assert record['validation']['status'] == 'failed'
    assert record['validation']['stage'] == 'validation'
    assert record['output']['raw']


def test_private_thinking_is_never_saved_in_raw_or_parsed_final_output(harness):
    tests, client, _, _ = harness
    client.response = '<think>synthetic-private-chain</think>' + json.dumps({
        'summary': '明确的摘要', 'reasoning_content': 'synthetic-private-chain'})
    record = invoke(tests, 'summary')
    assert record['status'] == 'success'
    assert record['output']['sanitized'] is True
    assert 'synthetic-private-chain' not in json.dumps(record)
    client.response = '<think>synthetic-unclosed-chain'
    record = invoke(tests, 'summary')
    assert record['status'] == 'failed'
    assert 'synthetic-unclosed-chain' not in json.dumps(record)


@pytest.mark.parametrize('raw', [
    '{"summary":"摘要","reasoning_content":"synthetic-private-malformed',
    '<THINK>synthetic-private-malformed',
    '<thinking>synthetic-private-malformed</thinking>{"summary":"摘要"}',
    'reasoning_content: synthetic-private-malformed',
])
def test_malformed_private_thinking_is_not_saved(harness, raw):
    tests, client, _, _ = harness
    client.response = raw
    result = invoke(tests, 'summary')
    assert 'synthetic-private-malformed' not in json.dumps(result, ensure_ascii=False)


@pytest.mark.parametrize('module,output', [
    ('understanding', {'intent': '理解', 'explicit_facts': ['我确诊了抑郁症'], 'unknowns': [], 'scope': 'guide'}),
    ('reply', {'status': 'answer', 'clarification': '', 'cards': [{'guide_id': '15-01', 'memory_ids': []}]}),
    ('home', {'followups': [{'memory_id': 'invented'}]}),
    ('judge', {'assessments': {stage: {'verdict': 'pass', 'reason': '通过', 'evidence': ['invented']} for stage in STAGES}}),
])
def test_invented_facts_guide_ids_home_candidates_and_judge_evidence_fail(harness, module, output):
    tests, client, _, _ = harness
    client.response = output
    result = invoke(tests, module)
    assert result['status'] == 'failed'
    assert result['validation']['status'] == 'failed'


def test_memory_cannot_mark_unresolved_feedback_resolved_or_add_unconsulted_guides(harness):
    tests, client, _, _ = harness
    client.response = {**GOOD_OUTPUTS['memory'], 'problem_status': 'resolved', 'status_evidence': '但还没解决'}
    assert invoke(tests, 'memory')['status'] == 'failed'
    client.response = {**GOOD_OUTPUTS['memory'], 'guide_ids': ['15-01']}
    assert invoke(tests, 'memory')['status'] == 'failed'


def test_input_private_keys_unknown_fields_and_excessive_budget_are_rejected_before_transport(harness):
    tests, client, _, _ = harness
    result = tests.run('alice', {'module': 'understanding', 'input': {'query': '你好', 'thinking': 'private'}})
    assert result['status'] == 'failed' and result['input'] is None
    result = tests.run('alice', {'module': 'understanding', 'input': {'query': '你好', 'unknown': True}})
    assert result['status'] == 'failed'
    result = invoke(tests, 'summary', prompt_mode='draft', prompt='很长的提示词' * 3500)
    assert result['status'] == 'failed'
    assert '20000' in result['message']
    assert client.calls == []


class RetrievalExecutor:
    def __init__(self, search=True, read=True, unauthorized=False):
        self.search, self.read, self.unauthorized = search, read, unauthorized
        self.requests = []
        self.sessions = []

    def execute(self, request):
        self.requests.append(request)
        assert {item['function']['name'] for item in request.tools.definitions} == {'search_entries', 'get_entry'}
        assert request.tools.store.state(request.owner)['memories'] == []
        assert request.tools.store.state(request.owner)['enabled'] is False
        if self.unauthorized:
            request.tools.invoke('Bash', {'command': 'must not execute'})
        if self.search:
            request.tools.invoke('search_entries', {'query': '手机通知'})
        if self.read:
            guide = request.tools.invoke('get_entry', {'guide_id': '03-01'})
            assert guide['complete'] and guide['full_text']
        session = SimpleNamespace(discarded=False, committed=False)
        session.discard = lambda: setattr(session, 'discarded', True)
        self.sessions.append(session)
        return ExecutionResult(json.dumps({'guide_ids': ['03-01'], 'missing_conditions': []}), {}, session)


def test_retrieval_uses_actual_read_only_guide_tools_fresh_temp_store_and_no_resume(harness):
    tests, client, store, _ = harness
    executor = RetrievalExecutor()
    tests.executor = executor
    before = copy.deepcopy(store.state('alice'))
    first = invoke(tests, 'retrieval')
    second = invoke(tests, 'retrieval')
    assert first['status'] == second['status'] == 'success'
    assert [tool['tool'] for tool in first['tools']] == ['search_entries', 'get_entry']
    assert first['tools'][1]['output'] == store.entries['03-01']
    assert first['tools'][0]['output']['entries']
    assert first['tools'][1]['output_sha256'] == digest(json.dumps(store.entries['03-01'], ensure_ascii=False, sort_keys=True))
    assert len(first['guide_snapshot']['sha256']) == len(first['tools_contract_sha256']) == 64
    assert first['prompt']['effective_content'] == executor.requests[0].instruction + SESSION_RULES
    request_input = json.loads(executor.requests[0].messages[-1]['content'])
    actual_user = json.dumps({'current': request_input}, ensure_ascii=False)
    assert first['transport_input'] == {'current': first['model_input']}
    assert first['transport_user_content'] == actual_user
    assert first['transport_user_sha256'] == digest(actual_user)
    assert first['input_budget']['estimated_tokens'] == estimate_tokens([
        {'role': 'system', 'content': executor.requests[0].instruction + SESSION_RULES},
        {'role': 'user', 'content': actual_user}])
    assert executor.requests[0].conversation_id != executor.requests[1].conversation_id
    assert all(not Path(request.directory).exists() for request in executor.requests)
    assert all(session.discarded and not session.committed for session in executor.sessions)
    assert store.state('alice') == before
    assert client.calls == []


@pytest.mark.parametrize('options', [{'search': False}, {'read': False}, {'unauthorized': True}])
def test_retrieval_cannot_skip_search_full_read_or_use_system_tools(harness, options):
    tests, _, _, _ = harness
    tests.executor = RetrievalExecutor(**options)
    result = invoke(tests, 'retrieval')
    assert result['status'] == 'failed'
    assert tests.result('alice', result['id']) == result


def test_non_retrieval_transport_cannot_return_tool_calls(harness):
    tests, client, _, _ = harness
    client.complete = lambda *args, **kwargs: {'content': '{}', 'tool_calls': [{'name': 'Bash'}]}
    record = invoke(tests, 'home')
    assert record['status'] == 'failed'
    assert record['validation']['errors'] == ['无工具环节返回了未授权工具调用。']
