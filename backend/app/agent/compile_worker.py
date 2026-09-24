"""Compile in a disposable process so cancellation also terminates compiler children.
Velxio = Cursor: supports ALL 30 boards with proper FQBN mapping.
"""
import asyncio
import json
import shutil
import sys

from app.agent import catalog
from app.agent.models import Project
from app.services.arduino_cli import ArduinoCLIService

# Map Velxio boardKind -> arduino-cli FQBN
BOARD_FQBN_MAP = {
    # Arduino AVR
    "arduino-uno": "arduino:avr:uno",
    "arduino-nano": "arduino:avr:nano",
    "arduino-mega": "arduino:avr:mega",
    "attiny85": "attiny:avr:ATtinyX5:chip=85,clock=8internal",
    # ESP32 family
    "esp32": "esp32:esp32:esp32",
    "esp32-devkit-c-v4": "esp32:esp32:esp32",
    "esp32-cam": "esp32:esp32:esp32cam",
    "wemos-lolin32-lite": "esp32:esp32:lolin32_lite",
    "esp32-s3": "esp32:esp32:esp32s3",
    "xiao-esp32-s3": "esp32:esp32:XIAO_ESP32S3",
    "arduino-nano-esp32": "arduino:esp32:nano_nora",
    "esp32-c3": "esp32:esp32:esp32c3",
    "xiao-esp32-c3": "esp32:esp32:XIAO_ESP32C3",
    "aitewinrobot-esp32c3-supermini": "esp32:esp32:esp32c3",
    # RP2040
    "raspberry-pi-pico": "rp2040:rp2040:rpipico",
    "pi-pico-w": "rp2040:rp2040:rpipicow",
    # STM32
    "stm32-bluepill": "STMicroelectronics:stm32:GenF1:pnum=BLUEPILL_F103C8",
    "stm32-bluepill-f103cb": "STMicroelectronics:stm32:GenF1:pnum=BLUEPILL_F103CB",
    "stm32-blackpill": "STMicroelectronics:stm32:GenF4:pnum=BLACKPILL_F401CC",
    "stm32-blackpill-f401": "STMicroelectronics:stm32:GenF4:pnum=BLACKPILL_F401CC",
    "stm32-f4-discovery": "STMicroelectronics:stm32:GenF4:pnum=DISCO_F407VG",
    "stm32-olimex-h405": "STMicroelectronics:stm32:GenF4:pnum=OLIMEX_H405",
    "stm32-netduino-plus2": "STMicroelectronics:stm32:GenF4:pnum=NETDUINO_PLUS_2",
    "stm32-netduino2": "STMicroelectronics:stm32:GenF4:pnum=NETDUINO_2",
    # Pi boards use python - not compiled via arduino-cli, return success with empty hex
    "raspberry-pi-zero": "python:python:pi",
    "raspberry-pi-1": "python:python:pi",
    "raspberry-pi-2": "python:python:pi",
    "raspberry-pi-3": "python:python:pi",
    "raspberry-pi-4": "python:python:pi",
    "raspberry-pi-5": "python:python:pi",
}

# Keep the worker bound to the same generated catalog used by validation and
# the browser. The literal table above remains a readable fallback for a
# rolling deploy that starts with an older catalog, but every supported board
# overrides it here (including exact ATTiny/STM32/Wemos FQBN spelling).
for _kind, _spec in catalog.BOARDS.items():
    BOARD_FQBN_MAP[_kind] = _spec.get("fqbn") or "python:python:pi"


def get_fqbn(board_kind: str) -> str:
    """Return the catalog FQBN; never silently compile an unknown board as Uno."""
    canonical = catalog.normalize_board_kind(board_kind)
    if not canonical or canonical not in catalog.BOARDS:
        raise ValueError(
            f"Unsupported board kind {board_kind!r}; choose one of the "
            f"{len(catalog.BOARDS)} generated Velxio boards.")
    fqbn = BOARD_FQBN_MAP.get(canonical)
    if not fqbn:
        raise ValueError(f"Board {canonical!r} has no configured build target.")
    return fqbn

async def main():
    try:
        raw = sys.stdin.read(1000000)
        project = Project.model_validate_json(raw)
        compiler = ArduinoCLIService()
        
        # Determine board kind
        board_kind = "arduino-uno"
        if project.board:
            board_kind = getattr(project.board, 'boardKind', 'arduino-uno') or 'arduino-uno'
        
        fqbn = get_fqbn(board_kind)
        
        # Python boards (Pi) don't need arduino-cli compilation
        if fqbn.startswith("python:"):
            # For Pi boards, firmware is Python script - return success with dummy hex
            # The simulator runs Python directly, not via hex
            has_py = any(f.name.endswith('.py') for f in project.files)
            if has_py:
                result = {"success": True, "hex_content": ":00000001FF\n", "stdout": f"Python board {board_kind}: no compilation needed", "stderr": ""}
            else:
                result = {"success": False, "error": f"Pi board {board_kind} needs a .py file, got: {[f.name for f in project.files]}"}
        elif not shutil.which(compiler.cli_path):
            result = {"success": False, "error_kind": "toolchain_unavailable",
                      "error": "arduino-cli is not installed or not on the backend PATH."}
        else:
            result = await compiler.compile(
                [file.model_dump() for file in project.files], fqbn
            )
    except Exception as e:
        result = {"success": False, "error": f"Compiler failed: {type(e).__name__}: {e}"}
    print("\n__VELXIO_AGENT_RESULT__" + json.dumps(result), flush=True)

if __name__ == "__main__":
    asyncio.run(main())
