"""Run records, usage accounting and secret scrubbing tests."""
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.agent import service


@pytest.fixture(autouse=True)
def no_forge_memory(monkeypatch):
    from app.agent import forge
    monkeypatch.setattr(forge, "is_enabled", lambda: False)
from app.agent.models import AgentRequest, Project
from app.agent.runlog import snapshot, start
from app.api.routes import agent


def chat_with_usage(prompt_tokens: int, completion_tokens: int,
                   **extra) -> "service.ChatResult":
    usage = {"prompt_tokens": prompt_tokens,
             "completion_tokens": completion_tokens,
             "total_tokens": prompt_tokens + completion_tokens, **extra}
    return service.ChatResult(content="ok", usage=usage)


# ── secret scrubbing ─────────────────────────────────────────────────────────

def test_scrub_redacts_assignment_style_credentials():
    source = (
        "// wifi setup\n"
        'const char* PASSWORD = "hunter2hunter2";\n'
        'String apiKey = "sk-live-abcdefgh";\n'
        "token: 'ghp_somethinglong'\n"
    )
    scrubbed = service.scrub_secrets(source)
    assert "hunter2hunter2" not in scrubbed
    assert "sk-live-abcdefgh" not in scrubbed
    assert "ghp_somethinglong" not in scrubbed
    assert "[REDACTED]" in scrubbed
    # The keys themselves stay so the model keeps the context.
    assert "PASSWORD" in scrubbed and "apiKey" in scrubbed


def test_scrub_leaves_normal_code_alone():
    source = ('int value = 330;\ndigitalWrite(13, HIGH);\nString msg = "Hello";\n'
              "// resistor before LED\n#define LED 13\n")
    assert service.scrub_secrets(source) == source


def test_prompt_payload_is_scrubbed(monkeypatch):
    captured = {}

    async def llm(messages, spec, max_tokens, tools=True):
        captured["user"] = messages[-1]["content"]
        # An untouched workspace + done() = an explanation run (answer event).
        return service.ChatResult(tool_calls=[
            {"id": "t1", "name": "done", "arguments": '{"summary": "ok"}'}])

    monkeypatch.setattr(service, "propose", llm)

    async def collect():
        request = AgentRequest(prompt='add wifi for password = "super-secret-9"',
                               project=Project(), messages=[])
        return [e async for e in service.run_agent(request)]

    import asyncio

    events = asyncio.run(collect())
    assert events[-1]["type"] == "answer"
    assert "super-secret-9" not in captured["user"]
    assert "add wifi" in captured["user"]


# ── run records ──────────────────────────────────────────────────────────────

def test_run_record_lifecycle_via_runlog():
    record = start("test-run-1")
    data = record.finish("compiled")
    assert data["outcome"] == "compiled" and data["finished"] is not None
    snaps = snapshot()
    assert any(s["run_id"] == "test-run-1" and s["outcome"] == "compiled" for s in snaps)


@pytest.mark.asyncio
async def test_run_record_counts_provider_usage(monkeypatch):
    monkeypatch.setattr(service, "_propose_once",
                        AsyncMock(side_effect=[
                            service.ProviderTransientError("429"),
                            chat_with_usage(111, 22),
                        ]))
    monkeypatch.setattr(service.asyncio, "sleep", AsyncMock())
    chat = await service.propose([], service._resolve_provider("bedrock"), 1000)
    assert chat.usage["prompt_tokens"] == 111

    monkeypatch.setattr(service, "propose", AsyncMock(return_value=chat_with_usage(50, 5)))
    events = [e async for e in service.run_agent(AgentRequest(prompt="explain", project=Project()))]
    assert events[-1]["type"] == "answer"
    record = next(s for s in snapshot() if s["run_id"] == events[-1]["run_id"])
    assert record["outcome"] == "explained"
    assert record["prompt_tokens"] == 50 and record["completion_tokens"] == 5
    assert record["provider_calls"] == 1


@pytest.mark.asyncio
async def test_run_record_counts_measured_cache_tokens(monkeypatch):
    """Measured cache activity lands in the record; prompt_tokens stays the
    full input basis (the adapter already sums cache into it)."""
    monkeypatch.setattr(service, "propose", AsyncMock(return_value=chat_with_usage(
        2000, 30, cache_read_tokens=1500, cache_write_tokens=500)))
    events = [e async for e in service.run_agent(AgentRequest(prompt="explain", project=Project()))]
    assert events[-1]["type"] == "answer"
    record = next(s for s in snapshot() if s["run_id"] == events[-1]["run_id"])
    assert record["cache_read_tokens"] == 1500
    assert record["cache_write_tokens"] == 500
    assert record["prompt_tokens"] == 2000  # full basis, not net of cache


# ── records endpoint ─────────────────────────────────────────────────────────

@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(agent.settings, "AGENT_ENABLED", True)
    monkeypatch.setattr(agent.settings, "BEDROCK_MODEL_ID", "bedrock-model")
    monkeypatch.setattr(agent.settings, "AWS_REGION", "us-east-1")
    app = FastAPI()
    app.include_router(agent.router, prefix="/api/agent")
    return TestClient(app)


def test_records_endpoint_is_open_when_configured(client):
    response = client.get("/api/agent/runs/records")
    assert response.status_code == 200
    assert isinstance(response.json()["runs"], list)
    assert all("outcome" in run and "run_id" in run for run in response.json()["runs"])
