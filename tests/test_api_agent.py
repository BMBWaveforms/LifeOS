import json
import tempfile
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from backend.main import create_app
from backend.model import AgentService, ModelClient, ModelError
from backend.executors import ExecutionResult
from backend.store import Store

class FakeModel:
    def __init__(self, responses):
        self.responses = list(responses)
        self.inputs = []
        self.sessions = {}
    def ready(self): return {'configured': True, 'model': 'test-only'}
    def complete(self, messages, **kwargs):
        self.inputs.append(messages)
        result = self.responses.pop(0)
        if isinstance(result, Exception): raise result
        return result

class ScriptedSDKExecutor:
    """Offline business-test transport; production has no native executor."""
    name = 'claude-sdk'

    def __init__(self, client):
        self.client = client

    def invalidate(self, directory):
        prefix = str(directory)
        self.client.invalidated = True
        self.client.sessions = {key: value for key, value in self.client.sessions.items() if key[0] != prefix}

    def execute(self, request):
        import secrets
        cid = request.conversation_id
        key = (str(request.directory), cid)
        previous = self.client.sessions.get(key)
        if previous and (previous['revision'] != request.memory_revision or previous['binding'] != request.context_binding):
            previous = None
        executor = self
        class Session:
            conversation_id = cid
            committed = False
            def ensure_active(self):
                pass
            def commit(self, revision):
                executor.client.sessions[(str(request.directory), cid)] = {'revision': revision, 'binding': request.context_binding}
                self.committed = True
            def discard(self):
                if not self.committed:
                    executor.client.sessions.pop((str(request.directory), cid), None)
        messages = list(request.messages)
        for turn in range(7):
            message = self.client.complete(messages, tools=request.tools.definitions)
            calls = message.get('tool_calls') or []
            if not calls:
                return ExecutionResult(message.get('content') or '', {'session_resumed': bool(previous)}, session=Session())
            if len(calls) > 12 or request.tools.calls + len(calls) > 24:
                raise ModelError('指南工具调用达到上限。')
            messages.append({k: v for k, v in message.items() if k in ('role', 'content', 'tool_calls')})
            for call in calls:
                function = call['function']
                output = request.tools.invoke(function['name'], json.loads(function['arguments']))
                messages.append({'role': 'tool', 'tool_call_id': call['id'], 'content': json.dumps(output, ensure_ascii=False)})
        raise ModelError('指南检索达到轮次上限，请重试。')


def agent_service(store, client):
    return AgentService(store, client, {'claude-sdk': ScriptedSDKExecutor(client)})


def text(value): return {'role': 'assistant', 'content': json.dumps(value, ensure_ascii=False)}
def read_call(gid='03-01', name='get_entry'):
    return {'role': 'assistant', 'content': '', 'tool_calls': [{'id': 'tool1','type':'function','function':{'name':name,'arguments':json.dumps({'guide_id':gid})}}]}
def summary():
    return text({'summary':'用户工作时被手机通知打断，咨询了减少通知的指南。','user_state':'工作时被手机通知打断','state_evidence':'被手机通知打断','problem':'手机通知打断工作','problem_status':'unresolved','status_evidence':'','followup_of':'','guide_ids':['03-01']})

@pytest.fixture
def s(tmp_path):
    store = Store(tmp_path)
    store.change('alice','settings',{'enabled':True})
    return store

def test_complete_agent_has_real_read_then_summary(s):
    client=FakeModel([read_call(),text({'status':'answer','cards':[{'guide_id':'03-01','memory_ids':[]}]}),summary()])
    result=agent_service(s,client).chat('alice',{'query':'我工作时被手机通知打断，怎么办？'})
    assert result['summary']['saved'] and result['tool_calls']==1
    assert s.state('alice')['effective'][0]['guide_ids']==['03-01']
    assert 'full_text' in json.loads(client.inputs[1][-1]['content'])

def test_model_cannot_skip_read(s):
    client=FakeModel([text({'status':'answer','cards':[{'guide_id':'03-01'}]})])
    with pytest.raises(ValueError,match='全文回读'):agent_service(s,client).chat('alice',{'query':'手机通知'})
    assert not s.state('alice')['memories']


def test_selected_situation_uses_snapshot_metadata_and_still_reads_full_entry(s):
    query = '我被手机通知打断，先看看这个情境'
    client = FakeModel([read_call(), text({'status': 'answer', 'cards': [{'guide_id': '03-01'}]}), summary()])
    result = agent_service(s, client).chat('alice', {
        'query': query, 'guide_id': '03-01', 'title': '客户端伪造标题', 'source_url': 'https://example.invalid'},
        include_trace=True)
    current = json.loads(client.inputs[0][1]['content'])
    assert current['query'] == query
    assert current['selected_guide'] == {'guide_id': '03-01', 'title': s.entries['03-01']['title'], 'user_selected': True}
    assert current['candidate_titles'][0]['guide_id'] == '03-01'
    assert sum(c['guide_id'] == '03-01' for c in current['candidate_titles']) == 1
    assert '客户端伪造标题' not in json.dumps(current, ensure_ascii=False)
    assert 'example.invalid' not in json.dumps(current)
    assert result['trace'][0]['tool'] == 'get_entry' and result['trace'][0]['output']['complete']
    assert result['summary']['saved']


def test_selected_situation_does_not_count_as_full_read(s):
    client = FakeModel([text({'status': 'answer', 'cards': [{'guide_id': '03-01'}]})])
    with pytest.raises(ValueError, match='全文回读'):
        agent_service(s, client).chat('alice', {'query': '我想了解这个情境', 'guide_id': '03-01'})
    assert not s.state('alice')['memories']


def test_selected_situation_is_only_a_candidate_and_not_carried_to_next_turn(s):
    s.change('alice', 'settings', {'enabled': False})
    client = FakeModel([text({'status': 'clarification', 'clarification': '想咨询哪方面？', 'cards': []}),
                        text({'status': 'acknowledged', 'cards': []})])
    service = agent_service(s, client)
    first = service.chat('alice', {'query': '我想问别的问题', 'guide_id': '03-01'})
    assert first['result']['status'] == 'clarification' and first['result']['cards'] == []
    service.chat('alice', {'query': '谢谢', 'conversation_id': first['conversation_id']})
    assert json.loads(client.inputs[1][-1]['content'])['selected_guide'] is None


@pytest.mark.parametrize('guide_id', ['missing-guide', 3, False, [], {}])
def test_invalid_selected_situation_returns_400_before_model_call(tmp_path, guide_id):
    model = FakeModel([])
    app = create_app(tmp_path, model)
    client = TestClient(app)
    credentials = json.loads((tmp_path / 'login.json').read_text())
    client.post('/api/login', json={'username': 'alice', 'password': credentials['alice']['password']})
    response = client.post('/api/run', json={'mode': 'chat', 'query': '咨询所选情境', 'guide_id': guide_id})
    assert response.status_code == 400 and '所选情境指南' in response.json()['message']
    assert not model.inputs and not app.state.store.runs

def test_unauthorized_tool_rejected(s):
    client=FakeModel([read_call(name='delete_memory')])
    with pytest.raises(ModelError,match='未授权工具'):agent_service(s,client).chat('alice',{'query':'手机通知'})

def test_summary_failure_is_visible(s):
    client=FakeModel([text({'status':'clarification','clarification':'主要被什么打断？','cards':[]}),ModelError('test')])
    result=agent_service(s,client).chat('alice',{'query':'工作很烦'})
    assert not result['summary']['saved']
    assert '失败' in result['markdown'] and not s.state('alice')['memories']

def test_disabled_memory_does_not_call_summarizer(s):
    s.change('alice','settings',{'enabled':False})
    client=FakeModel([text({'status':'acknowledged','cards':[]})])
    result=agent_service(s,client).chat('alice',{'query':'谢谢'})
    assert not result['summary']['saved'] and len(client.inputs)==1

def test_tool_iteration_limit(s):
    client=FakeModel([read_call() for _ in range(7)])
    with pytest.raises(ModelError,match='轮次上限'):agent_service(s,client).chat('alice',{'query':'手机通知'})
    assert not s.state('alice')['memories']

def test_local_config_is_not_executed(tmp_path,monkeypatch):
    from backend import config
    fake=tmp_path/'backend/config.py';fake.parent.mkdir();fake.write_text('')
    monkeypatch.setattr(config,'__file__',str(fake))
    (tmp_path/'.env').write_text('MODEL_NAME=$(touch /tmp/should-not-exist)\n')
    monkeypatch.delenv('MODEL_NAME',raising=False)
    config.load_local_env()
    import os
    assert os.environ['MODEL_NAME']=='$(touch /tmp/should-not-exist)'
    monkeypatch.delenv('MODEL_NAME')

def test_key_compatibility_and_redacted_status(tmp_path,monkeypatch):
    path=tmp_path/'api.json';path.write_text(json.dumps({'apikey':'synthetic-key','model':'custom-model'}))
    monkeypatch.setenv('API_CONFIG_FILE',str(path))
    monkeypatch.delenv('MODEL_API_KEY',raising=False)
    c=ModelClient()
    assert c.config()[0]=='synthetic-key'
    assert 'synthetic-key' not in json.dumps(c.ready())

def test_credentials_require_https(tmp_path,monkeypatch):
    path=tmp_path/'api.json';path.write_text(json.dumps({'apikey':'fake','base_url':'http://example.com'}))
    monkeypatch.setenv('API_CONFIG_FILE',str(path));monkeypatch.delenv('MODEL_BASE_URL',raising=False)
    with pytest.raises(ModelError,match='HTTPS'):ModelClient().config()

def test_login_isolation_and_cookie(tmp_path):
    app=create_app(tmp_path,FakeModel([]));creds=json.loads((tmp_path/'login.json').read_text())
    a=TestClient(app);b=TestClient(app)
    assert a.get('/api/memories').status_code==401
    assert a.post('/api/login',json={'username':'alice','password':'incorrect'}).status_code==401
    response=a.post('/api/login',json={'username':'alice','password':creds['alice']['password']})
    assert response.status_code==200 and 'HttpOnly' in response.headers['set-cookie']
    assert 'token' not in response.text
    b.post('/api/login',json={'username':'bob','password':creds['bob']['password']})
    assert a.post('/api/memory-action',json={'action':'settings','enabled':False}).status_code==400
    assert b.get('/api/memories').json()['enabled']
    a.post('/api/logout',json={});assert a.get('/api/memories').status_code==401

def test_csrf_origin_and_body_limit(tmp_path):
    c=TestClient(create_app(tmp_path,FakeModel([])))
    assert c.post('/api/login',json={},headers={'Origin':'https://attacker.example'}).status_code==403
    assert c.post('/api/login',content='a'*20001).status_code==413

def test_frontend_not_served_from_backend(tmp_path):
    c=TestClient(create_app(tmp_path,FakeModel([])))
    assert c.get('/').status_code==404
    assert c.get('/api/demo-profiles').status_code==404
    assert c.post('/api/summary',json={}).status_code==404


def test_deleted_memory_is_not_reintroduced_from_conversation(s):
    fake=FakeModel([read_call(),text({'status':'answer','cards':[{'guide_id':'03-01'}]}),summary()])
    service=agent_service(s,fake)
    first=service.chat('alice',{'query':'我被手机通知打断'})
    mid=first['summary']['memory_id']
    s.change('alice','delete',{'id':mid})
    fake.responses=[text({'status':'acknowledged','cards':[]}),text({'summary':'用户打了招呼。','user_state':'','state_evidence':'','problem':'','problem_status':'unknown','status_evidence':'','followup_of':'','guide_ids':[]})]
    second=service.chat('alice',{'query':'你好','conversation_id':first['conversation_id']})
    assert second['conversation_id']==first['conversation_id']
    assert '手机通知' not in json.dumps(fake.inputs[-2],ensure_ascii=False)


def test_home_uses_current_status_and_explicit_memory_id(s):
    model=FakeModel([read_call(),text({'status':'answer','cards':[{'guide_id':'03-01'}]}),summary()])
    service=agent_service(s,model)
    first=service.chat('alice',{'query':'我被手机通知打断'})
    mid=first['summary']['memory_id']
    with s.db() as db:
        db.execute("UPDATE memory_summaries SET status_evidence='这个问题已经解决了' WHERE memory_id=?",(mid,))
    s.change('alice','correct_summary',{'id':mid,'text':'问题尚未解决','problem_status':'unresolved'})
    memory=s.state('alice')['effective'][0]
    assert memory['status_evidence']==''
    model.responses=[text({'followups':[{'memory_id':mid}]})]
    result=service.home('alice')
    assert result['result']['followups'][0]['memory_id']==mid
    provided=json.loads(model.inputs[-1][1]['content'])['followups'][0]
    assert provided['memory_id']==mid and provided['problem_status']=='unresolved'
    assert 'status_evidence' not in provided and 'summary' not in provided


def test_followup_rolls_summary_id_for_two_turns_then_resolved_leaves_home(s):
    model = FakeModel([read_call(), text({'status': 'answer', 'cards': [{'guide_id': '03-01'}]}), summary()])
    service = agent_service(s, model)
    first = service.chat('alice', {'query': '我被手机通知打断', 'guide_id': '03-01'})
    original_id = first['summary']['memory_id']
    model.responses = [text({'followups': [{'memory_id': original_id}]})]
    assert service.home('alice')['result']['followups'][0]['memory_id'] == original_id

    model.responses = [read_call(), text({'status': 'answer', 'cards': [{'guide_id': '03-01'}]}),
        text({'summary': '问题尚未解决，用户继续咨询。', 'user_state': '', 'state_evidence': '',
              'problem': '', 'problem_status': 'unresolved', 'status_evidence': '', 'followup_of': '', 'guide_ids': []})]
    continued = service.chat('alice', {'query': '这个问题还没解决，需要继续咨询',
        'conversation_id': first['conversation_id'], 'followup_memory_id': original_id})
    continued_id = continued['summary']['memory_id']
    assert continued['summary']['saved'] and continued_id != original_id
    assert continued['conversation_id'] == first['conversation_id']
    model.responses = [text({'followups': [{'memory_id': continued_id}]})]
    assert service.home('alice')['result']['followups'][0]['memory_id'] == continued_id

    model.responses = [text({'status': 'acknowledged', 'cards': []}),
        text({'summary': '用户明确反馈该问题已经解决。', 'user_state': '', 'state_evidence': '',
              'problem': '', 'problem_status': 'resolved', 'status_evidence': '已经解决了',
              'followup_of': '', 'guide_ids': []})]
    resolved = service.chat('alice', {'query': '这个问题已经解决了',
        'conversation_id': continued['conversation_id'], 'followup_memory_id': continued_id})
    resolved_id = resolved['summary']['memory_id']
    assert resolved['summary']['saved'] and resolved_id != continued_id
    memories = {m['id']: m for m in s.state('alice')['memories']}
    assert memories[original_id]['state'] == memories[continued_id]['state'] == 'superseded'
    assert memories[continued_id]['followup_of'] == original_id
    assert memories[resolved_id]['followup_of'] == continued_id
    assert memories[resolved_id]['problem_status'] == 'resolved'
    assert memories[resolved_id]['guide_ids'] == ['03-01']
    assert service.home('alice')['result']['followups'] == []
    assert not model.responses


def test_private_conversation_delete_is_authenticated_owner_scoped_and_keeps_memories(tmp_path):
    from backend.sdk_sessions import SDKSessionStore
    from uuid import uuid4
    app = create_app(tmp_path, FakeModel([]))
    alice, bob = TestClient(app), TestClient(app)
    credentials = json.loads((tmp_path / 'login.json').read_text())
    for name, client in [('alice', alice), ('bob', bob)]:
        assert client.post('/api/login', json={'username': name, 'password': credentials[name]['password']}).status_code == 200
    manager = SDKSessionStore(app.state.service.runtime_directory('alice'))
    lease = manager.begin('alice', str(uuid4()), 0, {})
    sid = str(uuid4())
    path = lease.config_directory / 'projects' / 'session' / (sid + '.jsonl')
    path.parent.mkdir(parents=True)
    path.write_text('{"synthetic":true}\n')
    lease.ready(sid)
    lease.commit(0)
    cid = lease.conversation_id
    before = app.state.store.state('alice')
    assert TestClient(app).post('/api/conversation-action', json={'action': 'delete', 'conversation_id': cid}).status_code == 401
    assert alice.post('/api/conversation-action', json={'action': 'delete', 'conversation_id': '../invalid'}).status_code == 400
    assert bob.post('/api/conversation-action', json={'action': 'delete', 'conversation_id': cid}).status_code == 200
    assert path.exists()
    assert alice.post('/api/conversation-action', json={'action': 'delete', 'conversation_id': cid}).json() == {'deleted': True}
    assert not lease.directory.exists()
    assert app.state.store.state('alice') == before
    assert alice.post('/api/conversation-action', json={'action': 'delete', 'conversation_id': cid}).status_code == 200
