"""Single-purpose SDK JSON calls; no tools, resumable history or durable transcripts.

Summary, home and evaluation judge prompts use this transport. The caller still
validates the returned business JSON; this module never parses provider prose to
infer HTTP failures or persists assistant thinking/session content.
"""
import importlib.util
import json
import math
import tempfile
from pathlib import Path

import anyio

from backend.errors import ModelError


ERROR_STATUS = {
    'authentication_failed': 401,
    'billing_error': 402,
    'rate_limit': 429,
    'invalid_request': 400,
    'server_error': 502,
}


def sdk_http_status(message):
    """Extract only SDK-structured errors; never interpret provider/body text."""
    error = getattr(message, 'error', None)
    if isinstance(error, str) and error in ERROR_STATUS:
        return ERROR_STATUS[error]
    status = getattr(message, 'api_error_status', None)
    return status if type(status) is int and 400 <= status <= 599 else None


class _CompletionFailure(ModelError):
    """Only errors created here may cross the SDK boundary without redaction."""


def _provider_failure(status=None):
    if type(status) is not int or not 400 <= status <= 599:
        status = None
    message = ('模型接口返回 HTTP %s。请检查模型配置、可用额度或稍后重试。' % status
               if status else 'Claude Agent SDK 固定任务执行失败，请检查模型配置或稍后重试。')
    return _CompletionFailure(message, http_status=status)


def _messages(messages):
    if not isinstance(messages, list) or not messages:
        raise ValueError('SDK 固定任务需要非空消息列表。')
    clean = []
    for message in messages:
        if (not isinstance(message, dict) or message.get('role') not in ('system', 'user', 'assistant')
                or not isinstance(message.get('content'), str) or set(message) - {'role', 'content'}):
            raise ValueError('SDK 固定任务只接受 system/user/assistant 文本消息，不接受工具调用。')
        clean.append({'role': message['role'], 'content': message['content']})
    system = '\n\n'.join(m['content'] for m in clean if m['role'] == 'system')
    conversation = [m for m in clean if m['role'] != 'system']
    if not conversation:
        raise ValueError('SDK 固定任务需要用户输入。')
    payload = (conversation[0]['content'] if len(conversation) == 1 and conversation[0]['role'] == 'user'
               else json.dumps({'messages': conversation}, ensure_ascii=False))
    return system, payload


def complete_json(client, messages, timeout=75):
    """Return an OpenAI-shaped text message, using a fresh SDK-only transport."""
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
        raise ValueError('SDK 固定任务超时须为正数。')
    instruction, payload = _messages(messages)
    if importlib.util.find_spec('claude_agent_sdk') is None:
        raise ModelError('Claude Agent SDK 尚未安装；请使用 Python 3.10+ 安装锁定依赖。')
    # Configuration errors are app-owned and already safe. No direct API path exists.
    config = client.sdk_config()
    try:
        return anyio.run(_complete, config, instruction, payload, timeout)
    except _CompletionFailure:
        raise
    except TimeoutError:
        raise ModelError('Claude Agent SDK 固定任务执行超时，请重试。') from None
    except Exception:
        # CLI/transport errors can contain credentials, headers and raw model output.
        raise ModelError('Claude Agent SDK 固定任务连接或执行异常，请检查模型配置和 SDK 依赖。') from None


async def _complete(config, instruction, payload, timeout):
    from claude_agent_sdk import (AssistantMessage, ClaudeAgentOptions, ClaudeSDKClient,
                                  HookMatcher, PermissionResultDeny, ResultMessage, SystemMessage)
    key, base, model = config
    denied = False

    async def gate(input_data, tool_use_id, context):
        nonlocal denied
        denied = True
        return {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny',
                                       'permissionDecisionReason': '此固定任务不允许任何工具。'}}

    async def permission(name, args, context):
        nonlocal denied
        denied = True
        return PermissionResultDeny(message='此固定任务不允许任何工具。')

    def no_tools():
        return _CompletionFailure('SDK 固定任务请求了未授权工具，已停止本次任务。')

    # mkdtemp provides mode 0700; the SDK config and any transient transcript stay
    # inside it. Context-manager cleanup runs after disconnect on success or failure.
    with tempfile.TemporaryDirectory(prefix='lifeos-sdk-task-') as temporary:
        directory = Path(temporary)
        directory.chmod(0o700)
        config_directory = directory / 'config'
        config_directory.mkdir(mode=0o700)
        options = ClaudeAgentOptions(
            model=model, system_prompt=instruction, tools=[], allowed_tools=[],
            setting_sources=[], skills=[], agents={}, plugins=[], mcp_servers={}, strict_mcp_config=True,
            permission_mode='default', can_use_tool=permission,
            hooks={'PreToolUse': [HookMatcher(hooks=[gate])]}, thinking={'type': 'disabled'},
            max_turns=2, resume=None, continue_conversation=False,
            cwd=str(directory), stderr=lambda line: None,
            env={'ANTHROPIC_BASE_URL': base, 'ANTHROPIC_AUTH_TOKEN': key, 'ANTHROPIC_API_KEY': '',
                 'ANTHROPIC_MODEL': model, 'ANTHROPIC_DEFAULT_OPUS_MODEL': model,
                 'ANTHROPIC_DEFAULT_SONNET_MODEL': model, 'ANTHROPIC_DEFAULT_HAIKU_MODEL': model,
                 'CLAUDE_CODE_SUBAGENT_MODEL': model, 'CLAUDE_CONFIG_DIR': str(config_directory),
                 'CLAUDE_CODE_USE_BEDROCK': '0', 'CLAUDE_CODE_USE_VERTEX': '0', 'CLAUDE_CODE_USE_FOUNDRY': '0',
                 'CLAUDE_CODE_SKIP_PROMPT_HISTORY': '1', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
                 'CLAUDE_CODE_DISABLE_AUTO_MEMORY': '1', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS': '1',
                 'CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS': '1', 'ENABLE_TOOL_SEARCH': 'false',
                 'ENABLE_CLAUDEAI_MCP_SERVERS': 'false', 'DISABLE_AUTOUPDATER': '1',
                 'DISABLE_AUTO_COMPACT': '1', 'DISABLE_COMPACT': '1'},
        )
        terminal = None
        with anyio.fail_after(timeout):
            async with ClaudeSDKClient(options=options) as sdk:
                await sdk.query(payload)
                async for message in sdk.receive_response():
                    if isinstance(message, SystemMessage) and message.subtype == 'init':
                        reported_tools = message.data.get('tools', [])
                        if not isinstance(reported_tools, list) or reported_tools:
                            raise no_tools()
                    if isinstance(message, AssistantMessage):
                        status = sdk_http_status(message)
                        if message.error:
                            raise _provider_failure(status)
                        if message.stop_reason == 'tool_use' or any(
                            (block.get('type') if isinstance(block, dict) else type(block).__name__)
                            in ('tool_use', 'server_tool_use', 'tool_result', 'server_tool_result',
                                'ToolUseBlock', 'ServerToolUseBlock', 'ToolResultBlock', 'ServerToolResultBlock')
                            for block in message.content
                        ):
                            raise no_tools()
                    if isinstance(message, ResultMessage):
                        if denied or message.permission_denials or message.deferred_tool_use is not None:
                            raise no_tools()
                        status = sdk_http_status(message)
                        if message.is_error or message.subtype != 'success' or (type(status) is int and status >= 400):
                            raise _provider_failure(status)
                        if not isinstance(message.result, str) or not message.result.strip():
                            raise _CompletionFailure('Claude Agent SDK 固定任务未返回有效文本结果。')
                        if terminal is not None:
                            raise _CompletionFailure('Claude Agent SDK 固定任务返回了重复完成状态。')
                        terminal = message.result
                if denied:
                    raise no_tools()
                if terminal is None:
                    raise _CompletionFailure('Claude Agent SDK 固定任务未返回完成状态。')
        return {'role': 'assistant', 'content': terminal}
