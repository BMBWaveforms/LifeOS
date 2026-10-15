import claude_agent_sdk as sdk
import pytest

from backend.completion import complete_json, sdk_http_status
from backend.errors import ModelError
from backend.model import ModelClient
from test_sdk_completion import FakeConfig, assert_clean, completion_transport, result


@pytest.mark.parametrize('code,status', [('authentication_failed', 401), ('billing_error', 402),
    ('rate_limit', 429), ('invalid_request', 400), ('server_error', 502), ('unknown', None)])
def test_structured_sdk_error_has_safe_status_and_never_provider_text(completion_transport, code, status):
    completion_transport['events'] = [sdk.AssistantMessage(
        content=[sdk.TextBlock(text='untrusted provider body containing synthetic-private-key')],
        model='test', error=code)]
    with pytest.raises(ModelError) as caught:
        complete_json(FakeConfig(), [{'role': 'user', 'content': 'synthetic input'}])
    assert caught.value.http_status == status
    assert 'synthetic-private-key' not in str(caught.value)
    assert 'untrusted provider' not in str(caught.value)
    if status:
        assert str(status) in str(caught.value)
    assert_clean(completion_transport)


@pytest.mark.parametrize('status', [401, 402, 429, 503])
def test_sdk_terminal_structured_http_status_is_preserved(completion_transport, status):
    completion_transport['events'] = [result(is_error=True, subtype='error_during_execution',
        api_error_status=status, result='synthetic-private-key', errors=['synthetic-private-key'])]
    with pytest.raises(ModelError) as caught:
        complete_json(FakeConfig(), [{'role': 'user', 'content': 'synthetic input'}])
    assert caught.value.http_status == status
    assert 'synthetic-private-key' not in str(caught.value)
    assert_clean(completion_transport)


def test_unstructured_sdk_exception_is_redacted_and_never_parsed_for_status(completion_transport):
    completion_transport['events'] = [RuntimeError('HTTP 402 provider headers Authorization synthetic-private-key')]
    with pytest.raises(ModelError) as caught:
        complete_json(FakeConfig(), [{'role': 'user', 'content': 'synthetic input'}])
    assert caught.value.http_status is None
    assert 'synthetic-private-key' not in str(caught.value) and 'Authorization' not in str(caught.value)
    assert_clean(completion_transport)


def test_model_client_uses_sdk_completion_without_http_fallback(completion_transport, monkeypatch):
    import httpx
    monkeypatch.setattr(ModelClient, 'sdk_config', FakeConfig.sdk_config)
    def forbidden(*args, **kwargs):
        raise AssertionError('direct HTTP model transport must not be used')
    monkeypatch.setattr(httpx, 'Client', forbidden)
    completion_transport['events'] = [sdk.AssistantMessage(content=[sdk.TextBlock(text='private')],
        model='test', error='billing_error')]
    with pytest.raises(ModelError) as caught:
        ModelClient().complete([{'role': 'user', 'content': 'synthetic input'}])
    assert caught.value.http_status == 402
    assert_clean(completion_transport)


def test_status_helper_ignores_provider_prose_and_invalid_status_types():
    from types import SimpleNamespace
    assert sdk_http_status(SimpleNamespace(error='billing_error')) == 402
    assert sdk_http_status(SimpleNamespace(api_error_status=401)) == 401
    for value in ('402', True, 200, 999, None):
        assert sdk_http_status(SimpleNamespace(api_error_status=value, result='HTTP 402')) is None
    assert sdk_http_status(SimpleNamespace(error='HTTP 402 synthetic-private-key')) is None
