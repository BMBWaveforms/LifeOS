"""Application-owned guide tools shared by every execution engine."""
import json
import time
from pathlib import Path
from backend.errors import ModelError

ROOT = Path(__file__).resolve().parents[1]


def tool_definitions():
    definitions = json.loads((ROOT / 'prompts/tools.json').read_text())
    names = [t['function']['name'] for t in definitions] if isinstance(definitions, list) else []
    if set(names) != {'search_entries', 'get_entry'} or len(names) != 2:
        raise ModelError('工具定义必须保持两个授权的只读指南工具。')
    return definitions


class GuideTools:
    def __init__(self, store, owner, run_id):
        self.store, self.owner, self.run_id = store, owner, run_id
        self.definitions = tool_definitions()
        self.schemas = {t['function']['name']: t['function']['parameters'] for t in self.definitions}
        self.handlers = {'search_entries': self.search_entries, 'get_entry': self.get_entry}
        self.trace = []
        self.calls = 0
        self.failure = None

    def invoke(self, name, args):
        start = time.monotonic()
        try:
            if name not in self.handlers:
                raise ModelError('模型请求了未授权工具，已停止本次答复。')
            schema = self.schemas[name]
            if (not isinstance(args, dict) or set(args) != set(schema['required'])
                    or any(not isinstance(v, str) or not v.strip() or len(v) > 2000 for v in args.values())):
                raise ModelError('指南工具参数无效，已停止本次答复。')
            if self.calls >= 24:
                raise ModelError('指南工具调用达到上限，请缩小问题范围。')
            self.calls += 1
            with self.store.lock:
                run = self.store.run(self.run_id)
                if run['owner'] != self.owner:
                    raise ModelError('工具运行归属无效，已停止本次答复。')
                output = self.handlers[name](args, run)
            self.trace.append({'type': 'tool', 'tool': name, 'input': args, 'output': output,
                               'status': 'ok', 'elapsed_ms': round((time.monotonic() - start) * 1000)})
            return output
        except (ModelError, ValueError, KeyError) as error:
            self.failure = error
            self.trace.append({'type': 'tool', 'tool': name, 'status': 'error',
                               'message': '工具调用失败，本轮结果不能用于答复。'})
            raise

    def search_entries(self, args, run):
        blocked = {f['guide_id'] for f in run['feedback']}
        entries = self.store.search(args['query'])
        return {'entries': [{'guide_id': e['guide_id'], 'title': e['title']} for e in entries if e['guide_id'] not in blocked],
                'content_version': self.store.guide['content_version']}

    def get_entry(self, args, run):
        gid = args['guide_id']
        if gid not in self.store.entries:
            return {'status': 'error', 'message': '条目不存在，不能引用。'}
        entry = self.store.entries[gid]
        if not entry.get('complete'):
            raise ModelError('指南正文不完整，已停止本次答复。')
        run['reads'].add(gid)
        return entry
