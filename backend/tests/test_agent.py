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
    events = [e async for e in service.run_agent(AgentRequest(prompt="blink", project=Project()))]
    assert [e["type"] for e in events] == ["stage", "plan", "stage", "stage", "compile", "result"]
    assert events[-1]["project"]["board"]["id"] == "uno"
    assert events[-1]["attempts"] == 1


@pytest.mark.asyncio
async def test_bounded_compile_repair_against_original(monkeypatch):
    llm = AsyncMock(return_value=Proposal(summary="Blink", patch=blink_patch()))
    compiler = AsyncMock(side_effect=[{"success": False, "stderr": "syntax error"}, {"success": True, "hex_content": ":00000001FF"}])
    monkeypatch.setattr(service, "propose", llm)
    monkeypatch.setattr(service, "compile_project", compiler)
    events = [e async for e in service.run_agent(AgentRequest(prompt="blink", project=Project()))]
    assert events[-1]["attempts"] == 2
    assert compiler.call_args_list[0].args[0] == compiler.call_args_list[1].args[0]
    assert any(e["type"] == "diagnostic" and e["message"] == "syntax error" for e in events)


@pytest.mark.asyncio
async def test_stops_after_three_failures(monkeypatch):
    llm = AsyncMock(return_value=Proposal(summary="Blink", patch=blink_patch()))
    monkeypatch.setattr(service, "propose", llm)
    monkeypatch.setattr(service, "compile_project", AsyncMock(return_value={"success": False, "stderr": "broken"}))
    events = [e async for e in service.run_agent(AgentRequest(prompt="blink", project=Project()))]
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
    monkeypatch.setattr(agent.settings, "AGENT_API_KEY", "server-secret")
    monkeypatch.setattr(agent.settings, "AGENT_ACCESS_TOKEN", "workspace-token")
    app = FastAPI()
    app.include_router(agent.router, prefix="/api/agent")
    return TestClient(app)


def test_auth_disabled_and_no_secret_leaks(client, monkeypatch):
    payload = AgentRequest(prompt="hi", project=Project()).model_dump()
    assert client.post("/api/agent/runs", json=payload).status_code == 401
    assert "server-secret" not in client.get("/api/agent/status").text
    monkeypatch.setattr(agent.settings, "AGENT_ENABLED", False)
    assert client.post("/api/agent/runs", json=payload).status_code == 503


def test_stream_endpoint_and_slot_release(client, monkeypatch):
    async def fake(_body):
        yield {"type": "answer", "summary": "Hello"}
    monkeypatch.setattr(agent, "run_agent", fake)
    response = client.post("/api/agent/runs", json=AgentRequest(prompt="hi", project=Project()).model_dump(), headers={"Authorization": "Bearer workspace-token"})
    assert response.status_code == 200
    assert json.loads(response.text)["summary"] == "Hello"
    assert not agent._slots.locked()


def test_internal_exception_not_exposed(client, monkeypatch):
    async def fake(_body):
        raise RuntimeError("server-secret")
        yield
    monkeypatch.setattr(agent, "run_agent", fake)
    response = client.post("/api/agent/runs", json=AgentRequest(prompt="hi", project=Project()).model_dump(), headers={"Authorization": "Bearer workspace-token"})
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
    events = [e async for e in service.run_agent(AgentRequest(prompt="blink", project=Project()))]
    assert events[-1]["type"] == "error"
    assert "arduino-cli" in events[-1]["message"]
    assert llm.await_count == 1
