"""Tool-use loop, provider retry/backoff and run-record tests."""
from unittest.mock import AsyncMock

import pytest

from app.agent import service


@pytest.fixture(autouse=True)
def no_forge_memory(monkeypatch):
    from app.agent import forge
    monkeypatch.setattr(forge, "is_enabled", lambda: False)
from app.agent.models import (
    AgentRequest,
    Board,
    Expectations,
    Part,
    Patch,
    PinExpectation,
    Project,
    Proposal,
    Source,
    ToolCall,
    Connection,
    Endpoint,
)


def blink_patch():
    return Patch(
        board=Board(id="uno"),
        upsert_components=[
            Part(id="led1", metadataId="led", x=500, y=100, properties={"color": "red"}),
            Part(id="res1", metadataId="resistor", x=500, y=220, properties={"value": "330"}),
        ],
        upsert_wires=[
            Connection(id="w1", start=Endpoint(componentId="uno", pinName="13"),
                       end=Endpoint(componentId="res1", pinName="1")),
            Connection(id="w2", start=Endpoint(componentId="res1", pinName="2"),
                       end=Endpoint(componentId="led1", pinName="A")),
            Connection(id="w3", start=Endpoint(componentId="led1", pinName="C"),
                       end=Endpoint(componentId="uno", pinName="GND.1")),
        ],
        upsert_files=[Source(name="sketch.ino", content=(
            "void setup(){pinMode(13,OUTPUT);}\n"
            "void loop(){digitalWrite(13,HIGH);delay(500);digitalWrite(13,LOW);delay(500);}"))],
    )


def compile_ok():
    return {"success": True, "hex_content": ":00000001FF", "stdout": "compiled"}


async def collect(request):
    return [e async for e in service.run_agent(request)]


@pytest.mark.asyncio
async def test_tool_round_runs_then_patches(monkeypatch):
    calls = []

    async def llm(messages, spec=None, max_tokens=None):
        calls.append(messages)
        if len(calls) == 1:
            return Proposal(summary="checking", tool_calls=[ToolCall(tool="board_pinout")])
        return Proposal(summary="Blink", patch=blink_patch())

    monkeypatch.setattr(service, "propose", llm)
    monkeypatch.setattr(service, "compile_project", AsyncMock(return_value=compile_ok()))
    events = await collect(AgentRequest(prompt="blink", project=Project()))

    tools = [e for e in events if e["type"] == "tools"]
    assert tools and tools[0]["calls"] == [{"tool": "board_pinout", "ok": True}]
    # The tool result reached the model as a user message.
    second_user = [m for m in calls[1] if m["role"] == "user"][-1]["content"]
    assert "TOOL RESULTS" in second_user and "arduino-uno" in second_user
    assert events[-1]["type"] == "result"


@pytest.mark.asyncio
async def test_tool_budget_is_enforced(monkeypatch):
    monkeypatch.setattr(service.settings, "AGENT_MAX_TOOL_ROUNDS", 1)
    calls = []

    async def llm(messages, spec=None, max_tokens=None):
        calls.append(messages)
        return Proposal(summary="checking", tool_calls=[ToolCall(tool="check_design")])

    monkeypatch.setattr(service, "propose", llm)
    monkeypatch.setattr(service, "compile_project", AsyncMock(return_value=compile_ok()))
    events = await collect(AgentRequest(prompt="blink", project=Project()))
    # Bounded: one executed tool round, then a single nudge that the budget is
    # gone, and a model that keeps asking for tools ends the run as an answer
    # instead of looping (or executing anything else).
    assert len(calls) == 3
    assert "budget is exhausted" in calls[1][-1]["content"]
    assert "budget is exhausted" in calls[2][-1]["content"]
    assert len([e for e in events if e["type"] == "tools"]) == 1
    assert events[-1] == {**events[-1], "type": "answer", "summary": "checking",
                          "run_id": events[-1]["run_id"]}


@pytest.mark.asyncio
async def test_failing_tool_does_not_kill_the_run(monkeypatch):
    calls = []

    async def llm(messages, spec=None, max_tokens=None):
        calls.append(messages)
        if len(calls) == 1:
            return Proposal(summary="hmm", tool_calls=[ToolCall(tool="read_file", args={})])
        return Proposal(summary="Blink", patch=blink_patch())

    monkeypatch.setattr(service, "propose", llm)
    monkeypatch.setattr(service, "compile_project", AsyncMock(return_value=compile_ok()))
    events = await collect(AgentRequest(prompt="blink", project=Project()))
    tools = [e for e in events if e["type"] == "tools"]
    assert tools[0]["calls"][0]["ok"] is False
    assert events[-1]["type"] == "result"


@pytest.mark.asyncio
async def test_transient_provider_errors_retry_with_backoff(monkeypatch):
    sleeps: list[float] = []

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(service.asyncio, "sleep", fake_sleep)
    once = AsyncMock(side_effect=[
        service.ProviderTransientError("429"),
        service.ProviderTransientError("503"),
        Proposal(summary="ok"),
    ])
    monkeypatch.setattr(service, "_propose_once", once)
    proposal = await service.propose([])
    assert proposal.summary == "ok"
    assert once.await_count == 3
    assert sleeps == pytest.approx([1.5, 2.5], abs=0.6)  # exponential + jitter


@pytest.mark.asyncio
async def test_permanent_provider_error_is_a_graceful_error_event(monkeypatch):
    async def llm(messages, spec=None, max_tokens=None):
        raise service.ProviderError("Model provider returned HTTP 401. Check server configuration or quota.")

    monkeypatch.setattr(service, "propose", llm)
    events = await collect(AgentRequest(prompt="blink", project=Project()))
    assert events[-1]["type"] == "error"
    assert "HTTP 401" in events[-1]["message"]


@pytest.mark.asyncio
async def test_run_uses_the_requested_provider(monkeypatch):
    seen = []

    async def fake_propose_once(messages, spec, max_tokens=None):
        seen.append(spec)
        return Proposal(summary="explained")

    monkeypatch.setattr(service, "_propose_once", fake_propose_once)
    monkeypatch.setattr(service.settings, "AGENT_GEMINI_API_KEY", "gem-key")
    events = await collect(AgentRequest(prompt="explain", project=Project(), provider="gemini"))
    assert seen and seen[0].id == "gemini"
    assert seen[0].model == service.settings.AGENT_GEMINI_MODEL
    assert events[-1]["type"] == "answer"


@pytest.mark.asyncio
async def test_unconfigured_provider_is_a_graceful_error(monkeypatch):
    monkeypatch.setattr(service.settings, "AGENT_GEMINI_API_KEY", "")
    events = await collect(AgentRequest(prompt="blink", project=Project(), provider="gemini"))
    assert events[-1]["type"] == "error"
    assert "'gemini' is not configured" in events[-1]["message"]


@pytest.mark.asyncio
async def test_run_defaults_to_bedrock(monkeypatch):
    seen = []

    async def fake_propose_once(messages, spec, max_tokens=None):
        seen.append(spec)
        return Proposal(summary="explained")

    monkeypatch.setattr(service, "_propose_once", fake_propose_once)
    events = await collect(AgentRequest(prompt="explain", project=Project()))
    assert seen and seen[0].id == "bedrock"
    assert seen[0].kind == "bedrock"
    assert seen[0].model == service.settings.BEDROCK_MODEL_ID
    assert events[-1]["type"] == "answer"


@pytest.mark.asyncio
async def test_run_uses_the_requested_opencode_provider(monkeypatch):
    seen = []

    async def fake_propose_once(messages, spec, max_tokens=None):
        seen.append(spec)
        return Proposal(summary="explained")

    monkeypatch.setattr(service, "_propose_once", fake_propose_once)
    events = await collect(AgentRequest(prompt="explain", project=Project(), provider="opencode"))
    assert seen and seen[0].id == "opencode"
    assert seen[0].kind == "opencode"
    assert events[-1]["type"] == "answer"


@pytest.mark.asyncio
async def test_run_uses_the_requested_bedrock_provider(monkeypatch):
    seen = []

    async def fake_propose_once(messages, spec, max_tokens=None):
        seen.append(spec)
        return Proposal(summary="explained")

    monkeypatch.setattr(service, "_propose_once", fake_propose_once)
    monkeypatch.setattr(service.settings, "BEDROCK_MODEL_ID", "moonshotai.kimi-k2.5")
    monkeypatch.setattr(service.settings, "AWS_REGION", "eu-north-1")
    events = await collect(AgentRequest(prompt="explain", project=Project(), provider="bedrock"))
    assert seen and seen[0].id == "bedrock"
    assert seen[0].kind == "bedrock"
    assert seen[0].model == "moonshotai.kimi-k2.5"
    assert events[-1]["type"] == "answer"


@pytest.mark.asyncio
async def test_events_carry_a_stable_run_id(monkeypatch):
    monkeypatch.setattr(service, "propose", AsyncMock(return_value=Proposal(summary="It blinks")))
    events = await collect(AgentRequest(prompt="explain", project=Project()))
    assert {e["run_id"] for e in events} and len({e["run_id"] for e in events}) == 1


@pytest.mark.asyncio
async def test_result_carries_expectations_for_the_browser_verifier(monkeypatch):
    expectations = Expectations(
        observe_ms=3000,
        pins=[PinExpectation(pin="13", expect="toggles", min_transitions=2, period_ms=(800, 1200))],
    )
    monkeypatch.setattr(service, "propose",
                        AsyncMock(return_value=Proposal(summary="Blink", patch=blink_patch(),
                                                        expectations=expectations)))
    monkeypatch.setattr(service, "compile_project", AsyncMock(return_value=compile_ok()))
    events = await collect(AgentRequest(prompt="blink", project=Project()))
    assert events[-1]["type"] == "result"
    assert events[-1]["expectations"]["pins"][0]["pin"] == "13"
    assert events[-1]["expectations"]["pins"][0]["expect"] == "toggles"


@pytest.mark.asyncio
async def test_result_without_expectations_is_null(monkeypatch):
    monkeypatch.setattr(service, "propose",
                        AsyncMock(return_value=Proposal(summary="Blink", patch=blink_patch())))
    monkeypatch.setattr(service, "compile_project", AsyncMock(return_value=compile_ok()))
    events = await collect(AgentRequest(prompt="blink", project=Project()))
    assert events[-1]["type"] == "result" and events[-1]["expectations"] is None
