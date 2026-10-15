"""Immutable prompt documents, frozen bundles and explicit product activation."""
import difflib
import hashlib
import json
import secrets
import sqlite3
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULES = {
    'understanding': '理解问题', 'retrieval': '组织检索', 'reply': '组织回复',
    'memory': '提取记忆', 'summary': '会话摘要', 'home': '首页回访', 'judge': '评测判定',
}


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def load_contracts():
    contracts = {name: (ROOT / 'prompts' / 'contracts' / (name + '.md')).read_text().strip()
                 for name in ('chat', 'summary')}
    if any(not value for value in contracts.values()):
        raise ValueError('提示词输出契约文档不能为空。')
    return contracts


class PromptRegistry:
    def __init__(self, directory):
        self.path = Path(directory) / 'prompts.sqlite'
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS versions (
                    id TEXT PRIMARY KEY, module TEXT NOT NULL, content TEXT NOT NULL, hash TEXT NOT NULL,
                    parent TEXT NOT NULL, note TEXT NOT NULL, author TEXT NOT NULL, created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS bundles (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, versions TEXT NOT NULL,
                    author TEXT NOT NULL, created REAL NOT NULL, contracts TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS activations (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT, bundle_id TEXT NOT NULL,
                    author TEXT NOT NULL, note TEXT NOT NULL, created REAL NOT NULL);
            ''')
            if 'contracts' not in {r['name'] for r in db.execute('PRAGMA table_info(bundles)')}:
                db.execute("ALTER TABLE bundles ADD COLUMN contracts TEXT NOT NULL DEFAULT ''")
            db.execute("UPDATE bundles SET contracts=? WHERE contracts=''", (json.dumps(load_contracts(), ensure_ascii=False),))
            if db.execute('SELECT COUNT(*) FROM bundles').fetchone()[0] == 0:
                versions = {}
                for module in MODULES:
                    content = (ROOT / 'prompts' / 'modules' / (module + '.md')).read_text()
                    vid = secrets.token_hex(12)
                    db.execute('INSERT INTO versions VALUES (?,?,?,?,?,?,?,?)',
                               (vid, module, content, digest(content), '', '仓库初始文档', 'system', time.time()))
                    versions[module] = vid
                bid = secrets.token_hex(12)
                db.execute('INSERT INTO bundles VALUES (?,?,?,?,?,?)',
                           (bid, '初始提示词组合', json.dumps(versions), 'system', time.time(), json.dumps(load_contracts(), ensure_ascii=False)))
                db.execute('INSERT INTO activations(bundle_id,author,note,created) VALUES (?,?,?,?)',
                           (bid, 'system', '初始化', time.time()))

    def db(self):
        db = sqlite3.connect(str(self.path), timeout=10)
        db.row_factory = sqlite3.Row
        return db

    def catalog(self):
        with self.db() as db:
            versions = [dict(r) for r in db.execute('SELECT id,module,hash,parent,note,author,created FROM versions ORDER BY created DESC')]
            bundles = [dict(r) for r in db.execute('SELECT * FROM bundles ORDER BY created DESC')]
            activations = [dict(r) for r in db.execute('SELECT * FROM activations ORDER BY sequence DESC LIMIT 50')]
        for b in bundles:
            b['versions'] = json.loads(b['versions'])
            b['contracts'] = json.loads(b['contracts'])
        return {'modules': MODULES, 'versions': versions, 'bundles': bundles,
                'active_bundle_id': activations[0]['bundle_id'], 'activations': activations}

    def version(self, vid):
        if not isinstance(vid, str):
            raise ValueError('提示词版本 ID 无效。')
        with self.db() as db:
            row = db.execute('SELECT * FROM versions WHERE id=?', (vid,)).fetchone()
        if row is None:
            raise ValueError('提示词版本不存在。')
        return dict(row)

    def save(self, author, data):
        module, content = data.get('module'), data.get('content')
        if not isinstance(module, str) or module not in MODULES or not isinstance(content, str) or not content.strip() or len(content) > 24000:
            raise ValueError('请选择模块，内容须为 1—24000 字。')
        parent = data.get('parent', '')
        if not isinstance(parent, str):
            raise ValueError('父版本 ID 无效。')
        if parent and self.version(parent)['module'] != module:
            raise ValueError('父版本必须属于同一模块。')
        note = data.get('note', '')
        if not isinstance(note, str) or len(note) > 500:
            raise ValueError('版本说明最长 500 字。')
        vid = secrets.token_hex(12)
        with self.db() as db:
            db.execute('INSERT INTO versions VALUES (?,?,?,?,?,?,?,?)',
                       (vid, module, content.strip(), digest(content.strip()), parent, note, author, time.time()))
        return self.version(vid)

    def bundle(self, bid):
        if not isinstance(bid, str):
            raise ValueError('提示词组合 ID 无效。')
        with self.db() as db:
            row = db.execute('SELECT * FROM bundles WHERE id=?', (bid,)).fetchone()
        if row is None:
            raise ValueError('提示词组合不存在。')
        result = dict(row)
        result['versions'] = json.loads(result['versions'])
        result['contracts'] = json.loads(result['contracts'])
        return result

    def create_bundle(self, author, data):
        name, versions = data.get('name'), data.get('versions')
        if not isinstance(name, str) or not name.strip() or len(name) > 120:
            raise ValueError('组合名称须为 1—120 字。')
        if not isinstance(versions, dict) or set(versions) != set(MODULES):
            raise ValueError('组合须选择全部七个模块版本。')
        for module, vid in versions.items():
            if not isinstance(vid, str) or self.version(vid)['module'] != module:
                raise ValueError('组合模块和版本不匹配。')
        bid = secrets.token_hex(12)
        with self.db() as db:
            db.execute('INSERT INTO bundles VALUES (?,?,?,?,?,?)',
                       (bid, name.strip(), json.dumps(versions), author, time.time(), json.dumps(load_contracts(), ensure_ascii=False)))
        return self.bundle(bid)

    def active_id(self):
        with self.db() as db:
            return db.execute('SELECT bundle_id FROM activations ORDER BY sequence DESC LIMIT 1').fetchone()[0]

    def snapshot(self, bid=None):
        bundle = self.bundle(bid or self.active_id())
        bundle['documents'] = {module: self.version(vid) for module, vid in bundle['versions'].items()}
        return bundle

    @staticmethod
    def resolve(snapshot, name):
        names = {'chat': ('understanding', 'retrieval', 'reply'), 'summary': ('memory', 'summary'),
                 'home': ('home',), 'judge': ('judge',)}[name]
        text = '\n\n'.join(snapshot['documents'][m]['content'] for m in names)
        contract = (snapshot.get('contracts') or load_contracts())[name] if name in ('chat', 'summary') else ''
        text += '\n\n' + contract
        return text, digest(text)

    def activate(self, author, data):
        bid = data.get('bundle_id')
        self.bundle(bid)
        note = data.get('note', '')
        if not isinstance(note, str) or not note.strip() or len(note) > 500:
            raise ValueError('请填写启用或回滚原因（1—500 字）。')
        with self.db() as db:
            current = db.execute('SELECT bundle_id FROM activations ORDER BY sequence DESC LIMIT 1').fetchone()[0]
            if data.get('expected_active') != current:
                raise ValueError('产品启用版本已被其他人修改，请刷新后重试。')
            db.execute('INSERT INTO activations(bundle_id,author,note,created) VALUES (?,?,?,?)', (bid, author, note, time.time()))
        return {'active_bundle_id': bid}

    def diff(self, left, right):
        a, b = self.version(left), self.version(right)
        if a['module'] != b['module']:
            raise ValueError('只能对比同一模块的版本。')
        return {'diff': ''.join(difflib.unified_diff(a['content'].splitlines(True), b['content'].splitlines(True),
                                                   fromfile=a['id'], tofile=b['id']))}

    def import_bundle(self, author, data):
        documents = data.get('documents')
        if not isinstance(documents, dict) or set(documents) != set(MODULES):
            raise ValueError('导入须包含七个模块文档。')
        name = data.get('name', '导入提示词组合')
        if not isinstance(name, str) or not name.strip() or len(name) > 120:
            raise ValueError('组合名称须为 1—120 字。')
        # Validate all documents before writing any immutable versions.
        for module, doc in documents.items():
            if not isinstance(doc, dict) or not isinstance(doc.get('content'), str) or not doc['content'].strip() or len(doc['content']) > 24000:
                raise ValueError('导入提示词文档无效。')
        versions = {module: self.save(author, {'module': module, 'content': doc['content'], 'note': '导入文档'})['id']
                    for module, doc in documents.items()}
        return self.create_bundle(author, {'name': name, 'versions': versions})
