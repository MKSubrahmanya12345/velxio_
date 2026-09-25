"""Offline agent contract tests: no paid model calls and no installed toolchain needed."""
import asyncio
import json
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.agent import service
from app.agent.models import AgentRequest, Board, Connection, Endpoint, Part, Patch, Project, Proposal, Source, apply_patch
from app.api.routes import agent


def wire(id, a, ap, b, bp):
    return Connection(id=id, start=Endpoint(componentId=a, pinName=ap), end=Endpoint(componentId=b, pinName=bp))


@pytest.fixture(autouse=True)
def no_forge_memory(monkeypatch):
    """Keep the run-loop tests hermetic: project memory is pinned by test_agent_forge.

    FORGE_ENABLED defaults to on, and run_agent asks forge for context before the
    first propose — which adds a `stage` and a `forge` event to the stream and, in
    an offline run, waits for an unreachable server.
    """
    from app.agent import forge

    monkeypatch.setattr(forge, "is_enabled", lambda: False)


def blink_patch():
    return Patch(
        board=Board(id="uno"),
        upsert_components=[Part(id="led1", metadataId="led", x=500, y=100, properties={"color": "red"}),
                           Part(id="r1", metadataId="resistor", x=500, y=220, properties={"value": "330"})],
        upsert_wires=[wire("w1", "uno", "13", "r1", "1"), wire("w2", "r1", "2", "led1", "A"), wire("w3", "led1", "C", "uno", "GND.1")],
        upsert_files=[Source(name="sketch.ino", content="void setup() {}\nvoid loop() {}")],
    )


def project():
    return apply_patch(Project(), blink_patch())


def test_create_and_targeted_edit_preserve_unrelated_items():
    before = project()
    after = apply_patch(before, Patch(upsert_files=[Source(name="sketch.ino", content="// edited\nvoid setup() {}\nvoid loop() {}")]))
    assert after.components == before.components
    assert after.wires == before.wires
    assert not before.files[0].content.startswith("// edited")


def test_add_part_and_code_together():
    before = project()
    patch = Patch(upsert_components=[Part(id="button", metadataId="pushbutton", x=500, y=350)],
                  upsert_wires=[wire("b1", "uno", "2", "button", "1.l"), wire("b2", "button", "2.r", "uno", "GND.1")],
                  upsert_files=[Source(name="sketch.ino", content="// button control\nvoid setup(){} void loop(){}")])
    assert len(apply_patch(before, patch).components) == 3


def test_removing_part_requires_removing_wires():
    with pytest.raises(ValueError, match="Invalid endpoint"):
        apply_patch(project(), Patch(remove_components=["led1"]))
    result = apply_patch(project(), Patch(remove_components=["led1"], remove_wires=["w2", "w3"]))
    assert [p.id for p in result.components] == ["r1"]


@pytest.mark.parametrize("patch, message", [
    (Patch(board=Board(id="different")), "board ID"),
    (Patch(remove_files=["absent.ino"]), "unknown"),
    (Patch(remove_files=["sketch.ino"]), "exactly one"),
    (Patch(upsert_files=[Source(name="extra.ino", content="")]), "exactly one"),
    (Patch(upsert_components=[Part(id="uno", metadataId="buzzer", x=0, y=0)]), "Duplicate"),
    (Patch(upsert_wires=[wire("bad", "uno", "999", "r1", "1")]), "Invalid endpoint"),
    (Patch(upsert_wires=[wire("bad", "uno", "5V", "uno", "GND")]), "shorted"),
    (Patch(upsert_wires=[wire("bad", "uno", "5V", "uno", "3.3V")]), "shorted"),
    (Patch(upsert_wires=[wire("bad", "uno", "13", "uno", "13")]), "different pins"),
    (Patch(upsert_files=[Source(name="sketch.ino", content='#include <WiFi.h>')]), "Unsupported include"),
])
def test_invalid_patches_are_rejected(patch, message):
    before = project()
    original = before.model_dump_json()
    with pytest.raises(ValueError, match=message):
        apply_patch(before, patch)
    assert before.model_dump_json() == original


def test_remove_both_and_upsert_same_item_resolves_to_upsert():
    f = Source(name="sketch.ino", content="void setup(){} void loop(){}")
    after = apply_patch(project(), Patch(upsert_files=[f], remove_files=[f.name]))
    assert [x.name for x in after.files] == ["sketch.ino"]
    assert after.files[0].content == f.content


def test_duplicate_upsert_resolves_to_last_occurrence():
    a = Source(name="sketch.ino", content="void setup(){} void loop(){}")
    b = Source(name="sketch.ino", content="// updated\nvoid setup(){} void loop(){}")
    after = apply_patch(project(), Patch(upsert_files=[a, b]))
    assert [x.name for x in after.files] == ["sketch.ino"]
    assert after.files[0].content == b.content


def test_duplicate_upsert_components_resolves_to_last():
    p = project()
    led = Part(id="led1", metadataId="led", x=0, y=0)
    led_new = Part(id="led1", metadataId="led", x=100, y=200)
    after = apply_patch(p, Patch(upsert_components=[led_new, led]))
    assert [x for x in after.components if x.id == "led1"][0].x == 0


@pytest.mark.parametrize("name", ["../../secret.ino", "/tmp/x.cpp", "foo.txt", "foo\\bar.h"])
def test_file_path_escapes_rejected(name):
    with pytest.raises(ValidationError):
        Source(name=name, content="")


def test_missing_or_parallel_led_resistor_rejected():
    p = blink_patch()
    p.upsert_wires[0] = wire("w1", "uno", "13", "led1", "A")
    with pytest.raises(ValueError, match="series resistor"):
        apply_patch(Project(), p)


def test_board_kind_is_explicit_and_first_draft_can_infer_esp32():
    assert Board(id="esp32").boardKind == "esp32"
    draft = apply_patch(
        Project(),
        Patch(upsert_files=[Source(
            name="sketch.ino",
            content="#include <WiFi.h>\nvoid setup(){} void loop(){}",
        )]),
        board_hint="Build this on an ESP32 with WiFi",
    )
    assert draft.board is not None
    assert draft.board.boardKind == "esp32"


def test_wifi_header_is_scoped_to_esp32():
    source = Source(name="sketch.ino", content="#include <WiFi.h>\nvoid setup(){} void loop(){}")
    with pytest.raises(ValueError, match="WiFi.h"):
        apply_patch(Project(board=Board(id="uno"), files=[Source(
            name="sketch.ino", content="void setup(){} void loop(){}")]),
            Patch(upsert_files=[source]))
    esp32 = apply_patch(
        Project(board=Board(id="esp", boardKind="esp32"), files=[Source(
            name="sketch.ino", content="void setup(){} void loop(){}")]),
        Patch(upsert_files=[source]),
    )
    assert esp32.board.boardKind == "esp32"


@pytest.mark.parametrize("kwargs", [
    {"metadataId": "esp32"}, {"x": float("nan")}, {"x": float("inf")},
    {"properties": {"value": "1"}, "metadataId": "resistor"},
    {"properties": {"url": "https://example.com"}},
])
def test_capabilities_are_strict(kwargs):
    with pytest.raises(ValidationError):
        Part(**({"id": "part", "metadataId": "led", "x": 0, "y": 0} | kwargs))


@pytest.mark.asyncio
async def test_stream_success(monkeypatch):
    monkeypatch.setattr(service, "propose", AsyncMock(return_value=Proposal(summary="Blink", plan=["Wire LED"], patch=blink_patch())))
    monkeypatch.setattr(service, "compile_project", AsyncMock(return_value={"success": True, "hex_content": ":00000001FF", "stdout": "compiled"}))
    # fast_mode=False: this is the full pipeline (compile stage + real HEX).
    # Fast Mode is pinned by test_fast_mode_returns_a_result_without_waiting.
    events = [e async for e in service.run_agent(AgentRequest(prompt="blink", project=Project(), fast_mode=False))]
    # canvas_update events stream the progressive build and are not part of the
    # stage contract asserted here.
    assert [e["type"] for e in events if e["type"] != "canvas_update"] == [
        "run_started", "stage", "plan", "stage", "stage", "compile", "result"]
    assert events[-1]["project"]["board"]["id"] == "uno"
    assert events[-1]["attempts"] == 1


@pytest.mark.asyncio
async def test_fast_mode_surfaces_toolchain_failure_without_fake_firmware(monkeypatch):
    """Fast Mode still attempts a real build and never presents fake HEX."""
    llm = AsyncMock(return_value=Proposal(summary="Blink", patch=blink_patch()))
    monkeypatch.setattr(service, "propose", llm)
    monkeypatch.setattr(service, "compile_project", AsyncMock(return_value={
        "success": False,
        "error_kind": "toolchain_unavailable",
        "error": "no toolchain",
    }))
    events = [e async for e in service.run_agent(AgentRequest(prompt="blink", project=Project()))]
    assert events[-1]["type"] == "error"
    assert "arduino-cli" in events[-1]["message"]
    assert llm.await_count == 1


def button_patch(gnd_pin):
    """Pushbutton on pin 2; GND on the button leg named by `gnd_pin`.

    1.l/1.r are the two legs of ONE contact, 2.l/2.r the other, so `1.r` is the
    miswire (the pin is tied straight to GND and the switch does nothing) and
    `2.l` is the correct one.
    """
    return Patch(
        board=Board(id="uno"),
        upsert_components=[Part(id="btn1", metadataId="pushbutton", x=500, y=300)],
        upsert_wires=[wire("b1", "uno", "2", "btn1", "1.l"), wire("b2", "btn1", gnd_pin, "uno", "GND.1")],
        upsert_files=[Source(name="sketch.ino", content=(
            "void setup(){pinMode(2,INPUT_PULLUP);}\nvoid loop(){if(!digitalRead(2)){}}"))],
    )


@pytest.mark.asyncio
async def test_rejected_patch_is_shown_to_the_model_on_the_repair_turn(monkeypatch):
    """The bug behind "Repairing from diagnostics · attempt 4" with nothing built.

    A rejected patch was never put back into the conversation, so the model saw
    only the ORIGINAL project — which does not contain the draft it had just
    produced — plus one generic diagnostic line. It re-derived the same
    miswiring on every attempt until the run gave up. The repair turn now
    carries the rejected candidate and a diagnostic that names the part and the
    wire to move, so a single repair turn is enough.
    """
    seen: list[list[dict]] = []

    async def llm(messages, spec=None, max_tokens=None):
        seen.append(messages)
        diagnostics = "\n".join(m["content"] for m in messages if m["role"] == "user")
        return Proposal(summary="Button on pin 2",
                        patch=button_patch("2.l" if "SAME contact" in diagnostics else "1.r"))

    monkeypatch.setattr(service, "propose", llm)
    monkeypatch.setattr(service, "compile_project",
                        AsyncMock(return_value={"success": True, "hex_content": ":00000001FF"}))
    events = [e async for e in service.run_agent(AgentRequest(prompt="a button on pin 2", project=Project()))]

    assert [e["type"] for e in events].count("diagnostic") == 1
    assert events[-1]["type"] == "result" and events[-1]["attempts"] == 2
    repair_turn = seen[1]
    # The failing candidate travels with the diagnostic…
    assert any(m["role"] == "assistant" and '"1.r"' in m["content"] for m in repair_turn)
    # …and the diagnostic points at the wire to move, not at "add a component".
    assert any("Move the GND.1 wire from btn1.1.r to btn1.2.l" in m["content"] for m in repair_turn)


@pytest.mark.asyncio
async def test_bounded_compile_repair_against_original(monkeypatch):
    llm = AsyncMock(return_value=Proposal(summary="Blink", patch=blink_patch()))
    compiler = AsyncMock(side_effect=[{"success": False, "stderr": "syntax error"}, {"success": True, "hex_content": ":00000001FF"}])
    monkeypatch.setattr(service, "propose", llm)
    monkeypatch.setattr(service, "compile_project", compiler)
    events = [e async for e in service.run_agent(AgentRequest(prompt="blink", project=Project(), fast_mode=False))]
    assert events[-1]["attempts"] == 2
    assert compiler.call_args_list[0].args[0] == compiler.call_args_list[1].args[0]
    assert any(e["type"] == "diagnostic" and e["message"] == "syntax error" for e in events)


@pytest.mark.asyncio
async def test_stops_after_three_failures(monkeypatch):
    # The cap is a setting; pin it so the test says what it means.
    monkeypatch.setattr(service.settings, "AGENT_MAX_ATTEMPTS", 3)
    llm = AsyncMock(return_value=Proposal(summary="Blink", patch=blink_patch()))
    monkeypatch.setattr(service, "propose", llm)
    monkeypatch.setattr(service, "compile_project", AsyncMock(return_value={"success": False, "stderr": "broken"}))
    events = [e async for e in service.run_agent(AgentRequest(prompt="blink", project=Project(), fast_mode=False))]
    assert events[-1]["type"] == "error"
    assert llm.await_count == 3
    assert not any(e["type"] == "result" for e in events)


@pytest.mark.asyncio
async def test_explain_does_not_compile(monkeypatch):
    monkeypatch.setattr(service, "propose", AsyncMock(return_value=Proposal(summary="This is an LED circuit")))
    compiler = AsyncMock()
    monkeypatch.setattr(service, "compile_project", compiler)
    events = [e async for e in service.run_agent(AgentRequest(prompt="explain", project=project()))]
    assert events[-1]["type"] == "answer"
    compiler.assert_not_called()


@pytest.mark.asyncio
async def test_invalid_model_output_repairs_without_compilation(monkeypatch):
    llm = AsyncMock(side_effect=[ValueError("bad JSON"), Proposal(summary="Please clarify")])
    monkeypatch.setattr(service, "propose", llm)
    compiler = AsyncMock()
    monkeypatch.setattr(service, "compile_project", compiler)
    events = [e async for e in service.run_agent(AgentRequest(prompt="build", project=Project()))]
    assert events[-1]["type"] == "answer"
    compiler.assert_not_called()


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
    # Opt-in still gates keyed providers: AGENT_ENABLED=False + no built-in
    # planner = 503. With the built-in planner (on by default) the run is
    # served locally and costs nothing, so it stays open.
    monkeypatch.setattr(agent.settings, "AGENT_ENABLED", False)
    monkeypatch.setattr(agent.settings, "AGENT_BUILTIN", False)
    assert client.post("/api/agent/runs", json=payload).status_code == 503
    monkeypatch.setattr(agent.settings, "AGENT_BUILTIN", True)
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


@pytest.mark.asyncio
async def test_compile_process_cancel_kills_group(monkeypatch):
    process = AsyncMock()
    process.pid = 12345
    process.returncode = None
    async def hang(*_args):
        await asyncio.sleep(10)
    process.communicate.side_effect = hang
    monkeypatch.setattr(service.asyncio, "create_subprocess_exec", AsyncMock(return_value=process))
    killed = []
    monkeypatch.setattr(service.os, "killpg", lambda *args: killed.append(args))
    task = asyncio.create_task(service.compile_project(project()))
    await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert killed[0][0] == 12345
    process.wait.assert_awaited_once()


@pytest.mark.parametrize("code", [
    '#include/**/"/etc/passwd"',
    '#include \\\n"/etc/passwd"',
    '#define HEADER "/etc/passwd"\n#include HEADER',
    '#include_next <Arduino.h>',
    '%:include "/etc/passwd"',
    '??=include "/etc/passwd"',
])
def test_preprocessor_include_bypasses_are_rejected(code):
    with pytest.raises(ValueError):
        apply_patch(project(), Patch(upsert_files=[Source(name="sketch.ino", content=code)]))


def test_core_local_headers_and_comment_like_literals():
    p = Patch(upsert_files=[
        Source(name="sketch.ino", content='#include /* core */ <Arduino.h>\n#include "local.h"\nconst char* url="https://example.com";'),
        Source(name="local.h", content="#pragma once\n// comment"),
    ])
    assert len(apply_patch(project(), p).files) == 2


@pytest.mark.asyncio
async def test_toolchain_failure_does_not_spend_tokens_on_code_repairs(monkeypatch):
    llm = AsyncMock(return_value=Proposal(summary="Blink", patch=blink_patch()))
    monkeypatch.setattr(service, "propose", llm)
    monkeypatch.setattr(service, "compile_project", AsyncMock(return_value={"success": False, "error_kind": "toolchain_unavailable"}))
    events = [e async for e in service.run_agent(AgentRequest(prompt="blink", project=Project(), fast_mode=False))]
    assert events[-1]["type"] == "error"
    assert "arduino-cli" in events[-1]["message"]
    assert llm.await_count == 1
