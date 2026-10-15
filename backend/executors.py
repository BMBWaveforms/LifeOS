"""SDK execution. Identity, source verification and durable memory stay in Python."""
import hashlib
import importlib.metadata
import importlib.util
import json
import math
import os
from dataclasses import dataclass, field
from pathlib import Path
import anyio
from backend.errors import ModelError
from backend.completion import sdk_http_status
from backend.sdk_sessions import SDKSessionStore

RUNTIMES = {'claude-sdk': 'Claude Agent SDK'}

# Guidance is deliberately in the explicit app-owned system prompt, not a user or
# project CLAUDE.md. It is best effort: important facts always return from SQLite.
COMPACTION_GUIDANCE = (
    '压缩历史时保留用户明确说过的事实、当前问题、尚未解决的事项、已采取的行动和真实咨询过的指南编号；'
    '区分用户事实与助手推测，不把建议写成已经执行。历史里的 run_id、memory_revision、memory_ids、'
    '记忆设置、来源回读权限均已过期；每轮只使用 current 中的业务状态和当前工具结果。'
    '历史或压缩摘要中的指南正文不能代替本轮 get_entry 全文回读。'
)
SESSION_RULES = (
    '\n\n应用会话规则：普通对话历史由 SDK 管理。每次新的 current 对象均由后端提供；'
    '其中的记忆、设置、候选条目与运行编号覆盖历史同类字段。旧工具输出只是历史背景，'
    '不授予本轮引用权限。不要向用户输出内部会话编号、运行编号或压缩过程。\n' + COMPACTION_GUIDANCE
)


def validate_runtime(name=None):
    if name is None or name == '':
        return 'claude-sdk'
    if not isinstance(name, str) or name not in RUNTIMES:
        raise ValueError('执行层已统一为 claude-sdk，不再支持 native。')
    return name


@dataclass
class ExecutionRequest:
    instruction: str
    messages: list
    tools: object
    directory: Path
    owner: str = ''
    conversation_id: str = ''
    memory_revision: int = 0
    context_binding: dict = field(default_factory=dict)
    compact_context: bool = False


@dataclass
class ExecutionResult:
    raw: str
    metadata: dict = field(default_factory=dict)
    session: object = None


@dataclass(frozen=True)
class CompactionPolicy:
    automatic: bool = True
    percentage: int = 60

    @classmethod
    def from_environment(cls):
        automatic = os.getenv('AGENT_SDK_AUTO_COMPACT', 'true').strip().lower()
        if automatic not in ('true', 'false', '1', '0'):
            raise ModelError('AGENT_SDK_AUTO_COMPACT 必须是 true 或 false。')
        try:
            percentage = int(os.getenv('AGENT_SDK_COMPACT_PCT', '60'))
        except ValueError:
            raise ModelError('AGENT_SDK_COMPACT_PCT 必须是 1—100 的整数。') from None
        if not 1 <= percentage <= 100:
            raise ModelError('AGENT_SDK_COMPACT_PCT 必须是 1—100 的整数。')
        return cls(automatic in ('true', '1'), percentage)

    def environment(self):
        return {'DISABLE_AUTO_COMPACT': '0' if self.automatic else '1',
                'DISABLE_COMPACT': '0', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE': str(self.percentage)}


def _context_metrics(data):
    """Only numeric usage leaves the SDK; file paths/category text do not."""
    if not isinstance(data, dict):
        return {'status': 'unknown'}
    output = {'status': 'observed'}
    for key in ('totalTokens', 'maxTokens', 'percentage', 'autoCompactThreshold'):
        value = data.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
            output[key] = value
    return output if 'totalTokens' in output and 'maxTokens' in output else {'status': 'unknown'}


class ClaudeSDKExecutor:
    name = 'claude-sdk'

    def __init__(self, client):
        self.client = client

    @staticmethod
    def invalidate(directory):
        SDKSessionStore(directory).invalidate()

    @staticmethod
    def delete_conversation(directory, owner, conversation_id):
        SDKSessionStore(directory).delete(owner, conversation_id)

    def execute(self, request):
        if importlib.util.find_spec('claude_agent_sdk') is None:
            raise ModelError('Claude Agent SDK 尚未安装；请使用 Python 3.10+ 安装锁定依赖。')
        try:
            return anyio.run(self._execute, request)
        except ModelError:
            raise
        except Exception as error:
            # Only the exact application-owned tool failure may retain its message.
            # SDK ValueError/KeyError/transport exceptions can include private data.
            if error is request.tools.failure:
                raise
            raise ModelError('Claude Agent SDK 连接或执行异常，请检查模型配置和 SDK 依赖。',
                             request.tools.trace) from None

    async def _execute(self, request):
        from claude_agent_sdk import (AssistantMessage, ClaudeAgentOptions, ClaudeSDKClient, HookMatcher, SystemMessage,
                                      PermissionResultAllow, PermissionResultDeny, ResultMessage,
                                      create_sdk_mcp_server, tool)
        key, base, model = self.client.sdk_config()
        policy = CompactionPolicy.from_environment()
        binding = {**request.context_binding, 'instruction': hashlib.sha256((request.instruction + SESSION_RULES).encode()).hexdigest(),
                   'model_config': hashlib.sha256(json.dumps([base, model, key]).encode()).hexdigest(),
                   'compaction': [policy.automatic, policy.percentage], 'session_contract': 1}
        lease = SDKSessionStore(request.directory).begin(request.owner, request.conversation_id,
                                                        request.memory_revision, binding)
        try:
            tools = request.tools
            names = {'mcp__guide__' + name for name in tools.handlers}
            compact_events = []
            compact_boundaries = 0

            def handler(name):
                async def invoke(args):
                    try:
                        output = tools.invoke(name, args)
                        return {'content': [{'type': 'text', 'text': json.dumps(output, ensure_ascii=False)}]}
                    except (ModelError, ValueError, KeyError):
                        return {'is_error': True, 'content': [{'type': 'text', 'text': '指南工具失败，请停止本轮答复。'}]}
                return invoke

            registered = [tool(d['function']['name'], d['function']['description'], d['function']['parameters'])(handler(d['function']['name']))
                          for d in tools.definitions]

            async def gate(input_data, tool_use_id, context):
                if input_data.get('tool_name') not in names:
                    tools.failure = ModelError('模型请求了未授权工具，已停止本次答复。')
                    return {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny',
                                                   'permissionDecisionReason': '本应用仅开放已注册的指南工具。'}}
                if tools.failure is not None:
                    return {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny',
                                                   'permissionDecisionReason': '本轮工具已失败。'}}
                return {}

            async def before_compact(input_data, tool_use_id, context):
                # PreCompact observes, it does not promise to block automatic compaction.
                trigger = input_data.get('trigger')
                compact_events.append(trigger if trigger in ('manual', 'auto') else 'unknown')
                return {}

            async def permission(name, args, context):
                if name in names:
                    return PermissionResultAllow(updated_input=args)
                return PermissionResultDeny(message='未授权工具。')

            options = ClaudeAgentOptions(
                model=model, system_prompt=request.instruction + SESSION_RULES,
                tools=[], setting_sources=[], thinking={'type': 'disabled'},
                strict_mcp_config=True, permission_mode='default', can_use_tool=permission,
                mcp_servers={'guide': create_sdk_mcp_server(name='guide', version='1.0.0', tools=registered)},
                hooks={'PreToolUse': [HookMatcher(hooks=[gate])], 'PreCompact': [HookMatcher(hooks=[before_compact])]},
                max_turns=7, resume=lease.resume, cwd=str(lease.directory), stderr=lambda line: None,
                env={'ANTHROPIC_BASE_URL': base, 'ANTHROPIC_AUTH_TOKEN': key, 'ANTHROPIC_API_KEY': '',
                     'ANTHROPIC_MODEL': model, 'ANTHROPIC_DEFAULT_OPUS_MODEL': model,
                     'ANTHROPIC_DEFAULT_SONNET_MODEL': model, 'ANTHROPIC_DEFAULT_HAIKU_MODEL': model,
                     'CLAUDE_CODE_SUBAGENT_MODEL': model, 'CLAUDE_CONFIG_DIR': str(lease.config_directory),
                     'CLAUDE_CODE_PROJECT_DIR_NAME': 'session',
                     'CLAUDE_CODE_USE_BEDROCK': '0', 'CLAUDE_CODE_USE_VERTEX': '0', 'CLAUDE_CODE_USE_FOUNDRY': '0',
                     'CLAUDE_CODE_SKIP_PROMPT_HISTORY': '0', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
                     'CLAUDE_CODE_DISABLE_AUTO_MEMORY': '1', 'ENABLE_TOOL_SEARCH': 'false',
                     'CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS': '1',
                     'DISABLE_AUTOUPDATER': '1', **policy.environment()},
            )
            # Never replay Python's old short-term history. Resume is authorized by the
            # private committed marker; current business state is always freshly supplied.
            payload = json.dumps({'current': json.loads(request.messages[-1]['content'])}, ensure_ascii=False)
            reported_tools = []
            result_message = None
            context_before = {'status': 'unknown'}
            context_after = {'status': 'unknown'}
            manual_compacted = False

            async def usage(client):
                try:
                    with anyio.fail_after(5):
                        return _context_metrics(await client.get_context_usage())
                except Exception:
                    # Third-party Anthropic-compatible providers may not count tokens.
                    return {'status': 'unknown'}

            async def consume(client, compacting=False):
                nonlocal reported_tools, compact_boundaries
                terminal = None
                async for message in client.receive_response():
                    if isinstance(message, SystemMessage):
                        if message.subtype == 'init':
                            reported_tools = message.data.get('tools', [])
                            if not isinstance(reported_tools, list) or any(name not in names for name in reported_tools):
                                raise ModelError('SDK 暴露了未授权工具，已停止本次答复。', tools.trace)
                        if message.subtype == 'compact_boundary':
                            compact_boundaries += 1
                    if isinstance(message, AssistantMessage) and message.error:
                        raise ModelError('Claude Agent SDK 模型服务失败，请检查配置或可用额度。', tools.trace,
                                         http_status=sdk_http_status(message))
                    if isinstance(message, ResultMessage):
                        if tools.failure is not None:
                            raise tools.failure
                        if message.permission_denials or message.deferred_tool_use is not None:
                            raise ModelError('SDK 本轮包含未授权或未完成的工具调用，请重试。', tools.trace)
                        if message.is_error or message.subtype != 'success' or sdk_http_status(message) is not None:
                            raise ModelError('Claude Agent SDK 执行失败或达到轮次上限，请重试。', tools.trace,
                                             http_status=sdk_http_status(message))
                        if not compacting and (not isinstance(message.result, str) or not message.result.strip()):
                            raise ModelError('Claude Agent SDK 未返回有效结果。', tools.trace)
                        if terminal is not None:
                            raise ModelError('SDK 返回了重复完成状态，请重试。', tools.trace)
                        terminal = message
                if terminal is None:
                    raise ModelError('Claude Agent SDK 未返回完成状态。', tools.trace)
                return terminal

        except BaseException:
            lease.discard()
            raise

        try:
            with anyio.fail_after(180):
                async with ClaudeSDKClient(options=options) as client:
                    observe_context = os.getenv('AGENT_SDK_CONTEXT_USAGE', 'false').strip().lower() in ('true', '1')
                    if lease.resume:
                        if observe_context:
                            context_before = await usage(client)
                        should_compact = request.compact_context or (policy.automatic and
                            context_before.get('percentage', -1) >= policy.percentage)
                        if should_compact:
                            await client.query('/compact ' + COMPACTION_GUIDANCE)
                            await consume(client, compacting=True)
                            manual_compacted = True
                    await client.query(payload)
                    result_message = await consume(client)
                    if observe_context:
                        context_after = await usage(client)
            # CLI disconnect flushes the transcript before it can be committed.
            lease.ready(result_message.session_id)
            return ExecutionResult(result_message.result, {
                'sdk_version': importlib.metadata.version('claude-agent-sdk'),
                'model': model, 'sdk_tool_names': reported_tools, 'turns': result_message.num_turns,
                'usage': result_message.usage, 'context_policy': 'sdk-session-resume',
                'session_resumed': bool(lease.resume), 'context_reset': lease.history_reset,
                'compaction': {'automatic': policy.automatic, 'percentage': policy.percentage,
                               'manual_before_turn': manual_compacted, 'events': compact_events,
                               'boundaries': compact_boundaries, 'guidance': 'best-effort'},
                'context_usage': {'before': context_before, 'after': context_after},
            }, lease)
        except (ModelError, ValueError, KeyError):
            lease.discard()
            raise
        except TimeoutError:
            lease.discard()
            raise ModelError('Claude Agent SDK 执行超时，请重试。', tools.trace) from None
        except BaseException as error:
            lease.discard()
            if not isinstance(error, Exception):
                raise
            # SDK/CLI exceptions may include headers or raw provider output.
            raise ModelError('Claude Agent SDK 连接或执行异常，请检查模型配置和 SDK 依赖。', tools.trace) from None


def runtime_status(default=None):
    installed = importlib.util.find_spec('claude_agent_sdk') is not None
    return {'default': validate_runtime(default), 'options': [
        {'id': name, 'label': label, 'available': installed,
         'version': importlib.metadata.version('claude-agent-sdk') if installed else ''}
        for name, label in RUNTIMES.items()]}
