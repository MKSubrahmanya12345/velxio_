"""MCP validate_circuit: external agents get the SAME guarantees as the
in-editor agent (create_circuit/update_circuit used to be unchecked dicts)."""
from __future__ import annotations

import pytest

from app.mcp.server import validate_circuit

UNO = {"id": "uno", "type": "wokwi-arduino-uno"}
BLINK_CIRCUIT = {
    "board_fqbn": "arduino:avr:uno",
    "components": [UNO,
                   {"id": "led1", "type": "wokwi-led", "attrs": {"color": "red"}},
                   {"id": "r1", "type": "wokwi-resistor", "attrs": {"value": "330"}}],
    "connections": [
        {"from_part": "uno", "from_pin": "13", "to_part": "r1", "to_pin": "1"},
        {"from_part": "r1", "from_pin": "2", "to_part": "led1", "to_pin": "A"},
        {"from_part": "led1", "from_pin": "C", "to_part": "uno", "to_pin": "GND.1"},
    ],
}
BLINK_FILES = [{"name": "sketch.ino", "content": (
    "void setup(){pinMode(13,OUTPUT);}\n"
    "void loop(){digitalWrite(13,HIGH);delay(500);digitalWrite(13,LOW);delay(500);}")}]


@pytest.mark.asyncio
async def test_good_blink_circuit_with_firmware_is_valid():
    report = await validate_circuit(BLINK_CIRCUIT, files=BLINK_FILES)
    assert report["valid"] is True, report["errors"]
    assert report["errors"] == []
    assert report["pins"] and "13" in report["pins"]


@pytest.mark.asyncio
async def test_led_without_series_resistor_is_rejected():
    circuit = dict(BLINK_CIRCUIT)
    circuit["connections"] = [
        {"from_part": "uno", "from_pin": "13", "to_part": "led1", "to_pin": "A"},
        {"from_part": "led1", "from_pin": "C", "to_part": "uno", "to_pin": "GND.1"},
    ]
    report = await validate_circuit(circuit, files=BLINK_FILES)
    assert report["valid"] is False
    assert any("series resistor" in e for e in report["errors"])


@pytest.mark.asyncio
async def test_gpio_shorted_to_ground_is_rejected():
    circuit = dict(BLINK_CIRCUIT)
    circuit["connections"] = BLINK_CIRCUIT["connections"] + [
        {"from_part": "uno", "from_pin": "12", "to_part": "uno", "to_pin": "GND.1"}]
    report = await validate_circuit(circuit, files=BLINK_FILES)
    assert report["valid"] is False
    assert any("gpio-shorted" in e for e in report["errors"])


@pytest.mark.asyncio
async def test_firmware_driving_an_unwired_pin_is_rejected():
    files = [{"name": "sketch.ino",
              "content": "void setup(){pinMode(7,OUTPUT);}void loop(){digitalWrite(7,HIGH);}"}]
    report = await validate_circuit(BLINK_CIRCUIT, files=files)
    assert report["valid"] is False
    assert any("pin-unwired" in e for e in report["errors"])


@pytest.mark.asyncio
async def test_unknown_pin_names_are_rejected():
    circuit = dict(BLINK_CIRCUIT)
    circuit["connections"] = [
        {"from_part": "uno", "from_pin": "99", "to_part": "r1", "to_pin": "1"},
        {"from_part": "r1", "from_pin": "2", "to_part": "led1", "to_pin": "A"},
        {"from_part": "led1", "from_pin": "C", "to_part": "uno", "to_pin": "GND.1"},
    ]
    report = await validate_circuit(circuit, files=BLINK_FILES)
    assert report["valid"] is False


@pytest.mark.asyncio
async def test_non_uno_boards_report_as_not_checkable():
    report = await validate_circuit({"board_fqbn": "rp2040:rp2040:rpipico",
                                     "components": [], "connections": []})
    assert report["valid"] is None
    assert "not in the agent-checkable" in report["message"]


@pytest.mark.asyncio
async def test_non_catalog_parts_are_reported_as_notes_not_errors():
    circuit = dict(BLINK_CIRCUIT)
    circuit["components"] = BLINK_CIRCUIT["components"] + [{"id": "lcd1", "type": "wokwi-lcd1602"}]
    report = await validate_circuit(circuit, files=BLINK_FILES)
    assert report["valid"] is True
    assert any("lcd1602" in note for note in report["notes"])

# ── simulate_firmware: headless behavioural observation ─────────────────────
import os
import sys

from app.mcp.server import simulate_firmware, _AVR_SIM_SCRIPT

TOGGLE_HEX = ":0E0000000FEF04B910E205B9012705B9FDCFD5\\n:00000001FF"


def _avr8js_available() -> bool:
    candidates = [
        os.environ.get("VELXIO_AVR8JS_PATH"),
        _AVR_SIM_SCRIPT.resolve().parents[3] / "frontend" / "node_modules" / "avr8js",
    ]
    return any(c and os.path.exists(c) for c in candidates if c)


@pytest.mark.skipif(not _avr8js_available(), reason="node_modules/avr8js not installed")
@pytest.mark.asyncio
async def test_simulate_firmware_observes_pin_13_toggling():
    report = await simulate_firmware(TOGGLE_HEX, observe_ms=200)
    assert report["supported"] is True and report["success"] is True
    pin13 = report["pins"]["13"]
    assert pin13["transitions"] > 1000
    assert pin13["first_change_ms"] is not None
    assert report["simulated_ms"] == 200


@pytest.mark.skipif(not _avr8js_available(), reason="node_modules/avr8js not installed")
@pytest.mark.asyncio
async def test_simulate_firmware_reports_untouched_firmware_honestly():
    # No port writes at all: the honest result is NO transitions, not success theatre.
    report = await simulate_firmware(":00000001FF", observe_ms=100)
    assert report["success"] is True
    assert report["pins"].get("13") is None or report["pins"]["13"]["transitions"] <= 1


@pytest.mark.asyncio
async def test_simulate_firmware_rejects_empty_hex():
    report = await simulate_firmware("   ")
    assert report["success"] is False and report["error"]


@pytest.mark.asyncio
async def test_simulate_firmware_degrades_gracefully_without_node(monkeypatch):
    import app.mcp.server as server

    async def missing(*_a, **_k):
        raise FileNotFoundError("node")

    monkeypatch.setattr(server.asyncio, "create_subprocess_exec", missing)
    report = await simulate_firmware(TOGGLE_HEX)
    assert report["supported"] is False
    assert "Node.js" in report["error"]

