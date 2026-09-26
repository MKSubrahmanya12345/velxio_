"""Velxio agent contract tests: no paid model calls, no installed toolchain.

Covers the v2 loop contract, the workspace converter + intent check, the
routes and the compile service. The provider adapter is faked at
`service.propose`; the compiler at `service.compile_project`. The electrical
rules (shorted rails, series resistor) are pinned through `validate_electrical`
— the same path check()/done() use.
"""
import asyncio
import json
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.agent import service
from app.agent import workspace as wsmod
from app.agent.models import AgentRequest, Board, Part, Project, Source, validate_electrical
from app.api.routes import agent


DIAGRAM = {
    "board": "uno", "boardKind": "arduino-uno",
    "parts": [
        {"id": "led1", "type": "led", "x": 500, "y": 100, "props": {"color": "red"}},
        {"id": "r1", "type": "resistor", "x": 500, "y": 220, "props": {"value": "330"}},
    ],
    "connections": [
        {"from": "uno:13", "to": "r1:1", "color": "orange"},
        {"from": "r1:2", "to": "led1:A", "color": "orange"},
        {"from": "led1:C", "to": "uno:GND.1", "color": "black"},
    ],
}

SKETCH = ("void setup(){pinMode(13,OUTPUT);}\n"
          "void loop(){digitalWrite(13,HIGH);delay(500);"
          "digitalWrite(13,LOW);delay(500);}")


@pytest.fixture(autouse=True)
def no_forge_memory(monkeypatch):
    """Keep the run-loop tests hermetic: project memory is pinned by test_agent_forge."""
    from app.agent import forge

    monkeypatch.setattr(forge, "is_enabled", lambda: False)


def blink_workspace_files():
    return {"diagram.json": json.dumps(DIAGRAM), "sketch.ino": SKETCH}


def blink_project() -> Project:
    return wsmod.build_project(blink_workspace_files())


def tool_call(tool, **args):
    # `tool`, not `name`: write_file/read_file take a `name` argument, which
    # would collide with a `name` parameter here.
    return {"id": f"call-{tool}", "name": tool, "arguments": json.dumps(args)}


# --- the electrical rules still bind, on the v2 path -------------------------

def test_led_needs_series_resistor():
    p = blink_project()
    validate_electrical(p)  # the good circuit passes
    bad = p.model_copy(deep=True)
    # Bypass the resistor: wire the board pin straight to the LED anode.
    bad.wires = [w for w in bad.wires if not (w.start.componentId == "r1" or w.end.componentId == "r1")]
    from app.agent.models import Connection, Endpoint
    bad.wires.insert(0, Connection(id="w0",
                                   start=Endpoint(componentId="uno", pinName="13"),
                                   end=Endpoint(componentId="led1", pinName="A")))
    with pytest.raises(ValueError, match="series resistor"):
        validate_electrical(bad)


def test_power_rails_must_not_be_shorted():
    from app.agent.models import Connection, Endpoint
    p = blink_project()
    p.wires.append(Connection(id="short", start=Endpoint(componentId="uno", pinName="5V"),
                              end=Endpoint(componentId="uno", pinName="GND.1")))
    with pytest.raises(ValueError, match="shorted"):
        validate_electrical(p)


def test_file_names_and_caps_are_strict():
    for name in ["../../secret.ino", "/tmp/x.cpp", "foo.txt", "foo\\bar.h", "no-ext"]:
        with pytest.raises(ValidationError):
            Source(name=name, content="")
    with pytest.raises(ValidationError):
        Source(name="sketch.ino", content="x" * 40001)


def test_part_capabilities_are_strict():
    for kwargs in [{"metadataId": "esp32"}, {"x": float("nan")}, {"x": float("inf")},
                   {"properties": {"value": "1"}, "metadataId": "resistor"},
                   {"properties": {"url": "https://example.com"}}]:
        with pytest.raises(ValidationError):
            Part(**({"id": "part", "metadataId": "led", "x": 0, "y": 0} | kwargs))


def test_board_kind_is_explicit_and_defaults_are_sane():
    assert Board(id="esp32").boardKind == "esp32"
    assert Board(id="arduino").boardKind == "arduino-uno"


def test_wifi_header_is_scoped_to_esp32():
    from app.agent.models import validate_includes
    uno = "arduino-uno"
    with pytest.raises(ValueError, match="WiFi.h"):
        validate_includes("#include <WiFi.h>\nvoid setup(){} void loop(){}",
                          set(), board_id=uno)
    validate_includes("#include <WiFi.h>\nvoid setup(){} void loop(){}",
                      set(), board_id="esp32-devkit-c-v4")


def test_preprocessor_include_bypasses_are_rejected():
    from app.agent.models import validate_includes
    for code in ['#include/**/"/etc/passwd"',
                 '#include \\\n"/etc/passwd"',
                 '#define HEADER "/etc/passwd"\n#include HEADER',
                 '#include_next <Arduino.h>',
                 '%:include "/etc/passwd"',
                 '??=include "/etc/passwd"']:
        with pytest.raises(ValueError):
            validate_includes(code, set())


def test_local_headers_and_comment_like_literals_pass():
    validate_includes(
        '#include /* core */ <Arduino.h>\n#include "local.h"\n'
        'const char* url="https://example.com";',
        {"local.h"})


# --- the workspace: converter, caps, intent check ----------------------------

def test_workspace_round_trip_preserves_the_project():
    p = blink_project()
    assert p.board.boardKind == "arduino-uno"
    assert {c.id for c in p.components} == {"led1", "r1"}
    assert len(p.wires) == 3
    assert {f.name for f in p.files} == {"sketch.ino"}


def test_build_rejects_unresolvable_pins_and_bad_parts():
    bad = dict(DIAGRAM)
    bad["parts"] = DIAGRAM["parts"] + [{"id": "x1", "type": "led", "x": 0, "y": 0}]
    bad["parts"][-1]["type"] = "not-a-part"
    with pytest.raises(wsmod.WorkspaceError):
        wsmod.build_project({"diagram.json": json.dumps(bad), "sketch.ino": SKETCH})
    bad2 = json.loads(json.dumps(DIAGRAM))
    bad2["connections"].append({"from": "uno:999", "to": "led1:A"})
    with pytest.raises(wsmod.WorkspaceError):
        wsmod.build_project({"diagram.json": json.dumps(bad2), "sketch.ino": SKETCH})


def test_file_caps_are_enforced():
    ws = wsmod.Workspace(Project(), "blink an led")
    envelope = ws.write_file("big.h", "x" * (64 * 1024 + 1))
    assert envelope["ok"] is False and "64" in envelope["error"]


def test_wire_colour_names_are_accepted():
    """The system prompt's own diagram example writes `"color":"red"`; a
    colour name must build, not raise on the #rrggbb pattern."""
    p = blink_project()  # DIAGRAM wires are "orange" and "black"
    assert [w.color for w in p.wires] == ["#f97316", "#f97316", "#111827"]


def test_a_model_invented_part_property_is_tool_data_not_a_dead_run():
    """`resistance` is not an editable resistor property. That is a design
    problem the model fixes in one edit, so it must reach it as a problem
    line — a raw pydantic error here escaped the tools and killed the run."""
    diagram = json.loads(json.dumps(DIAGRAM))
    diagram["parts"][1]["props"] = {"resistance": 330}
    files = {"diagram.json": json.dumps(diagram), "sketch.ino": SKETCH}
    with pytest.raises(wsmod.WorkspaceError) as excinfo:
        wsmod.build_project(files)
    # the message names the offender AND the fix
    assert "resistance" in str(excinfo.value) and "value" in str(excinfo.value)
    ws = wsmod.Workspace(Project(), "blink an led")
    ws.files = files
    envelope = ws.check()
    assert envelope["ok"] is True
    assert envelope["data"]["clean"] is False
    assert "resistance" in envelope["data"]["problems"][0]


def test_mentioned_parts_are_found_and_missing_parts_rejected():
    assert "servo" in wsmod.mentioned_parts("control a servo with a button")
    assert wsmod.mentioned_parts("blink an led") == []  # ids < 4 chars never match
    ws = wsmod.Workspace(Project(), "drive a servo")
    for name, content in blink_workspace_files().items():
        envelope = ws.write_file(name, content)
        assert envelope["ok"] is True
    envelope = ws.done("built it")
    assert envelope["ok"] is False
    assert "servo" in envelope["error"]


def test_done_on_untouched_workspace_is_an_explanation():
    ws = wsmod.Workspace(Project(), "what is a pull-up resistor")
    envelope = ws.done("A pull-up resistor holds the pin high when nothing drives it.")
    assert envelope["ok"] is True
    assert envelope["data"]["kind"] == "explain"


def test_done_requires_a_summary():
    ws = wsmod.Workspace(Project(), "blink")
    envelope = ws.done("")
    assert envelope["ok"] is False


# --- the v2 tool loop --------------------------------------------------------

@pytest.mark.asyncio
async def test_v2_loop_writes_checks_and_finishes(monkeypatch):
    """One scripted turn: write diagram + sketch, done -> gates -> result."""
    async def llm(messages, spec, max_tokens, tools=True):
        return service.ChatResult(tool_calls=[
            tool_call("write_file", name="diagram.json", content=json.dumps(DIAGRAM)),
            tool_call("write_file", name="sketch.ino", content=SKETCH),
            tool_call("done", summary="Blink built"),
        ])

    monkeypatch.setattr(service, "propose", llm)
    monkeypatch.setattr(service, "compile_project",
                        AsyncMock(return_value={"success": True, "hex_content": ":00000001FF",
                                                "stdout": "compiled"}))
    events = [e async for e in service.run_agent(
        AgentRequest(prompt="blink an led", project=Project()))]
    kinds = [e["type"] for e in events]
    assert kinds[0] == "run_started" and kinds[-1] == "result"
    assert "tools" in kinds and "compile" in kinds
    # The terminal trace rides just before the terminal event (the frontend
    # renders it as the run's latency/token footer).
    assert kinds[kinds.index("result") - 1] == "latency_summary"
    trace = next(e for e in events if e["type"] == "latency_summary")
    assert trace["provider_ms"] >= 0 and trace["prompt_tokens"] == 0
    assert trace["cache_hit_pct"] is None  # nothing measured -> never implied
    tools_ev = next(e for e in events if e["type"] == "tools")
    assert all(c["ok"] for c in tools_ev["calls"])
    result = events[-1]
    assert result["project"]["board"]["boardKind"] == "arduino-uno"
    assert result["hex"] == ":00000001FF"
    assert result["summary"] == "Blink built"


@pytest.mark.asyncio
async def test_v2_done_gate_rejects_missing_mentioned_part(monkeypatch):
    """done() is the intent check: a named part that is absent is a bare fact.
    The fix is to add it — never an explanation, never a prose escape hatch."""
    async def llm(messages, spec, max_tokens, tools=True):
        # Prompt names a servo; the model "forgets" it and calls done.
        return service.ChatResult(tool_calls=[
            tool_call("write_file", name="diagram.json", content=json.dumps(DIAGRAM)),
            tool_call("write_file", name="sketch.ino", content=SKETCH),
            tool_call("done", summary="built it"),
        ])

    monkeypatch.setattr(service, "propose", llm)
    monkeypatch.setattr(service, "compile_project",
                        AsyncMock(return_value={"success": True, "hex_content": ":00000001FF"}))
    events = [e async for e in service.run_agent(
        AgentRequest(prompt="drive a servo", project=Project()))]
    # The model keeps "forgetting" the servo, done() keeps refusing, and the
    # run ends at the turn cap with no result — exactly one enforcement layer.
    assert events[-1]["type"] == "error"
    tools_ev = [e for e in events if e["type"] == "tools"][0]
    assert tools_ev["calls"][-1]["ok"] is False  # done() was refused
    assert not any(e["type"] == "result" for e in events)


@pytest.mark.asyncio
async def test_v2_compile_failure_feeds_back_and_the_loop_continues(monkeypatch):
    """A failed done() gate is NOT the end of the run: the fix request goes
    back to the model and the loop continues (the budgets still bind it)."""
    calls = {"n": 0}

    async def llm(messages, spec, max_tokens, tools=True):
        calls["n"] += 1
        sketch = SKETCH if calls["n"] == 1 else SKETCH + "\n// fixed"
        return service.ChatResult(tool_calls=[
            tool_call("write_file", name="diagram.json", content=json.dumps(DIAGRAM)),
            tool_call("write_file", name="sketch.ino", content=sketch),
            tool_call("done", summary="Blink built"),
        ])

    monkeypatch.setattr(service, "propose", llm)
    compiler = AsyncMock(side_effect=[
        {"success": False, "stderr": "syntax error"},
        {"success": True, "hex_content": ":00000001FF"}])
    monkeypatch.setattr(service, "compile_project", compiler)
    events = [e async for e in service.run_agent(
        AgentRequest(prompt="blink an led", project=Project()))]
    assert events[-1]["type"] == "result"
    assert compiler.await_count == 2
    assert calls["n"] == 2  # the feedback turn really happened


@pytest.mark.asyncio
async def test_v2_unconfigured_bedrock_is_a_hard_error(monkeypatch):
    monkeypatch.setattr(service.settings, "BEDROCK_MODEL_ID", "")
    monkeypatch.setattr(service.settings, "AWS_REGION", "")
    monkeypatch.setattr(service.settings, "BEDROCK_REGION", "")
    events = [e async for e in service.run_agent(AgentRequest(prompt="x", project=Project()))]
    assert events[-1]["type"] == "error"
    assert "bedrock" in events[-1]["message"].lower()


def test_fast_mode_shrinks_the_compile_headroom():
    from app.agent.compile_service import family_ceiling_s
    from app.agent.service import agent_run_budget_s
    assert family_ceiling_s("esp32-devkit-c-v4", fast=True) == 180.0
    assert agent_run_budget_s("esp32-devkit-c-v4", fast=True) < agent_run_budget_s(
        "esp32-devkit-c-v4")
    # AVR: fast ceiling (30s) is under the flat budget, so no headroom either way.
    assert agent_run_budget_s("arduino-uno", fast=True) == agent_run_budget_s(
        "arduino-uno", fast=False)


# --- routes ------------------------------------------------------------------

@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(agent.settings, "AGENT_ENABLED", True)
    monkeypatch.setattr(agent.settings, "BEDROCK_MODEL_ID", "bedrock-model")
    monkeypatch.setattr(agent.settings, "AWS_REGION", "us-east-1")
    app = FastAPI()
    app.include_router(agent.router, prefix="/api/agent")
    return TestClient(app)


def test_runs_open_and_no_secret_leaks(client, monkeypatch):
    async def fake(_body):
        yield {"type": "answer", "summary": "Hello"}
    monkeypatch.setattr(agent, "run_agent", fake)
    payload = AgentRequest(prompt="hi", project=Project()).model_dump()
    assert client.post("/api/agent/runs", json=payload).status_code == 200
    assert "server-secret" not in client.get("/api/agent/status").text
    # Opt-in gate: AGENT_ENABLED=False means 503, on means the (Bedrock-only)
    # agent serves runs.
    monkeypatch.setattr(agent.settings, "AGENT_ENABLED", False)
    assert client.post("/api/agent/runs", json=payload).status_code == 503
    monkeypatch.setattr(agent.settings, "AGENT_ENABLED", True)
    assert client.post("/api/agent/runs", json=payload).status_code == 200


def test_stream_endpoint_and_slot_release(client, monkeypatch):
    async def fake(_body):
        yield {"type": "answer", "summary": "Hello"}
    monkeypatch.setattr(agent, "run_agent", fake)
    response = client.post("/api/agent/runs", json=AgentRequest(prompt="hi", project=Project()).model_dump())
    assert response.status_code == 200
    assert json.loads(response.text)["summary"] == "Hello"
    assert not agent._slots.locked()


def test_internal_exception_not_exposed(client, monkeypatch):
    async def fake(_body):
        raise RuntimeError("server-secret")
        yield
    monkeypatch.setattr(agent, "run_agent", fake)
    response = client.post("/api/agent/runs", json=AgentRequest(prompt="hi", project=Project()).model_dump())
    assert "server-secret" not in response.text
    assert json.loads(response.text)["type"] == "error"
    assert not agent._slots.locked()


# --- compile service ---------------------------------------------------------

@pytest.mark.asyncio
async def test_compile_process_cancel_kills_group(monkeypatch):
    from app.agent import compile_service
    process = AsyncMock()
    process.pid = 12345
    process.returncode = None
    async def hang(*_args):
        await asyncio.sleep(10)
    process.communicate.side_effect = hang
    monkeypatch.setattr(compile_service.asyncio, "create_subprocess_exec", AsyncMock(return_value=process))
    killed = []
    monkeypatch.setattr(compile_service.os, "killpg", lambda *args: killed.append(args))
    task = asyncio.create_task(compile_service.compile_project(blink_project()))
    await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert killed and killed[0][0] == 12345
    process.wait.assert_awaited_once()
