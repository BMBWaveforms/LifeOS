"""Direct OpenAI-compatible model API. No workflow platform or server-side DSL."""
import json
import os
import time
from pathlib import Path
from urllib.parse import urlparse
import httpx
from backend.config import load_local_env
from backend.errors import ModelError
from backend.tools import GuideTools, tool_definitions
from backend.executors import (ClaudeSDKExecutor, ExecutionRequest, NativeExecutor,
                               runtime_status, validate_runtime)
load_local_env()

ROOT = Path(__file__).resolve().parents[1]

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

    def sdk_config(self):
        key, base, model = self.config()
        sdk_base = os.getenv('AGENT_SDK_BASE_URL')
        if not sdk_base:
            if urlparse(base).hostname != 'api.deepseek.com':
                raise ModelError('非 DeepSeek 官方接口请显式配置 AGENT_SDK_BASE_URL。')
            sdk_base = 'https://api.deepseek.com/anthropic'
        parsed = urlparse(sdk_base)
        if parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ModelError('SDK 模型接口必须是无凭据、无查询参数的 HTTPS 地址。')
        return key, sdk_base.rstrip('/'), model

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


class AgentService:
    def __init__(self, store, client=None, executors=None):
        self.store = store
        self.client = client or ModelClient()
        self.conversations = {}
        self.executors = executors or {'native': NativeExecutor(self.client), 'claude-sdk': ClaudeSDKExecutor(self.client)}
        self.default_runtime = validate_runtime(os.getenv('AGENT_RUNTIME', 'native'))

    def runtime_status(self):
        return runtime_status(self.default_runtime)

    def json_call(self, name, data):
        instruction, version = prompt(name)
        message = self.client.complete([{'role': 'system', 'content': instruction},
                                       {'role': 'user', 'content': json.dumps(data, ensure_ascii=False)}])
        return message.get('content') or '', version

    def chat(self, owner, data, include_trace=False):
        import secrets
        import hashlib
        runtime = validate_runtime(data.get('runtime', self.default_runtime))
        query = str(data.get('query', '')).strip()
        if not query or len(query) > 2000:
            raise ValueError('请输入 1—2000 字的问题。')
        c = self.store.context(owner, query, 'chat', followup_memory_id=str(data.get('followup_memory_id') or ''))
        rid = c['run_id']
        instruction, version = prompt('chat')
        tools = GuideTools(self.store, owner, rid)
        tool_version = hashlib.sha256(json.dumps(tools.definitions, sort_keys=True).encode()).hexdigest()
        cid = str(data.get('conversation_id') or '')
        saved = self.conversations.get((owner, cid))
        # Any management change invalidates both old model output and short-term history.
        history = saved['messages'] if (saved and saved['revision'] == c['memory_revision']
                    and saved.get('runtime') == runtime and saved.get('prompt_version') == version
                    and saved.get('tool_version') == tool_version) else []
        if not history:
            cid = secrets.token_urlsafe(18)
        messages = [{'role': 'system', 'content': instruction}] + history[-12:] + [
            {'role': 'user', 'content': json.dumps(c, ensure_ascii=False)}]
        start = time.monotonic()
        request = ExecutionRequest(instruction, messages, tools,
                  self.store.directory / 'agent-runtime' / hashlib.sha256(owner.encode()).hexdigest()[:24])
        try:
            executed = self.executors[runtime].execute(request)
            result = self.store.finalize(owner, rid, executed.raw)
        except (ModelError, ValueError, KeyError) as error:
            error.trace = tools.trace
            raise
        agent_ms = round((time.monotonic() - start) * 1000)
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
                'runtime': runtime, 'prompt_version': version, 'tool_version': tool_version,
                'messages': (history + [{'role': 'user', 'content': query},
                                       {'role': 'assistant', 'content': result['markdown']}])[-12:]}
            cutoff = time.time() - 3600
            self.conversations = {k: v for k, v in self.conversations.items() if v['updated'] > cutoff}
        response = {'markdown': result['markdown'] + '\n\n' + summary['message'], 'result': result,
                'summary': summary, 'conversation_id': cid, 'prompt_versions': versions, 'tool_calls': tools.calls,
                'execution': {'runtime': runtime, 'agent_elapsed_ms': agent_ms,
                              'elapsed_ms': round((time.monotonic() - start) * 1000),
                              'auxiliary_runtime': 'direct-api', 'tool_version': tool_version,
                              'content_version': c['content_version'], **executed.metadata}}
        if include_trace:
            response['trace'] = tools.trace
        return response

    def home(self, owner):
        c = self.store.context(owner, '', 'home')
        if c['cold_start']:
            return {'markdown': '暂时没有需要回访的问题。开启记忆后聊一个困扰，下次回来会询问问题进展。',
                    'result': {'status': 'empty', 'followups': []}}
        raw, version = self.json_call('home', {'followups': [{'memory_id': m['id'], 'problem': m['problem'], 'problem_status': m['problem_status'], 'updated': m['updated']} for m in c['followups']]})
        result = self.store.finalize_home(owner, c['run_id'], raw)
        return {'markdown': result['markdown'], 'result': result, 'prompt_versions': {'home': version}}
