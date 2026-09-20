"""
Velxio MCP Server

Exposes the following tools to MCP-compatible agents (e.g. Claude):

  - compile_project       Compile Arduino sketch files → hex / binary
  - run_project           Compile and return simulation-ready artifacts
  - import_wokwi_json     Parse a Wokwi diagram.json → Velxio circuit
  - export_wokwi_json     Serialise a Velxio circuit → Wokwi diagram.json
  - create_circuit        Create a new circuit definition
  - update_circuit        Merge changes into an existing circuit definition
  - generate_code_files   Generate starter Arduino code from a circuit
  - validate_circuit      Run the in-editor agent's full validation stack
                          (pin catalog, electrical rules, firmware/circuit
                          coherence) over a circuit — use it BEFORE compiling
  - simulate_firmware     Execute compiled AVR firmware headlessly and report
                          what it actually did (pin transitions, serial) —
                          use it AFTER compiling to verify behaviour

Transport:
  - stdio  — run `python mcp_server.py` for Claude Desktop / CLI agents
  - SSE    — mounted at /mcp in the FastAPI app for HTTP-based agents
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Annotated, Any

from mcp.server.fastmcp import FastMCP

from app.mcp.wokwi import (
    format_wokwi_diagram,
    generate_arduino_sketch,
    parse_wokwi_diagram,
)
from app.mcp.validate import validate_circuit as _validate_circuit
from app.services.arduino_cli import ArduinoCLIService

_AVR_SIM_SCRIPT = Path(__file__).with_name("avr_sim.cjs")

# ---------------------------------------------------------------------------
# Server setup
# ---------------------------------------------------------------------------

mcp = FastMCP(
    name="velxio",
    instructions=(
        "Velxio MCP server — create circuits, import/export Wokwi JSON, "
        "generate Arduino code, and compile projects."
    ),
)

_arduino = ArduinoCLIService()

# ---------------------------------------------------------------------------
# compile_project
# ---------------------------------------------------------------------------


@mcp.tool()
async def compile_project(
    files: Annotated[
        list[dict[str, str]],
        "List of source files. Each item must have 'name' (filename, e.g. 'sketch.ino') "
        "and 'content' (file text).",
    ],
    board: Annotated[
        str,
        "Arduino board FQBN, e.g. 'arduino:avr:uno' or 'rp2040:rp2040:rpipico'. "
        "Defaults to 'arduino:avr:uno'.",
    ] = "arduino:avr:uno",
) -> dict[str, Any]:
    """
    Compile one or more Arduino sketch files and return the compiled artifact.

    Returns a dict with:
      - success (bool)
      - hex_content (str | null)    Intel HEX for AVR boards
      - binary_content (str | null) Base-64 .bin/.uf2 for RP2040
      - binary_type (str | null)    'bin' or 'uf2'
      - uf2_content (str | null)   Base-64 .uf2 for RP2040/RP2350 (hardware flash)
      - stdout (str)
      - stderr (str)
      - error (str | null)
    """
    for f in files:
        if "name" not in f or "content" not in f:
            return {
                "success": False,
                "error": "Each file entry must have 'name' and 'content' keys.",
                "stdout": "",
                "stderr": "",
            }

    try:
        result = await _arduino.compile(files, board)
        return result
    except Exception as exc:  # pragma: no cover
        return {
            "success": False,
            "error": str(exc),
            "stdout": "",
            "stderr": "",
        }


# ---------------------------------------------------------------------------
# run_project
# ---------------------------------------------------------------------------


@mcp.tool()
async def run_project(
    files: Annotated[
        list[dict[str, str]],
        "List of source files (same format as compile_project).",
    ],
    board: Annotated[str, "Board FQBN (default: 'arduino:avr:uno')."] = "arduino:avr:uno",
) -> dict[str, Any]:
    """
    Compile the project and return simulation-ready artifacts.

    The Velxio frontend can load the returned hex_content / binary_content
    directly into its AVR / RP2040 emulator.  Actual execution happens
    client-side in the browser.

    Returns the same payload as compile_project plus a 'simulation_ready' flag.
    """
    result = await compile_project(files=files, board=board)
    result["simulation_ready"] = result.get("success", False)
    return result


# ---------------------------------------------------------------------------
# import_wokwi_json
# ---------------------------------------------------------------------------


@mcp.tool()
async def import_wokwi_json(
    diagram_json: Annotated[
        str,
        "Wokwi diagram.json content as a JSON string. "
        "Must contain at minimum a 'parts' array.",
    ],
) -> dict[str, Any]:
    """
    Parse a Wokwi diagram.json payload and return a Velxio circuit object.

    The returned circuit can be passed directly to export_wokwi_json,
    generate_code_files, compile_project, or saved as a Velxio project.

    Returns:
      - board_fqbn (str)         Detected Arduino board FQBN
      - components (list)        List of component objects
      - connections (list)       List of connection objects
      - version (int)
    """
    try:
        diagram = json.loads(diagram_json)
    except json.JSONDecodeError as exc:
        return {"error": f"Invalid JSON: {exc}"}

    if not isinstance(diagram, dict):
        return {"error": "diagram_json must be a JSON object."}

    return parse_wokwi_diagram(diagram)


# ---------------------------------------------------------------------------
# export_wokwi_json
# ---------------------------------------------------------------------------


@mcp.tool()
async def export_wokwi_json(
    circuit: Annotated[
        dict[str, Any],
        "Velxio circuit object with 'components', 'connections', and 'board_fqbn'.",
    ],
    author: Annotated[str, "Author name to embed in the diagram (default: 'velxio')."] = "velxio",
) -> dict[str, Any]:
    """
    Convert a Velxio circuit object into a Wokwi diagram.json payload.

    The returned payload is compatible with the Wokwi simulator and can be
    imported using the Wokwi zip import feature in Velxio.

    Returns the Wokwi diagram dict (version, author, editor, parts, connections).
    """
    if not isinstance(circuit, dict):
        return {"error": "circuit must be a JSON object."}

    return format_wokwi_diagram(circuit, author=author)


# ---------------------------------------------------------------------------
# create_circuit
# ---------------------------------------------------------------------------


@mcp.tool()
async def create_circuit(
    board_fqbn: Annotated[
        str,
        "Arduino board FQBN. e.g. 'arduino:avr:uno', 'rp2040:rp2040:rpipico'.",
    ] = "arduino:avr:uno",
    components: Annotated[
        list[dict[str, Any]] | None,
        "List of component objects. Each item may have: "
        "id (str), type (str, Wokwi element type), left (number), top (number), "
        "rotate (number), attrs (object).",
    ] = None,
    connections: Annotated[
        list[dict[str, Any]] | None,
        "List of connection objects. Each item may have: "
        "from_part (str), from_pin (str), to_part (str), to_pin (str), color (str).",
    ] = None,
) -> dict[str, Any]:
    """
    Create a new Velxio circuit definition.

    Example component types: wokwi-led, wokwi-pushbutton, wokwi-resistor,
    wokwi-buzzer, wokwi-servo, wokwi-lcd1602.

    Example connection:
      { "from_part": "uno", "from_pin": "13", "to_part": "led1", "to_pin": "A",
        "color": "green" }

    Returns the new circuit object (board_fqbn, components, connections, version).
    """
    components_list = components if components is not None else []
    connections_list = connections if connections is not None else []

    # Normalise components
    normalised_components: list[dict[str, Any]] = []
    for i, comp in enumerate(components_list):
        normalised_components.append(
            {
                "id": comp.get("id", f"comp{i}"),
                "type": comp.get("type", ""),
                "left": float(comp.get("left", 0)),
                "top": float(comp.get("top", 0)),
                "rotate": int(comp.get("rotate", 0)),
                "attrs": dict(comp.get("attrs", {})),
            }
        )

    # Normalise connections
    normalised_connections: list[dict[str, Any]] = []
    for conn in connections_list:
        normalised_connections.append(
            {
                "from_part": conn.get("from_part", ""),
                "from_pin": conn.get("from_pin", ""),
                "to_part": conn.get("to_part", ""),
                "to_pin": conn.get("to_pin", ""),
                "color": conn.get("color", "green"),
            }
        )

    return {
        "board_fqbn": board_fqbn,
        "components": normalised_components,
        "connections": normalised_connections,
        "version": 1,
    }


# ---------------------------------------------------------------------------
# update_circuit
# ---------------------------------------------------------------------------


@mcp.tool()
async def update_circuit(
    circuit: Annotated[
        dict[str, Any],
        "Existing Velxio circuit object to update.",
    ],
    add_components: Annotated[
        list[dict[str, Any]] | None,
        "Components to add. Merged after existing components.",
    ] = None,
    remove_component_ids: Annotated[
        list[str] | None,
        "IDs of components to remove.",
    ] = None,
    add_connections: Annotated[
        list[dict[str, Any]] | None,
        "Connections to add.",
    ] = None,
    remove_connections: Annotated[
        list[dict[str, Any]] | None,
        "Connections to remove (matched by from_part+from_pin+to_part+to_pin).",
    ] = None,
    board_fqbn: Annotated[
        str | None,
        "If provided, replaces the circuit board_fqbn.",
    ] = None,
) -> dict[str, Any]:
    """
    Merge changes into an existing Velxio circuit definition.

    Supports adding/removing components and connections, and changing the board.

    Returns the updated circuit object.
    """
    if not isinstance(circuit, dict):
        return {"error": "circuit must be a JSON object."}

    import copy

    updated = copy.deepcopy(circuit)

    if board_fqbn is not None:
        updated["board_fqbn"] = board_fqbn

    # Remove components
    if remove_component_ids:
        remove_set = set(remove_component_ids)
        updated["components"] = [
            c for c in updated.get("components", []) if c.get("id") not in remove_set
        ]

    # Add components
    existing_ids = {c.get("id") for c in updated.get("components", [])}
    for i, comp in enumerate(add_components or []):
        comp_id = comp.get("id", f"comp_new_{i}")
        if comp_id in existing_ids:
            comp_id = f"{comp_id}_new"
        updated.setdefault("components", []).append(
            {
                "id": comp_id,
                "type": comp.get("type", ""),
                "left": float(comp.get("left", 0)),
                "top": float(comp.get("top", 0)),
                "rotate": int(comp.get("rotate", 0)),
                "attrs": dict(comp.get("attrs", {})),
            }
        )

    # Remove connections (exact match)
    if remove_connections:
        def _conn_key(c: dict[str, Any]) -> tuple[str, str, str, str]:
            return (
                c.get("from_part", ""),
                c.get("from_pin", ""),
                c.get("to_part", ""),
                c.get("to_pin", ""),
            )

        remove_keys = {_conn_key(c) for c in remove_connections}
        updated["connections"] = [
            c for c in updated.get("connections", []) if _conn_key(c) not in remove_keys
        ]

    # Add connections
    for conn in (add_connections or []):
        updated.setdefault("connections", []).append(
            {
                "from_part": conn.get("from_part", ""),
                "from_pin": conn.get("from_pin", ""),
                "to_part": conn.get("to_part", ""),
                "to_pin": conn.get("to_pin", ""),
                "color": conn.get("color", "green"),
            }
        )

    return updated


# ---------------------------------------------------------------------------
# generate_code_files
# ---------------------------------------------------------------------------


@mcp.tool()
async def generate_code_files(
    circuit: Annotated[
        dict[str, Any],
        "Velxio circuit object (from create_circuit or import_wokwi_json).",
    ],
    sketch_name: Annotated[
        str,
        "Base name for the generated sketch file (without extension).",
    ] = "sketch",
    extra_instructions: Annotated[
        str,
        "Optional extra instructions or comments to embed in the sketch.",
    ] = "",
) -> dict[str, Any]:
    """
    Generate starter Arduino code files for the given circuit.

    Returns:
      - files: list of { "name": str, "content": str } — ready for compile_project
      - board_fqbn: str — detected board FQBN
    """
    if not isinstance(circuit, dict):
        return {"error": "circuit must be a JSON object."}

    sketch_content = generate_arduino_sketch(circuit, sketch_name=sketch_name)

    if extra_instructions:
        header = f"// {extra_instructions}\n"
        sketch_content = header + sketch_content

    board_fqbn: str = circuit.get("board_fqbn", "arduino:avr:uno")

    return {
        "files": [{"name": f"{sketch_name}.ino", "content": sketch_content}],
        "board_fqbn": board_fqbn,
    }


# ---------------------------------------------------------------------------
# validate_circuit
# ---------------------------------------------------------------------------


@mcp.tool()
async def validate_circuit(
    circuit: Annotated[
        dict[str, Any],
        "Velxio circuit object (as from create_circuit / import_wokwi_json). "
        "Only the Arduino Uno catalog (led, resistor, pushbutton, potentiometer, "
        "buzzer) is fully checkable.",
    ],
    files: Annotated[
        list[dict[str, str]] | None,
        "Optional sketch files ({'name','content'}) — when given, firmware/circuit "
        "coherence and include rules are checked too (strongly recommended).",
    ] = None,
) -> dict[str, Any]:
    """
    Validate a circuit with the exact rules the Velxio in-editor agent enforces.

    Checks: pin names against the catalog, GPIO shorted to a rail, bridged
    GPIOs, LED series resistor, firmware pins vs wiring, analogWrite/analogRead
    pin capabilities, shorted buttons/LEDs/resistors, include allowlist.

    ALWAYS call this before compile_project: a circuit that fails here compiles
    fine and still does nothing (or burns out). valid=false lists the reasons;
    fix them and validate again.
    """
    if not isinstance(circuit, dict):
        return {"error": "circuit must be a JSON object."}
    return _validate_circuit(circuit, files)


# ---------------------------------------------------------------------------
# simulate_firmware
# ---------------------------------------------------------------------------


@mcp.tool()
async def simulate_firmware(
    hex_content: Annotated[
        str,
        "Intel HEX string — exactly the hex_content returned by compile_project.",
    ],
    observe_ms: Annotated[
        int,
        "How long (simulated milliseconds, 100..10000) to run the firmware.",
    ] = 2000,
    watch_pins: Annotated[
        list[str] | None,
        "Arduino pin names to report, e.g. ['13', 'A0']. Defaults to every pin that changed.",
    ] = None,
    analog: Annotated[
        dict[str, float] | None,
        "Analog stimulus in volts, keyed by ADC channel: {'0': 2.5} drives A0 to 2.5V "
        "(as if a potentiometer wiper sat there).",
    ] = None,
) -> dict[str, Any]:
    """
    Execute compiled AVR firmware in a headless emulator and OBSERVE it.

    Reports, per pin: transition count, final level, first/last change time and
    the median period between changes; plus up to 4000 chars of serial output.
    This is how you VERIFY behaviour instead of assuming it:

      - "does the LED blink?" -> watch pin 13, expect many transitions and a
        median_period_ms near the sketch's delay
      - "does it react to input?" -> pass analog {'0': 2.5} for a pot on A0
      - "does it print?" -> check the returned serial text

    Returns { supported, success, simulated_ms, pins, serial }. supported=false
    means the server has no Node.js/avr8js runtime — say so and stop simulating.
    """
    if not isinstance(hex_content, str) or not hex_content.strip():
        return {"success": False, "supported": False,
                "error": "hex_content (Intel HEX string) is required."}
    try:
        observe = max(100, min(int(observe_ms), 10000))
    except (TypeError, ValueError):
        return {"success": False, "supported": False, "error": "observe_ms must be an integer."}
    payload = {
        "hex": hex_content,
        "observe_ms": observe,
        "watch_pins": [str(p)[:4] for p in (watch_pins or [])][:24],
        "analog": {str(k)[:3]: max(0.0, min(5.0, float(v)))
                   for k, v in (analog or {}).items() if isinstance(v, (int, float))},
    }
    if not _AVR_SIM_SCRIPT.exists():
        return {"success": False, "supported": False,
                "error": "The simulate_firmware helper is missing from this install."}
    try:
        process = await asyncio.create_subprocess_exec(
            "node", str(_AVR_SIM_SCRIPT),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            out, err = await asyncio.wait_for(
                process.communicate(json.dumps(payload).encode()), timeout=60)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            return {"success": False, "supported": True, "error": "Simulation timed out."}
    except FileNotFoundError:
        return {"success": False, "supported": False,
                "error": "Node.js is not installed on the server; headless simulation is unavailable."}
    if process.returncode != 0:
        stderr = err.decode(errors="replace").strip()[:300]
        supported = "avr8js-not-found" not in stderr
        hint = ("" if supported
                else " Install Node.js + avr8js (npm install avr8js; set VELXIO_AVR8JS_PATH).")
        return {"success": False, "supported": supported,
                "error": "Headless simulation failed." + (f" Detail: {stderr}" if stderr else "") + hint}
    try:
        result = json.loads(out.decode())
    except ValueError:
        return {"success": False, "supported": True, "error": "Simulator returned unparseable output."}
    return result
