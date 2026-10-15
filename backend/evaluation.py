"""Versioned shared datasets, durable batch records, six assessments and human review."""
import hashlib
import json
import secrets
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from backend.errors import ModelError
from backend.executors import validate_runtime
from backend.model import ModelClient
from backend.prompts import MODULES, PromptRegistry, ROOT
from backend.store import Store
from backend.tools import tool_definitions
from backend.workbench import Workbench

STAGES = {'understanding': '理解问题', 'retrieval': '检索指南', 'reply': '组织回复',
          'memory': '提取记忆', 'summary': '生成摘要', 'overall': '整体输入输出'}
VERDICTS = ('pass', 'fail', 'pending')
RULES = ('contains', 'not_contains', 'status', 'guide_include', 'guide_exclude',
         'tool_called', 'memory_contains', 'memory_not_contains', 'summary_saved', 'followup_count')


def encoded(value):
    return json.dumps(value, ensure_ascii=False)


def string(value, limit, label, empty=False):
    if not isinstance(value, str) or len(value) > limit or (not empty and not value.strip()):
        raise ValueError(f'{label}须为 {0 if empty else 1}—{limit} 字。')
    return value.strip()


def validate_case(case):
    if not isinstance(case, dict):
        raise ValueError('每个用例必须是对象。')
    cid = case.get('id') or secrets.token_hex(12)
    string(cid, 80, '用例ID')
    title = string(case.get('title'), 120, '用例名称')
    tags = case.get('tags', [])
    if not isinstance(tags, list) or len(tags) > 12:
        raise ValueError('分类标签最多 12 个。')
    tags = [string(t, 40, '分类标签') for t in tags]
    enabled = case.get('memory_enabled', True)
    if not isinstance(enabled, bool):
        raise ValueError('记忆开关必须是布尔值。')
    steps = case.get('steps')
    if not isinstance(steps, list) or not 1 <= len(steps) <= 20:
        raise ValueError('每个用例须有 1—20 个步骤。')
    clean = []
    for step in steps:
        if not isinstance(step, dict) or step.get('kind') not in ('chat', 'new_conversation', 'home', 'memory'):
            raise ValueError('步骤类型须为 chat / new_conversation / home / memory。')
        kind = step['kind']
        item = {'kind': kind}
        if kind == 'chat':
            item['query'] = string(step.get('query'), 2000, '输入')
        if kind == 'memory':
            action = step.get('action')
            if action not in ('clear', 'delete_last', 'correct_last', 'settings'):
                raise ValueError('测试记忆操作无效。')
            data = step.get('data', {})
            if not isinstance(data, dict) or len(encoded(data)) > 3000:
                raise ValueError('记忆操作参数无效。')
            if action == 'settings' and not isinstance(data.get('enabled'), bool):
                raise ValueError('记忆设置须提供 enabled 布尔值。')
            if action == 'correct_last':
                string(data.get('text'), 800, '纠正后的摘要')
                if data.get('problem_status', 'unknown') not in ('resolved', 'unresolved', 'unknown'):
                    raise ValueError('纠正后的问题状态无效。')
            item.update(action=action, data=data)
        clean.append(item)
    if not any(s['kind'] in ('chat', 'home') for s in clean):
        raise ValueError('用例至少包含一次聊天或首页回访。')
    criteria = case.get('criteria', {})
    if not isinstance(criteria, dict) or set(criteria) - set(STAGES):
        raise ValueError('评测环节无效。')
    criteria = {key: string(criteria.get(key, ''), 2000, '评测标准', True) for key in STAGES}
    rules = case.get('rules', [])
    if not isinstance(rules, list) or len(rules) > 40:
        raise ValueError('自动规则最多 40 条。')
    normalized_rules = []
    for rule in rules:
        if not isinstance(rule, dict) or rule.get('stage') not in STAGES or rule.get('type') not in RULES:
            raise ValueError('自动规则的环节或类型无效。')
        index = rule.get('step', len(clean))
        if type(index) is not int or not 1 <= index <= len(clean):
            raise ValueError('规则的 step 是从 1 开始的步骤编号。')
        target_kind = clean[index - 1]['kind']
        if (rule['type'] in ('status', 'guide_include', 'guide_exclude') and target_kind not in ('chat', 'home')
                or rule['type'] in ('tool_called', 'summary_saved') and target_kind != 'chat'
                or rule['type'] == 'followup_count' and target_kind != 'home'):
            raise ValueError('自动规则类型与目标步骤不匹配。')
        value = rule.get('value')
        if rule['type'] == 'summary_saved':
            if not isinstance(value, bool):
                raise ValueError('summary_saved 的值必须为布尔值。')
        elif rule['type'] == 'followup_count':
            if type(value) is not int or not 0 <= value <= 3:
                raise ValueError('followup_count 的值须为 0—3。')
        else:
            string(value, 1000, '规则值')
        normalized_rules.append({'stage': rule['stage'], 'type': rule['type'], 'step': index, 'value': value})
    return {'id': cid, 'title': title, 'tags': tags, 'memory_enabled': enabled, 'steps': clean,
            'criteria': criteria, 'rules': normalized_rules,
            'reference_answer': string(case.get('reference_answer', ''), 5000, '参考答案', True)}


class FrozenClient(ModelClient):
    """Keep a real batch on one model configuration, credentials stay in process memory."""
    def __init__(self, client):
        self.values = client.config()
        self.sdk_values = ModelClient.sdk_config(self)

    def config(self):
        return self.values

    def sdk_config(self):
        return self.sdk_values


class Evaluation:
    def __init__(self, directory, client, registry, executors=None, start_workers=True):
        self.directory, self.client, self.registry, self.executors = directory, client, registry, executors
        self.path = registry.path.parent / 'evaluations.sqlite'
        self.lock = threading.Lock()
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='evaluation') if start_workers else None
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS datasets (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, current INTEGER NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0, author TEXT NOT NULL, updated REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS dataset_versions (
                    dataset_id TEXT NOT NULL, version INTEGER NOT NULL, cases TEXT NOT NULL,
                    author TEXT NOT NULL, created REAL NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
                    PRIMARY KEY(dataset_id,version));
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY, owner TEXT NOT NULL, status TEXT NOT NULL, created REAL NOT NULL,
                    updated REAL NOT NULL, spec TEXT NOT NULL, cancel INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '');
                CREATE TABLE IF NOT EXISTS evaluations (
                    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, owner TEXT NOT NULL, case_id TEXT NOT NULL,
                    variant TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS reviews (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, evaluation_id TEXT NOT NULL, stage TEXT NOT NULL,
                    verdict TEXT NOT NULL, note TEXT NOT NULL, author TEXT NOT NULL, created REAL NOT NULL);
            ''')
            columns = {r['name'] for r in db.execute('PRAGMA table_info(dataset_versions)')}
            for column in ('name', 'description'):
                if column not in columns:
                    db.execute(f"ALTER TABLE dataset_versions ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
                    db.execute(f'UPDATE dataset_versions SET {column}=(SELECT {column} FROM datasets WHERE datasets.id=dataset_versions.dataset_id)')
            db.execute("UPDATE jobs SET status='interrupted', message='服务重启中断了任务；可用原始快照重新运行。', updated=? WHERE status IN ('queued','running')", (time.time(),))
            for row in db.execute('SELECT id,spec FROM jobs').fetchall():
                spec, changed = json.loads(row['spec']), False
                for variant in spec['variants']:
                    if 'contracts' not in variant['bundle']:
                        variant['bundle']['contracts'] = self.registry.bundle(variant['bundle']['id'])['contracts']
                        changed = True
                if changed:
                    db.execute('UPDATE jobs SET spec=? WHERE id=?', (encoded(spec), row['id']))
            empty = db.execute('SELECT COUNT(*) FROM datasets').fetchone()[0] == 0
        if empty:
            starter = json.loads((ROOT / 'data' / 'evaluation-starter.json').read_text())
            self.save_dataset('system', starter)
        # Retain early workbench records, but never allow an evaluation session to be resumed in free tests.
        legacy = self.path.parent / 'workbench' / 'tests.sqlite'
        if legacy.exists():
            with self.db() as db, sqlite3.connect(legacy) as tests:
                columns = {r[1] for r in tests.execute('PRAGMA table_info(sessions)')}
                if 'scope' not in columns:
                    tests.execute("ALTER TABLE sessions ADD COLUMN scope TEXT NOT NULL DEFAULT 'free'")
                for row in db.execute('SELECT owner,payload FROM evaluations'):
                    sid = json.loads(row['payload']).get('session_id')
                    if sid:
                        tests.execute("UPDATE sessions SET scope='evaluation' WHERE id=? AND owner=?", (sid, row['owner']))

    def db(self):
        db = sqlite3.connect(str(self.path), timeout=20)
        db.row_factory = sqlite3.Row
        return db

    def datasets(self):
        with self.db() as db:
            return [dict(r) for r in db.execute('SELECT * FROM datasets WHERE archived=0 ORDER BY updated DESC')]

    def dataset(self, did, version=None):
        if not isinstance(did, str):
            raise ValueError('评测集 ID 无效。')
        with self.db() as db:
            row = db.execute('SELECT * FROM datasets WHERE id=?', (did,)).fetchone()
            if row is None:
                raise ValueError('评测集不存在。')
            d = dict(row)
            if version is not None and (type(version) is not int or version < 1):
                raise ValueError('评测集版本无效。')
            version = version or d['current']
            r = db.execute('SELECT * FROM dataset_versions WHERE dataset_id=? AND version=?', (did, version)).fetchone()
            if r is None:
                raise ValueError('评测集版本不存在。')
            d.update(version=version, cases=json.loads(r['cases']), name=r['name'], description=r['description'])
            d['history'] = [dict(r) for r in db.execute('SELECT version,author,created FROM dataset_versions WHERE dataset_id=? ORDER BY version DESC', (did,))]
            return d

    def save_dataset(self, author, data):
        name = string(data.get('name'), 120, '评测集名称')
        description = string(data.get('description', ''), 2000, '评测集说明', True)
        cases = data.get('cases', [])
        if not isinstance(cases, list) or len(cases) > 200:
            raise ValueError('每个评测集最多 200 个用例。')
        cases = [validate_case(c) for c in cases]
        if len({c['id'] for c in cases}) != len(cases):
            raise ValueError('同一评测集中用例 ID 不能重复。')
        did = data.get('id') or secrets.token_hex(12)
        now = time.time()
        with self.lock, self.db() as db:
            existing = db.execute('SELECT * FROM datasets WHERE id=?', (did,)).fetchone()
            if existing:
                if data.get('expected_version') != existing['current']:
                    raise ValueError('评测集已被其他人修改，请刷新后再保存。')
                version = existing['current'] + 1
                db.execute('UPDATE datasets SET name=?,description=?,current=?,archived=0,updated=? WHERE id=?', (name, description, version, now, did))
            else:
                version = 1
                db.execute('INSERT INTO datasets VALUES (?,?,?,?,?,?,?)', (did, name, description, version, 0, author, now))
            db.execute('INSERT INTO dataset_versions VALUES (?,?,?,?,?,?,?)', (did, version, encoded(cases), author, now, name, description))
        return self.dataset(did)

    def archive(self, data):
        with self.db() as db:
            changed = db.execute('UPDATE datasets SET archived=1,updated=? WHERE id=? AND current=?',
                                 (time.time(), data.get('id'), data.get('expected_version'))).rowcount
        if not changed:
            raise ValueError('评测集版本已变更或不存在。')
        return {'ok': True}

    def create_job(self, owner, data):
        dataset = self.dataset(data.get('dataset_id'), data.get('dataset_version'))
        selected = data.get('case_ids', [c['id'] for c in dataset['cases']])
        if not isinstance(selected, list) or not selected or any(not isinstance(cid, str) for cid in selected):
            raise ValueError('请至少选择一个用例。')
        cases = [c for c in dataset['cases'] if c['id'] in selected]
        if len(cases) != len(set(selected)):
            raise ValueError('选中的用例不存在于此版本。')
        variants = data.get('variants')
        if not isinstance(variants, list) or not 1 <= len(variants) <= 2:
            raise ValueError('选择一或两个对比方案。')
        snapshots = []
        for index, v in enumerate(variants):
            if not isinstance(v, dict):
                raise ValueError('执行方案格式无效。')
            snapshots.append({'label': 'AB'[index], 'runtime': validate_runtime(v.get('runtime', 'claude-sdk')),
                              'bundle': self.registry.snapshot(v.get('bundle_id'))})
        judge_id = data.get('judge_version_id') or snapshots[0]['bundle']['versions']['judge']
        judge = self.registry.version(judge_id)
        if judge['module'] != 'judge':
            raise ValueError('判定版本须属于评测判定模块。')
        model = FrozenClient(self.client) if isinstance(self.client, ModelClient) else self.client
        spec = {'dataset_id': dataset['id'], 'dataset_name': dataset['name'], 'dataset_version': dataset['version'],
                'cases': cases, 'variants': snapshots, 'judge': judge,
                'model': model.ready(), 'tool_hash': hashlib.sha256(encoded(tool_definitions()).encode()).hexdigest(),
                'guide_hash': hashlib.sha256((ROOT / 'data' / 'guide.json').read_bytes()).hexdigest()}
        return self.enqueue(owner, spec, model)

    def enqueue(self, owner, spec, model=None):
        jid, now = secrets.token_hex(16), time.time()
        with self.lock, self.db() as db:
            active = db.execute("SELECT owner FROM jobs WHERE status IN ('queued','running')").fetchall()
            if len(active) >= 20 or sum(r['owner'] == owner for r in active) >= 3:
                raise ValueError('已有批量任务在排队，请等待完成或取消后再创建。')
            db.execute('INSERT INTO jobs(id,owner,status,created,updated,spec) VALUES (?,?,?,?,?,?)',
                       (jid, owner, 'queued', now, now, encoded(spec)))
        if self.pool:
            self.pool.submit(self.execute_job, owner, jid, model or self.client)
        return self.job(owner, jid)

    def jobs(self, owner):
        with self.db() as db:
            ids = [r[0] for r in db.execute('SELECT id FROM jobs WHERE owner=? ORDER BY created DESC LIMIT 50', (owner,))]
        return [self.job(owner, jid, full=False) for jid in ids]

    def job(self, owner, jid, full=True):
        with self.db() as db:
            r = db.execute('SELECT * FROM jobs WHERE id=? AND owner=?', (jid, owner)).fetchone()
            if r is None:
                raise PermissionError('批量任务不存在或不属于当前账号。')
            d = dict(r)
            spec = json.loads(d.pop('spec'))
            rows = [dict(r) for r in db.execute('SELECT id,case_id,variant,status FROM evaluations WHERE job_id=? ORDER BY created', (jid,))]
            reviews = [dict(r) for r in db.execute('SELECT r.* FROM reviews r JOIN evaluations e ON e.id=r.evaluation_id WHERE e.job_id=? ORDER BY r.id', (jid,))]
        d.update(dataset_name=spec['dataset_name'], dataset_version=spec['dataset_version'],
                 total=len(spec['cases']) * len(spec['variants']), completed=len(rows), results=rows)
        d['variants'] = [{'label': v['label'], 'runtime': v['runtime'], 'bundle_id': v['bundle']['id'], 'bundle_name': v['bundle']['name']} for v in spec['variants']]
        d['counts'] = {v['label']: {x: 0 for x in VERDICTS} for v in spec['variants']}
        d['review_counts'] = {v['label']: {'unreviewed': 0, **{x: 0 for x in VERDICTS}} for v in spec['variants']}
        latest = {(r['evaluation_id'], r['stage']): r for r in reviews}
        for row in rows:
            d['counts'][row['variant']][row['status']] += 1
            verdict = latest.get((row['id'], 'overall'), {}).get('verdict', 'unreviewed')
            d['review_counts'][row['variant']][verdict] += 1
        if full:
            d['snapshot'] = spec
        return d

    def cancel(self, owner, jid):
        self.job(owner, jid, False)
        with self.db() as db:
            db.execute("UPDATE jobs SET cancel=1,updated=? WHERE id=? AND status IN ('queued','running')", (time.time(), jid))
        return self.job(owner, jid, False)

    def rerun(self, owner, jid, failed_only=False):
        old = self.job(owner, jid)
        if old['status'] in ('queued', 'running'):
            raise ValueError('请等待任务结束再重跑。')
        spec = old['snapshot']
        if any(v['runtime'] != 'claude-sdk' for v in spec['variants']):
            raise ValueError('原快照含已停用的执行层；历史记录保留，请新建 SDK 任务。')
        if failed_only:
            ids = {r['case_id'] for r in old['results'] if r['status'] != 'pass'}
            for record in old['results']:
                reviewed = self.result(owner, record['id'])['latest_reviews']
                if any(r['verdict'] != 'pass' for r in reviewed.values()):
                    ids.add(record['case_id'])
            completed = {(r['case_id'], r['variant']) for r in old['results']}
            ids.update(c['id'] for c in spec['cases'] if any((c['id'], v['label']) not in completed for v in spec['variants']))
            spec['cases'] = [c for c in spec['cases'] if c['id'] in ids]
            if not spec['cases']:
                raise ValueError('没有失败、待确认或未完成的用例。')
        model = FrozenClient(self.client) if isinstance(self.client, ModelClient) else self.client
        if model.ready() != spec['model']:
            raise ValueError('模型配置已变更，请新建任务；原记录保留。')
        spec['rerun_of'] = jid
        return self.enqueue(owner, spec, model)

    def execute_job(self, owner, jid, model=None):
        def update(status, message=''):
            with self.db() as db:
                db.execute('UPDATE jobs SET status=?,message=?,updated=? WHERE id=?', (status, message, time.time(), jid))
        def cancelled():
            with self.db() as db:
                return bool(db.execute('SELECT cancel FROM jobs WHERE id=?', (jid,)).fetchone()[0])
        spec = self.job(owner, jid)['snapshot']
        if any(v['runtime'] != 'claude-sdk' for v in spec['variants']):
            update('interrupted', '原快照含已停用的执行层；历史记录保留，请新建 SDK 任务。')
            return
        update('running')
        model = model or self.client
        bench = Workbench(self.path.parent / 'evaluation-runs' / jid, model, self.executors, self.registry)
        try:
            for case in spec['cases']:
                for variant in spec['variants']:
                    if cancelled():
                        update('cancelled', '已取消；已完成的结果保留。')
                        return
                    if hashlib.sha256((ROOT / 'data' / 'guide.json').read_bytes()).hexdigest() != spec['guide_hash'] or hashlib.sha256(encoded(tool_definitions()).encode()).hexdigest() != spec['tool_hash']:
                        update('interrupted', '指南或工具版本已变化，停止当前批次。')
                        return
                    result = self.run_case(bench, owner, case, variant, spec)
                    result['assessments'], result['judge_status'] = assess_case(model, spec['judge'], case, result)
                    result.update(id=secrets.token_hex(16), job_id=jid, created=time.time(),
                                  case=case, variant=variant['label'], runtime=variant['runtime'],
                                  bundle_id=variant['bundle']['id'])
                    with self.db() as db:
                        db.execute('INSERT INTO evaluations VALUES (?,?,?,?,?,?,?,?)',
                                   (result['id'], jid, owner, case['id'], variant['label'],
                                    result['assessments']['overall']['verdict'], encoded(result), result['created']))
                        db.execute('UPDATE jobs SET updated=? WHERE id=?', (time.time(), jid))
                    if result.get('dependency_http_status') in (401, 402):
                        update('interrupted', '模型接口返回 HTTP %s，停止剩余用例；检查模型凭据或余额后按原快照重跑。' % result['dependency_http_status'])
                        return
            update('cancelled' if cancelled() else 'completed')
        except Exception:
            # Third-party errors can include credentials: never expose exception repr/remote bodies.
            update('interrupted', '任务发生运行错误；已完成结果保留，可检查模型与运行配置后重跑。')

    def run_case(self, bench, owner, case, variant, spec=None):
        session = bench.create_session(owner, variant['runtime'], case['memory_enabled'], snapshot=variant['bundle'])
        service = bench.service(bench.session(owner, session['session_id']))
        records, fresh, start = [], False, time.monotonic()
        def versions_match():
            return not spec or (hashlib.sha256((ROOT / 'data' / 'guide.json').read_bytes()).hexdigest() == spec['guide_hash']
                                and hashlib.sha256(encoded(tool_definitions()).encode()).hexdigest() == spec['tool_hash'])
        for index, step in enumerate(case['steps'], 1):
            before = service.store.state(owner)
            record = {'step': index, 'kind': step['kind'], 'input': step, 'memories_before': before}
            try:
                if not versions_match():
                    raise ValueError('指南或工具版本发生变化。')
                if step['kind'] == 'chat':
                    run = bench.run(owner, {**session, 'query': step['query'], 'new_conversation': fresh})
                    record.update(execution=run, status=run['status'], observations=run.get('result', {}).get('observations', run.get('observations', {})))
                    fresh = False
                elif step['kind'] == 'new_conversation':
                    fresh = True
                    record.update(status='success', output='新会话，保留本用例的有效长期记忆。')
                elif step['kind'] == 'home':
                    output = service.home(owner, include_trace=True)
                    record.update(status='success', output=output, observations=output.get('observations', {}))
                else:
                    action, data = step['action'], dict(step.get('data', {}))
                    if action in ('delete_last', 'correct_last'):
                        memories = before['effective']
                        if not memories:
                            raise ValueError('本用例还没有可删除或纠正的有效摘要。')
                        data['id'] = memories[-1]['id']
                        action = 'delete' if action == 'delete_last' else 'correct_summary'
                    service.store.change(owner, action, data)
                    record.update(status='success', output='测试记忆管理已执行。')
                if not versions_match():
                    record.update(status='error', message='指南或工具版本已变化，此步骤失效。')
            except (ModelError, ValueError, KeyError, PermissionError):
                record.update(status='error', message='此步骤运行或校验失败。')
            record['memories_after'] = service.store.state(owner)
            records.append(record)
            unavailable = record.get('execution', {}).get('provider_http_status') or record.get('execution', {}).get('result', {}).get('summary', {}).get('provider_http_status')
            if record['status'] == 'error' or unavailable in (401, 402):
                break
        unavailable = next((status for s in records for status in
                           (s.get('execution', {}).get('provider_http_status'),
                            s.get('execution', {}).get('result', {}).get('summary', {}).get('provider_http_status')) if status in (401, 402)), None)
        return {'session_id': session['session_id'], 'steps': records, 'dependency_http_status': unavailable,
                'execution_status': 'error' if len(records) < len(case['steps']) or any(r['status'] == 'error' for r in records) else 'success',
                'elapsed_ms': round((time.monotonic() - start) * 1000)}

    def result(self, owner, rid):
        with self.db() as db:
            row = db.execute('SELECT payload FROM evaluations WHERE id=? AND owner=?', (rid, owner)).fetchone()
            if row is None:
                raise PermissionError('评测结果不存在或不属于当前账号。')
            result = json.loads(row['payload'])
            history = [dict(r) for r in db.execute('SELECT * FROM reviews WHERE evaluation_id=? ORDER BY id', (rid,))]
        result['reviews'] = history
        result['latest_reviews'] = {r['stage']: r for r in history}
        return result

    def review(self, owner, rid, data):
        self.result(owner, rid)
        stage, verdict = data.get('stage'), data.get('verdict')
        if stage not in STAGES or verdict not in VERDICTS:
            raise ValueError('复核环节或结论无效。')
        note = string(data.get('note'), 2000, '复核依据')
        with self.db() as db:
            db.execute('INSERT INTO reviews(evaluation_id,stage,verdict,note,author,created) VALUES (?,?,?,?,?,?)',
                       (rid, stage, verdict, note, owner, time.time()))
        return self.result(owner, rid)

    def tested_bundle(self, bid):
        # Previously activated bundles may always be restored; new bundles require an executed case.
        with self.registry.db() as db:
            if db.execute('SELECT 1 FROM activations WHERE bundle_id=?', (bid,)).fetchone():
                return True
        with self.db() as db:
            for row in db.execute("SELECT e.payload FROM evaluations e JOIN jobs j ON j.id=e.job_id WHERE j.status='completed'"):
                payload = json.loads(row['payload'])
                if payload.get('bundle_id') == bid and payload.get('execution_status') == 'success':
                    return True
        return False

    def export(self, owner, jid):
        job = self.job(owner, jid)
        job['records'] = [self.result(owner, r['id']) for r in job['results']]
        return job


def evidence_map(result):
    evidence = {}
    for step in result['steps']:
        prefix = 'step:' + str(step['step'])
        evidence[prefix + ':input'] = step['input']
        evidence[prefix + ':memory_before'] = step['memories_before']
        evidence[prefix + ':memory_after'] = step['memories_after']
        for stage, observation in step.get('observations', {}).items():
            evidence[prefix + ':' + stage] = observation
        if 'execution' in step:
            evidence[prefix + ':answer'] = step['execution'].get('result', {}).get('result', step['execution'].get('message'))
        if 'output' in step:
            evidence[prefix + ':output'] = step['output']
    return evidence


def rule_check(rule, result):
    step = next((s for s in result['steps'] if s['step'] == rule['step']), None)
    if not step or step['status'] != 'success':
        return None, '目标步骤没有成功输出。'
    answer = step.get('execution', {}).get('result', {}).get('result', step.get('output', {}).get('result', {}) if isinstance(step.get('output'), dict) else {})
    value, kind = rule['value'], rule['type']
    observation = step.get('observations', {}).get(rule['stage'], {})
    output = observation.get('output')
    if kind in ('contains', 'not_contains') and rule['stage'] != 'overall' and output is None:
        return None, '此环节没有可观察的输出，不能用最终答案替代。'
    text = encoded(output if output is not None else answer) if rule['stage'] != 'overall' else encoded(answer)
    memory_text = encoded(step['memories_after']['effective'])
    gids = [c['guide_id'] for c in answer.get('cards', [])]
    if kind == 'contains': ok = value in text
    elif kind == 'not_contains': ok = value not in text
    elif kind == 'status': ok = value == answer.get('status')
    elif kind == 'guide_include': ok = value in gids
    elif kind == 'guide_exclude': ok = value not in gids
    elif kind == 'tool_called': ok = any(e.get('tool') == value and e.get('status') == 'ok' for e in step.get('execution', {}).get('trace', []))
    elif kind == 'memory_contains': ok = value in memory_text
    elif kind == 'memory_not_contains': ok = value not in memory_text
    elif kind == 'summary_saved': ok = step.get('execution', {}).get('result', {}).get('summary', {}).get('saved') is value
    else: ok = len(answer.get('followups', [])) == value
    return ok, f"步骤 {rule['step']} · {kind} · {encoded(value)}"


def assess_case(client, judge, case, result):
    evidence = evidence_map(result)
    assessment = {s: {'verdict': 'pending', 'reason': '未提供判定标准，等待人工复核。', 'evidence': [], 'rules': []} for s in STAGES}
    judge_status = 'not_needed'
    semantic = any(case['criteria'].values())
    if result.get('dependency_http_status'):
        judge_status = 'unavailable'
        for item in assessment.values():
            item['reason'] = '模型服务不可用，语义判定未运行。'
    elif semantic:
        judge_status = 'completed'
        try:
            inp = {'criteria': case['criteria'], 'reference_answer': case['reference_answer'],
                   'rules': case['rules'], 'evidence_map': evidence, 'execution_status': result['execution_status'],
                   'memory_enabled': case['memory_enabled']}
            message = client.complete([{'role': 'system', 'content': judge['content']}, {'role': 'user', 'content': encoded(inp)}])
            values = Store.model_json(message.get('content', ''))['assessments']
            if not isinstance(values, dict) or set(values) != set(STAGES):
                raise ValueError()
            for stage in STAGES:
                item = values[stage]
                refs = item.get('evidence')
                if item.get('verdict') not in VERDICTS or not isinstance(item.get('reason'), str) or len(item['reason']) > 600 or not isinstance(refs, list) or len(refs) > 8 or any(not isinstance(r, str) or r not in evidence for r in refs):
                    raise ValueError()
                if case['criteria'][stage]:
                    if item['verdict'] != 'pending' and not refs:
                        item = {'verdict': 'pending', 'reason': '判定没有提供有效证据引用。', 'evidence': []}
                    assessment[stage].update(verdict=item['verdict'], reason=item['reason'], evidence=item['evidence'])
        except (ModelError, ValueError, KeyError, TypeError) as error:
            judge_status = 'error'
            if getattr(error, 'http_status', None) in (401, 402):
                result['dependency_http_status'] = error.http_status
            for stage in STAGES:
                if case['criteria'][stage]:
                    assessment[stage].update(reason='系统语义判定失败，等待人工复核。')
    for rule in case['rules']:
        ok, message = rule_check(rule, result)
        stage = rule['stage']
        ref_stage = 'memory_after' if rule['type'].startswith('memory_') else 'retrieval' if rule['type'] == 'tool_called' else 'summary' if rule['type'] == 'summary_saved' else 'answer' if rule['stage'] == 'overall' else rule['stage']
        assessment[stage]['rules'].append({'verdict': 'pending' if ok is None else 'pass' if ok else 'fail', 'message': message,
                                           'evidence': 'step:' + str(rule['step']) + ':' + ref_stage})
    for stage, item in assessment.items():
        checks = item['rules']
        if any(r['verdict'] == 'fail' for r in checks):
            item.update(verdict='fail', reason='自动规则未满足；查看规则结果与目标步骤。')
        elif any(r['verdict'] == 'pending' for r in checks):
            item.update(verdict='pending', reason='规则目标步骤未运行，等待复核。')
        elif checks and not case['criteria'][stage]:
            item.update(verdict='pass', reason='本环节已配置的自动规则全部满足。')
    if result['execution_status'] == 'error':
        assessment['overall'].update(verdict='fail', reason='用例存在执行或后端校验失败，不能判为通过。')
    # Missing intermediate output never becomes a claim about a hidden model process.
    chats = [s for s in result['steps'] if s.get('kind', s['input'].get('kind')) == 'chat']
    if case['criteria']['understanding'] and (not chats or any(s.get('observations', {}).get('understanding', {}).get('status') != 'observed' for s in chats)):
        assessment['understanding'].update(verdict='pending', reason='没有可观察的任务理解输出，不能从最终答案定位理解过程。')
    return assessment, judge_status
