"""Deletion, provenance, bounded input and stale-worker tests without a model."""
import json
import time

import pytest

from backend.memory_selection import estimate_tokens
from backend.memory_topics import LEGACY_NOTICE, TopicMemory
from backend.store import Store


@pytest.fixture
def topics(tmp_path, monkeypatch):
    monkeypatch.setenv('MEMORY_CONSOLIDATE_SOURCES', '2')
    monkeypatch.setenv('MEMORY_CONSOLIDATE_TOKENS', '100000')
    store = Store(tmp_path)
    manager = TopicMemory(store)
    manager.initialize()
    with store.db() as db:
        db.execute('UPDATE profiles SET enabled=1')
    return manager


def add(manager, mid, query, *, owner='alice', parent='', problem='专注问题',
        text='不可信累积摘要', status='unresolved', evidence='', created=None):
    store = manager.store
    stamp = created if created is not None else time.time()
    with store.lock, store.db() as db:
        if parent:
            db.execute("UPDATE memories SET state='superseded' WHERE id=?", (parent,))
        db.execute('INSERT INTO memories VALUES (?,?,?,?,?,?,?,?)',
                   (mid, owner, 'conversation_summary', text, stamp, stamp, 'active', None))
        db.execute('INSERT INTO memory_summaries VALUES (?,?,?,?,?,?,?,?,?)',
                   (mid, 'run-' + mid, '可能含继承事实', problem, status,
                    json.dumps(['03-01', '15-01']), parent, query, evidence))
        tid = manager.register(db, mid, owner, query, ['03-01'],
                               dependencies=[parent] if parent else (),
                               parent_id=parent, problem=problem, now=stamp)
        db.execute('UPDATE profiles SET revision=revision+1 WHERE id=?', (owner,))
    return tid


def change(manager, action, data, owner='alice'):
    with manager.store.lock, manager.store.db() as db:
        mids = manager.on_change(db, owner, action, data)
        if action == 'delete':
            mids = [data['id']]
        if action == 'clear':
            mids = [r['id'] for r in db.execute('SELECT id FROM memories WHERE owner=?', (owner,))]
        for mid in mids:
            db.execute('DELETE FROM memory_summaries WHERE memory_id=?', (mid,))
            db.execute('DELETE FROM memories WHERE id=? AND owner=?', (mid, owner))
        db.execute('UPDATE profiles SET revision=revision+1 WHERE id=?', (owner,))


def quote(job, index=0):
    source = job['sources'][index]
    return json.dumps({'items': [{'source_id': source['source_id'], 'quote': source['text']}]},
                      ensure_ascii=False)


def test_legacy_migration_uses_only_originally_validated_evidence_and_is_idempotent(topics):
    store = topics.store
    with store.db() as db:
        for mid, evidence in [('legacy-safe', '用户明确的原文'), ('legacy-opaque', '')]:
            db.execute('INSERT INTO memories VALUES (?,?,?,?,?,?,?,?)',
                       (mid, 'alice', 'conversation_summary', '不能证明的累计秘密', 1, 1, 'active', None))
            db.execute('INSERT INTO memory_summaries VALUES (?,?,?,?,?,?,?,?,?)',
                       (mid, mid, '累计秘密', '可能错误的主题', 'unknown', '["15-01"]', '', evidence, ''))
    topics.initialize()
    topics.initialize()
    memories = [{'id': mid, 'origin': 'model_summary'} for mid in ('legacy-safe', 'legacy-opaque')]
    view = topics.annotate('alice', memories)
    by_id = {m['id']: m for m in memories}
    assert by_id['legacy-safe']['text'] == '用户明确的原文'
    assert by_id['legacy-safe']['query'] == ''
    assert by_id['legacy-safe']['source_kind'] == 'legacy'
    assert by_id['legacy-opaque']['text'] == LEGACY_NOTICE
    assert all(not m['guide_ids'] for m in memories)
    assert '累计秘密' not in json.dumps(view, ensure_ascii=False)
    with store.db() as db:
        assert db.execute('SELECT count(*) FROM memory_sources').fetchone()[0] == 2


def test_stable_parent_topic_exact_grouping_and_owner_boundary(topics):
    first = add(topics, 'a1', '手机影响专注')
    assert add(topics, 'a2', '进展更新', parent='a1', problem='模型改了主题') == first
    assert add(topics, 'a3', '另一次明确同题', problem='专注问题') == first
    assert add(topics, 'a4', '相似字面不归并', problem='专注的问题') != first
    assert add(topics, 'b1', '另一账号原文', owner='bob') != first
    with pytest.raises(PermissionError):
        add(topics, 'bad-parent', '越权', owner='bob', parent='a1')
    assert topics.prepare('bob', first) is None


def test_delete_ancestor_cannot_leak_through_descendant_fields_api_or_context(topics):
    tid = add(topics, 'first', '独有秘密：银行卡尾号9988')
    add(topics, 'later', '今天稍有进展', parent='first',
        text='独有秘密：银行卡尾号9988，今天稍有进展')
    job = topics.prepare('alice', tid)
    assert topics.commit(job, quote(job))
    change(topics, 'delete', {'id': 'first'})
    memory = {'id': 'later', 'origin': 'model_summary', 'state': 'active', 'text': '银行卡尾号9988',
              'problem': '银行卡尾号9988', 'user_state': '银行卡尾号9988',
              'state_evidence': '银行卡尾号9988', 'status_evidence': '银行卡尾号9988'}
    view = topics.annotate('alice', [memory])
    projected = topics.context_memories('alice', [memory], '9988')
    serialized = json.dumps([view, memory, projected], ensure_ascii=False)
    assert '9988' not in serialized
    assert '今天稍有进展' in serialized
    assert view[0]['source_count'] == 1
    assert view[0]['current_memory_id'] == 'later'
    assert not topics.commit(job, quote(job))


def test_correction_replaces_old_original_and_preserves_explicit_confirmed_fields(topics):
    tid = add(topics, 'old', '每月预算为9000元')
    add(topics, 'later', '继续这个问题', parent='old', text='每月预算9000元的后代摘要')
    job = topics.prepare('alice', tid)
    change(topics, 'correct_summary', {'id': 'old', 'text': '我现在的预算是3000元',
                                     'problem': '月度开支', 'user_state': '需要节省',
                                     'problem_status': 'unresolved'})
    memories = [{'id': 'old', 'origin': 'model_summary'}, {'id': 'later', 'origin': 'model_summary'}]
    view = topics.annotate('alice', memories)
    projected = topics.context_memories('alice', [memories[1]], '预算')
    text = json.dumps([view, memories, projected], ensure_ascii=False)
    assert '9000' not in text
    assert '3000' in text and '需要节省' in text
    assert view[0]['title'] == '月度开支'
    assert not topics.commit(job, quote(job))


@pytest.mark.parametrize('action,data', [
    ('delete', {'id': 'first'}), ('delete_topic', {'topic_id': 'TID'}),
    ('clear', {}), ('correct_summary', {'id': 'first', 'text': '用户纠正后的原文'})])
def test_late_worker_cannot_overwrite_management_changes(topics, action, data):
    tid = add(topics, 'first', '最初的来源')
    add(topics, 'second', '新的来源', parent='first')
    job = topics.prepare('alice', tid)
    assert job is not None
    if data.get('topic_id') == 'TID':
        data = {'topic_id': tid}
    change(topics, action, data)
    assert topics.commit(job, quote(job)) is False
    assert topics.fail(job) is False
    if action in ('clear', 'delete_topic'):
        assert topics.annotate('alice', []) == []


def test_cache_commit_is_disposable_and_does_not_advance_business_revision(topics):
    tid = add(topics, 'first', '手机打断专注')
    add(topics, 'second', '关闭通知后有所改善', parent='first')
    job = topics.prepare('alice', tid)
    assert topics.prepare('alice', tid) is None  # one lease per fingerprint
    before = topics.store.state('alice')['revision']
    assert topics.commit(job, quote(job), 'prompt-v1') is True
    assert topics.store.state('alice')['revision'] == before
    assert topics.fail(job) is False  # failed old callback cannot overwrite ready
    assert topics.prepare('alice', tid) is None
    reopened = TopicMemory(Store(topics.store.directory))
    reopened.initialize()
    view = reopened.annotate('alice', [])
    assert view[0]['consolidation']['status'] == 'ready'


@pytest.mark.parametrize('payload', [
    {'summary': '自由文本不能成为事实', 'items': []},
    {'items': [{'source_id': 'bob-source', 'quote': '手机'}]},
    {'items': [{'source_id': 'first', 'quote': '伪造用户收入'}]},
    {'items': [{'source_id': 'first', 'quote': ''}]},
    {'items': [{'source_id': ['first'], 'quote': '手机'}]},
])
def test_invalid_outputs_fail_closed_and_same_fingerprint_has_bounded_retries(topics, payload):
    tid = add(topics, 'first', '手机打断专注')
    add(topics, 'second', '我尝试了关闭通知', parent='first')
    first = topics.prepare('alice', tid)
    with pytest.raises(ValueError, match='原始来源仍然可用'):
        topics.commit(first, json.dumps(payload, ensure_ascii=False))
    assert topics.annotate('alice', [])[0]['consolidation']['status'] == 'failed'
    retry = topics.prepare('alice', tid)
    assert retry is not None
    topics.fail(retry)
    assert topics.prepare('alice', tid) is None
    add(topics, 'third', '新的原文允许新指纹再试', parent='second')
    assert topics.prepare('alice', tid) is not None


def test_partial_job_has_bounded_original_input_and_old_relevant_source_remains_retrievable(topics, monkeypatch):
    monkeypatch.setenv('MEMORY_CONSOLIDATE_INPUT_TOKENS', '160')
    monkeypatch.setenv('MEMORY_CONSOLIDATE_MAX_SOURCES', '3')
    tid = add(topics, 'first', '独特目标：租房押金退还', created=1)
    parent = 'first'
    for i in range(10):
        mid = 'next-' + str(i)
        add(topics, mid, '重复的近期进展' * 5 + str(i), parent=parent, created=i + 2)
        parent = mid
    job = topics.prepare('alice', tid)
    assert job['partial'] is True and job['total_source_count'] == 11
    assert len(job['sources']) <= 3
    assert estimate_tokens(job['sources']) <= 160
    assert topics.commit(job, quote(job))
    current = {'id': parent, 'origin': 'model_summary', 'state': 'active'}
    selected = topics.context_memories('alice', [current], '租房押金')
    assert '租房押金退还' in selected[0]['_context_text']
    assert '租房押金退还' in selected[0]['_search_text']
    assert '不可信累积摘要' not in json.dumps(selected, ensure_ascii=False)


def test_current_head_is_empty_after_deleting_active_without_reviving_superseded(topics):
    tid = add(topics, 'first', '原始问题')
    add(topics, 'last', '最新进展', parent='first')
    change(topics, 'delete', {'id': 'last'})
    view = topics.annotate('alice', [])
    assert view[0]['id'] == tid
    assert view[0]['current_memory_id'] == ''
    with topics.store.db() as db:
        assert db.execute('SELECT state FROM memories WHERE id=?', ('first',)).fetchone()[0] == 'superseded'


def test_context_refuses_other_accounts_and_disabled_commit(topics):
    tid = add(topics, 'first', '甲用户来源')
    add(topics, 'second', '甲用户进展', parent='first')
    add(topics, 'bob-source', '乙用户私人来源', owner='bob')
    assert topics.context_memories('alice', [{'id': 'bob-source', 'origin': 'model_summary'}], '来源') == []
    assert '乙用户' not in json.dumps(topics.annotate('alice', []), ensure_ascii=False)
    job = topics.prepare('alice', tid)
    with topics.store.db() as db:
        db.execute("UPDATE profiles SET enabled=0 WHERE id='alice'")
    assert topics.commit(job, quote(job)) is False
    assert topics.prepare('alice', tid) is None


def test_expiration_or_new_source_invalidates_inflight_cache_even_without_cached_prose(topics):
    tid = add(topics, 'first', '即将过期的原文')
    add(topics, 'second', '保留的原文', parent='first')
    job = topics.prepare('alice', tid)
    with topics.store.db() as db:
        db.execute('UPDATE memories SET expires=? WHERE id=?', (time.time() - 1, 'first'))
    assert topics.commit(job, quote(job)) is False
    add(topics, 'third', '新增的原文', parent='second')
    another = topics.prepare('alice', tid)
    assert another and all(s['source_id'] != 'first' for s in another['sources'])


def test_empty_extracts_are_a_valid_ready_cache_without_repeated_model_calls(topics):
    tid = add(topics, 'first', '你好', problem='')
    add(topics, 'second', '谢谢', parent='first', problem='')
    job = topics.prepare('alice', tid)
    assert topics.commit(job, '{"items":[]}') is True
    assert topics.annotate('alice', [])[0]['consolidation']['status'] == 'ready'
    assert topics.prepare('alice', tid) is None


def test_output_is_short_extracts_and_cannot_use_the_large_input_budget(topics):
    tid = add(topics, 'first', '用户原文' * 200)
    add(topics, 'second', '跟进原文' * 200, parent='first')
    job = topics.prepare('alice', tid)
    with pytest.raises(ValueError, match='原始来源仍然可用'):
        topics.commit(job, json.dumps({'items': [{'source_id': 'first', 'quote': '用户原文' * 61}]}))
    retry = topics.prepare('alice', tid)
    with pytest.raises(ValueError, match='原始来源仍然可用'):
        topics.commit(retry, json.dumps({'items': [
            {'source_id': 'first', 'quote': '用户原文' * 60},
            {'source_id': 'second', 'quote': '跟进原文' * 60},
            {'source_id': 'second', 'quote': '跟进原文' * 59},
        ]}))


def test_oversized_current_source_reaches_outer_budget_instead_of_a_placeholder(topics, monkeypatch):
    from backend.memory_selection import select_memories
    monkeypatch.setenv('MEMORY_TOPIC_CONTEXT_TOKENS', '5')
    original_query = '这是完整来源不能用占位替代' * 100
    add(topics, 'first', original_query)
    projected = topics.context_memories('alice', [{'id': 'first', 'origin': 'model_summary'}], '来源')
    assert projected[0]['_context_text'].endswith(original_query)
    assert '创建时间 ' in projected[0]['_context_text']
    with pytest.raises(ValueError, match='回访记忆超过当前上下文预算'):
        select_memories(projected, '来源', followup_memory_id='first', budget=200)


def test_ui_fallback_is_bounded_dated_and_orders_newer_originals_first(topics):
    add(topics, 'first', '先前预算9000元', created=1)
    add(topics, 'second', '现在预算3000元', parent='first', created=2)
    add(topics, 'third', '需要进一步节省', parent='second', created=3)
    view = topics.annotate('alice', [])
    text = view[0]['text']
    assert len(text) <= 600
    assert text.index('进一步节省') < text.index('现在预算3000') < text.index('先前预算9000')
    assert '1970-01-01T00:00Z' in text


def test_stale_unrelated_revision_releases_only_its_own_lease(topics):
    tid = add(topics, 'first', '来源一')
    add(topics, 'second', '来源二', parent='first')
    stale = topics.prepare('alice', tid)
    add(topics, 'other', '另一个问题', problem='不同的题目')
    assert topics.commit(stale, quote(stale)) is False
    current = topics.prepare('alice', tid)
    assert current is not None and current['lease_token'] != stale['lease_token']
    assert topics.fail(stale) is False
    assert topics.prepare('alice', tid) is None
    assert topics.commit(current, quote(current)) is True


def test_annotate_cannot_preserve_foreign_manual_text(topics):
    add(topics, 'foreign', '另一账号信息', owner='bob')
    with pytest.raises(PermissionError):
        topics.annotate('alice', [{'id': 'foreign', 'text': '另一账号信息'}])


def test_exact_problem_grouping_without_parent_has_only_one_effective_head(topics):
    tid = add(topics, 'old', '先前计划', problem='相同主题')
    assert add(topics, 'new', '最新进展', problem='相同主题') == tid
    state = topics.store.state('alice')
    assert [memory['id'] for memory in state['effective']] == ['new']
    view = topics.annotate('alice', state['memories'])
    assert view[0]['current_memory_id'] == 'new'
    assert view[0]['source_count'] == 2
    assert len(topics.context_memories('alice', state['effective'], '计划')) == 1
    # Re-registering an existing source (manual edit compatibility) is idempotent.
    with topics.store.db() as db:
        assert topics.register(db, 'old', 'alice', '编辑后旧条目', [], problem='相同主题') == tid
        assert db.execute("SELECT state FROM memories WHERE id='new'").fetchone()[0] == 'active'


def test_expired_fact_stays_in_management_sources_but_not_topic_title_or_context(topics):
    tid = add(topics, 'expired', '已过期独有事实7788')
    add(topics, 'current', '仍然有效的新原文', parent='expired')
    with topics.store.db() as db:
        db.execute('UPDATE memories SET expires=? WHERE id=?', (time.time() - 1, 'expired'))
    memories = [{'id': 'current', 'origin': 'model_summary'}]
    view = topics.annotate('alice', memories)
    assert '7788' not in view[0]['title'] + view[0]['text'] + memories[0]['problem']
    assert view[0]['id'] == tid and view[0]['source_count'] == 2
    assert '7788' in view[0]['sources'][0]['text']
    projected = topics.context_memories('alice', memories, '7788')
    assert '7788' not in json.dumps(projected, ensure_ascii=False)


def test_context_marks_each_quote_with_creation_date_and_newer_fact_priority(topics):
    add(topics, 'old', '之前预算9000元', created=1)
    add(topics, 'new', '现在预算3000元', parent='old', created=2)
    projected = topics.context_memories('alice', [{'id': 'new', 'origin': 'model_summary'}], '预算')
    text = projected[0]['_context_text']
    assert '优先采用最新来源中的明确表达' in text
    assert '[来源 old；创建时间 1970-01-01T00:00:01Z] 之前预算9000元' in text
    assert '[来源 new；创建时间 1970-01-01T00:00:02Z] 现在预算3000元' in text


def test_aggregate_expiry_covers_older_evidence_and_invalidates_inflight_run(topics, monkeypatch):
    add(topics, 'expiring', '旧来源中有重要约束')
    add(topics, 'permanent-head', '本轮新进展', parent='expiring')
    deadline = time.time() + 20
    with topics.store.db() as db:
        db.execute('UPDATE memories SET expires=? WHERE id=?', (deadline, 'expiring'))
    original = {'id': 'permanent-head', 'origin': 'model_summary', 'expires': None}
    projected = topics.context_memories('alice', [original], '重要约束')
    assert projected[0]['expires'] == deadline
    assert original['expires'] is None
    run = topics.store.context('alice', '重要约束', 'chat')
    assert run['memories'][0]['expires'] == deadline
    monkeypatch.setattr('backend.store.time.time', lambda: deadline + 1)
    with pytest.raises(ValueError, match='记忆已到期'):
        topics.store.run(run['run_id'])


def test_aggregate_expiry_preserves_earlier_head_expiry(topics):
    add(topics, 'old', '旧来源')
    add(topics, 'head', '当前来源', parent='old')
    soon, later = time.time() + 10, time.time() + 30
    with topics.store.db() as db:
        db.execute('UPDATE memories SET expires=? WHERE id=?', (later, 'old'))
        db.execute('UPDATE memories SET expires=? WHERE id=?', (soon, 'head'))
    projected = topics.context_memories('alice', [{'id': 'head', 'origin': 'model_summary', 'expires': soon}], '')
    assert projected[0]['expires'] == soon
