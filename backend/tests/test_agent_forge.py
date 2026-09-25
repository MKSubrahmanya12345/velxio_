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
from app.agent.models import AgentRequest, Proposal


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
    assert result == {"ok": False, "context": "", "summary": {}, "error": "forge is not reachable"}


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


def test_base_messages_injects_forge_block():
    from app.agent.service import _base_messages
    request = _minimal_request()
    messages = _base_messages(request)
    # Layout: [system] → [history] → [state] → [request]; the request (last)
    # must stay free of memory, and without context the state block is clean too.
    assert "PROJECT MEMORY" not in messages[-1]["content"]
    assert "PROJECT MEMORY" not in messages[-2]["content"]
    request._forge_context = "PROJECT MEMORY (user-established, JEV-reviewed; rules are binding):\n- [rule] Only one LED."
    # Accepted memory reaches the state message (second to last), which the
    # cache-friendly layout keeps byte-stable for the whole run.
    assert "[rule] Only one LED." in _base_messages(request)[-2]["content"]


def test_agent_request_accepts_forge_session():
    request = _minimal_request()
    assert request.forge_session == "ws-1"
    bad = json.loads(json.dumps({"prompt": "p", "project": request.project.model_dump(),
                                 "provider": "bedrock", "forge_session": "no spaces allowed!!"}))
    with pytest.raises(Exception):
        AgentRequest.model_validate(bad)


@pytest.mark.asyncio
async def test_run_agent_yields_forge_event_and_survives_failures(monkeypatch):
    """Memory no longer blocks the first provider call: the turn runs as a
    background task, its verdict is yielded when it lands, and a dead forge
    degrades to an 'unavailable' event instead of a crash."""
    import app.agent.service as service

    turns = {"count": 0}

    async def fake_run_turn(prompt, session="default"):
        turns["count"] += 1
        await asyncio.sleep(0)
        return {"ok": True, "context": "PROJECT MEMORY (user-established, JEV-reviewed; rules are binding):\n- [rule] Use a red LED only.",
                "summary": {"conversation_id": "c", "active_notes": 1, "open_notes": 0,
                            "withheld": False, "jev_calls": 3, "guard": "Passed"}}

    async def dead_turn(prompt, session="default"):
        turns["count"] += 1
        await asyncio.sleep(0)
        raise forge.ForgeUnavailable("forge is not reachable")

    async def llm(messages, spec=None, max_tokens=None):
        # A real provider call yields to the loop (network I/O); the sleep is
        # the parity for that, letting the forge task run during the call.
        await asyncio.sleep(0)
        return Proposal(summary="ok")

    monkeypatch.setattr(forge, "run_turn", fake_run_turn)
    monkeypatch.setattr(service, "propose", llm)

    request = _minimal_request()
    events = [e async for e in service.run_agent(request)]
    kinds = [e["type"] for e in events]
    assert kinds[0] == "run_started"
    assert "forge" in kinds
    forge_ev = [e for e in events if e["type"] == "forge"][0]
    assert forge_ev["status"] == "ok" and forge_ev["summary"]["active_notes"] == 1
    # The terminal event stays last for consumers that key on events[-1].
    assert events[-1]["type"] == "answer"

    # fail-open: an unavailable forge yields an 'unavailable' event, not a crash.
    # `count` is deliberately not reset: it proves both runs attempted the turn.
    monkeypatch.setattr(forge, "run_turn", dead_turn)
    events = [e async for e in service.run_agent(request)]
    assert [e for e in events if e["type"] == "forge"][0]["status"] == "unavailable"
    assert turns["count"] == 2  # both runs attempted the turn, neither propagated an error
