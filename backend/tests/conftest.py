"""Shared fixtures for the backend test suite."""
import pytest

from app.core.config import settings


@pytest.fixture(autouse=True)
def default_provider_configured(monkeypatch):
    """Every test runs with the DEFAULT provider available.

    `AgentRequest.provider` defaults to `bedrock`, so any request that does
    not name a provider resolves to it — and an unconfigured default would
    make every such test fail with "provider is not configured" for reasons
    that have nothing to do with what it is testing.

    Tests that exercise the unconfigured path (or a different provider) patch
    their own provider and are unaffected by this.
    """
    monkeypatch.setattr(settings, "BEDROCK_MODEL_ID",
                        settings.BEDROCK_MODEL_ID or "test-bedrock-model")
    monkeypatch.setattr(settings, "AWS_REGION",
                        settings.AWS_REGION or "us-east-1")
