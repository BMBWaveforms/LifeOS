import copy
import json

import pytest

from backend.memory_selection import estimate_tokens, select_memories


def memory(identifier, text='普通记录', updated=1, **fields):
    return {'id': identifier, 'text': text, 'updated': updated, 'state': 'active', **fields}


def test_old_relevant_topic_survives_one_hundred_recent_unrelated_memories():
    old = memory('old', '我租房预算5000，通勤很长。', problem='搬家找房', updated=0)
    noise = [memory(f'noise-{index}', '记录今晚吃面条和水果。', index + 1) for index in range(100)]
    selected, metadata = select_memories(noise + [old], '公司附近租房会改善通勤吗？', budget=500, max_items=3)
    assert selected[0]['id'] == 'old'
    assert metadata['count'] <= 3
    assert metadata['estimated_tokens'] <= 500
    assert metadata['truncated_by_count'] or metadata['truncated_by_budget']


def test_explicit_old_followup_is_first_even_when_query_matches_other_topics():
    old = memory('selected', '早期问题', updated=0)
    recent = [memory(f'recent-{index}', '睡眠不好', index + 1) for index in range(100)]
    selected, _ = select_memories(recent + [old], '睡眠不好', followup_memory_id='selected', max_items=2)
    assert [item['id'] for item in selected] == ['selected', 'recent-99']


def test_explicit_followup_too_large_fails_instead_of_silently_dropping_it():
    with pytest.raises(ValueError, match='选中的回访记忆超过.*预算'):
        select_memories([memory('large', '重要内容' * 1000)], '继续', followup_memory_id='large', budget=100)


def test_unknown_explicit_followup_is_not_replaced_with_an_unrelated_memory():
    with pytest.raises(ValueError, match='已删除、停用或不属于'):
        select_memories([memory('other')], '继续', followup_memory_id='missing')


def test_budget_accounts_for_full_final_json_and_keeps_each_record_intact():
    first = memory('first', '租房预算', updated=2, problem='租房', guides=[{'title': '元数据' * 20}])
    second = memory('second', '租房预算', updated=1)
    budget = estimate_tokens([first])
    original = copy.deepcopy([first, second])
    selected, metadata = select_memories([first, second], '租房', budget=budget)
    assert selected == [first]
    assert [first, second] == original
    assert metadata['estimated_tokens'] == estimate_tokens(selected) == budget
    assert metadata['truncated_by_budget'] is True
    assert metadata['token_estimate'] == 'utf8_bytes_div_2'


def test_oversized_non_explicit_record_does_not_block_smaller_candidate():
    large = memory('large', '租房' * 1000, updated=2)
    small = memory('small', '租房', updated=1)
    selected, metadata = select_memories([large, small], '租房', budget=estimate_tokens([small]))
    assert selected == [small]
    assert metadata['truncated_by_budget'] is True


def test_empty_memories_still_count_the_json_array():
    selected, metadata = select_memories([], '租房', budget=100)
    assert selected == []
    assert metadata['estimated_tokens'] == estimate_tokens([]) > 0
    assert metadata['candidate_count'] == 0
    assert not metadata['truncated_by_budget']


@pytest.mark.parametrize('query', ['', '你好，谢谢', '火星矿石交易'])
def test_empty_or_unrelated_query_falls_back_to_recent_records(query):
    records = [memory('old', '租赁合同', 1), memory('new', '睡眠作息', 2)]
    selected, metadata = select_memories(records, query, max_items=1)
    assert selected == [records[1]]
    assert metadata['truncated_by_count'] is True


def test_topic_synonyms_find_old_memory_without_shared_bigrams():
    selected, _ = select_memories([memory('new', '记录晚餐', 2), memory('old', '失眠', 1)],
                                  '睡不好', max_items=1)
    assert selected[0]['id'] == 'old'


def test_home_prefers_unresolved_topics_and_deduplicates_current_topic():
    records = [
        memory('latest-topic', '新进展', 5, origin='model_summary', problem='搬家计划',
               problem_status='unknown', topic_id='move'),
        memory('same-topic', '重复主题', 4, origin='model_summary', problem='搬家',
               problem_status='unresolved', topic_id='move'),
        memory('other', '另一个问题', 1, origin='model_summary', problem='睡眠', problem_status='unresolved'),
        memory('resolved', '已解决', 10, origin='model_summary', problem='手机通知', problem_status='resolved'),
        memory('fact', '我是北京人', 20),
    ]
    selected, metadata = select_memories(records, '', mode='home')
    assert [item['id'] for item in selected] == ['other', 'latest-topic']
    assert metadata['duplicate_topics_omitted'] == 1


def test_home_legacy_problem_deduplication_and_greetings_without_topics():
    records = [
        memory('new', '新进展', 2, origin='model_summary', problem=' 租房！', problem_status='unresolved'),
        memory('old', '旧进展', 1, origin='model_summary', problem='租房', problem_status='unresolved'),
        memory('greeting', '你好', 3, origin='model_summary', problem='', problem_status='unknown'),
    ]
    selected, _ = select_memories(records, '', mode='home')
    assert [item['id'] for item in selected] == ['new']


def test_home_new_resolved_topic_does_not_resurrect_old_unresolved_duplicate():
    records = [
        memory('resolved', '事情已处理好', 2, origin='model_summary', problem='搬家',
               problem_status='resolved', topic_id='move'),
        memory('old', '尚未完成', 1, origin='model_summary', problem='搬家',
               problem_status='unresolved', topic_id='move'),
    ]
    selected, _ = select_memories(records, '', mode='home')
    assert selected == []


def test_numeric_correction_retrieves_latest_related_fact_without_inventing_a_merge():
    records = [
        memory('budget-old', '租房预算3500元', 1),
        memory('budget-current', '租房预算5000元', 2),
        memory('unrelated-price', '这台显卡价格5000元', 30),
    ]
    original = copy.deepcopy(records)
    selected, _ = select_memories(records, '租房预算改到5000元了', max_items=2)
    assert [item['id'] for item in selected] == ['budget-current', 'budget-old']
    assert records == original  # Resolving validity/conflicts belongs to the store.


def test_selection_is_deterministic_does_not_mutate_and_omits_content_from_metadata():
    records = [memory('b', '私人记录', 1), memory('a', '私人记录', 1)]
    original = copy.deepcopy(records)
    selected, metadata = select_memories(records, '无关', max_items=1)
    assert selected[0]['id'] == 'a'
    assert records == original
    assert '私人记录' not in json.dumps(metadata, ensure_ascii=False)


def test_private_search_evidence_improves_recall_but_budget_only_counts_public_projection():
    projected = memory('old', '聚合主题', 1, _search_text='通勤租房预算' + '旧来源' * 1000,
                       _context_text='搬家当前预算5000元', _private='never expose')
    public = {key: value for key, value in projected.items() if not key.startswith('_')}
    public['text'] = projected['_context_text']
    original = copy.deepcopy(projected)
    selected, metadata = select_memories([memory('recent', '今晚晚餐', 10), projected],
                                         '租房通勤', budget=estimate_tokens([public]), max_items=1)
    assert selected == [public]
    assert metadata['estimated_tokens'] == estimate_tokens([public])
    assert projected == original
    assert not any(key.startswith('_') for key in selected[0])
    assert '旧来源' not in json.dumps(selected, ensure_ascii=False)


def test_duplicate_memory_ids_do_not_consume_multiple_slots():
    selected, _ = select_memories([memory('same', '旧文本', 1), memory('same', '新文本', 2)], '')
    assert len(selected) == 1
    assert selected[0]['text'] == '新文本'


def test_configurable_environment_and_explicit_options(monkeypatch):
    monkeypatch.setenv('MEMORY_CONTEXT_TOKENS', '1000')
    monkeypatch.setenv('MEMORY_CONTEXT_MAX_ITEMS', '1')
    records = [memory('a'), memory('b')]
    selected, metadata = select_memories(records, '')
    assert len(selected) == 1
    assert metadata['token_budget'] == 1000
    selected, metadata = select_memories(records, '', budget=2000, max_items=2)
    assert len(selected) == 2
    assert metadata['token_budget'] == 2000


@pytest.mark.parametrize('name,value', [('MEMORY_CONTEXT_TOKENS', '0'),
                                       ('MEMORY_CONTEXT_TOKENS', 'oops'),
                                       ('MEMORY_CONTEXT_MAX_ITEMS', '-1'),
                                       ('MEMORY_CONTEXT_MAX_ITEMS', '2.5')])
def test_invalid_environment_configuration_is_explicit(monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(ValueError, match=name):
        select_memories([], '')


@pytest.mark.parametrize('options', [{'budget': True}, {'budget': 1.5}, {'max_items': False},
                                    {'max_items': 0}, {'mode': 'unknown'}])
def test_invalid_call_options_are_rejected(options):
    with pytest.raises(ValueError):
        select_memories([], '', **options)
