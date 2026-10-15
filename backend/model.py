"""SDK-backed model tasks with application-owned business state and validation."""
import json
import os
import time
from pathlib import Path
from urllib.parse import urlparse
from backend.config import load_local_env
from backend.errors import ModelError
from backend.tools import GuideTools, tool_definitions
from backend.prompts import PromptRegistry
from backend.memory_maintenance import MemoryMaintenance
from backend.executors import (ClaudeSDKExecutor, ExecutionRequest,
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
        # Every production model task uses the SDK. Guide tools are available only
        # through ClaudeSDKExecutor; summary/home/judge get fresh tool-free tasks.
        if tools:
            raise ValueError('固定模型任务不允许调用指南或系统工具。')
        from backend.completion import complete_json
        return complete_json(self, messages, timeout=timeout)


def prompt(name):
    import hashlib
    text = (ROOT / 'prompts' / (name + '.md')).read_text()
    if not text.strip():
        raise ModelError('提示词文件为空。')
    return text, hashlib.sha256(text.encode()).hexdigest()


class AgentService:
    def __init__(self, store, client=None, executors=None, prompt_source=None, maintenance_enabled=True):
        self.store = store
        self.client = client or ModelClient()
        self.executors = executors if executors is not None else {'claude-sdk': ClaudeSDKExecutor(self.client)}
        self.default_runtime = 'claude-sdk'
        if 'claude-sdk' not in self.executors:
            raise ValueError('当前仅支持 Claude Agent SDK 执行层。')
        self.store.change_listeners.append(self.invalidate_conversations)
        self.prompt_source = prompt_source
        self.memory_maintenance = MemoryMaintenance(store, self.client)
        self.maintenance_enabled = maintenance_enabled

    def runtime_directory(self, owner):
        import hashlib
        return self.store.directory / 'agent-runtime' / hashlib.sha256(owner.encode()).hexdigest()[:24]

    def invalidate_conversations(self, owner):
        executor = self.executors['claude-sdk']
        if hasattr(executor, 'invalidate'):
            executor.invalidate(self.runtime_directory(owner))

    def delete_conversation(self, owner, conversation_id):
        import re
        if not isinstance(conversation_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{24,64}', conversation_id):
            raise ValueError('会话编号无效。')
        with self.store.lock:
            self.executors['claude-sdk'].delete_conversation(self.runtime_directory(owner), owner, conversation_id)
        return {'deleted': True}

    def prompt_snapshot(self):
        return self.prompt_source() if callable(self.prompt_source) else self.prompt_source

    def resolve_prompt(self, name, snapshot=None):
        return PromptRegistry.resolve(snapshot, name) if snapshot else prompt(name)

    def runtime_status(self):
        return runtime_status(self.default_runtime)

    def json_call(self, name, data, snapshot=None):
        instruction, version = self.resolve_prompt(name, snapshot)
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
        c = self.store.context(owner, query, 'chat', followup_memory_id=str(data.get('followup_memory_id') or ''),
                               guide_id=data.get('guide_id'))
        rid = c['run_id']
        snapshot = self.prompt_snapshot()
        instruction, version = self.resolve_prompt('chat', snapshot)
        tools = GuideTools(self.store, owner, rid)
        tool_version = hashlib.sha256(json.dumps(tools.definitions, sort_keys=True).encode()).hexdigest()
        cid = data.get('conversation_id') or ''
        import re
        if not isinstance(cid, str) or (cid and not re.fullmatch(r'[A-Za-z0-9_-]{24,64}', cid)):
            raise ValueError('会话编号无效，请开始新会话。')
        cid = cid or secrets.token_urlsafe(18)
        # Only this round's authoritative business state is injected. The SDK owns
        # the conversation transcript and compaction, never the memory database.
        messages = [{'role': 'system', 'content': instruction},
                    {'role': 'user', 'content': json.dumps(c, ensure_ascii=False)}]
        binding = {'prompt_version': version, 'tool_version': tool_version,
                   'content_version': c['content_version'],
                   'content_hash': hashlib.sha256(json.dumps(self.store.guide, sort_keys=True).encode()).hexdigest(),
                   'memory_enabled': c['memory_enabled'],
                   'memory_policy': 'topic-retrieval-v1',
                   'expires_at': min((m['expires'] for m in c['memories'] if m.get('expires')), default=None)}
        start = time.monotonic()
        request = ExecutionRequest(instruction, messages, tools, self.runtime_directory(owner),
                                   owner=owner, conversation_id=cid,
                                   memory_revision=c['memory_revision'], context_binding=binding)
        observations = {
            'understanding': {'input': {'query': query, 'memories': c['memories'],
                                         'memory_selection': c['memory_selection'],
                                         'history': {'managed_by': 'claude-sdk', 'restored': None}},
                              'output': None, 'status': 'unobserved'},
            'retrieval': {'input': {'query': query, 'candidate_titles': c['candidate_titles'],
                                    'selected_guide': c['selected_guide']},
                          'output': tools.trace, 'status': 'observed'},
            'reply': {'input': {'query': query}, 'output': None, 'status': 'unobserved'},
        }
        executed = None
        try:
            try:
                executed = self.executors[runtime].execute(request)
                if executed.session is not None:
                    cid = executed.session.conversation_id
                    executed.session.ensure_active()
                observations['understanding']['input']['history']['restored'] = executed.metadata.get('session_resumed')
                parsed = self.store.model_json(executed.raw)
                understanding = parsed.get('understanding')
                if isinstance(understanding, dict):
                    # Only documented task labels; no raw response, reasoning_content or thinking blocks.
                    clean = {key: understanding[key] for key in ('intent', 'scope')
                             if isinstance(understanding.get(key), str) and len(understanding[key]) <= 600}
                    for key in ('explicit_facts', 'unknowns'):
                        value = understanding.get(key)
                        if isinstance(value, list) and len(value) <= 12 and all(isinstance(v, str) and len(v) <= 600 for v in value):
                            clean[key] = value
                    observations['understanding'].update(output=clean, status='observed' if set(clean) == {'intent', 'scope', 'explicit_facts', 'unknowns'} else 'partial')
                result = self.store.finalize(owner, rid, executed.raw)
                observations['reply'].update(output=result, status='observed')
            except (ModelError, ValueError, KeyError) as error:
                error.trace = tools.trace
                error.observations = observations
                raise
            agent_ms = round((time.monotonic() - start) * 1000)
            summary = {'saved': False, 'message': '记忆已关闭，本轮不保存摘要。'}
            versions = {'chat': version}
            observations['memory'] = {'input': None, 'output': None, 'status': 'disabled'}
            observations['summary'] = {'input': None, 'output': None, 'status': 'disabled'}
            if c['memory_enabled']:
                inp = {'query': query, 'followup_memory_id': (c['followup'] or {}).get('id', ''),
                       'previous_memories': [m for m in c['memories'] if m.get('origin') == 'model_summary'],
                       'answer_status': result['status'], 'clarification': result['clarification'],
                       'assistant_answer': result['markdown'][:6000],
                       'consulted_guides': [{'guide_id': g['guide_id'], 'title': g['title']} for g in result['cards']]}
                try:
                    observations['memory']['input'] = inp
                    observations['summary']['input'] = inp
                    summary_raw, versions['summary'] = self.json_call('summary', inp, snapshot)
                    summary_data = self.store.model_json(summary_raw)
                    observations['memory'].update(status='candidate', output={k: summary_data.get(k) for k in
                        ('user_state', 'state_evidence', 'problem', 'problem_status', 'status_evidence', 'followup_of', 'guide_ids')})
                    observations['summary'].update(status='candidate', output={'summary': summary_data.get('summary')})
                    with self.store.lock:
                        if executed.session is not None:
                            executed.session.ensure_active()
                        summary = self.store.save_summary(owner, rid, summary_raw)
                    for stage in ('memory', 'summary'):
                        observations[stage].update(status='saved', persistence=summary)
                except (ModelError, ValueError, KeyError) as error:
                    # If memories were edited/deleted while model ran, invalidate whole response.
                    self.store.run(rid)
                    summary = {'saved': False, 'message': '本轮摘要生成或校验失败，未写入记忆；答复仍可查看。'}
                    if getattr(error, 'http_status', None):
                        summary['provider_http_status'] = error.http_status
                    for stage in ('memory', 'summary'):
                        observations[stage].update(status='error', persistence=summary)
            # Atomic final revision check prevents deletion from being undone by in-flight results.
            with self.store.lock:
                current = self.store.state(owner)['revision']
                expected = summary.get('memory_revision', c['memory_revision'])
                if current != expected:
                    raise ValueError('记忆已变更，本轮结果已失效，请重试。')
                # Commit the SDK resume marker only after both business validation and
                # the final memory revision check. Failed rounds are never resumable.
                if executed.session is not None:
                    executed.session.commit(current)
            if summary.get('saved') and self.maintenance_enabled:
                self.memory_maintenance.schedule(owner, summary.get('topic_id'))
            response = {'markdown': result['markdown'] + '\n\n' + summary['message'], 'result': result,
                    'summary': summary, 'conversation_id': cid, 'prompt_versions': versions, 'tool_calls': tools.calls,
                    'execution': {'runtime': runtime, 'agent_elapsed_ms': agent_ms,
                                  'elapsed_ms': round((time.monotonic() - start) * 1000),
                                  'auxiliary_runtime': 'claude-sdk', 'tool_version': tool_version,
                                  'content_version': c['content_version'], **executed.metadata}}
            if snapshot:
                response['prompt_bundle_id'] = snapshot['id']
                response['module_versions'] = snapshot['versions']
            if include_trace:
                response['trace'] = tools.trace
                response['observations'] = observations
            return response
        finally:
            if executed is not None and executed.session is not None:
                executed.session.discard()

    def home(self, owner, include_trace=False):
        snapshot = self.prompt_snapshot()
        c = self.store.context(owner, '', 'home')
        if c['cold_start']:
            return {'markdown': '暂时没有需要回访的问题。开启记忆后聊一个困扰，下次回来会询问问题进展。',
                    'result': {'status': 'empty', 'followups': []}}
        inp = {'followups': [{'memory_id': m['id'], 'problem': m['problem'], 'problem_status': m['problem_status'], 'updated': m['updated']} for m in c['followups']]}
        raw, version = self.json_call('home', inp, snapshot)
        result = self.store.finalize_home(owner, c['run_id'], raw)
        response = {'markdown': result['markdown'], 'result': result, 'prompt_versions': {'home': version},
                    'execution': {'runtime': 'claude-sdk', 'session_policy': 'isolated-task'}}
        if include_trace:
            response['observations'] = {'reply': {'input': inp, 'output': result, 'status': 'observed'}}
        return response
