"""Board and board-core include contracts for the agent catalog."""
from __future__ import annotations

import pytest

from app.agent import catalog
from app.agent.compile_worker import get_fqbn
from app.agent.models import Board, validate_includes


EXPECTED_BOARDS = {
    "arduino-uno",
    "arduino-nano",
    "arduino-mega",
    "attiny85",
    "raspberry-pi-pico",
    "pi-pico-w",
    "raspberry-pi-zero",
    "raspberry-pi-1",
    "raspberry-pi-2",
    "raspberry-pi-3",
    "raspberry-pi-4",
    "raspberry-pi-5",
    "esp32",
    "esp32-devkit-c-v4",
    "esp32-cam",
    "wemos-lolin32-lite",
    "esp32-s3",
    "xiao-esp32-s3",
    "arduino-nano-esp32",
    "esp32-c3",
    "xiao-esp32-c3",
    "aitewinrobot-esp32c3-supermini",
    "stm32-bluepill",
    "stm32-blackpill",
    "stm32-bluepill-f103cb",
    "stm32-blackpill-f401",
    "stm32-f4-discovery",
    "stm32-olimex-h405",
    "stm32-netduino-plus2",
    "stm32-netduino2",
}


def test_catalog_contains_exactly_the_30_supported_boards():
    assert len(catalog.BOARDS) == 30
    assert set(catalog.BOARDS) == EXPECTED_BOARDS
    assert all(catalog.BOARDS[k].get("family") for k in EXPECTED_BOARDS)


def test_compile_target_is_catalog_bound_for_every_board():
    for kind, spec in catalog.BOARDS.items():
        fqbn = get_fqbn(kind)
        if spec["family"] == "python":
            assert fqbn == "python:python:pi"
        else:
            assert fqbn == spec["fqbn"]

    with pytest.raises(ValueError, match="Unsupported board kind"):
        get_fqbn("not-a-velxio-board")


def test_board_aliases_canonicalize_without_opening_an_unknown_board_escape_hatch():
    assert Board(id="uno").boardKind == "arduino-uno"
    assert Board(id="esp32dev").boardKind == "esp32"
    assert Board(id="pico-w").boardKind == "pi-pico-w"
    with pytest.raises(ValueError, match="Unsupported board kind"):
        Board(id="board-from-a-model-hallucination", boardKind="made-up")


def test_board_core_headers_are_compatible_not_global():
    assert "WiFi.h" in catalog.allowed_headers("esp32")
    assert "WiFi.h" in catalog.allowed_headers("pi-pico-w")
    assert "WiFi.h" not in catalog.allowed_headers("arduino-uno")
    assert "WiFi.h" not in catalog.allowed_headers("raspberry-pi-pico")
    assert "avr/io.h" in catalog.allowed_headers("arduino-uno")
    assert "avr/io.h" not in catalog.allowed_headers("esp32")

    validate_includes("#include <WiFi.h>\n", {"sketch.ino"}, board_id="esp32")
    with pytest.raises(ValueError, match="WiFi.h"):
        validate_includes("#include <WiFi.h>\n", {"sketch.ino"}, board_id="arduino-uno")
