"""One capability surface: MCP circuits checked by the SAME rules as the agent.

create_circuit/update_circuit used to be pure dict normalizers — they accepted
any pin on any part, so what the in-editor agent rejects (an LED without a
series resistor, a GPIO shorted to GND, firmware driving an unwired pin) sailed
through MCP. Everything an agent can build now funnels through app.agent:
the models, the pin catalog and the static analysis.
"""
from __future__ import annotations

from typing import Any

from pydantic import ValidationError

from app.agent.analysis import analyse
from app.agent.models import (
    BOARD_CAPABILITIES,
    PINS,
    Board,
    Connection,
    Endpoint,
    Part,
    Project,
    Source,
    validate_electrical,
    validate_includes,
)

# wokwi/velxio type → agent catalog kind. Anything not listed here is outside
# the agent's catalog and is reported as such instead of being waved through.
_KIND_MAP = {
    "led": "led",
    "resistor": "resistor",
    "pushbutton": "pushbutton",
    "potentiometer": "potentiometer",
    "buzzer": "buzzer",
}
# Board shapes seen in the wild: wokwi part type, FQBN, plain agent id.
_BOARD_MAP = {
    "wokwi-arduino-uno": "uno",
    "arduino:avr:uno": "uno",
    "uno": "uno",
    "arduino-uno": "uno",
}


def _kind_of(component: dict[str, Any]) -> str:
    raw = str(component.get("metadataId") or component.get("type") or "").strip()
    return _KIND_MAP.get(raw.removeprefix("wokwi-").removeprefix("wokwi_"), "")


def _board_id_of(circuit: dict[str, Any], components: list[dict[str, Any]]) -> str | None:
    raw = str(circuit.get("board") or circuit.get("board_fqbn") or "").strip()
    mapped = _BOARD_MAP.get(raw)
    if mapped:
        return mapped
    for component in components:
        board_raw = str(component.get("type") or component.get("metadataId") or "")
        if board_raw in _BOARD_MAP:
            return _BOARD_MAP[board_raw]
    return None


def to_agent_project(circuit: dict[str, Any], files: list[dict[str, str]] | None = None) -> tuple[Project | None, list[str], list[str]]:
    """Map an MCP circuit dict to an agent Project.

    Returns (project | None, notes, hard_errors). notes explain parts left out
    of the catalog subset; hard_errors are structural problems (unknown pin
    names, malformed endpoints) that make the circuit invalid outright.
    """
    notes: list[str] = []
    hard_errors: list[str] = []
    raw_components = circuit.get("components") or []
    if not isinstance(raw_components, list):
        return None, ["components must be a list."], []
    raw_connections = circuit.get("connections") or []
    if not isinstance(raw_connections, list):
        return None, ["connections must be a list."], []

    board = _board_id_of(circuit, raw_components)
    if board is None:
        return None, ["No Arduino Uno found (board_fqbn/board or a wokwi-arduino-uno part). "
                      "The agent guarantees only cover the Uno catalog."], []

    parts: list[Part] = []
    for i, component in enumerate(raw_components):
        # The board part became project.board above — not a catalog candidate.
        raw_type = str(component.get("type") or component.get("metadataId") or "")
        if raw_type in _BOARD_MAP:
            continue
        kind = _kind_of(component)
        if not kind:
            notes.append(f"Part {component.get('id', i)} ({raw_type}) is outside the agent catalog; "
                         "it is not covered by these checks.")
            continue
        part_id = str(component.get("id") or f"part{i}")
        attrs = component.get("attrs") or component.get("properties") or {}
        properties = {k: v for k, v in dict(attrs).items() if isinstance(v, (str, int, float, bool))}
        parts.append(Part(id=part_id, metadataId=kind,
                          x=float(component.get("left", component.get("x", 0)) or 0),
                          y=float(component.get("top", component.get("y", 0)) or 0),
                          properties=properties))

    wires: list[Connection] = []
    for i, conn in enumerate(raw_connections):
        start = conn.get("from_part", conn.get("start", {}).get("componentId") if isinstance(conn.get("start"), dict) else "")
        end = conn.get("to_part", conn.get("end", {}).get("componentId") if isinstance(conn.get("end"), dict) else "")
        start_pin = conn.get("from_pin", conn.get("start", {}).get("pinName") if isinstance(conn.get("start"), dict) else "")
        end_pin = conn.get("to_pin", conn.get("end", {}).get("pinName") if isinstance(conn.get("end"), dict) else "")
        try:
            wires.append(Connection(
                id=str(conn.get("id") or f"w{i}"),
                start=Endpoint(componentId=str(start), pinName=str(start_pin)),
                end=Endpoint(componentId=str(end), pinName=str(end_pin)),
            ))
        except Exception as exc:  # bad ids/pin names — surface, never crash
            notes.append(f"Connection {i} is malformed ({exc}).")

    sources: list[Source] = []
    for source in files or []:
        try:
            sources.append(Source(name=str(source.get("name", "sketch.ino")),
                                  content=str(source.get("content", ""))))
        except Exception as exc:
            notes.append(f"File {source.get('name')!r} rejected: {exc}")

    try:
        project = Project(board=Board(id=board), components=parts, wires=wires, files=sources)
    except ValidationError as exc:
        hard_errors.append(
            f"Invalid circuit (unknown pin name or endpoint?): {exc}".replace("\n", " ")
            + " Valid pin names: " + ", ".join(PINS.get("arduino-uno", [])))
        return None, notes, hard_errors
    return project, notes, hard_errors


def validate_circuit(circuit: dict[str, Any], files: list[dict[str, str]] | None = None) -> dict[str, Any]:
    """Run the full agent validation stack over an MCP circuit.

    Same order as apply_patch: static coherence/short analysis, then the
    electrical checks, then include allowlisting when files are given.
    """
    project, notes, hard_errors = to_agent_project(circuit, files)
    if hard_errors:
        return {"valid": False, "errors": hard_errors, "warnings": [], "notes": notes,
                "message": "Circuit is structurally invalid."}
    if project is None:
        return {"valid": None, "errors": [], "warnings": [], "notes": notes,
                "message": "Circuit is not in the agent-checkable (Uno catalog) subset."}

    errors: list[str] = []
    warnings: list[str] = []
    for finding in analyse(project):
        (errors if finding.severity == "error" else warnings).append(f"{finding.code}: {finding.message}")
    try:
        validate_electrical(project)
    except ValueError as exc:
        errors.append(f"electrical: {exc}")

    filenames = {str(f.get("name", "")) for f in files or []}
    for source in files or []:
        try:
            validate_includes(str(source.get("content", "")), filenames)
        except ValueError as exc:
            errors.append(f"includes: {exc}")

    return {"valid": not errors, "errors": errors, "warnings": warnings, "notes": notes,
            "pins": PINS.get("arduino-uno", []),
            "capabilities": BOARD_CAPABILITIES.get("arduino-uno", {})}
