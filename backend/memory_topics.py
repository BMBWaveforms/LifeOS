"""Source-backed memory topics and disposable, extractive consolidation caches.

The original per-turn query is the authority. Older cumulative model summaries
are never used as evidence, including when a source has been deleted. All writes
except cache commits participate in the caller's existing SQLite transaction.
"""
import hashlib
import json
import os
import re
import secrets
import time
from datetime import datetime, timezone

from backend.memory_selection import estimate_tokens


MAX_ATTEMPTS = 2
LEASE_SECONDS = 300
LEGACY_NOTICE = '旧记录缺少可核验原文，仅保留记录供管理。'


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _limit(name, default, maximum):
    raw = os.getenv(name, str(default))
    if not raw.isdigit() or not 1 <= int(raw) <= maximum:
        raise ValueError(f'{name} 必须是 1—{maximum} 的整数。')
    return int(raw)


def _words(text):
    words = set(re.findall(r'[a-z0-9]{2,}', text.lower()))
    for part in re.findall(r'[\u3400-\u9fff]+', text):
        words.update(part[i:i + 2] for i in range(len(part) - 1))
    return words - {'这个', '问题', '怎么', '什么', '现在', '继续', '自己'}


class TopicMemory:
    def __init__(self, store):
        self.store = store

    def initialize(self):
        with self.store.lock, self.store.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS memory_topics (
                    id TEXT PRIMARY KEY, owner TEXT NOT NULL, group_key TEXT NOT NULL,
                    created REAL NOT NULL, updated REAL NOT NULL,
                    current_memory_id TEXT NOT NULL DEFAULT '',
                    cache_items TEXT NOT NULL DEFAULT '[]',
                    cache_fingerprint TEXT NOT NULL DEFAULT '',
                    prompt_version TEXT NOT NULL DEFAULT '',
                    attempt_fingerprint TEXT NOT NULL DEFAULT '',
                    attempts INTEGER NOT NULL DEFAULT 0,
                    lease_token TEXT NOT NULL DEFAULT '', lease_started REAL NOT NULL DEFAULT 0,
                    last_status TEXT NOT NULL DEFAULT 'pending');
                CREATE INDEX IF NOT EXISTS memory_topics_owner ON memory_topics(owner);
                CREATE TABLE IF NOT EXISTS memory_sources (
                    memory_id TEXT PRIMARY KEY, owner TEXT NOT NULL, topic_id TEXT NOT NULL,
                    query TEXT NOT NULL, source_text TEXT NOT NULL, kind TEXT NOT NULL,
                    consulted_ids TEXT NOT NULL, dependencies TEXT NOT NULL,
                    source_version INTEGER NOT NULL DEFAULT 1,
                    has_problem INTEGER NOT NULL DEFAULT 0,
                    confirmed_title TEXT NOT NULL DEFAULT '',
                    problem_status TEXT NOT NULL DEFAULT 'unknown',
                    status_evidence TEXT NOT NULL DEFAULT '', created REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS memory_sources_topic ON memory_sources(owner,topic_id);
            ''')
            rows = db.execute('''SELECT m.*,s.user_state,s.state_evidence,s.problem,
                                 s.problem_status,s.status_evidence,s.followup_of
                                 FROM memories m LEFT JOIN memory_summaries s ON s.memory_id=m.id
                                 WHERE NOT EXISTS (SELECT 1 FROM memory_sources r WHERE r.memory_id=m.id)
                                 ORDER BY m.created,m.id''').fetchall()
            for row in rows:
                summary = row['problem_status'] is not None
                # Historical summaries have no durable original query. Do not
                # invent one or trust their inherited guide lists/cumulative text.
                evidence = row['state_evidence'] if summary else row['text']
                evidence = evidence if isinstance(evidence, str) and len(evidence) <= 1000 else ''
                parent = row['followup_of'] if summary else ''
                if parent and not db.execute('SELECT 1 FROM memory_sources WHERE memory_id=? AND owner=?',
                                             (parent, row['owner'])).fetchone():
                    parent = ''
                self._register(db, row['id'], row['owner'], '' if summary else evidence,
                               [], (), parent, row['problem'] or '', row['created'],
                               source_text=evidence, kind='legacy' if summary else 'manual')

    def register(self, db, memory_id, owner, query, consulted_ids, dependencies=(),
                 parent_id='', problem='', now=None):
        return self._register(db, memory_id, owner, query, consulted_ids, dependencies,
                              parent_id, problem, time.time() if now is None else now)

    def _register(self, db, memory_id, owner, query, consulted_ids, dependencies,
                  parent_id, problem, now, source_text=None, kind='query'):
        row = db.execute('SELECT * FROM memories WHERE id=?', (memory_id,)).fetchone()
        if not row or row['owner'] != owner:
            raise PermissionError('记忆来源不属于当前用户。')
        if not isinstance(query, str) or len(query) > 4000:
            raise ValueError('原始来源必须是有限长度的文本。')
        if (not isinstance(consulted_ids, (list, tuple)) or len(consulted_ids) > 12
                or any(not isinstance(gid, str) or gid not in self.store.entries for gid in consulted_ids)):
            raise ValueError('来源的真实咨询指南无效。')
        if not isinstance(problem, str) or len(problem) > 160:
            raise ValueError('问题主题无效。')
        if not isinstance(dependencies, (list, tuple, set)) or len(dependencies) > 1000:
            raise ValueError('来源依赖无效。')
        for mid in dependencies:
            owned = db.execute('SELECT owner FROM memories WHERE id=?', (mid,)).fetchone()
            if not owned or owned['owner'] != owner:
                raise PermissionError('来源依赖不属于当前用户。')
        old = db.execute('SELECT * FROM memory_sources WHERE memory_id=?', (memory_id,)).fetchone()
        if old:
            if old['owner'] != owner:
                raise PermissionError('来源不属于当前用户。')
            return old['topic_id']
        parent = db.execute('SELECT * FROM memory_sources WHERE memory_id=?', (parent_id,)).fetchone() if parent_id else None
        if parent_id and (not parent or parent['owner'] != owner):
            raise PermissionError('回访来源不属于当前用户或已删除。')
        matches = db.execute('SELECT id FROM memory_topics WHERE owner=? AND group_key=?',
                             (owner, problem)).fetchall() if problem else []
        tid = parent['topic_id'] if parent else (matches[0]['id'] if len(matches) == 1 else secrets.token_hex(12))
        db.execute('INSERT OR IGNORE INTO memory_topics(id,owner,group_key,created,updated) VALUES (?,?,?,?,?)',
                   (tid, owner, problem, now, now))
        detail = db.execute('SELECT * FROM memory_summaries WHERE memory_id=?', (memory_id,)).fetchone()
        text = query if source_text is None else source_text
        status = 'unknown'
        status_evidence = ''
        if detail:
            candidate = detail['problem_status']
            quoted = detail['status_evidence']
            if candidate == 'unresolved' and problem:
                status = candidate
            elif candidate == 'resolved' and quoted and quoted in text:
                status, status_evidence = candidate, quoted
        db.execute('''INSERT INTO memory_sources
                   (memory_id,owner,topic_id,query,source_text,kind,consulted_ids,dependencies,
                    has_problem,problem_status,status_evidence,created)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)''',
                   (memory_id, owner, tid, query, text, kind, _json(sorted(set(consulted_ids))),
                    _json(sorted(set(dependencies))), int(bool(problem)), status, status_evidence, now))
        # Exact-problem grouping has the same single-current-head semantics as
        # an explicit followup. Existing source IDs return above and are not
        # treated as new turns when a manual record is edited.
        db.execute('''UPDATE memories SET state='superseded' WHERE owner=? AND id<>? AND state='active'
                      AND id IN (SELECT memory_id FROM memory_sources WHERE owner=? AND topic_id=?)''',
                   (owner, memory_id, owner, tid))
        self._invalidate(db, owner, tid)
        self._refresh(db, owner, tid, now)
        return tid

    def _invalidate(self, db, owner, tid):
        db.execute('''UPDATE memory_topics SET cache_items='[]',cache_fingerprint='',prompt_version='',
                      attempt_fingerprint='',attempts=0,lease_token='',lease_started=0,last_status='pending'
                      WHERE id=? AND owner=?''', (tid, owner))

    def _refresh(self, db, owner, tid, now=None):
        rows = db.execute('''SELECT m.id,m.created,m.updated,m.state,m.expires FROM memories m
                            JOIN memory_sources s ON s.memory_id=m.id
                            WHERE s.owner=? AND m.owner=? AND s.topic_id=?
                            ORDER BY m.created DESC,m.id DESC''', (owner, owner, tid)).fetchall()
        if not rows:
            db.execute('DELETE FROM memory_topics WHERE id=? AND owner=?', (tid, owner))
            return
        moment = time.time() if now is None else now
        head = next((r['id'] for r in rows if r['state'] == 'active'
                     and (r['expires'] is None or r['expires'] > moment)), '')
        db.execute('UPDATE memory_topics SET current_memory_id=?,updated=? WHERE id=? AND owner=?',
                   (head, max(r['updated'] for r in rows), tid, owner))

    def _sources(self, db, owner, tid=None):
        sql = '''SELECT s.*,m.state,m.expires,m.updated FROM memory_sources s
                 JOIN memories m ON m.id=s.memory_id AND m.owner=s.owner WHERE s.owner=?'''
        args = [owner]
        if tid is not None:
            sql += ' AND s.topic_id=?'
            args.append(tid)
        sql += ' ORDER BY s.created,s.memory_id'
        return [dict(r) for r in db.execute(sql, args)]

    @staticmethod
    def _usable(sources):
        now = time.time()
        return [s for s in sources if s['state'] in ('active', 'superseded')
                and (s['expires'] is None or s['expires'] > now) and s['source_text']]

    @staticmethod
    def _fingerprint(sources):
        content = [(s['memory_id'], s['source_version'], s['source_text'], s['consulted_ids'],
                    s['state'], s['expires'], s['problem_status'], s['confirmed_title']) for s in sources]
        return hashlib.sha256(_json(content).encode()).hexdigest()

    @staticmethod
    def _title(sources):
        confirmed = next((s['confirmed_title'] for s in reversed(sources) if s['confirmed_title']), '')
        if confirmed:
            return confirmed[:80] + ('…' if len(confirmed) > 80 else '')
        # A topic label must not turn an old budget/address into a current fact.
        # Keep concrete values in the dated evidence, not in a sticky heading.
        text = '\n'.join(s['source_text'] for s in sources if s['has_problem'])
        for label, pattern in (
            ('搬家与居住', r'搬家|租房|房租|租金|房东|押金|住处'),
            ('通勤与出行', r'通勤|上下班|地铁|出行'),
            ('专注与工作', r'专注|手机通知|注意力|打断|分心'),
            ('睡眠与休息', r'睡眠|失眠|作息|熬夜|休息'),
            ('行动与习惯', r'拖延|习惯|拖着|不想做'),
            ('工作与职业', r'工作|职业|离职|求职|同事'),
            ('日常开支', r'预算|开支|支出|花费'),
        ):
            if re.search(pattern, text):
                return label
        return '生活话题' if text else '会话记录'

    @staticmethod
    def _status(sources):
        return next((s['problem_status'] for s in reversed(sources)
                     if s['problem_status'] in ('resolved', 'unresolved')), 'unknown')

    @staticmethod
    def _due(sources):
        count = _limit('MEMORY_CONSOLIDATE_SOURCES', 8, 10000)
        tokens = _limit('MEMORY_CONSOLIDATE_TOKENS', 1200, 1000000)
        return bool(sources) and (len(sources) >= count or estimate_tokens(
            [{'source_id': s['memory_id'], 'text': s['source_text']} for s in sources]) >= tokens)

    def _cached_items(self, topic, sources):
        if topic['cache_fingerprint'] != self._fingerprint(sources):
            return None
        available = {s['memory_id']: s['source_text'] for s in sources}
        try:
            items = json.loads(topic['cache_items'])
            if (not isinstance(items, list) or any(not isinstance(item, dict)
                    or not isinstance(item.get('quote'), str) or not item['quote']
                    or not isinstance(item.get('source_id'), str) or item['source_id'] not in available
                    or item['quote'] not in available[item['source_id']] for item in items)):
                return None
            return items
        except (ValueError, TypeError):
            return None

    def _cache(self, topic, sources):
        return self._cached_items(topic, sources) or []

    @staticmethod
    def _display_items(sources, items=None, limit=600):
        by_id = {s['memory_id']: s for s in sources}
        snippets = ([{'source_id': s['memory_id'], 'quote': s['source_text']}
                     for s in sources if s['source_text']] if items is None else list(items))
        snippets.sort(key=lambda item: (-by_id[item['source_id']]['created'], item['source_id']))
        excerpts, seen, used = [], set(), 0
        for item in snippets:
            if item['quote'] in seen:
                continue
            seen.add(item['quote'])
            source = by_id[item['source_id']]
            date = datetime.fromtimestamp(source['created'], timezone.utc).strftime('%Y-%m-%dT%H:%MZ')
            prefix = '[' + date + '] '
            remaining = limit - used - len(prefix)
            if remaining <= 24 or len(excerpts) >= 3:
                break
            quote = item['quote'] if len(item['quote']) <= remaining else item['quote'][:remaining - 1] + '…'
            excerpts.append({'source_id': item['source_id'], 'quote': quote, 'created': source['created']})
            used += len(prefix) + len(quote) + 1
        return excerpts

    @classmethod
    def _dated_text(cls, sources, items=None, limit=600):
        excerpts = cls._display_items(sources, items, limit)
        return '\n'.join('[' + datetime.fromtimestamp(item['created'], timezone.utc).strftime('%Y-%m-%dT%H:%MZ')
                         + '] ' + item['quote'] for item in excerpts) or LEGACY_NOTICE

    def _consolidation(self, topic, sources):
        fp = self._fingerprint(sources)
        if self._cached_items(topic, sources) is not None:
            status = 'ready'
        elif not self._due(sources):
            status = 'not_needed'
        elif topic['attempt_fingerprint'] == fp and topic['last_status'] == 'failed':
            status = 'failed'
        else:
            status = 'pending'
        return {'status': status}

    def _sanitize(self, memory, source, sources):
        usable = self._usable(sources)
        memory['topic_id'] = source['topic_id']
        memory['text'] = source['source_text'] or LEGACY_NOTICE
        memory['query'] = source['query']
        memory['source_kind'] = source['kind']
        memory['problem'] = self._title(usable) if any(s['has_problem'] for s in usable) else ''
        memory['problem_status'] = self._status(usable)
        # Do not re-expose model rewrites or inherited fields outside the safe
        # source layer. The quote itself remains available in text/query.
        memory['user_state'] = ''
        memory['state_evidence'] = ''
        memory['status_evidence'] = source['status_evidence']
        memory['guide_ids'] = sorted({gid for item in usable for gid in json.loads(item['consulted_ids'])})
        memory['guides'] = [{'guide_id': gid, 'title': self.store.entries[gid]['title']}
                            for gid in memory['guide_ids'] if gid in self.store.entries]

    def annotate(self, owner, memories):
        with self.store.lock, self.store.db() as db:
            owned_ids = {r['id'] for r in db.execute('SELECT id FROM memories WHERE owner=?', (owner,))}
            if any(memory.get('id') not in owned_ids for memory in memories):
                raise PermissionError('记忆不属于当前用户或已删除。')
            source_rows = self._sources(db, owner)
            by_id = {s['memory_id']: s for s in source_rows}
            groups = {}
            for source in source_rows:
                groups.setdefault(source['topic_id'], []).append(source)
            topics = []
            for row in db.execute('SELECT * FROM memory_topics WHERE owner=? ORDER BY updated DESC,id', (owner,)):
                topic = dict(row)
                sources = groups.get(topic['id'], [])
                if not sources:
                    continue
                usable = self._usable(sources)
                active = [s for s in reversed(usable) if s['state'] == 'active']
                quotes = self._cache(topic, usable)
                topics.append({'id': topic['id'], 'title': self._title(usable),
                               'text': self._dated_text(usable, quotes if quotes else None),
                               'excerpts': self._display_items(usable, quotes if quotes else None),
                               'created': topic['created'], 'updated': topic['updated'],
                               'problem_status': self._status(usable),
                               'current_memory_id': active[0]['memory_id'] if active else '',
                               'source_count': len(sources),
                               'sources': [{'id': s['memory_id'], 'text': s['source_text'] or LEGACY_NOTICE,
                                            'query': s['query'], 'created': s['created'], 'state': s['state'],
                                            'guide_ids': json.loads(s['consulted_ids']), 'kind': s['kind']}
                                           for s in sources],
                               'consolidation': self._consolidation(topic, usable)})
            for memory in memories:
                source = by_id.get(memory['id'])
                if source:
                    self._sanitize(memory, source, groups[source['topic_id']])
                elif memory.get('origin') == 'model_summary':
                    # An unregistered summary must fail closed, never fall back
                    # to the cumulative legacy prose during a partial migration.
                    memory.update(text=LEGACY_NOTICE, problem='', user_state='',
                                  state_evidence='', status_evidence='', guide_ids=[], guides=[])
            return topics

    def context_memories(self, owner, effective, query, mode='chat'):
        if mode not in ('chat', 'home'):
            raise ValueError('未知的记忆上下文模式。')
        budget = _limit('MEMORY_TOPIC_CONTEXT_TOKENS', 900, 32000)
        terms = _words(str(query))
        with self.store.lock, self.store.db() as db:
            all_sources = self._sources(db, owner)
            groups = {}
            for source in self._usable(all_sources):
                groups.setdefault(source['topic_id'], []).append(source)
            sources_by_id = {s['memory_id']: s for s in all_sources}
            topics = {r['id']: dict(r) for r in db.execute('SELECT * FROM memory_topics WHERE owner=?', (owner,))}
            result = []
            for original in effective:
                memory = dict(original)
                source = sources_by_id.get(memory.get('id'))
                if not source:
                    if memory.get('origin') == 'model_summary':
                        continue
                    # Legacy manual records are explicit user-confirmed facts.
                    owned = db.execute('SELECT owner FROM memories WHERE id=?', (memory.get('id'),)).fetchone()
                    if not owned or owned['owner'] != owner:
                        raise PermissionError('记忆不属于当前用户。')
                    result.append(memory)
                    continue
                sources = groups.get(source['topic_id'], [])
                if not sources:
                    continue
                self._sanitize(memory, source, sources)
                topic = topics[source['topic_id']]
                ranked = sorted(sources, key=lambda s: (-len(terms & _words(s['source_text'])),
                                                       -s['created'], s['memory_id']))
                candidates = [{'source_id': s['memory_id'], 'quote': s['source_text']}
                              for s in ranked if terms & _words(s['source_text'])]
                candidates += self._cache(topic, sources)
                candidates += [{'source_id': s['memory_id'], 'quote': s['source_text']} for s in ranked]
                picked, seen = [], set()
                for item in candidates:
                    marker = (item['source_id'], item['quote'])
                    if marker in seen:
                        continue
                    seen.add(marker)
                    if estimate_tokens(picked + [item]) <= budget:
                        picked.append(item)
                memory['_search_text'] = '\n'.join(s['source_text'] for s in sources)
                source_by_id = {item['memory_id']: item for item in sources}
                def dated_line(item):
                    stamp = datetime.fromtimestamp(source_by_id[item['source_id']]['created'], timezone.utc)
                    return ('[来源 ' + item['source_id'] + '；创建时间 ' +
                            stamp.isoformat(timespec='seconds').replace('+00:00', 'Z') + '] ' + item['quote'])
                priority = '同一事实有更新时优先采用最新来源中的明确表达；旧来源仅作历史背景。\n'
                memory['_context_text'] = priority + '\n'.join(dated_line(item) for item in picked)
                memory['text'] = memory['_context_text']
                if not picked:
                    # The outer complete-record selector can skip an oversized
                    # candidate or clearly reject an explicit followup. It must
                    # never pretend that a placeholder contains the source.
                    item = {'source_id': source['memory_id'], 'quote': source['source_text'] or LEGACY_NOTICE}
                    memory['text'] = memory['_context_text'] = priority + dated_line(item)
                # The projection includes older sources as well as the current
                # head. Their earliest expiry must invalidate in-flight answers
                # and SDK resume bindings even when the head has no expiry.
                expirations = [item['expires'] for item in sources if item['expires'] is not None]
                if original.get('expires') is not None:
                    expirations.append(original['expires'])
                memory['expires'] = min(expirations, default=None)
                result.append(memory)
            return result

    def on_change(self, db, owner, action, data):
        if action == 'clear':
            db.execute('DELETE FROM memory_sources WHERE owner=?', (owner,))
            db.execute('DELETE FROM memory_topics WHERE owner=?', (owner,))
            return []
        if action == 'delete_topic':
            tid = data.get('topic_id', data.get('id', ''))
            topic = db.execute('SELECT owner FROM memory_topics WHERE id=?', (tid,)).fetchone()
            if not topic or topic['owner'] != owner:
                raise PermissionError('主题不属于当前用户或已删除。')
            mids = [r['memory_id'] for r in db.execute('SELECT memory_id FROM memory_sources WHERE owner=? AND topic_id=?', (owner, tid))]
            db.execute('DELETE FROM memory_sources WHERE owner=? AND topic_id=?', (owner, tid))
            db.execute('DELETE FROM memory_topics WHERE owner=? AND id=?', (owner, tid))
            return mids
        if action in ('delete', 'correct_summary', 'save'):
            mid = data.get('id', '')
            source = db.execute('SELECT * FROM memory_sources WHERE memory_id=?', (mid,)).fetchone()
            if not source:
                return []
            if source['owner'] != owner:
                raise PermissionError('来源不属于当前用户。')
            tid = source['topic_id']
            if action == 'delete':
                db.execute('DELETE FROM memory_sources WHERE memory_id=? AND owner=?', (mid, owner))
            else:
                text = data.get('text', '')
                if not isinstance(text, str) or not text.strip() or len(text) > 800:
                    raise ValueError('纠正来源必须是有效文本。')
                title = data.get('problem', '')
                user_state = data.get('user_state', '')
                if not isinstance(title, str) or len(title) > 160 or not isinstance(user_state, str) or len(user_state) > 400:
                    raise ValueError('纠正的问题或状态无效。')
                status = data.get('problem_status', 'unknown')
                if status not in ('resolved', 'unresolved', 'unknown'):
                    raise ValueError('问题状态无效。')
                confirmed = text.strip()
                for label, value in (('问题', title), ('明确状态', user_state)):
                    if value and value not in confirmed:
                        confirmed += '\n' + label + '：' + value
                db.execute('''UPDATE memory_sources SET query=?,source_text=?,kind='corrected',
                              source_version=source_version+1,confirmed_title=?,has_problem=?,
                              problem_status=?,status_evidence='',dependencies='[]'
                              WHERE memory_id=? AND owner=?''',
                           (confirmed, confirmed, title, int(bool(title) or bool(source['has_problem'])), status, mid, owner))
            self._invalidate(db, owner, tid)
            self._refresh(db, owner, tid)
            remaining = self._usable(self._sources(db, owner, tid))
            # The old grouping label may itself have been copied from the
            # deleted/corrected source. It is private metadata, but should not
            # retain that text or influence future grouping after management.
            db.execute('UPDATE memory_topics SET group_key=? WHERE id=? AND owner=?',
                       (self._title(remaining) if any(s['has_problem'] for s in remaining) else '', tid, owner))
            return []
        if action == 'settings':
            for row in db.execute('SELECT id FROM memory_topics WHERE owner=?', (owner,)).fetchall():
                self._invalidate(db, owner, row['id'])
        return []

    def prepare(self, owner, topic_id=None):
        with self.store.lock, self.store.db() as db:
            profile = db.execute('SELECT enabled,revision FROM profiles WHERE id=?', (owner,)).fetchone()
            if not profile or not profile['enabled']:
                return None
            args = [owner]
            sql = 'SELECT * FROM memory_topics WHERE owner=?'
            if topic_id is not None:
                sql += ' AND id=?'
                args.append(topic_id)
            sql += ' ORDER BY updated DESC,id'
            for row in db.execute(sql, args).fetchall():
                topic = dict(row)
                sources = self._usable(self._sources(db, owner, topic['id']))
                if not self._due(sources) or self._cached_items(topic, sources) is not None:
                    continue
                fp = self._fingerprint(sources)
                same = topic['attempt_fingerprint'] == fp
                if same and (topic['attempts'] >= MAX_ATTEMPTS or
                             (topic['lease_token'] and topic['lease_started'] > time.time() - LEASE_SECONDS)):
                    continue
                budget = _limit('MEMORY_CONSOLIDATE_INPUT_TOKENS', 6000, 32000)
                maximum = _limit('MEMORY_CONSOLIDATE_MAX_SOURCES', 64, 1000)
                selected = []
                for source in reversed(sources):
                    item = {'source_id': source['memory_id'], 'text': source['source_text']}
                    if len(selected) < maximum and estimate_tokens(selected + [item]) <= budget:
                        selected.append(item)
                if not selected:
                    continue
                selected.reverse()
                token = secrets.token_hex(16)
                db.execute('''UPDATE memory_topics SET attempt_fingerprint=?,attempts=?,lease_token=?,
                              lease_started=?,last_status='pending' WHERE id=? AND owner=?''',
                           (fp, (topic['attempts'] if same else 0) + 1, token, time.time(), topic['id'], owner))
                return {'owner': owner, 'topic_id': topic['id'], 'revision': profile['revision'],
                        'fingerprint': fp, 'sources': selected, 'lease_token': token,
                        'partial': len(selected) < len(sources), 'total_source_count': len(sources),
                        'estimated_tokens': estimate_tokens(selected)}
            return None

    def _current_job(self, db, job):
        profile = db.execute('SELECT enabled,revision FROM profiles WHERE id=?', (job['owner'],)).fetchone()
        topic = db.execute('SELECT * FROM memory_topics WHERE id=? AND owner=?',
                           (job['topic_id'], job['owner'])).fetchone()
        if (not profile or not profile['enabled'] or profile['revision'] != job['revision'] or not topic
                or topic['lease_token'] != job.get('lease_token')
                or topic['attempt_fingerprint'] != job['fingerprint']):
            return None
        sources = self._usable(self._sources(db, job['owner'], job['topic_id']))
        return topic if self._fingerprint(sources) == job['fingerprint'] else None

    def is_current(self, job):
        """Recheck a queued job before sending any sources to a provider."""
        with self.store.lock, self.store.db() as db:
            return self._current_job(db, job) is not None

    def abandon(self, job):
        """Release only this reservation; do not disturb a newer topic job."""
        with self.store.lock, self.store.db() as db:
            db.execute('''UPDATE memory_topics SET lease_token='',lease_started=0,
                          attempts=MAX(0,attempts-1),last_status='pending'
                          WHERE id=? AND owner=? AND lease_token=?''',
                       (job['topic_id'], job['owner'], job.get('lease_token', '')))

    @staticmethod
    def _release_stale(db, job):
        # A revision change in another topic makes this result stale but must
        # not leave its lease blocking this topic for five minutes. Clear only
        # this exact worker's lease, without creating/updating any cache.
        db.execute('''UPDATE memory_topics SET lease_token='',lease_started=0,
                      attempts=max(0,attempts-1),last_status='pending'
                      WHERE id=? AND owner=? AND lease_token=?''',
                   (job['topic_id'], job['owner'], job.get('lease_token')))

    def commit(self, job, raw, prompt_version=''):
        try:
            data = json.loads(raw) if isinstance(raw, str) else raw
            if not isinstance(data, dict) or set(data) != {'items'}:
                raise ValueError('主题压缩只能返回有来源的摘录。')
            items = data['items']
            if not isinstance(items, list) or len(items) > 12:
                raise ValueError('主题摘录数量无效。')
            available = {s['source_id']: s['text'] for s in job['sources']}
            clean, seen = [], set()
            for item in items:
                if (not isinstance(item, dict) or set(item) != {'source_id', 'quote'}
                        or not isinstance(item['source_id'], str) or item['source_id'] not in available
                        or not isinstance(item['quote'], str) or not item['quote'].strip()
                        or len(item['quote']) > 240 or item['quote'] not in available[item['source_id']]):
                    raise ValueError('主题摘录必须逐字来自本次有效来源。')
                marker = (item['source_id'], item['quote'])
                if marker not in seen:
                    clean.append({'source_id': item['source_id'], 'quote': item['quote']})
                    seen.add(marker)
            if (sum(len(item['quote']) for item in clean) > 600 or
                    estimate_tokens(clean) > _limit('MEMORY_CONSOLIDATE_OUTPUT_TOKENS', 1200, 32000)):
                raise ValueError('主题摘录超过预算。')
        except (ValueError, TypeError, KeyError):
            self.fail(job)
            raise ValueError('主题压缩校验失败，原始来源仍然可用。') from None
        with self.store.lock, self.store.db() as db:
            if self._current_job(db, job) is None:
                self._release_stale(db, job)
                return False
            db.execute('''UPDATE memory_topics SET cache_items=?,cache_fingerprint=?,prompt_version=?,
                          lease_token='',lease_started=0,last_status='ready' WHERE id=? AND owner=?''',
                       (_json(clean), job['fingerprint'], str(prompt_version)[:128], job['topic_id'], job['owner']))
            return True

    def fail(self, job):
        with self.store.lock, self.store.db() as db:
            if self._current_job(db, job) is None:
                self._release_stale(db, job)
                return False
            db.execute("UPDATE memory_topics SET lease_token='',lease_started=0,last_status='failed' WHERE id=? AND owner=?",
                       (job['topic_id'], job['owner']))
            return True
