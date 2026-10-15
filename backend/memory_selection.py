"""Application-side memory retrieval with an estimated JSON input budget.

The caller supplies only the current owner's effective memories. This module
does not read storage, call a model, mutate records, or truncate their text.
UTF-8 bytes / 2 is a deliberately cautious approximation, not a tokenizer or a
guarantee about a provider's actual token count. It includes the complete JSON
array, including metadata and punctuation, using model.py's JSON formatting.
"""

import json
import math
import os
import re
import unicodedata


DEFAULT_TOKEN_BUDGET = 4096
DEFAULT_MAX_ITEMS = 32

# These groups improve recall only; matching a topic never establishes a fact.
_TOPICS = (
    ('租房', '租赁', '房租', '租金', '房东', '押金', '看房'),
    ('搬家', '换房', '迁居'),
    ('通勤', '上下班', '往返公司'),
    ('睡眠', '失眠', '熬夜', '睡不好', '作息'),
    ('专注', '分心', '注意力', '集中精力', '集中注意', '手机通知'),
    ('拖延', '拖着', '拖到', '迟迟不做'),
    ('预算', '开支', '花费', '支出', '费用'),
)
_STOP_GRAMS = {
    '怎么', '什么', '可以', '时候', '觉得', '一个', '这个', '那个', '最近',
    '自己', '需要', '问题', '应该', '每天', '时间', '工作', '我的', '现在',
    '帮我', '建议', '一下', '继续', '关于', '事情', '如何', '你好',
    '您好', '谢谢', '用户', '情况', '目前', '已经', '还是', '是否', '想要',
}


def estimate_tokens(value):
    """Estimate tokens for the entire JSON value, including all record fields."""
    encoded = json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')
    return math.ceil(len(encoded) / 2)


def _positive_integer(value, env_name, default, maximum):
    candidate = os.getenv(env_name, str(default)) if value is None else value
    if isinstance(candidate, bool):
        raise ValueError(f'{env_name} 必须是 1—{maximum} 的整数。')
    if isinstance(candidate, str):
        if not candidate.strip().isdigit():
            raise ValueError(f'{env_name} 必须是 1—{maximum} 的整数。')
        candidate = int(candidate.strip())
    if not isinstance(candidate, int) or not 1 <= candidate <= maximum:
        raise ValueError(f'{env_name} 必须是 1—{maximum} 的整数。')
    return candidate


def _normalized(value):
    return unicodedata.normalize('NFKC', str(value or '')).lower()


def _features(value):
    text = _normalized(value)
    terms = set(re.findall(r'[a-z][a-z0-9_-]{1,}', text))
    for part in re.findall(r'[\u3400-\u9fff]+', text):
        terms.update(part[index:index + 2] for index in range(len(part) - 1))
    return (terms - _STOP_GRAMS,
            {index for index, words in enumerate(_TOPICS) if any(word in text for word in words)},
            set(re.findall(r'\d+(?:\.\d+)?', text)))


def _relevance(memory, query_features):
    query_terms, query_topics, query_numbers = query_features
    score = 0
    for key, weight in (('problem', 4), ('user_state', 2), ('text', 1)):
        terms, topics, numbers = _features(memory.get(key, ''))
        score += weight * (len(query_terms & terms) + 3 * len(query_topics & topics))
        # Numbers help retrieve corrections, but should not outrank topic matches.
        score += 0.25 * weight * len(query_numbers & numbers)
    return score


def _public_memory(memory):
    """Keep search-only evidence outside the model's context and its budget."""
    result = {key: value for key, value in memory.items() if not key.startswith('_')}
    if '_context_text' in memory:
        if not isinstance(memory['_context_text'], str):
            raise ValueError('记忆上下文文本必须是字符串。')
        result['text'] = memory['_context_text']
    return result


def _updated(memory):
    value = memory.get('updated', memory.get('created', 0))
    try:
        timestamp = float(value)
        return timestamp if math.isfinite(timestamp) else 0
    except (ValueError, TypeError):
        return 0


def _topic_key(memory):
    topic_id = memory.get('topic_id')
    if isinstance(topic_id, str) and topic_id:
        return ('id', topic_id)
    return ('problem', re.sub(r'[\W_]+', '', _normalized(memory.get('problem', ''))))


def select_memories(effective, query, mode='chat', followup_memory_id='', budget=None, max_items=None):
    """Return (complete selected records, non-content selection metadata).

    Chat ranks lexical relevance before recency, with recent records as fallback.
    Home selects current, unresolved/unknown model-summary topics and deduplicates
    them by topic ID, or normalized problem when older records lack a topic ID.
    A valid explicit followup always comes first, including an old record. If it
    cannot fit by itself, fail clearly instead of pretending to continue it.
    """
    token_budget = _positive_integer(budget, 'MEMORY_CONTEXT_TOKENS', DEFAULT_TOKEN_BUDGET, 1_000_000)
    limit = _positive_integer(max_items, 'MEMORY_CONTEXT_MAX_ITEMS', DEFAULT_MAX_ITEMS, 1000)
    if mode not in ('chat', 'home'):
        raise ValueError('未知的记忆选择模式。')
    if not isinstance(followup_memory_id, str):
        raise ValueError('回访记忆编号必须是字符串。')

    # No inferred fact correction happens here: effective/superseded and fact
    # conflicts remain the store's responsibility. Input records stay unchanged.
    records = list(effective)
    if any(not isinstance(memory, dict) or not isinstance(memory.get('id'), str)
           or not memory['id'] for memory in records):
        raise ValueError('有效记忆必须包含有效的记忆编号。')
    records.sort(key=lambda memory: (-_updated(memory), memory['id']))
    unique = {}
    for memory in records:
        unique.setdefault(memory['id'], memory)
    # Projection-only search evidence affects recall but never leaves this module.
    raw_records = list(unique.values())
    query_features = _features(query)
    scores = {memory['id']: _relevance(memory, query_features)
              + _relevance({'text': memory.get('_search_text', '')}, query_features)
              for memory in raw_records}
    records = [_public_memory(memory) for memory in raw_records]
    public_by_id = {memory['id']: memory for memory in records}
    explicit = public_by_id.get(followup_memory_id) if followup_memory_id else None
    if followup_memory_id and explicit is None:
        raise ValueError('回访记录已删除、停用或不属于当前用户。')

    duplicate_topics = 0
    if mode == 'home':
        candidates = []
        topics = {_topic_key(explicit)} if explicit else set()
        for memory in records:
            if memory is explicit:
                continue
            if memory.get('origin') != 'model_summary' or not memory.get('problem'):
                continue
            topic = _topic_key(memory)
            if topic in topics:
                duplicate_topics += 1
                continue
            topics.add(topic)
            # A recent resolved snapshot must also suppress an older unresolved
            # duplicate, rather than resurrecting the topic in home followups.
            if memory.get('problem_status') == 'resolved':
                continue
            candidates.append(memory)
        candidates.sort(key=lambda memory: (memory.get('problem_status') != 'unresolved',
                                             -_updated(memory), memory['id']))
    else:
        candidates = [memory for memory in records if memory is not explicit]
        candidates.sort(key=lambda memory: (-scores[memory['id']], -_updated(memory), memory['id']))

    selected = [explicit] if explicit else []
    if estimate_tokens(selected) > token_budget:
        raise ValueError('选中的回访记忆超过当前上下文预算，请提高 MEMORY_CONTEXT_TOKENS 后重试；本次未丢弃或截断该记忆。')
    skipped_budget = False
    skipped_count = False
    for memory in candidates:
        if len(selected) >= limit:
            skipped_count = True
            break
        if estimate_tokens(selected + [memory]) > token_budget:
            skipped_budget = True
            continue
        selected.append(memory)

    metadata = {
        'estimated_tokens': estimate_tokens(selected),
        'token_budget': token_budget,
        'count': len(selected),
        'max_items': limit,
        'candidate_count': len(candidates) + bool(explicit),
        'relevant_candidates': sum(scores[memory['id']] > 0 for memory in candidates) + bool(explicit),
        'truncated_by_budget': skipped_budget,
        'truncated_by_count': skipped_count,
        'duplicate_topics_omitted': duplicate_topics,
        'selection_method': 'lexical-recency-v1',
        'token_estimate': 'utf8_bytes_div_2',
    }
    return selected, metadata
