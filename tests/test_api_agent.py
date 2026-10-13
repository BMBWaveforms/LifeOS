import json
import tempfile
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from backend.main import create_app
from backend.model import AgentService, ModelClient, ModelError
from backend.store import Store

class FakeModel:
    def __init__(self, responses):
        self.responses = list(responses)
        self.inputs = []
    def ready(self): return {'configured': True, 'model': 'test-only'}
    def complete(self, messages, **kwargs):
        self.inputs.append(messages)
        result = self.responses.pop(0)
        if isinstance(result, Exception): raise result
        return result

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
    result=AgentService(s,client).chat('alice',{'query':'我工作时被手机通知打断，怎么办？'})
    assert result['summary']['saved'] and result['tool_calls']==1
    assert s.state('alice')['effective'][0]['guide_ids']==['03-01']
    assert 'full_text' in json.loads(client.inputs[1][-1]['content'])

def test_model_cannot_skip_read(s):
    client=FakeModel([text({'status':'answer','cards':[{'guide_id':'03-01'}]})])
    with pytest.raises(ValueError,match='全文回读'):AgentService(s,client).chat('alice',{'query':'手机通知'})
    assert not s.state('alice')['memories']

def test_unauthorized_tool_rejected(s):
    client=FakeModel([read_call(name='delete_memory')])
    with pytest.raises(ModelError,match='未授权工具'):AgentService(s,client).chat('alice',{'query':'手机通知'})

def test_summary_failure_is_visible(s):
    client=FakeModel([text({'status':'clarification','clarification':'主要被什么打断？','cards':[]}),ModelError('test')])
    result=AgentService(s,client).chat('alice',{'query':'工作很烦'})
    assert not result['summary']['saved']
    assert '失败' in result['markdown'] and not s.state('alice')['memories']

def test_disabled_memory_does_not_call_summarizer(s):
    s.change('alice','settings',{'enabled':False})
    client=FakeModel([text({'status':'acknowledged','cards':[]})])
    result=AgentService(s,client).chat('alice',{'query':'谢谢'})
    assert not result['summary']['saved'] and len(client.inputs)==1

def test_tool_iteration_limit(s):
    client=FakeModel([read_call() for _ in range(7)])
    with pytest.raises(ModelError,match='轮次上限'):AgentService(s,client).chat('alice',{'query':'手机通知'})
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
    a.post('/api/memory-action',json={'action':'settings','enabled':True})
    assert not b.get('/api/memories').json()['enabled']
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
    service=AgentService(s,fake)
    first=service.chat('alice',{'query':'我被手机通知打断'})
    mid=first['summary']['memory_id']
    s.change('alice','delete',{'id':mid})
    fake.responses=[text({'status':'acknowledged','cards':[]}),text({'summary':'用户打了招呼。','user_state':'','state_evidence':'','problem':'','problem_status':'unknown','status_evidence':'','followup_of':'','guide_ids':[]})]
    second=service.chat('alice',{'query':'你好','conversation_id':first['conversation_id']})
    assert second['conversation_id']!=first['conversation_id']
    assert '手机通知' not in json.dumps(fake.inputs[-2],ensure_ascii=False)


def test_home_uses_current_status_and_explicit_memory_id(s):
    model=FakeModel([read_call(),text({'status':'answer','cards':[{'guide_id':'03-01'}]}),summary()])
    service=AgentService(s,model)
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
