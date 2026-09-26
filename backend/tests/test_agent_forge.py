"""Tests for the Velxio ↔ Forge bridge (agent project memory, JEV-governed).

The bridge is a direct HTTP connection to the standalone forge service, so the
tests fake `forge._request`/`forge._probe` instead of spawning node. They pin
the contract that matters: fail-open everywhere, the runtime toggle wins over
env, sessions map to one forge conversation, and accepted memory reaches the
model prompt via _base_messages.
"""
import asyncio
import json

import pytest

from app.agent import forge
from app.agent.models import AgentRequest


@pytest.fixture(autouse=True)
def isolate_state(tmp_path, monkeypatch):
    """State file in tmp; env defaults off so autostart never fires."""
    monkeypatch.setattr(forge.settings, "FORGE_ENABLED", True)
    monkeypatch.setattr(forge.settings, "FORGE_AUTOSTART", False)
    monkeypatch.setattr(forge.settings, "FORGE_BASE_URL", "http://127.0.0.1:59999")
    monkeypatch.setattr(forge.settings, "FORGE_TURN_TIMEOUT_S", 5.0)
    monkeypatch.setattr(forge, "_state_path", lambda: tmp_path / "forge_state.json")
    yield


CONV = {
    "id": "conv_1",
    "memory": {"notes": [
        {"kind": "rule", "status": "active", "text": "Only me, no other actors or crew."},
        {"kind": "fact", "status": "active", "text": "I have a phone."},
        {"kind": "assumption", "status": "pending", "text": "Brother may replace the rule."},
    ]},
    "counters": {"jevCalls": 2},
}


def fake_turn_payload(*, withheld=False):
    return {
        "conversation": CONV,
        "response": {"content": "ok", "meta": {"withheld": withheld},
                     "decisions": [{"kind": "memory_guard", "summary": "Passed · 2/2 active notes passed"}]},
        "decisions": [],
    }


# ── toggle: file override beats env, persists atomically ────────────────────

@pytest.mark.asyncio
async def test_toggle_persists_and_overrides_env():
    assert forge.is_enabled() is True
    await forge.set_enabled(False)
    assert forge.is_enabled() is False
    saved = json.loads((forge._state_path()).read_text())
    assert saved["enabled"] is False
    await forge.set_enabled(True)
    assert forge.is_enabled() is True


@pytest.mark.asyncio
async def test_status_reports_unreachable_without_raising(monkeypatch):
    async def dead_probe(timeout=2.0):
        return None
    monkeypatch.setattr(forge, "_probe", dead_probe)
    st = await forge.status()
    assert st["enabled"] is True and st["live"] is False and st["autostart"] is False
    assert st["forge_present"] is True  # the repo ships forge/server


# ── run_turn: happy path, session mapping, and fail-open paths ──────────────

@pytest.mark.asyncio
async def test_run_turn_builds_memory_context_and_maps_session(monkeypatch):
    async def live():
        return True, {}
    monkeypatch.setattr(forge, "ensure_live", live)
    calls = []

    async def fake_request(method, path, body=None, timeout=8.0):
        calls.append((method, path))
        if path == "/api/chat":
            return {"conversation": {"id": "conv_1"}}
        return fake_turn_payload()

    monkeypatch.setattr(forge, "_request", fake_request)
    result = await forge.run_turn("I want to make a film. Only me.", "ws-abc")
    assert result["ok"] is True
    # first use creates the conversation, the turn then posts to it
    assert calls == [("POST", "/api/chat"), ("POST", "/api/chat/conv_1/messages")]
    ctx = result["context"]
    assert "Only me, no other actors or crew." in ctx
    assert "[rule]" in ctx and "unconfirmed" in ctx
    assert "Brother may replace the rule." in ctx
    assert "I have a phone." in ctx
    # the pending note is under "Open, unconfirmed", not the active block
    assert ctx.index("[assumption?] Brother") > ctx.index("Open, unconfirmed")
    assert result["summary"] == {
        "conversation_id": "conv_1", "active_notes": 2, "open_notes": 1,
        "withheld": False, "jev_calls": 2, "guard": "Passed · 2/2 active notes passed",
    }
    # session → conversation id persists; the next turn skips creation
    assert forge._sessions()["ws-abc"] == "conv_1"
    calls.clear()
    await forge.run_turn("next", "ws-abc")
    assert calls == [("POST", "/api/chat/conv_1/messages")]


@pytest.mark.asyncio
async def test_run_turn_fails_open_when_forge_down(monkeypatch):
    async def live():
        return True, {}
    monkeypatch.setattr(forge, "ensure_live", live)
    async def dead(method, path, body=None, timeout=8.0):
        raise forge.ForgeUnavailable("forge is not reachable")
    monkeypatch.setattr(forge, "_request", dead)
    result = await forge.run_turn("anything")
    assert result["ok"] is False and result["error"] == "forge is not reachable"
    assert result["clarification"] == "" and result["pending_questions"] == []


@pytest.mark.asyncio
async def test_run_turn_silent_when_disabled(monkeypatch):
    await forge.set_enabled(False)
    async def explode(*a, **k):
        raise AssertionError("must not touch forge while disabled")
    monkeypatch.setattr(forge, "_request", explode)
    result = await forge.run_turn("anything")
    assert result["ok"] is False and result["context"] == ""


@pytest.mark.asyncio
async def test_run_turn_fails_open_on_unexpected_error(monkeypatch):
    async def live():
        return True, {}
    monkeypatch.setattr(forge, "ensure_live", live)
    async def weird(method, path, body=None, timeout=8.0):
        raise RuntimeError("provider exploded inside forge")
    monkeypatch.setattr(forge, "_request", weird)
    result = await forge.run_turn("anything")
    assert result["ok"] is False and "RuntimeError" in result["error"] and result["context"] == ""


@pytest.mark.asyncio
async def test_withheld_flag_surfaces(monkeypatch):
    async def live():
        return True, {}
    monkeypatch.setattr(forge, "ensure_live", live)
    async def fake_request(method, path, body=None, timeout=8.0):
        if path == "/api/chat":
            return {"conversation": {"id": "conv_1"}}
        return fake_turn_payload(withheld=True)
    monkeypatch.setattr(forge, "_request", fake_request)
    result = await forge.run_turn("a", "s1")
    assert result["summary"]["withheld"] is True


# ── memory_snapshot for the panel ────────────────────────────────────────────

@pytest.mark.asyncio
async def test_memory_snapshot_lists_notes_and_checks(monkeypatch):
    async def fake_request(method, path, body=None, timeout=8.0):
        assert path == "/api/chat/conv_9"
        conv = json.loads(json.dumps(CONV))
        conv["memory"]["events"] = [
            {"stage": "check", "status": "complete", "label": "Response passed the active-memory checks"},
            {"stage": "extract", "status": "complete", "label": "ignored"},
        ]
        return {"conversation": conv}
    monkeypatch.setattr(forge, "_request", fake_request)
    state = forge._load_state()
    state.setdefault("sessions", {})["s1"] = "conv_9"
    forge._save_state(state)
    snap = await forge.memory_snapshot("s1")
    assert len(snap["notes"]) == 3 and snap["checks"][0]["label"].startswith("Response passed")


# ── service wiring: memory reaches the model prompt ─────────────────────────

def _minimal_request():
    project = json.loads(json.dumps({
        "board": {"id": "arduino", "x": 0, "y": 0},
        "components": [], "wires": [],
        "files": [{"name": "main.ino", "content": "void setup(){}\nvoid loop(){}"}],
    }))
    return AgentRequest(prompt="make it blink", project=project, forge_session="ws-1")


def test_workspace_summary_stays_free_of_memory():
    """v2: the workspace summary block replaces the old state block; project
    memory joins the conversation as its own user turn, never inside it."""
    from app.agent import workspace as wsmod
    from app.agent.service import _workspace_summary
    project = AgentRequest.model_validate(_minimal_request().model_dump()).project
    summary = _workspace_summary(wsmod.Workspace(project, "make it blink"))
    assert "PROJECT MEMORY" not in summary
    assert "main.ino" in summary


def test_agent_request_accepts_forge_session():
    request = _minimal_request()
    assert request.forge_session == "ws-1"
    bad = json.loads(json.dumps({"prompt": "p", "project": request.project.model_dump(),
                                 "provider": "bedrock", "forge_session": "no spaces allowed!!"}))
    with pytest.raises(Exception):
        AgentRequest.model_validate(bad)


@pytest.mark.asyncio
async def test_run_agent_waits_for_the_decision_before_designing(monkeypatch):
    """JEV decides first. The coding model sees the rules, or the run stops to ask."""
    import app.agent.service as service

    turns = {"count": 0}
    seen: list[str] = []

    async def fake_decision(prompt, session="default"):
        turns["count"] += 1
        return {
            "ok": True,
            "context": "PROJECT MEMORY (user-established, JEV-reviewed; rules are binding):\n- [rule] Use a red LED only.",
            "summary": {"conversation_id": "c", "active_notes": 1, "open_notes": 0,
                        "withheld": False, "jev_calls": 1, "guard": "Passed"},
            "clarify": False,
            "decision": "answer",
            "clarification": "",
        }

    async def dead_decision(prompt, session="default"):
        turns["count"] += 1
        raise forge.ForgeUnavailable("forge is not reachable")

    async def clarify_decision(prompt, session="default"):
        turns["count"] += 1
        return {
            "ok": True,
            "context": "- [rule] Use a red LED only.",
            "summary": {"active_notes": 1},
            "clarify": True,
            "decision": "clarify",
            "clarification": "A decision is needed before designing. Which pin?",
        }

    async def llm(messages, spec, max_tokens, tools=True):
        seen.append("\n".join(str(m.get("content")) for m in messages))
        # Untouched workspace + done() = an explanation run (answer event).
        return service.ChatResult(tool_calls=[
            {"id": "t1", "name": "done",
             "arguments": json.dumps({"summary": "ok"})}])

    monkeypatch.setattr(forge, "run_decision", fake_decision)
    monkeypatch.setattr(service, "propose", llm)

    request = _minimal_request()
    events = [e async for e in service.run_agent(request)]
    assert events[0]["type"] == "run_started"
    forge_ev = [e for e in events if e["type"] == "forge"][0]
    assert forge_ev["status"] == "ok" and forge_ev["summary"]["active_notes"] == 1
    assert events[-1]["type"] == "answer"
    assert seen and "Use a red LED only." in seen[0]

    monkeypatch.setattr(forge, "run_decision", dead_decision)
    events = [e async for e in service.run_agent(request)]
    assert [e for e in events if e["type"] == "forge"][0]["status"] == "unavailable"
    assert events[-1]["type"] == "answer"

    monkeypatch.setattr(forge, "run_decision", clarify_decision)
    seen.clear()
    events = [e async for e in service.run_agent(request)]
    assert events[-1]["type"] == "answer"
    assert "Which pin?" in events[-1]["summary"]
    assert not seen
    assert turns["count"] == 3
