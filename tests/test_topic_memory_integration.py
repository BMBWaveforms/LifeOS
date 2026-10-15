import json
from fastapi.testclient import TestClient

from backend.main import create_app
from backend.model import AgentService
from backend.store import Store
from test_api_agent import FakeModel, ScriptedSDKExecutor, text


def save_turn(store, query, parent='', problem='搬家计划', summary=None):
    run = store.context('alice', query, 'chat', followup_memory_id=parent)
    store.finalize('alice', run['run_id'], json.dumps({'status': 'acknowledged', 'cards': []}))
    return store.save_summary('alice', run['run_id'], json.dumps({
        'summary': summary or query, 'user_state': query, 'state_evidence': query,
        'problem': problem, 'problem_status': 'unresolved', 'status_evidence': '',
        'followup_of': parent, 'guide_ids': [],
    }, ensure_ascii=False))


def test_old_relevant_topic_survives_many_recent_unrelated_records(tmp_path):
    store = Store(tmp_path)
    store.change('alice', 'settings', {'enabled': True})
    first = save_turn(store, '搬家租房预算5000元，通勤90分钟')
    for index in range(40):
        store.change('alice', 'save', {'confirmed': True, 'text': f'合成运动记录编号{index}：跑步结束'})
    current = store.context('alice', '租房搬家预算和通勤怎么考虑', 'chat')
    assert current['memories'][0]['id'] == first['memory_id']
    assert '5000' in current['memories'][0]['text']
    selection = current['memory_selection']
    assert selection['estimated_tokens'] <= selection['token_budget']
    assert all(not key.startswith('_') for memory in current['memories'] for key in memory)


def test_deleted_ancestor_cannot_survive_through_cumulative_descendant(tmp_path):
    store = Store(tmp_path)
    store.change('alice', 'settings', {'enabled': True})
    first = save_turn(store, '我的合成私人条件是红色雨伞编号731')
    latest = save_turn(store, '搬家这个问题还没解决', first['memory_id'],
                       summary='用户持有红色雨伞编号731，搬家还没有解决。')
    assert len(store.state('alice')['topics']) == 1
    store.change('alice', 'delete', {'id': first['memory_id']})
    state = store.state('alice')
    assert '红色雨伞' not in json.dumps(state, ensure_ascii=False)
    assert state['topics'][0]['source_count'] == 1
    assert state['topics'][0]['current_memory_id'] == latest['memory_id']
    current = store.context('alice', '继续搬家', 'chat', followup_memory_id=latest['memory_id'])
    assert '红色雨伞' not in json.dumps(current, ensure_ascii=False)
    assert '红色雨伞' not in json.dumps(Store(tmp_path).state('alice'), ensure_ascii=False)


def test_text_only_correction_cannot_restore_deleted_fact_from_old_model_fields(tmp_path):
    def fact_text(value):
        # Random opaque IDs can coincidentally contain the tested four digits.
        # Check every user-facing/evidence text field rather than UUID bytes.
        if isinstance(value, dict):
            return '\n'.join(str(item) if key in {
                'text', 'query', 'problem', 'title', 'quote', 'user_state',
                'state_evidence', 'status_evidence'} else fact_text(item)
                for key, item in value.items())
        if isinstance(value, list):
            return '\n'.join(fact_text(item) for item in value)
        return ''
    store = Store(tmp_path)
    store.change('alice', 'settings', {'enabled': True})
    first = save_turn(store, '我的信用卡尾号是9988，担心还款', problem='信用卡9988还款')
    latest = save_turn(store, '我今天安排了一步', first['memory_id'],
                       problem='信用卡9988还款', summary='信用卡9988还款有进展')
    # Model summary fields can retain inherited facts even though the later
    # original query never stated them. They are not new user confirmation.
    with store.db() as db:
        db.execute('UPDATE memory_summaries SET user_state=? WHERE memory_id=?',
                   ('曾经继承的信用卡9988信息', latest['memory_id']))
    store.change('alice', 'delete', {'id': first['memory_id']})
    assert '9988' not in fact_text(store.state('alice'))

    store.change('alice', 'correct_summary', {'id': latest['memory_id'], 'text': '我今天完成了一步'})
    state = store.state('alice')
    context = store.context('alice', '后续安排', 'chat', followup_memory_id=latest['memory_id'])
    assert '9988' not in fact_text([state, context])
    assert context['followup']['query'] == '我今天完成了一步'
    assert '我今天完成了一步' in context['followup']['text']
    assert '9988' not in fact_text(Store(tmp_path).state('alice'))


def test_topic_delete_api_is_account_scoped_and_removes_all_sources(tmp_path):
    app = create_app(tmp_path, FakeModel([]))
    store = app.state.store
    store.change('alice', 'settings', {'enabled': True})
    first = save_turn(store, '我的租房预算5000元')
    save_turn(store, '我希望通勤缩短到45分钟', first['memory_id'])
    topic_id = store.state('alice')['topics'][0]['id']
    credentials = json.loads((tmp_path / 'login.json').read_text())
    alice, bob = TestClient(app), TestClient(app)
    for name, client in [('alice', alice), ('bob', bob)]:
        assert client.post('/api/login', json={'username': name, 'password': credentials[name]['password']}).status_code == 200
    assert TestClient(app).post('/api/memory-action', json={'action': 'delete_topic', 'id': topic_id}).status_code == 401
    assert bob.post('/api/memory-action', json={'action': 'delete_topic', 'id': topic_id}).status_code == 401
    assert len(alice.get('/api/memories').json()['topics'][0]['sources']) == 2
    response = alice.post('/api/memory-action', json={'action': 'delete_topic', 'id': topic_id})
    assert response.status_code == 200
    assert response.json()['topics'] == response.json()['memories'] == []
    assert Store(tmp_path).state('alice')['topics'] == []


def test_topic_heading_does_not_present_old_budget_as_current(tmp_path):
    store = Store(tmp_path)
    store.change('alice', 'settings', {'enabled': True})
    first = save_turn(store, '租房预算3500元')
    save_turn(store, '租房预算已调整到5000元', first['memory_id'])
    topic = store.state('alice')['topics'][0]
    assert topic['title'] == '搬家与居住'
    assert '3500' not in topic['title']
    assert '5000' in topic['text']


def test_product_schedules_extracts_after_validated_reply_without_touching_revision(tmp_path, monkeypatch):
    monkeypatch.setenv('MEMORY_CONSOLIDATION_ENABLED', 'true')
    monkeypatch.setenv('MEMORY_CONSOLIDATE_SOURCES', '1')

    class Model(FakeModel):
        def complete(self, messages, **kwargs):
            payload = json.loads(messages[-1]['content'])
            if 'sources' in payload:
                source = payload['sources'][0]
                return text({'items': [{'source_id': source['source_id'], 'quote': source['text']}]})
            return super().complete(messages, **kwargs)

    store = Store(tmp_path)
    store.change('alice', 'settings', {'enabled': True})
    model = Model([text({'status': 'acknowledged', 'cards': []}), text({
        'summary': '用户正在考虑租房', 'user_state': '我想租房', 'state_evidence': '我想租房',
        'problem': '租房计划', 'problem_status': 'unresolved', 'status_evidence': '',
        'followup_of': '', 'guide_ids': [],
    })])
    service = AgentService(store, model, {'claude-sdk': ScriptedSDKExecutor(model)})
    try:
        response = service.chat('alice', {'query': '我想租房'})
        assert response['summary']['saved']
        assert service.memory_maintenance.wait_idle(3)
        state = store.state('alice')
        assert state['revision'] == response['summary']['memory_revision']
        assert state['topics'][0]['consolidation']['status'] == 'ready'
        assert '我想租房' in state['topics'][0]['text']
    finally:
        service.memory_maintenance.close()
