"""Authenticated, isolated execution tests, also used by evaluation batch runners."""
import json
import secrets
import sqlite3
import time
from pathlib import Path
from backend.errors import ModelError
from backend.executors import validate_runtime
from backend.model import AgentService, prompt
from backend.store import Store


class Workbench:
    def __init__(self, directory, client, executors=None, registry=None):
        self.directory = Path(directory) / 'workbench'
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = self.directory / 'tests.sqlite'
        self.client, self.executors = client, executors
        self.services = {}
        self.registry = registry
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY, owner TEXT NOT NULL, runtime TEXT NOT NULL, created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS results (
                    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, owner TEXT NOT NULL, runtime TEXT NOT NULL,
                    query TEXT NOT NULL, created REAL NOT NULL, elapsed_ms INTEGER NOT NULL,
                    status TEXT NOT NULL, payload TEXT NOT NULL);
            ''')
            if 'bundle' not in {r['name'] for r in db.execute('PRAGMA table_info(sessions)')}:
                db.execute("ALTER TABLE sessions ADD COLUMN bundle TEXT NOT NULL DEFAULT ''")
            if 'scope' not in {r['name'] for r in db.execute('PRAGMA table_info(sessions)')}:
                db.execute("ALTER TABLE sessions ADD COLUMN scope TEXT NOT NULL DEFAULT 'free'")
            if self.registry:
                for row in db.execute("SELECT id,bundle FROM sessions WHERE bundle<>''").fetchall():
                    snapshot = json.loads(row['bundle'])
                    if 'contracts' not in snapshot:
                        snapshot['contracts'] = self.registry.bundle(snapshot['id'])['contracts']
                        db.execute('UPDATE sessions SET bundle=? WHERE id=?', (json.dumps(snapshot, ensure_ascii=False), row['id']))

    def db(self):
        connection = sqlite3.connect(str(self.path), timeout=10)
        connection.row_factory = sqlite3.Row
        return connection

    def create_session(self, owner, runtime, memory_enabled=True, bundle_id=None, snapshot=None):
        runtime = validate_runtime(runtime)
        if not isinstance(memory_enabled, bool):
            raise ValueError('memory_enabled 必须为布尔值。')
        sid = secrets.token_hex(16)
        directory = self.directory / sid
        directory.mkdir(mode=0o700)
        profiles = directory / 'profiles.json'
        profiles.write_text(json.dumps({owner: {'name': '测试用户', 'token': secrets.token_urlsafe(32)}}))
        profiles.chmod(0o600)
        store = Store(directory)
        store.change(owner, 'settings', {'enabled': memory_enabled})
        snapshot = snapshot or (self.registry.snapshot(bundle_id) if self.registry else None)
        with self.db() as db:
            db.execute('INSERT INTO sessions(id,owner,runtime,created,bundle) VALUES (?,?,?,?,?)',
                       (sid, owner, runtime, time.time(), json.dumps(snapshot) if snapshot else ''))
        return {'session_id': sid, 'runtime': runtime, 'memory_enabled': memory_enabled,
                'bundle_id': snapshot['id'] if snapshot else None}

    def session(self, owner, sid):
        if not isinstance(sid, str):
            raise ValueError('测试会话 ID 无效。')
        with self.db() as db:
            row = db.execute("SELECT * FROM sessions WHERE id=? AND owner=? AND scope='free'", (sid, owner)).fetchone()
        if row is None:
            raise PermissionError('测试会话不存在或不属于当前账号。')
        return dict(row)

    def service(self, session):
        sid, owner = session['id'], session['owner']
        if sid not in self.services:
            snapshot = json.loads(session['bundle']) if session.get('bundle') else None
            service = AgentService(Store(self.directory / sid), self.client, self.executors, snapshot)
            # Restore only approved exchanges whose final memory revision still matches.
            with self.db() as db:
                rows = db.execute('SELECT payload FROM results WHERE session_id=? AND status=? ORDER BY created DESC LIMIT 6',
                                  (sid, 'success')).fetchall()
            records = [json.loads(row['payload']) for row in reversed(rows)]
            if records:
                last = records[-1]
                cid = last['result']['conversation_id']
                revision = service.store.state(owner)['revision']
                if last['memory_revision'] == revision:
                    history = []
                    for record in records:
                        if record['result']['conversation_id'] == cid:
                            history.extend([{'role': 'user', 'content': record['query']},
                                            {'role': 'assistant', 'content': record['result']['result']['markdown']}])
                    service.conversations[(owner, cid)] = {
                        'messages': history, 'revision': revision, 'runtime': session['runtime'],
                        'prompt_version': last['prompt_versions']['chat'],
                        'tool_version': last['result']['execution'].get('tool_version', ''), 'updated': time.time()}
            if len(self.services) >= 30:
                self.services.pop(next(iter(self.services)))
            self.services[sid] = service
        return self.services[sid]

    def run(self, owner, data):
        session = self.session(owner, data.get('session_id'))
        runtime = validate_runtime(data.get('runtime', session['runtime']))
        if runtime != session['runtime']:
            raise ValueError('切换执行层请新建对应的测试会话。')
        query = data.get('query')
        if not isinstance(query, str) or not query.strip() or len(query) > 2000:
            raise ValueError('请输入 1—2000 字的问题。')
        query = query.strip()
        service = self.service(session)
        with self.db() as db:
            row = db.execute('SELECT payload FROM results WHERE session_id=? AND status=? ORDER BY created DESC LIMIT 1',
                             (session['id'], 'success')).fetchone()
        last = json.loads(row['payload']) if row else {}
        record = {'id': secrets.token_hex(16), 'session_id': session['id'], 'runtime': runtime,
                  'query': query, 'created': time.time(), 'prompt_versions': {},
                  'memories_before': service.store.state(owner), 'trace': []}
        start = time.monotonic()
        try:
            snapshot = service.prompt_snapshot()
            _, record['prompt_versions']['chat'] = service.resolve_prompt('chat', snapshot)
            _, record['prompt_versions']['summary'] = service.resolve_prompt('summary', snapshot)
            if snapshot:
                record['bundle_id'] = snapshot['id']
                record['module_versions'] = snapshot['versions']
            result = service.chat(owner, {'query': query, 'runtime': runtime,
                                  'conversation_id': '' if data.get('new_conversation') else last.get('result', {}).get('conversation_id', '')}, include_trace=True)
            record.update(status='success', result=result, trace=result.pop('trace'), prompt_versions=result['prompt_versions'])
        except (ModelError, ValueError, KeyError) as error:
            record.update(status='error', message=str(error) if isinstance(error, (ModelError, ValueError))
                          and not isinstance(error, json.JSONDecodeError) else '模型结果格式或字段无效。',
                          trace=getattr(error, 'trace', []), observations=getattr(error, 'observations', {}))
            if getattr(error, 'http_status', None):
                record['provider_http_status'] = error.http_status
        record['elapsed_ms'] = round((time.monotonic() - start) * 1000)
        record['memories_after'] = service.store.state(owner)
        record['memory_revision'] = record['memories_after']['revision']
        with self.db() as db:
            db.execute('INSERT INTO results VALUES (?,?,?,?,?,?,?,?,?)',
                       (record['id'], session['id'], owner, runtime, query, record['created'],
                        record['elapsed_ms'], record['status'], json.dumps(record, ensure_ascii=False)))
        return record

    def results(self, owner):
        with self.db() as db:
            return [dict(row) for row in db.execute(
                "SELECT r.id,r.session_id,r.runtime,r.query,r.created,r.elapsed_ms,r.status FROM results r JOIN sessions s ON s.id=r.session_id WHERE r.owner=? AND s.scope='free' ORDER BY r.created DESC LIMIT 30", (owner,))]

    def result(self, owner, rid):
        with self.db() as db:
            row = db.execute("SELECT r.payload FROM results r JOIN sessions s ON s.id=r.session_id WHERE r.id=? AND r.owner=? AND s.scope='free'", (rid, owner)).fetchone()
        if row is None:
            raise PermissionError('测试结果不存在或不属于当前账号。')
        return json.loads(row['payload'])
