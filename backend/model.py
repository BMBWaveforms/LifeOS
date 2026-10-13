"""Direct OpenAI-compatible model API. No workflow platform or server-side DSL."""
import json
import os
import time
from pathlib import Path
from urllib.parse import urlparse
import httpx
from backend.config import load_local_env
load_local_env()

ROOT = Path(__file__).resolve().parents[1]

class ModelError(RuntimeError):
    pass

class ModelClient:
    def config(self):
        path = Path(os.getenv('API_CONFIG_FILE', str(ROOT.parent / 'api.json')))
        data = {}
        if path.exists():
            text = path.read_text().strip()
            if text:
                try:
                    data = json.loads(text)
                except ValueError:
                    data = {'api_key': text} if len(text.splitlines()) == 1 and text.startswith('sk-') else {}
        if not isinstance(data, dict):
            raise ModelError('API 配置应为 JSON 对象。')
        key = os.getenv('MODEL_API_KEY') or data.get('api_key') or data.get('apikey') or data.get('key')
        base = os.getenv('MODEL_BASE_URL') or data.get('base_url') or data.get('api_base') or 'https://api.deepseek.com/v1'
        model = os.getenv('MODEL_NAME') or data.get('model') or 'deepseek-flash'
        parsed = urlparse(base)
        if parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ModelError('模型接口必须是无凭据、无查询参数的 HTTPS 地址。')
        if not isinstance(key, str) or not key.strip():
            raise ModelError('尚未配置模型 API Key，请补齐后端 API 配置文件。')
        return key.strip(), base.rstrip('/'), model

    def ready(self):
        try:
            _, _, model = self.config()
            return {'configured': True, 'model': model}
        except (ModelError, OSError, ValueError):
            return {'configured': False, 'model': ''}

    def complete(self, messages, tools=None, timeout=75):
        key, base, model = self.config()
        payload = {'model': model, 'messages': messages, 'stream': False, 'temperature': 0.1, 'max_tokens': 4096}
        if urlparse(base).hostname == 'api.deepseek.com':
            payload['thinking'] = {'type': 'disabled'}
        if tools:
            payload['tools'] = tools
            payload['tool_choice'] = 'auto'
        else:
            payload['response_format'] = {'type': 'json_object'}
        try:
            with httpx.Client(timeout=timeout, trust_env=False) as client:
                r = client.post(base + '/chat/completions', json=payload,
                                headers={'Authorization': 'Bearer ' + key})
                if r.status_code != 200:
                    raise ModelError('模型接口返回 HTTP %d，请检查模型名、余额和接口配置。' % r.status_code)
                d = r.json()
                result = d['choices'][0]['message']
                if not isinstance(result, dict):
                    raise ValueError()
                return result
        except (httpx.HTTPError, ValueError, KeyError, IndexError):
            # Do not expose remote response bodies, HTTP headers or credential values.
            raise ModelError('模型调用超时或响应异常，本次未生成可靠结果。') from None


def prompt(name):
    import hashlib
    text = (ROOT / 'prompts' / (name + '.md')).read_text()
    if not text.strip():
        raise ModelError('提示词文件为空。')
    return text, hashlib.sha256(text.encode()).hexdigest()


def tool_definitions():
    definitions = json.loads((ROOT / 'prompts/tools.json').read_text())
    if not isinstance(definitions, list) or {t['function']['name'] for t in definitions} != {'search_entries','get_entry'}:
        raise ModelError('工具定义必须保持两个授权的只读指南工具。')
    return definitions


class AgentService:
    def __init__(self, store, client=None):
        self.store = store
        self.client = client or ModelClient()
        self.conversations = {}

    def json_call(self, name, data):
        instruction, version = prompt(name)
        message = self.client.complete([{'role': 'system', 'content': instruction},
                                       {'role': 'user', 'content': json.dumps(data, ensure_ascii=False)}])
        return message.get('content') or '', version

    def chat(self, owner, data):
        import secrets
        query = str(data.get('query', '')).strip()
        if not query or len(query) > 2000:
            raise ValueError('请输入 1—2000 字的问题。')
        c = self.store.context(owner, query, 'chat', followup_memory_id=str(data.get('followup_memory_id') or ''))
        rid = c['run_id']
        instruction, version = prompt('chat')
        cid = str(data.get('conversation_id') or '')
        saved = self.conversations.get((owner, cid))
        # Any management change invalidates both old model output and short-term history.
        history = saved['messages'] if saved and saved['revision'] == c['memory_revision'] else []
        if not history:
            cid = secrets.token_urlsafe(18)
        messages = [{'role': 'system', 'content': instruction}] + history[-12:] + [
            {'role': 'user', 'content': json.dumps(c, ensure_ascii=False)}]
        start = time.monotonic()
        raw = None
        tool_calls = 0
        for _ in range(7):
            remaining = 180 - (time.monotonic() - start)
            if remaining <= 0:
                raise ModelError('指南检索超时，请重试。')
            message = self.client.complete(messages, tools=tool_definitions(), timeout=min(75, remaining))
            calls = message.get('tool_calls') or []
            if not calls:
                raw = message.get('content') or ''
                break
            if len(calls) > 12 or tool_calls + len(calls) > 24:
                raise ModelError('指南工具调用达到上限，请缩小问题范围。')
            # Keep compatible reasoning content for models that require it in tool loops.
            messages.append({k: v for k, v in message.items() if k in ('role', 'content', 'tool_calls', 'reasoning_content')})
            for call in calls:
                with self.store.lock:
                    run = self.store.run(rid)
                    function = call['function']
                    args = json.loads(function['arguments'])
                    if function['name'] == 'search_entries':
                        entries = self.store.search(args['query'])
                        blocked = {f['guide_id'] for f in run['feedback']}
                        output = {'entries': [{'guide_id': e['guide_id'], 'title': e['title']} for e in entries if e['guide_id'] not in blocked],
                                  'content_version': self.store.guide['content_version']}
                    elif function['name'] == 'get_entry':
                        gid = args['guide_id']
                        if gid not in self.store.entries:
                            output = {'status': 'error', 'message': '条目不存在，不能引用。'}
                        else:
                            output = self.store.entries[gid]
                            if not output.get('complete'):
                                raise ModelError('指南正文不完整，已停止本次答复。')
                            run['reads'].add(gid)
                    else:
                        raise ModelError('模型请求了未授权工具，已停止本次答复。')
                messages.append({'role': 'tool', 'tool_call_id': call['id'],
                                 'content': json.dumps(output, ensure_ascii=False)})
                tool_calls += 1
        if raw is None:
            raise ModelError('指南检索达到轮次上限，请重试。')
        result = self.store.finalize(owner, rid, raw)
        summary = {'saved': False, 'message': '记忆已关闭，本轮不保存摘要。'}
        versions = {'chat': version}
        if c['memory_enabled']:
            inp = {'query': query, 'followup_memory_id': (c['followup'] or {}).get('id', ''),
                   'previous_memories': [m for m in c['memories'] if m.get('origin') == 'model_summary'],
                   'answer_status': result['status'], 'clarification': result['clarification'],
                   'assistant_answer': result['markdown'][:6000],
                   'consulted_guides': [{'guide_id': g['guide_id'], 'title': g['title']} for g in result['cards']]}
            try:
                summary_raw, versions['summary'] = self.json_call('summary', inp)
                summary = self.store.save_summary(owner, rid, summary_raw)
            except (ModelError, ValueError, KeyError):
                # If memories were edited/deleted while model ran, invalidate whole response.
                self.store.run(rid)
                summary = {'saved': False, 'message': '本轮摘要生成或校验失败，未写入记忆；答复仍可查看。'}
        # Atomic final revision check prevents deletion from being undone by in-flight results.
        with self.store.lock:
            current = self.store.state(owner)['revision']
            expected = summary.get('memory_revision', c['memory_revision'])
            if current != expected:
                raise ValueError('记忆已变更，本轮结果已失效，请重试。')
            # Store only query and validated answer, never old memory snapshots/tool transcripts.
            self.conversations[(owner, cid)] = {'revision': current, 'updated': time.time(),
                'messages': (history + [{'role': 'user', 'content': query},
                                       {'role': 'assistant', 'content': result['markdown']}])[-12:]}
            cutoff = time.time() - 3600
            self.conversations = {k: v for k, v in self.conversations.items() if v['updated'] > cutoff}
        return {'markdown': result['markdown'] + '\n\n' + summary['message'], 'result': result,
                'summary': summary, 'conversation_id': cid, 'prompt_versions': versions, 'tool_calls': tool_calls}

    def home(self, owner):
        c = self.store.context(owner, '', 'home')
        if c['cold_start']:
            return {'markdown': '暂时没有需要回访的问题。开启记忆后聊一个困扰，下次回来会询问问题进展。',
                    'result': {'status': 'empty', 'followups': []}}
        raw, version = self.json_call('home', {'followups': [{'memory_id': m['id'], 'problem': m['problem'], 'problem_status': m['problem_status'], 'updated': m['updated']} for m in c['followups']]})
        result = self.store.finalize_home(owner, c['run_id'], raw)
        return {'markdown': result['markdown'], 'result': result, 'prompt_versions': {'home': version}}
