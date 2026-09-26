"""Physics scene layer: agent/MCP tool surface + headless runner contract.

The runner tests need Node.js and the bundled core
(backend/app/mcp/physics-core.cjs); they skip cleanly where either is absent.
"""
from __future__ import annotations

import asyncio
import shutil

import pytest

from app.mcp import server as mcp_server
from app.mcp.server import physics_capabilities, physics_simulate

HAS_NODE = shutil.which("node") is not None
CORE = mcp_server._PHYSICS_SIM_SCRIPT.with_name("physics-core.cjs")
RUNNER_AVAILABLE = HAS_NODE and mcp_server._PHYSICS_SIM_SCRIPT.exists() and CORE.exists()

QUAD_SCENE = {
    "version": 1,
    "name": "test quad",
    "environment": {"floorY": 0, "gravity": {"x": 0, "y": -9.81, "z": 0}},
    "bodies": [{
        "id": "craft", "mass": 1,
        "position": {"x": 0, "y": 2, "z": 0},
        "inertia": {"ix": 0.01, "iy": 0.01, "iz": 0.01},
        "shape": {"type": "box", "halfExtents": {"x": 0.2, "y": 0.05, "z": 0.2}},
    }],
    "actuators": [
        {"id": "t1", "bodyId": "craft", "kind": "thrust",
         "axis": {"x": 0, "y": 1, "z": 0}, "maxForce": 9.81},
    ],
}


def test_physics_lives_on_the_mcp_bridge_not_the_agent_tools():
    """v2: the agent's schema set is the 9 workspace tools; physics scenes are
    exposed to external agents (WireGI) through the MCP bridge instead."""
    from app.agent import toolspecs
    names = {spec["name"] for spec in toolspecs.SPECS}
    assert "physics_simulate" not in names
    assert {"write_file", "read_file", "edit_file", "list_files", "remove_file",
            "check", "compile", "simulate", "done"} <= names


def test_physics_capabilities_is_static_reference():
    result = physics_capabilities()
    assert result["ok"] is True
    assert "bodies" in result["scene"]
    assert "actuators" in result["scene"]
    assert "sensorLinks" in result["scene"]
    assert "thrust" in result["scene"]["actuators"][0]["kind"]


def test_physics_simulate_requires_scene_object():
    result = asyncio.run(physics_simulate(scene="nope"))
    assert result["ok"] is False
    assert "physics_capabilities" in result["error"]


@pytest.mark.skipif(not RUNNER_AVAILABLE, reason="Node.js or the bundled physics core is unavailable")
def test_physics_simulate_free_fall():
    result = asyncio.run(physics_simulate(None, {
        "scene": {"version": 1, "environment": {"floorY": None},
                  "bodies": [{"id": "ball", "mass": 1,
                              "position": {"x": 0, "y": 10, "z": 0}}]},
        "duration_ms": 1000, "sample_every_ms": 500,
    }))
    assert result["ok"] is True
    assert result["simulated_ms"] == 1000
    # last sample ≈ 10 - ½·g·t²
    last_body = result["samples"][-1]["bodies"]["ball"]
    assert last_body["pos"][1] == pytest.approx(10 - 4.905, abs=0.15)


@pytest.mark.skipif(not RUNNER_AVAILABLE, reason="Node.js or the bundled physics core is unavailable")
def test_physics_simulate_hover_check_passes():
    result = asyncio.run(physics_simulate(None, {
        "scene": QUAD_SCENE,
        "duration_ms": 2000, "sample_every_ms": 500,
        "inputs": [{"at_ms": 0, "actuator": "t1", "value": 1}],
        "checks": [
            {"kind": "altitude", "body": "craft", "at_ms": 2000, "target": 2, "tolerance": 0.2},
            {"kind": "velocity", "body": "craft", "at_ms": 2000, "target": [0, 0, 0], "tolerance": 0.1},
        ],
    }))
    assert result["ok"] is True
    assert len(result["checks"]) == 2
    assert all(c["ok"] for c in result["checks"]), result["checks"]


@pytest.mark.skipif(not RUNNER_AVAILABLE, reason="Node.js or the bundled physics core is unavailable")
def test_physics_simulate_rejects_bad_scene_with_readable_error():
    result = asyncio.run(physics_simulate(None, {
        "scene": {"version": 1, "bodies": [{"id": "a", "mass": 1}],
                  "actuators": [{"id": "t", "bodyId": "ghost", "maxForce": 1}]},
    }))
    assert result["ok"] is False
    assert "ghost" in str(result.get("error", ""))
