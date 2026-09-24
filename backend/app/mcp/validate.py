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

from app.agent import catalog
from app.agent.analysis import analyse
from app.agent.models import (
    Board,
    Connection,
    Endpoint,
    Part,
    Project,
    Source,
    describe_error,
    validate_electrical,
    validate_includes,
)

# MCP circuits spell parts the Wokwi way (`wokwi-led`) while the agent catalog
# uses its own ids; `catalog.resolve_id` is the single translation table, so
# every part the editor can place is checkable here — not just the original five.
def _kind_of(component: dict[str, Any]) -> str:
    raw = str(component.get("metadataId") or component.get("type") or component.get("id") or "")
    return catalog.resolve_id(raw) or ""
# Board shapes seen in the wild: wokwi part type, FQBN, plain agent id.
_BOARD_MAP = {
    "wokwi-arduino-uno": "arduino-uno",
    "arduino:avr:uno": "arduino-uno",
    "uno": "arduino-uno",
    "arduino-uno": "arduino-uno",
    "arduino-uno-3v3": "arduino-uno",
    "wokwi-arduino-nano": "arduino-nano",
    "arduino-nano": "arduino-nano",
}


def _canonical_board_kind(raw: str) -> str | None:
    value = str(raw or "").strip().lower()
    if not value:
        return None
    mapped = _BOARD_MAP.get(value)
    if mapped:
        return mapped
    normalized = catalog.normalize_board_kind(value)
    if normalized:
        return normalized
    for kind, spec in catalog.BOARDS.items():
        if str(spec.get("fqbn") or "").lower() == value:
            return kind
    if value.startswith("wokwi-"):
        return catalog.normalize_board_kind(value.removeprefix("wokwi-"))
    return None



def _board_id_of(circuit: dict[str, Any], components: list[dict[str, Any]]) -> str | None:
    raw = str(
        circuit.get("boardKind") or circuit.get("board") or circuit.get("board_fqbn") or ""
    ).strip()
    mapped = _canonical_board_kind(raw)
    if mapped:
        return mapped
    # Any board component is fine as long as it is one of the generated board
    # catalog entries, not just the historical Uno subset.
    for component in components:
        board_raw = str(component.get("type") or component.get("metadataId") or "").strip()
        mapped = _canonical_board_kind(board_raw)
        if mapped:
            return mapped
        board_kind = catalog.resolve_id(board_raw.lower())
        if board_kind and catalog.get(board_kind) and catalog.get(board_kind).cls == "board":
            # Legacy metadata ids can still describe a board; only use it when
            # the corresponding project board exists in the 30-board table.
            candidate = catalog.normalize_board_kind(board_kind)
            if candidate:
                return candidate
    return None


def to_agent_project(circuit: dict[str, Any], files: list[dict[str, str]] | None = None) -> tuple[Project | None, list[str], list[str]]:
    """Map an MCP circuit dict to an agent Project.

    Returns (project | None, notes, hard_errors). notes explain parts left out
    of the catalog subset; hard_errors are structural problems (unknown pin
    names, malformed endpoints) that make the circuit invalid outright. Board
    resolution is against all 30 generated Velxio boards, not just Uno.
    """
    notes: list[str] = []
    hard_errors: list[str] = []
    raw_components = circuit.get("components") or []
    if not isinstance(raw_components, list):
        return None, ["components must be a list."], []
    raw_connections = circuit.get("connections") or []
    if not isinstance(raw_connections, list):
        return None, ["connections must be a list."], []

    raw_board = str(
        circuit.get("boardKind") or circuit.get("board") or circuit.get("board_fqbn") or ""
    ).strip()
    if raw_board and _canonical_board_kind(raw_board) is None:
        return None, [], [f"Unsupported board kind {raw_board!r}. Velxio supports "
                          f"{len(catalog.BOARDS)} board kinds: " + ", ".join(catalog.BOARDS)]
    board_kind = _board_id_of(circuit, raw_components)
    if board_kind is None:
        return None, [f"No supported board found. Velxio supports {len(catalog.BOARDS)} board kinds: "
                      + ", ".join(catalog.BOARDS)], []
    # Preserve the imported board component id used by wire endpoints (Wokwi
    # calls them `uno`, `nano`, etc.) while keeping boardKind canonical.
    board = "uno" if board_kind == "arduino-uno" else board_kind
    for component in raw_components:
        raw_type = str(component.get("type") or component.get("metadataId") or "")
        component_kind = _canonical_board_kind(raw_type)
        if component_kind == board_kind and component.get("id"):
            board = str(component["id"])
            break

    parts: list[Part] = []
    for i, component in enumerate(raw_components):
        # The board part became project.board above — not a catalog candidate.
        raw_type = str(component.get("type") or component.get("metadataId") or "")
        if _canonical_board_kind(raw_type):
            continue
        component_board_id = catalog.resolve_id(raw_type)
        if component_board_id and (spec := catalog.get(component_board_id)) and spec.cls == "board":
            continue  # a board part: the project has one board, this is it
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
        project = Project(
            board=Board(id=board, boardKind=board_kind),
            components=parts,
            wires=wires,
            files=sources,
        )
    except ValidationError as exc:
        # describe_error keeps the actionable line ("r1 has pins: 1, 2"); a raw
        # ValidationError repr embeds the whole circuit and buries it.
        hard_errors.append(f"Invalid circuit: {describe_error(exc)}"
                           + " Board pin names: " + ", ".join(catalog.board_pins(board_kind)))
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
                "message": "Circuit is not in the agent-checkable Velxio board/component catalog subset."}

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
            validate_includes(
                str(source.get("content", "")), filenames, board_id=project.board.boardKind)
        except ValueError as exc:
            errors.append(f"includes: {exc}")

    board_kind = project.board.boardKind
    return {"valid": not errors, "errors": errors, "warnings": warnings, "notes": notes,
            "board": board_kind,
            "pins": catalog.board_pins(board_kind),
            "capabilities": catalog.board_capabilities(board_kind)}
