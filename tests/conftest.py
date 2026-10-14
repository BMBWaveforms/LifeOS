import pytest


@pytest.fixture(autouse=True)
def isolated_runtime_config(monkeypatch):
    # Local product settings must never send FakeModel tests to a real provider.
    monkeypatch.setenv('AGENT_RUNTIME', 'native')
    monkeypatch.delenv('TEST_ACCOUNT_PASSWORD', raising=False)
