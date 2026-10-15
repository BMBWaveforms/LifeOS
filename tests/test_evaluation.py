import json
import pytest
from fastapi.testclient import TestClient
from backend.main import create_app
from backend.prompts import PromptRegistry
from backend.evaluation import Evaluation, STAGES, assess_case, validate_case
from backend.executors import ExecutionResult
from backend.errors import ModelError
from test_workbench import login


class ObservableExecutor:
    def __init__(self):
        self.requests = []

    def execute(self, request):
        self.requests.append(request)
        context = json.loads(request.messages[-1]['content'])
        query = context['query']
        if '通知' in query and '解决' not in query:
            request.tools.invoke('get_entry', {'guide_id': '03-01'})
            result = {'status': 'answer', 'cards': [{'guide_id': '03-01'}]}
        else:
            result = {'status': 'acknowledged', 'cards': []}
        result['understanding'] = {'intent': query, 'explicit_facts': [], 'unknowns': [], 'scope': 'guide',
                                   'private_reasoning': 'must-not-be-stored'}
        return ExecutionResult(json.dumps(result), {'runtime': 'synthetic'})


class Organizer:
    judge_fail = False

    def ready(self):
        return {'configured': True, 'model': 'synthetic-only'}

    def complete(self, messages, **kwargs):
        data = json.loads(messages[-1]['content'])
        if 'evidence_map' in data:
            if self.judge_fail:
                raise ModelError('synthetic judge failure')
            refs = list(data['evidence_map'])[:1]
            output = {'assessments': {s: {'verdict': 'pass', 'reason': 'Synthetic evidence.', 'evidence': refs,
                                        'private_reasoning': 'judge-must-not-be-stored'} for s in STAGES}}
        elif 'query' in data:
            query, previous = data['query'], data['previous_memories']
            problem = '手机通知打断工作' if '通知' in query else ''
            resolved = '解决了' in query
            output = {'summary': query, 'user_state': '', 'state_evidence': '', 'problem': problem,
                      'problem_status': 'resolved' if resolved else 'unresolved' if problem else 'unknown',
                      'status_evidence': query if resolved else '',
                      'followup_of': previous[-1]['id'] if previous and problem else '',
                      'guide_ids': [g['guide_id'] for g in data['consulted_guides']]}
        else:
            output = {'followups': []}
        return {'content': json.dumps(output)}


@pytest.fixture
def env(tmp_path):
    model, executor = Organizer(), ObservableExecutor()
    app = create_app(tmp_path, model, {'claude-sdk': executor})
    app.state.evaluation.pool = None
    client = TestClient(app)
    login(client, tmp_path)
    return client, app, model, executor, tmp_path


def simple_case(**updates):
    case = {'title': 'synthetic', 'memory_enabled': False, 'steps': [{'kind': 'chat', 'query': '你好'}],
            'criteria': {}, 'rules': [{'stage': 'overall', 'type': 'status', 'value': 'acknowledged'}]}
    case.update(updates)
    return case


def save_set(client, cases=None):
    r = client.post('/api/eval/datasets', json={'name': 'synthetic set', 'cases': cases or [simple_case()]})
    assert r.status_code == 200, r.text
    return r.json()


def job(env, dataset, variants=None, run=True):
    client, app, *_ = env
    bid = app.state.registry.active_id()
    r = client.post('/api/eval/jobs', json={'dataset_id': dataset['id'], 'dataset_version': dataset['version'],
                                           'variants': variants or [{'runtime': 'claude-sdk', 'bundle_id': bid}]})
    assert r.status_code == 200, r.text
    jid = r.json()['id']
    if run:
        app.state.evaluation.execute_job('alice', jid)
    return client.get('/api/eval/jobs/'+jid).json()


def test_new_interfaces_require_login(tmp_path):
    c = TestClient(create_app(tmp_path, Organizer()))
    for path in ['/api/prompts', '/api/eval/datasets', '/api/eval/jobs']:
        assert c.get(path).status_code == 401


def test_dataset_versions_shared_and_optimistic(env):
    client, app, _, _, path = env
    original = save_set(client)
    bob = TestClient(app)
    login(bob, path, 'bob')
    assert bob.get('/api/eval/datasets/'+original['id']).json() == original
    updated = client.post('/api/eval/datasets', json={**original, 'expected_version': 1, 'name': 'new name'}).json()
    assert updated['version'] == 2
    assert client.get('/api/eval/datasets/'+original['id']+'?version=1').json()['name'] == 'synthetic set'
    assert client.post('/api/eval/datasets', json={**original, 'expected_version': 1}).status_code == 400


def test_archive_preserves_history_and_results(env):
    client, *_ = env
    dataset = save_set(client)
    assert client.post('/api/eval/archive', json={'id': dataset['id'], 'expected_version': 1}).status_code == 200
    assert dataset['id'] not in [d['id'] for d in client.get('/api/eval/datasets').json()['datasets']]
    assert client.get('/api/eval/datasets/'+dataset['id']).json()['cases']


def test_prompt_edit_bundle_test_activation_and_rollback_are_separate(env):
    client, app, *_ = env
    registry = app.state.registry
    old = registry.snapshot()
    parent = old['versions']['reply']
    content = registry.version(parent)['content'] + '\nSynthetic revision.'
    new = client.post('/api/prompts/versions', json={'module': 'reply', 'parent': parent, 'content': content, 'note': 'test'}).json()
    assert registry.active_id() == old['id']
    assert registry.version(parent)['content'] != new['content']
    versions = {**old['versions'], 'reply': new['id']}
    bundle = client.post('/api/prompts/bundles', json={'name': 'candidate', 'versions': versions}).json()
    activate = {'bundle_id': bundle['id'], 'expected_active': old['id'], 'note': 'test deployment'}
    assert client.post('/api/prompts/activate', json=activate).status_code == 400
    result = job(env, save_set(client), [{'runtime': 'claude-sdk', 'bundle_id': bundle['id']}])
    assert result['status'] == 'completed'
    assert client.post('/api/prompts/activate', json=activate).status_code == 200
    assert registry.active_id() == bundle['id']
    next_request = client.post('/api/run', json={'runtime':'claude-sdk','query':'你好'}).json()
    assert next_request['prompt_bundle_id'] == bundle['id']
    assert client.post('/api/prompts/activate', json=activate).status_code == 400
    assert client.post('/api/prompts/activate', json={'bundle_id': old['id'], 'expected_active': bundle['id'], 'note': 'rollback'}).status_code == 200
    assert registry.active_id() == old['id']
    restored = client.post('/api/run', json={'runtime':'claude-sdk','query':'你好'}).json()
    assert restored['prompt_bundle_id'] == old['id']
    assert 'Synthetic revision.' in client.post('/api/prompts/diff', json={'left': parent, 'right': new['id']}).json()['diff']


def test_prompt_documents_export_import_preserves_content_not_ids(env):
    client, app, *_ = env
    original = app.state.registry.snapshot()
    imported = client.post('/api/prompts/import', json=original).json()
    copy = client.get('/api/prompts/bundles/'+imported['id']).json()
    assert imported['id'] != original['id']
    for module in original['documents']:
        assert copy['documents'][module]['content'].strip() == original['documents'][module]['content'].strip()
    assert app.state.registry.active_id() == original['id']


def test_batch_pins_dataset_bundle_and_judge_versions(env):
    client, app, _, executor, _ = env
    dataset = save_set(client)
    initial = app.state.registry.snapshot()
    queued = job(env, dataset, run=False)
    client.post('/api/eval/datasets', json={**dataset, 'expected_version': 1, 'cases': [simple_case(steps=[{'kind':'chat','query':'different input'}])]})
    original_reply = initial['documents']['reply']
    changed = app.state.registry.save('alice', {'module':'reply','content':original_reply['content']+'\nChanged after submit.'})
    app.state.registry.create_bundle('alice', {'name':'later','versions':{**initial['versions'],'reply':changed['id']}})
    app.state.evaluation.execute_job('alice', queued['id'])
    done = client.get('/api/eval/jobs/'+queued['id']).json()
    assert done['snapshot']['dataset_version'] == 1
    assert done['snapshot']['judge']['id'] == initial['versions']['judge']
    assert 'Changed after submit.' not in executor.requests[-1].instruction
    assert json.loads(executor.requests[-1].messages[-1]['content'])['query'] == '你好'
    assert done['status'] == 'completed'


def test_batch_cases_and_ab_do_not_share_memory_or_product_state(env):
    client, app, _, executor, _ = env
    original = client.get('/api/memories').json()
    dataset = save_set(client, [simple_case(title='first',memory_enabled=True,steps=[{'kind':'chat','query':'我被手机通知打断'}],rules=[]),simple_case(title='second')])
    bid = app.state.registry.active_id()
    done = job(env, dataset, [{'runtime':'claude-sdk','bundle_id':bid},{'runtime':'claude-sdk','bundle_id':bid}])
    assert done['completed'] == 4 and done['status'] == 'completed'
    assert len({client.get('/api/eval/results/'+r['id']).json()['session_id'] for r in done['results']}) == 4
    for r in done['results']:
        record = client.get('/api/eval/results/'+r['id']).json()
        assert record['steps'][0]['memories_before']['memories'] == []
    assert client.get('/api/memories').json() == original
    assert client.get('/api/test-runs').json()['runs'] == []
    any_result = client.get('/api/eval/results/'+done['results'][0]['id']).json()
    assert client.post('/api/test-run',json={'session_id':any_result['session_id'],'runtime':'claude-sdk','query':'干扰评测'}).status_code == 401


def test_legacy_batch_sessions_are_retained_but_cannot_resume_as_free_tests(env):
    client,app,model,executor,path=env
    dataset=save_set(client)
    done=job(env,dataset,run=False)
    variant=done['snapshot']['variants'][0]
    record=app.state.evaluation.run_case(app.state.workbench,'alice',done['snapshot']['cases'][0],variant)
    sid=record['session_id']
    assert client.get('/api/test-runs').json()['runs']
    with app.state.evaluation.db() as db:
        db.execute('INSERT INTO evaluations VALUES (?,?,?,?,?,?,?,?)',('legacy-id',done['id'],'alice','legacy-case','A','pass',json.dumps(record),0))
    Evaluation(path,model,app.state.registry,{'claude-sdk':executor},start_workers=False)
    assert client.get('/api/test-runs').json()['runs']==[]
    assert client.post('/api/test-run',json={'session_id':sid,'runtime':'claude-sdk','query':'干扰评测'}).status_code==401
    with app.state.workbench.db() as db:
        assert db.execute('SELECT COUNT(*) FROM results WHERE session_id=?',(sid,)).fetchone()[0]==1


def test_five_observable_outputs_exclude_private_fields(env):
    client, *_ = env
    case = simple_case(memory_enabled=True, steps=[{'kind':'chat','query':'我被手机通知打断'}],rules=[])
    done = job(env, save_set(client,[case]))
    record = client.get('/api/eval/results/'+done['results'][0]['id']).json()
    observations = record['steps'][0]['observations']
    assert set(observations) == set(STAGES)-{'overall'}
    assert observations['memory']['status'] == observations['summary']['status'] == 'saved'
    assert observations['retrieval']['output'][0]['tool'] == 'get_entry'
    assert 'must-not-be-stored' not in json.dumps(record)


def test_multiturn_cross_conversation_resolution_and_deletion(env):
    client, app, _, executor, _ = env
    steps = [{'kind':'chat','query':'我被手机通知打断'}, {'kind':'new_conversation'},
             {'kind':'chat','query':'手机通知问题已经解决了'}, {'kind':'home'},
             {'kind':'memory','action':'clear','data':{}}, {'kind':'chat','query':'你好'}]
    rules = [{'stage':'overall','type':'status','value':'acknowledged','step':3},
             {'stage':'memory','type':'memory_contains','value':'resolved','step':3},
             {'stage':'memory','type':'memory_not_contains','value':'手机通知','step':6},
             {'stage':'overall','type':'followup_count','value':0,'step':4}]
    done = job(env, save_set(client,[simple_case(memory_enabled=True,steps=steps,rules=rules)]))
    record = client.get('/api/eval/results/'+done['results'][0]['id']).json()
    assert record['execution_status'] == 'success' and record['assessments']['overall']['verdict'] == 'pass'
    assert record['assessments']['memory']['verdict'] == 'pass'
    third_context = json.loads(executor.requests[1].messages[-1]['content'])
    assert third_context['memories']
    last = executor.requests[-1]
    assert len(last.messages) == 2 and not json.loads(last.messages[-1]['content'])['memories']


def test_human_review_is_audited_separately_and_private(env):
    client, app, _, _, path = env
    done = job(env, save_set(client))
    rid = done['results'][0]['id']
    assert client.post('/api/eval/results/'+rid+'/review', json={'stage':'overall','verdict':'fail','note':'人工发现遗漏'}).status_code == 200
    record = client.get('/api/eval/results/'+rid).json()
    assert record['assessments']['overall']['verdict'] == 'pass'
    assert record['latest_reviews']['overall']['verdict'] == 'fail'
    client.post('/api/eval/results/'+rid+'/review', json={'stage':'overall','verdict':'pass','note':'核对后通过'})
    assert len(client.get('/api/eval/results/'+rid).json()['reviews']) == 2
    bob = TestClient(app);login(bob,path,'bob')
    assert bob.get('/api/eval/jobs/'+done['id']).status_code == 401
    assert bob.get('/api/eval/results/'+rid).status_code == 401
    assert bob.post('/api/eval/results/'+rid+'/review',json={'stage':'overall','verdict':'pass','note':'bad'}).status_code == 401
    assert bob.get('/api/eval/jobs').json()['jobs'] == []


def test_judge_failure_and_missing_understanding_do_not_fake_pass(env):
    client, _, model, *_ = env
    model.judge_fail = True
    case = simple_case(criteria={'overall':'温和回应'},rules=[])
    done = job(env, save_set(client,[case]))
    record = client.get('/api/eval/results/'+done['results'][0]['id']).json()
    assert record['judge_status'] == 'error'
    assert record['assessments']['overall']['verdict'] == 'pending'
    model.judge_fail = False
    result = {'execution_status':'success','steps':[{'step':1,'input':{'kind':'chat'},'status':'success','memories_before':{},'memories_after':{}}]}
    assessment, _ = assess_case(model, {'content':'judge'}, validate_case(simple_case(criteria={'understanding':'看实际理解'},rules=[])), result)
    assert assessment['understanding']['verdict'] == 'pending'


def test_overall_is_not_average_of_five_stages_and_rule_fail_overrides_judge(env):
    client, *_ = env
    case=simple_case(criteria={'overall':'温和回应'},rules=[{'stage':'reply','type':'status','value':'unsupported'}])
    done=job(env,save_set(client,[case]));record=client.get('/api/eval/results/'+done['results'][0]['id']).json()
    assert record['assessments']['reply']['verdict']=='fail'
    assert record['assessments']['overall']['verdict']=='pass'


def test_cancel_rerun_snapshot_and_service_restart(env):
    client, app, model, executor, path = env
    dataset = save_set(client)
    queued = job(env, dataset, run=False)
    client.post('/api/eval/jobs/'+queued['id']+'/cancel',json={})
    app.state.evaluation.execute_job('alice',queued['id'])
    assert client.get('/api/eval/jobs/'+queued['id']).json()['status']=='cancelled'
    rerun=client.post('/api/eval/jobs/'+queued['id']+'/rerun',json={'failed_only':True}).json()
    assert rerun['snapshot']['rerun_of']==queued['id']
    assert rerun['snapshot']['cases']==queued['snapshot']['cases']
    restarted=Evaluation(path,model,app.state.registry,{'claude-sdk':executor},start_workers=False)
    assert restarted.job('alice',rerun['id'])['status']=='interrupted'


@pytest.mark.parametrize('case',[simple_case(steps=[]),simple_case(steps=[{'kind':'invalid'}]),
    simple_case(rules=[{'stage':'overall','type':'status','value':'answer','step':99}]),
    simple_case(memory_enabled='true'),simple_case(tags=['x']*13)])
def test_invalid_cases_rejected_before_batch(case):
    with pytest.raises(ValueError):validate_case(case)


def test_new_eval_body_limit_and_login_original_limit(env):
    client,*_=env
    assert client.post('/api/login',content='a'*20001).status_code==413
    assert client.post('/api/eval/datasets',content='a'*2000001).status_code==413
    case=simple_case(criteria={'overall':'x'*1900})
    assert client.post('/api/eval/datasets',json={'name':'large but valid','cases':[case]*15}).status_code==200


def test_manual_failure_is_included_in_retry_even_if_system_passed(env):
    client,*_=env
    done=job(env,save_set(client))
    rid=done['results'][0]['id']
    client.post('/api/eval/results/'+rid+'/review',json={'stage':'overall','verdict':'fail','note':'人工发现问题'})
    retry=client.post('/api/eval/jobs/'+done['id']+'/rerun',json={'failed_only':True})
    assert retry.status_code==200
    assert retry.json()['total']==1


def test_judge_extras_are_not_saved_and_rule_target_must_match(env):
    client,*_=env
    case=simple_case(criteria={'overall':'温和回应'},rules=[])
    done=job(env,save_set(client,[case]))
    record=client.get('/api/eval/results/'+done['results'][0]['id']).json()
    assert 'judge-must-not-be-stored' not in json.dumps(record)
    with pytest.raises(ValueError,match='不匹配'):
        validate_case(simple_case(rules=[{'stage':'overall','type':'followup_count','value':0}]))


def test_real_batch_configuration_is_read_once_and_not_serialized(monkeypatch):
    from backend.evaluation import FrozenClient
    from backend.model import ModelClient
    monkeypatch.setenv('AGENT_SDK_BASE_URL','https://api.deepseek.com/anthropic')
    class ChangingConfig(ModelClient):
        reads=0
        def config(self):
            self.reads+=1
            return 'synthetic-key-'+str(self.reads), 'https://api.deepseek.com/v1', 'synthetic-model'
    original=ChangingConfig()
    frozen=FrozenClient(original)
    assert original.reads==1
    assert frozen.config()[0]==frozen.sdk_config()[0]
    assert 'synthetic-key' not in json.dumps(frozen.ready())


def test_insufficient_balance_stops_batch_and_never_runs_judge(env):
    client,app,model,*_=env
    calls=[]
    def unavailable(*args,**kwargs):
        calls.append(args)
        raise ModelError('模型接口返回 HTTP 402。',http_status=402)
    model.complete=unavailable
    first=simple_case(memory_enabled=True,steps=[{'kind':'chat','query':'你好'},{'kind':'chat','query':'谢谢'}],criteria={'overall':'温和回应'},rules=[])
    dataset=save_set(client,[first,simple_case(title='second')])
    done=job(env,dataset)
    assert done['status']=='interrupted' and done['completed']==1
    record=client.get('/api/eval/results/'+done['results'][0]['id']).json()
    assert record['dependency_http_status']==402
    assert record['judge_status']=='unavailable'
    assert len(record['steps'])==1 and len(calls)==1


def test_contract_documents_are_frozen_in_bundle(env,monkeypatch):
    from backend import prompts
    _,app,*_=env
    registry=app.state.registry
    original=registry.snapshot()
    before=registry.resolve(original,'chat')
    monkeypatch.setattr(prompts,'load_contracts',lambda:{'chat':'synthetic new contract','summary':'synthetic summary contract'})
    new=registry.create_bundle('alice',{'name':'new contract','versions':original['versions']})
    assert registry.resolve(registry.snapshot(original['id']),'chat')==before
    assert registry.snapshot(new['id'])['contracts']['chat']=='synthetic new contract'


def test_new_jobs_reject_native_and_legacy_snapshots_remain_readable(env):
    client, app, _, executor, _ = env
    dataset = save_set(client)
    rejected = client.post('/api/eval/jobs', json={'dataset_id': dataset['id'],
        'variants': [{'runtime': 'native', 'bundle_id': app.state.registry.active_id()}]})
    assert rejected.status_code == 400
    queued = job(env, dataset, run=False)
    spec = queued['snapshot']
    spec['variants'][0]['runtime'] = 'native'
    with app.state.evaluation.db() as db:
        db.execute('UPDATE jobs SET spec=?, status=? WHERE id=?', (json.dumps(spec), 'interrupted', queued['id']))
    original = client.get('/api/eval/jobs/'+queued['id']).json()
    assert original['snapshot'] == spec
    assert client.get('/api/eval/jobs/'+queued['id']+'/export').status_code == 200
    retry = client.post('/api/eval/jobs/'+queued['id']+'/rerun', json={})
    assert retry.status_code == 400 and '停用' in retry.json()['message']
    app.state.evaluation.execute_job('alice', queued['id'])
    assert client.get('/api/eval/jobs/'+queued['id']).json()['status'] == 'interrupted'
    assert client.get('/api/eval/jobs/'+queued['id']).json()['snapshot'] == spec
    assert not executor.requests


def test_ab_compares_prompt_bundles_with_sdk_only(env):
    client, app, _, executor, _ = env
    first = app.state.registry.snapshot()
    revision = app.state.registry.save('alice', {'module': 'reply',
        'content': first['documents']['reply']['content']+'\nSynthetic SDK variant B.'})
    second = app.state.registry.create_bundle('alice', {'name': 'SDK variant B',
        'versions': {**first['versions'], 'reply': revision['id']}})
    done = job(env, save_set(client), [{'bundle_id': first['id']}, {'bundle_id': second['id']}])
    assert done['status'] == 'completed' and done['completed'] == 2
    assert {v['runtime'] for v in done['variants']} == {'claude-sdk'}
    assert len(executor.requests) == 2
    assert 'Synthetic SDK variant B.' not in executor.requests[0].instruction
    assert 'Synthetic SDK variant B.' in executor.requests[1].instruction
