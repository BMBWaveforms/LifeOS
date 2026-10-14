import httpx
import pytest
from backend.errors import ModelError
from backend.model import ModelClient


def test_http_status_is_safe_and_provider_body_is_never_exposed(monkeypatch):
    monkeypatch.setenv('MODEL_API_KEY', 'synthetic-secret')
    monkeypatch.setenv('MODEL_BASE_URL', 'https://api.deepseek.com/v1')
    actual = httpx.Client
    def respond(request):
        return httpx.Response(402, json={'error': 'untrusted provider body containing synthetic-secret'})
    monkeypatch.setattr(httpx, 'Client', lambda **kwargs: actual(transport=httpx.MockTransport(respond)))
    with pytest.raises(ModelError) as caught:
        ModelClient().complete([{'role':'user','content':'synthetic input'}])
    assert caught.value.http_status == 402
    assert '402' in str(caught.value)
    assert 'synthetic-secret' not in str(caught.value)
