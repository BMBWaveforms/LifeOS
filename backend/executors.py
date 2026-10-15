"""Replaceable execution engines. Identity, sources and memory stay in Python."""
import importlib.metadata
import importlib.util
import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
import anyio
from backend.errors import ModelError

RUNTIMES = {'native': 'Python 自实现', 'claude-sdk': 'Claude Agent SDK'}


def validate_runtime(name):
    if not isinstance(name, str) or name not in RUNTIMES:
        raise ValueError('执行层必须是 native 或 claude-sdk。')
    return name


@dataclass
class ExecutionRequest:
    instruction: str
    messages: list
    tools: object
    directory: Path


@dataclass
class ExecutionResult:
    raw: str
    metadata: dict = field(default_factory=dict)


class NativeExecutor:
    name = 'native'

    def __init__(self, client):
        self.client = client

    def execute(self, request):
        messages = list(request.messages)
        start = time.monotonic()
        for turn in range(7):
            remaining = 180 - (time.monotonic() - start)
            if remaining <= 0:
                raise ModelError('指南检索超时，请重试。', request.tools.trace)
            message = self.client.complete(messages, tools=request.tools.definitions, timeout=min(75, remaining))
            calls = message.get('tool_calls') or []
            if not calls:
                return ExecutionResult(message.get('content') or '', {'turns': turn + 1})
            if len(calls) > 12 or request.tools.calls + len(calls) > 24:
                raise ModelError('指南工具调用达到上限，请缩小问题范围。', request.tools.trace)
            messages.append({k: v for k, v in message.items() if k in ('role', 'content', 'tool_calls', 'reasoning_content')})
            for call in calls:
                function = call['function']
                output = request.tools.invoke(function['name'], json.loads(function['arguments']))
                messages.append({'role': 'tool', 'tool_call_id': call['id'], 'content': json.dumps(output, ensure_ascii=False)})
        raise ModelError('指南检索达到轮次上限，请重试。', request.tools.trace)


class ClaudeSDKExecutor:
    name = 'claude-sdk'

    def __init__(self, client):
        self.client = client

    def execute(self, request):
        if importlib.util.find_spec('claude_agent_sdk') is None:
            raise ModelError('Claude Agent SDK 尚未安装；请使用 Python 3.10+ 安装锁定依赖。')
        return anyio.run(self._execute, request)

    async def _execute(self, request):
        from claude_agent_sdk import (ClaudeAgentOptions, ClaudeSDKClient, HookMatcher, SystemMessage,
                                      PermissionResultAllow, PermissionResultDeny, ResultMessage,
                                      create_sdk_mcp_server, tool)
        key, base, model = self.client.sdk_config()
        tools = request.tools
        names = {'mcp__guide__' + name for name in tools.handlers}

        def handler(name):
            async def invoke(args):
                try:
                    output = tools.invoke(name, args)
                    return {'content': [{'type': 'text', 'text': json.dumps(output, ensure_ascii=False)}]}
                except (ModelError, ValueError, KeyError):
                    # The SDK may continue after a tool error; Python rejects the entire run below.
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

        async def permission(name, args, context):
            if name in names:
                return PermissionResultAllow(updated_input=args)
            return PermissionResultDeny(message='未授权工具。')

        runtime_dir = request.directory / 'sdk'
        runtime_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        options = ClaudeAgentOptions(
            model=model, system_prompt=request.instruction, tools=[], setting_sources=[], thinking={'type': 'disabled'},
            strict_mcp_config=True, permission_mode='default', can_use_tool=permission,
            mcp_servers={'guide': create_sdk_mcp_server(name='guide', version='1.0.0', tools=registered)},
            hooks={'PreToolUse': [HookMatcher(hooks=[gate])]}, max_turns=7,
            cwd=str(runtime_dir), stderr=lambda line: None,
            env={'ANTHROPIC_BASE_URL': base, 'ANTHROPIC_AUTH_TOKEN': key, 'ANTHROPIC_API_KEY': '',
                 'ANTHROPIC_MODEL': model, 'ANTHROPIC_DEFAULT_OPUS_MODEL': model,
                 'ANTHROPIC_DEFAULT_SONNET_MODEL': model, 'ANTHROPIC_DEFAULT_HAIKU_MODEL': model,
                 'CLAUDE_CODE_SUBAGENT_MODEL': model, 'CLAUDE_CONFIG_DIR': str(runtime_dir / 'config'),
                 'CLAUDE_CODE_USE_BEDROCK': '0', 'CLAUDE_CODE_USE_VERTEX': '0', 'CLAUDE_CODE_USE_FOUNDRY': '0',
                 'CLAUDE_CODE_SKIP_PROMPT_HISTORY': '1', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
                 'DISABLE_AUTOUPDATER': '1'},
        )
        # Start fresh and replay only application-approved history. No shared SDK transcript,
        # hidden project settings or "continue most recent" can restore deleted memory.
        payload = json.dumps({'conversation': request.messages[1:-1],
                              'current': json.loads(request.messages[-1]['content'])}, ensure_ascii=False)
        reported_tools = []
        try:
            with anyio.fail_after(180):
                async with ClaudeSDKClient(options=options) as client:
                    await client.query(payload)
                    async for message in client.receive_response():
                        if isinstance(message, SystemMessage) and message.subtype == 'init':
                            reported_tools = message.data.get('tools', [])
                            if not isinstance(reported_tools, list) or any(name not in names for name in reported_tools):
                                raise ModelError('SDK 暴露了未授权工具，已停止本次答复。', tools.trace)
                        if isinstance(message, ResultMessage):
                            if tools.failure is not None:
                                raise tools.failure
                            if message.is_error or message.subtype != 'success':
                                raise ModelError('Claude Agent SDK 执行失败或达到轮次上限，请重试。', tools.trace)
                            if not isinstance(message.result, str) or not message.result.strip():
                                raise ModelError('Claude Agent SDK 未返回有效结果。', tools.trace)
                            return ExecutionResult(message.result, {
                                'sdk_version': importlib.metadata.version('claude-agent-sdk'),
                                'model': model, 'sdk_tool_names': reported_tools,
                                'turns': message.num_turns, 'usage': message.usage,
                                'context_policy': 'validated-history-per-turn',
                            })
            raise ModelError('Claude Agent SDK 未返回完成状态。', tools.trace)
        except (ModelError, ValueError, KeyError):
            raise
        except TimeoutError:
            raise ModelError('Claude Agent SDK 执行超时，请重试。', tools.trace) from None
        except Exception:
            # SDK/CLI exceptions may include request headers or raw provider output.
            raise ModelError('Claude Agent SDK 连接或执行异常，请检查模型配置和 SDK 依赖。', tools.trace) from None


def runtime_status(default):
    installed = importlib.util.find_spec('claude_agent_sdk') is not None
    return {'default': validate_runtime(default), 'options': [
        {'id': name, 'label': label, 'available': name != 'claude-sdk' or installed,
         'version': importlib.metadata.version('claude-agent-sdk') if name == 'claude-sdk' and installed else ''}
        for name, label in RUNTIMES.items()]}
