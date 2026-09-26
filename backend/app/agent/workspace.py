"""The run-scoped workspace: the project IS a file set (v2 architecture).

Wokwi-compatible shape:
  sketch.ino   entry firmware (+ optional flat headers; main.py for Pi)
  diagram.json board, parts and connections

The model edits these files with plain file tools (write_file / edit_file),
checks and compiles them like a developer, and ends the run with `done`.
Nothing bespoke is parsed anywhere: the transport enforces tool-call shapes,
`diagram.json` is checked by a real parser, and a bad edit is an error the
model reads — not a failure class.
"""
from __future__ import annotations

import json
import re
from typing import Any, Callable

from app.agent import catalog
from app.agent.models import (
    Board,
    Connection,
    Endpoint,
    Expectations,
    Part,
    Project,
    Source,
)

FILE_SKETCH = "sketch.ino"
FILE_FIRMWARE_PY = "main.py"
FILE_DIAGRAM = "diagram.json"

# Caps enforced by the tools with clear errors — never silent truncation.
MAX_FILE_BYTES = 64_000
MAX_WORKSPACE_BYTES = 200_000
# simulate(): one virtual-time cap (clamped here) + one fixed wall-clock kill
# passed by the caller. Two mechanisms, nothing stacked.
MIN_OBSERVE_MS = 100
MAX_OBSERVE_MS = 10_000

_ENTRY_SUFFIXES = (".ino", ".py")
_NATIVE_SUFFIXES = (".cpp", ".c")
_SOURCE_SUFFIXES = (".ino", ".py", ".cpp", ".c", ".h")


class WorkspaceError(ValueError):
    """A tool rejected an edit; the message is the fix, shown to the model."""


class DoneSignal(Exception):
    """Raised by the `done` tool: the model is finished.

    kind "explain" — nothing was built (a question answered in agent mode).
    kind "submit"  — the workspace holds the design; the loop runs the final
    gates (build → phone-page → compile) before the result event.
    """

    def __init__(self, summary: str, plan: list[str] | None = None,
                 expectations: Expectations | None = None,
                 kind: str = "submit") -> None:
        super().__init__(summary)
        self.summary = summary
        self.plan = plan or []
        self.expectations = expectations
        self.kind = kind


# --------------------------------------------------------------------------
# Project ↔ workspace-file conversion (pure; shared by tools and the browser
# apply step through the same code path).
# --------------------------------------------------------------------------

def project_to_files(project: Project) -> dict[str, str]:
    files: dict[str, str] = {}
    diagram: dict[str, Any] = {"board": None, "boardKind": None,
                               "parts": [], "connections": []}
    if project.board is not None:
        diagram["board"] = project.board.id
        diagram["boardKind"] = project.board.boardKind
        diagram["boardX"] = project.board.x
        diagram["boardY"] = project.board.y
    for part in project.components:
        diagram["parts"].append({
            "id": part.id, "type": part.metadataId,
            "x": part.x, "y": part.y, "props": part.properties,
        })
    for wire in project.wires:
        diagram["connections"].append({
            "from": f"{wire.start.componentId}:{wire.start.pinName}",
            "to": f"{wire.end.componentId}:{wire.end.pinName}",
            "color": wire.color,
        })
    files[FILE_DIAGRAM] = json.dumps(diagram, indent=2)
    for source in project.files:
        files[source.name] = source.content
    return files


def parse_diagram(text: str) -> dict[str, Any]:
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise WorkspaceError(
            f"{FILE_DIAGRAM} is not valid JSON: {exc}. Fix the syntax at the "
            "reported position — check() reports the exact state otherwise.") from None
    if not isinstance(data, dict):
        raise WorkspaceError(f"{FILE_DIAGRAM} must be a JSON object.")
    return data


_COLOR_NAMES = {
    "red": "#ef4444", "green": "#22c55e", "blue": "#3b82f6",
    "yellow": "#eab308", "orange": "#f97316", "purple": "#a855f7",
    "pink": "#ec4899", "black": "#111827", "white": "#f9fafb",
    "gray": "#8a92a3", "grey": "#8a92a3", "brown": "#92400e",
    "cyan": "#06b6d4", "magenta": "#d946ef",
}


def _wire_color(value: Any) -> str:
    """A wire color as #rrggbb.

    The system prompt's own diagram example writes `"color":"red"`, so colour
    NAMES are expected input: map the common ones instead of rejecting the
    model's own example. Anything else passes through to the model validator.
    """
    text = str(value or "").strip()
    return _COLOR_NAMES.get(text.lower(), text or "#8a92a3")


def _validated(model: type, payload: dict, what: str):
    """One workspace model built from model-written JSON.

    A rejected part (an unsupported property, a colour that is not #rrggbb)
    is a design problem the model can fix in one edit, so it must arrive as
    tool data — never as a raw pydantic error escaping the tools and killing
    the run.
    """
    try:
        return model(**payload)
    except WorkspaceError:
        raise
    except Exception as exc:  # noqa: BLE001 - pydantic ValidationError and friends
        from app.agent.models import describe_error
        raise WorkspaceError(f"{what}: {describe_error(exc)}") from None


def diagram_to_parts(data: dict[str, Any]) -> tuple[Board | None, list[Part], list[Connection]]:
    board: Board | None = None
    board_id = data.get("board")
    kind = data.get("boardKind")
    if board_id or kind:
        kind = catalog.normalize_board_kind(str(kind or board_id)) or str(kind or board_id)
        if kind not in catalog.BOARDS:
            raise WorkspaceError(
                f"Unknown boardKind {kind!r} in {FILE_DIAGRAM}. Pick one from "
                f"the board list ({len(catalog.BOARDS)} boards) or ask catalog().")
        board = Board(id=str(board_id or kind), boardKind=kind,
                      x=float(data.get("boardX", 100) or 100),
                      y=float(data.get("boardY", 120) or 120))
    parts: list[Part] = []
    for raw in data.get("parts") or []:
        if not isinstance(raw, dict) or "id" not in raw or "type" not in raw:
            raise WorkspaceError(
                f"{FILE_DIAGRAM} part needs at least id and type: {json.dumps(raw)[:120]}")
        parts.append(_validated(Part, {
            "id": str(raw["id"]), "metadataId": str(raw["type"]),
            "x": float(raw.get("x", 240) or 240), "y": float(raw.get("y", 200) or 200),
            "properties": {k: v for k, v in (raw.get("props") or {}).items()},
        }, f"{FILE_DIAGRAM} part {str(raw['id'])!r} is invalid"))
    wires: list[Connection] = []
    for raw in data.get("connections") or []:
        if not isinstance(raw, dict) or "from" not in raw or "to" not in raw:
            raise WorkspaceError(
                f"{FILE_DIAGRAM} connection needs from and to: {json.dumps(raw)[:120]}")
        wires.append(_validated(Connection, {
            "id": str(raw.get("id") or f"w{len(wires) + 1}"),
            "start": _endpoint(str(raw["from"])),
            "end": _endpoint(str(raw["to"])),
            "color": _wire_color(raw.get("color")),
        }, f"{FILE_DIAGRAM} connection is invalid"))
    return board, parts, wires


def _endpoint(ref: str) -> Endpoint:
    if ":" not in ref:
        raise WorkspaceError(
            f"Connection endpoint {ref!r} must be 'componentId:pinName' "
            f"(the board is referenced by its id, e.g. 'arduino-uno:13').")
    component_id, _, pin = ref.partition(":")
    return Endpoint(componentId=component_id, pinName=pin)


def build_project(files: dict[str, str]) -> Project:
    """A validated Project from the workspace, or WorkspaceError with the fix.

    Project.model_validate resolves pins (with property variants), enforces
    unique ids and the size caps — the same deterministic validation every
    design has always gone through. This is check()'s engine.
    """
    diagram_text = files.get(FILE_DIAGRAM)
    if not diagram_text or not diagram_text.strip():
        raise WorkspaceError(
            f"{FILE_DIAGRAM} is empty. Create it with write_file: "
            '{"board":"<boardKind>","parts":[...],"connections":[...]}.')
    data = parse_diagram(diagram_text)
    board, parts, wires = diagram_to_parts(data)
    sources = [Source(name=name, content=content)
               for name, content in sorted(files.items())
               if name != FILE_DIAGRAM and name.endswith(_SOURCE_SUFFIXES)]
    try:
        project = Project(board=board, components=parts, wires=wires, files=sources)
    except Exception as exc:  # pydantic ValidationError and friends
        from app.agent.models import describe_error
        raise WorkspaceError(describe_error(exc) if hasattr(exc, "errors") else str(exc)) from None
    _check_entry_files(project)
    return project


def _check_entry_files(project: Project) -> None:
    """One entry source per project (the same rule apply_patch has always
    enforced), phrased as a fix rather than a rejection."""
    sketches = [f for f in project.files if f.name.endswith(_ENTRY_SUFFIXES)]
    native = [f for f in project.files if f.name.endswith(_NATIVE_SUFFIXES)]
    entries = sketches or native
    if len(entries) > 1:
        raise WorkspaceError(
            "A build needs exactly ONE entry file (.ino/.py, or .cpp/.c when "
            f"there is no sketch); found {', '.join(f.name for f in entries)}. "
            "Keep the helpers as .h headers and merge the entry.")
    for source in project.files:
        errors = []
        from app.agent.models import validate_includes
        board_id = project.board.boardKind if project.board else catalog.DEFAULT_BOARD
        try:
            validate_includes(source.content, {f.name for f in project.files},
                              board_id=board_id)
        except ValueError as exc:
            errors.append(f"{source.name}: {exc}")
        if errors:
            raise WorkspaceError(" ".join(errors))


def analyse_project(files: dict[str, str]) -> tuple[Project, list[str]]:
    """The full deterministic linter: build + static analysis + electrical.

    Returns (project, problem lines). Never raises for design problems —
    every finding is a line the model can act on.
    """
    from app.agent.analysis import analyse
    from app.agent.models import validate_electrical

    project = build_project(files)
    findings = analyse(project)
    problems = [f"{f.severity}: {f.message}" for f in findings]
    try:
        validate_electrical(project)
    except ValueError as exc:
        problems.append(f"error: {exc}")
    return project, problems


# --------------------------------------------------------------------------
# The intent check: compiles ≠ what the user meant. Deterministic, one job:
# catch a MENTIONED part being MISSING. Wrong-part substitution is not
# decidable from prose — that is the pending checkpoint's job (the user).
# --------------------------------------------------------------------------

def mentioned_parts(prompt: str) -> list[str]:
    text = f" {prompt.lower()} "
    found: list[str] = []
    for spec in catalog.PLACEABLE.values():
        keys = {spec.id}
        if spec.name:
            keys.add(spec.name.lower())
        for key in keys:
            if len(key) < 4 or not re.fullmatch(r"[a-z0-9][a-z0-9 -]+", key):
                continue
            token = key.strip().replace(" ", r"\s+")
            if re.search(rf"(?<![a-z0-9]){token}(?:e?s)?(?![a-z0-9])", text):
                if spec.id not in found:
                    found.append(spec.id)
                break
    return found


# --------------------------------------------------------------------------
# The Workspace: run-scoped file set + the file tools. Every tool returns the
# envelope {ok, data | error} — structured, actionable, never pretty prose.
# --------------------------------------------------------------------------

Envelope = dict


class Workspace:
    def __init__(self, project: Project, prompt: str,
                 board_hint: str | None = None) -> None:
        self.files: dict[str, str] = project_to_files(project)
        self.prompt = prompt
        self.board_hint = board_hint or prompt
        self.touched = False
        self.finished = False
        # Dependencies injected by the service (keeps this module import-free
        # of the provider layer).
        self.compile_fn: Callable[[Project], Any] | None = None
        self.simulate_fn: Callable[..., Any] | None = None

    # -- the 9 tools -------------------------------------------------------

    def list_files(self) -> Envelope:
        listing = []
        for name in sorted(self.files):
            body = self.files[name]
            listing.append({"name": name, "bytes": len(body.encode("utf-8"))})
        return {"ok": True, "data": {"files": listing}}

    def read_file(self, name: str) -> Envelope:
        if name not in self.files:
            return self._unknown_file(name)
        return {"ok": True, "data": {"name": name, "content": self.files[name]}}

    def write_file(self, name: str, content: str) -> Envelope:
        problem = self._name_ok(name)
        if problem:
            return {"ok": False, "error": problem}
        body = str(content or "")
        if len(body.encode("utf-8")) > MAX_FILE_BYTES:
            return {"ok": False, "error": (
                f"{name} is {len(body.encode('utf-8')):,} bytes; the cap is "
                f"{MAX_FILE_BYTES:,}. Split the source into headers.")}
        merged = dict(self.files)
        merged[name] = body
        if self._total_bytes(merged) > MAX_WORKSPACE_BYTES:
            return {"ok": False, "error": (
                f"The workspace would exceed {MAX_WORKSPACE_BYTES:,} bytes. "
                "Trim the design before writing more.")}
        self.files = merged
        self.touched = True
        return {"ok": True,
                "data": {"name": name, "bytes": len(body.encode("utf-8"))}}

    def edit_file(self, name: str, old_string: str, new_string: str) -> Envelope:
        if name not in self.files:
            return self._unknown_file(name)
        body = self.files[name]
        old = str(old_string or "")
        if not old:
            return {"ok": False, "error": "edit_file needs a non-empty old_string anchor."}
        count = body.count(old)
        if count == 0:
            # Show a slice of what IS there so the model re-anchors instead of
            # guessing (the whole-file rewrite this tool exists to avoid).
            hint = body[:300] + ("…" if len(body) > 300 else "")
            return {"ok": False, "error": (
                f"old_string was not found in {name}. Re-read the file and use "
                f"an exact span. File starts with:\n{hint}")}
        if count > 1:
            return {"ok": False, "error": (
                f"old_string matches {count} places in {name}; include more "
                "surrounding text so the edit is unambiguous.")}
        new_body = body.replace(old, str(new_string or ""), 1)
        if len(new_body.encode("utf-8")) > MAX_FILE_BYTES:
            return {"ok": False, "error": (
                f"The edit would push {name} past the {MAX_FILE_BYTES:,}-byte cap.")}
        self.files[name] = new_body
        self.touched = True
        return {"ok": True, "data": {"name": name, "edited": True}}

    def catalog(self, query: str = "") -> Envelope:
        q = str(query or "").strip().lower()
        if not q or q in {"board", "pinout", "pins"}:
            return self._board_pinout()
        hits: list[dict] = []
        for spec in catalog.PLACEABLE.values():
            haystack = " ".join([spec.id, spec.name or "",
                                 *(spec.tags or [])]).lower()
            if q in haystack:
                hits.append(self._part_summary(spec.id))
            if len(hits) >= 12:
                break
        if not hits:
            return {"ok": True, "data": {
                "parts": [], "note": (
                    f"Nothing matches {q!r}. The full board list is in the "
                    "system prompt; try a shorter query like 'oled', 'sensor', 'motor'.")}}
        return {"ok": True, "data": {"parts": hits}}

    def check(self) -> Envelope:
        try:
            project, problems = analyse_project(self.files)
        except WorkspaceError as exc:
            return {"ok": True, "data": {"clean": False, "problems": [str(exc)]}}
        return {"ok": True, "data": {
            "clean": not problems,
            "problems": problems[:24],
            "board": project.board.boardKind if project.board else None,
            "parts": [p.id for p in project.components],
            "wires": len(project.wires),
        }}

    async def compile(self, fast: bool = False) -> Envelope:
        if self.compile_fn is None:
            return {"ok": False, "error": "compile is unavailable on this server."}
        try:
            project = build_project(self.files)
        except WorkspaceError as exc:
            return {"ok": False, "error": str(exc)}
        # Pre-commit hook: the linter runs before every compile.
        from app.agent.analysis import analyse
        findings = analyse(project)
        errors = [f.message for f in findings if f.severity == "error"]
        if errors:
            return {"ok": False, "error": (
                "check() found blocking problems — fix these before compiling: "
                + " | ".join(errors[:8]))}
        result = await self.compile_fn(project, fast)
        if result.get("success"):
            return {"ok": True, "data": {
                "board": project.board.boardKind if project.board else None,
                "stdout": str(result.get("stdout", ""))[-2000:],
                "runtime": result.get("kind") or "hex",
                "note": "Compiled. Run simulate() on AVR boards to watch it behave."}}
        detail = str(result.get("stderr") or result.get("error") or "no output")[-4000:]
        return {"ok": False, "error": f"Compilation failed:\n{detail}"}

    async def simulate(self, observe_ms: int = 3000,
                       interactions: list[dict] | None = None) -> Envelope:
        if self.simulate_fn is None:
            return {"ok": False, "error": "simulate is unavailable on this server."}
        try:
            project = build_project(self.files)
        except WorkspaceError as exc:
            return {"ok": False, "error": str(exc)}
        kind = project.board.boardKind if project.board else catalog.DEFAULT_BOARD
        if catalog.board_family(kind) != "avr":
            return {"ok": False, "error": (
                f"simulate() runs AVR boards only (this is {kind}); "
                "compile() is the check for every other family.")}
        result = await self.simulate_fn(
            project,
            observe_ms=max(MIN_OBSERVE_MS, min(int(observe_ms or 3000), MAX_OBSERVE_MS)),
            interactions=[i for i in (interactions or []) if isinstance(i, dict)][:8],
        )
        return result

    def done(self, summary: str, plan: list[str] | None = None,
             expectations: dict | None = None) -> Envelope:
        text = str(summary or "").strip()
        if not text:
            return {"ok": False, "error": "done() needs a one-paragraph summary for the user."}
        if not self.touched:
            # Nothing was built: this run is an explanation. No gates apply.
            raise DoneSignal(text, plan=[str(p) for p in (plan or [])][:8], kind="explain")
        # The intent check — the fact and nothing else; the remedy is to add
        # the part, not to write prose. Missing parts only; wrong-part
        # substitution is decided by the user at the pending checkpoint.
        try:
            project = build_project(self.files)
        except WorkspaceError as exc:
            return {"ok": False, "error": (
                f"The workspace does not build yet — fix this before done(): {exc}")}
        present = {p.metadataId for p in project.components}
        missing = [part_id for part_id in mentioned_parts(self.prompt)
                   if part_id not in present]
        if missing:
            return {"ok": False, "error": (
                f"prompt names {', '.join(missing)}; no such part in the circuit. "
                "Add it (catalog() for its id) and wire it, then done() again.")}
        parsed_expectations = None
        if expectations:
            try:
                parsed_expectations = Expectations.model_validate(expectations)
            except Exception as exc:
                from app.agent.models import describe_error
                return {"ok": False, "error": (
                    "expectations did not validate: "
                    + (describe_error(exc) if hasattr(exc, "errors") else str(exc)))}
        self.finished = True
        raise DoneSignal(text, plan=[str(p) for p in (plan or [])][:8],
                         expectations=parsed_expectations, kind="submit")

    # -- helpers ------------------------------------------------------------

    def _unknown_file(self, name: str) -> Envelope:
        return {"ok": False, "error": (
            f"No file named {name!r}. Files: {', '.join(sorted(self.files)) or 'none'}.")}

    @staticmethod
    def _name_ok(name: str) -> str | None:
        if not name or "/" in name or "\\" in name or ".." in name:
            return ("File names are flat (no directories). Good: sketch.ino, "
                    "servo.h, diagram.json.")
        if not name.endswith(_SOURCE_SUFFIXES) and name != FILE_DIAGRAM:
            return ("Only source files (.ino .py .cpp .c .h) and diagram.json "
                    f"live in the workspace; {name!r} is not one.")
        return None

    @staticmethod
    def _total_bytes(files: dict[str, str]) -> int:
        return sum(len(body.encode("utf-8")) for body in files.values())

    def _board_pinout(self) -> Envelope:
        kind = None
        try:
            data = parse_diagram(self.files.get(FILE_DIAGRAM, ""))
            kind = catalog.normalize_board_kind(str(data.get("boardKind") or data.get("board") or ""))
        except WorkspaceError:
            pass
        if not kind or kind not in catalog.BOARDS:
            return {"ok": True, "data": {"note": (
                "No board yet. Set FILE_DIAGRAM's boardKind to one of: "
                + ", ".join(list(catalog.BOARDS)[:12]) + " … (catalog() for the rest).")}}
        spec = catalog.BOARDS[kind]
        return {"ok": True, "data": {
            "board": kind,
            "pins": [str(p) for p in spec.get("pins", [])],
            "pwm": [str(p) for p in spec.get("pwm", [])],
            "analog": [str(p) for p in spec.get("analog", [])],
            "i2c": spec.get("i2c", {}),
            "power": catalog.power_rails(kind),
            "family": catalog.board_family(kind),
        }}

    @staticmethod
    def _part_summary(part_id: str) -> dict:
        spec = catalog.PARTS[part_id]
        return {"id": spec.id, "name": spec.name,
                "pins": [str(p) for p in spec.pins[:16]],
                "sim": bool(spec.sim),
                "libraries": list(getattr(spec, "libraries", []) or []),
                "notes": (spec.notes or spec.description or "")[:200]}
