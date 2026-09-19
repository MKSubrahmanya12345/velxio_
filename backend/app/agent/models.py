"""Strict agent protocol and deterministic, non-destructive patch application."""
from typing import Annotated, Literal
import re
import json
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

Id = Annotated[str, StringConstraints(pattern=r"^[a-zA-Z][a-zA-Z0-9_-]{0,63}$")]
Coordinate = Annotated[float, Field(ge=-5000, le=5000, allow_inf_nan=False)]

# Pin names from @wokwi/elements 1.9.2 pinInfo. Deliberately a small capability set.
PINS: dict[str, list[str]] = json.loads(Path(__file__).with_name("catalog.json").read_text())

PROPERTIES = {
    "led": {"color", "label", "flip", "rotation"},
    "resistor": {"value", "rotation"},
    "pushbutton": {"color", "label", "rotation"},
    "potentiometer": {"value", "rotation"},
    "buzzer": {"rotation"},
}


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Board(StrictModel):
    id: Id
    x: Coordinate = 100
    y: Coordinate = 120


class Part(StrictModel):
    id: Id
    metadataId: Literal["led", "resistor", "pushbutton", "potentiometer", "buzzer"]
    x: Coordinate
    y: Coordinate
    properties: dict[str, str | float | bool] = Field(default_factory=dict, max_length=8)

    @model_validator(mode="after")
    def valid_properties(self):
        if set(self.properties) - PROPERTIES[self.metadataId]:
            raise ValueError(f"Unsupported properties for {self.metadataId}")
        for key, value in self.properties.items():
            if key in ("color", "label") and (not isinstance(value, str) or len(value) > 80):
                raise ValueError(f"Invalid {key}")
            if key == "flip" and not isinstance(value, bool):
                raise ValueError("flip must be boolean")
            if key in ("value", "rotation"):
                try:
                    n = float(value)
                except (ValueError, TypeError):
                    raise ValueError(f"{key} must be numeric (resistance in ohms)")
                low, high = (100, 1e7) if self.metadataId == "resistor" else (0, 1023)
                if key == "rotation":
                    low, high = 0, 270
                if not low <= n <= high or isinstance(value, bool):
                    raise ValueError(f"{key} outside supported range {low}..{high}")
        return self


class Endpoint(StrictModel):
    componentId: Id
    pinName: str = Field(min_length=1, max_length=16)


class Connection(StrictModel):
    id: Id
    start: Endpoint
    end: Endpoint
    color: str = Field(default="#4ade80", pattern=r"^#[0-9a-fA-F]{6}$")


class Source(StrictModel):
    name: str = Field(pattern=r"^[A-Za-z0-9_-]+\.(ino|h|cpp|c)$", max_length=80)
    content: str = Field(max_length=40000)


class Project(StrictModel):
    board: Board | None = None
    components: list[Part] = Field(default_factory=list, max_length=40)
    wires: list[Connection] = Field(default_factory=list, max_length=100)
    files: list[Source] = Field(default_factory=list, max_length=12)

    @model_validator(mode="after")
    def valid_graph(self):
        ids = [p.id for p in self.components] + ([self.board.id] if self.board else [])
        if len(set(ids)) != len(ids):
            raise ValueError("Duplicate component/board ID")
        for items, key in [(self.wires, "id"), (self.files, "name")]:
            values = [getattr(item, key) for item in items]
            if len(set(values)) != len(values):
                raise ValueError(f"Duplicate {key}")
        kinds = {p.id: p.metadataId for p in self.components}
        if self.board:
            kinds[self.board.id] = "arduino-uno"
        for wire in self.wires:
            for end in (wire.start, wire.end):
                if end.componentId not in kinds or end.pinName not in PINS[kinds[end.componentId]]:
                    raise ValueError(f"Invalid endpoint {end.componentId}:{end.pinName}")
            if wire.start == wire.end:
                raise ValueError("A wire must connect two different pins")
        if sum(len(f.content) for f in self.files) > 80000:
            raise ValueError("Project source too large")
        return self


class Patch(StrictModel):
    # Full replacement ONLY for explicitly named items. Everything else survives.
    board: Board | None = None
    upsert_components: list[Part] = Field(default_factory=list, max_length=40)
    remove_components: list[Id] = Field(default_factory=list, max_length=40)
    upsert_wires: list[Connection] = Field(default_factory=list, max_length=100)
    remove_wires: list[Id] = Field(default_factory=list, max_length=100)
    upsert_files: list[Source] = Field(default_factory=list, max_length=12)
    remove_files: list[str] = Field(default_factory=list, max_length=12)


class Proposal(StrictModel):
    summary: str = Field(min_length=1, max_length=5000)
    plan: list[str] = Field(default_factory=list, max_length=8)
    patch: Patch | None = None


class Message(StrictModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=6000)


class AgentRequest(StrictModel):
    prompt: str = Field(min_length=1, max_length=6000)
    project: Project
    messages: list[Message] = Field(default_factory=list, max_length=12)


def merge_items(old, new, removed, key):
    keys = [getattr(item, key) for item in new]
    if len(set(keys)) != len(keys) or set(keys) & set(removed):
        raise ValueError(f"Duplicate or conflicting patch {key}")
    if set(removed) - {getattr(item, key) for item in old}:
        raise ValueError(f"Cannot remove unknown {key}")
    result = {getattr(item, key): item for item in old if getattr(item, key) not in removed}
    result.update({getattr(item, key): item for item in new})
    return list(result.values())


def apply_patch(project: Project, patch: Patch) -> Project:
    if patch.board and project.board and patch.board.id != project.board.id:
        raise ValueError("Existing board ID must be preserved")
    candidate = Project(
        board=patch.board or project.board,
        components=merge_items(project.components, patch.upsert_components, patch.remove_components, "id"),
        wires=merge_items(project.wires, patch.upsert_wires, patch.remove_wires, "id"),
        files=merge_items(project.files, patch.upsert_files, patch.remove_files, "name"),
    )
    if not candidate.board or sum(f.name.endswith(".ino") for f in candidate.files) != 1:
        raise ValueError("A build needs one Arduino Uno and exactly one .ino file")
    # Restrict user includes to the core and explicit workspace headers. This
    # is a capability check, NOT a substitute for an OS compiler sandbox.
    filenames = {f.name for f in candidate.files}
    for source in candidate.files:
        validate_includes(source.content, filenames)
    validate_electrical(candidate)
    return candidate


def validate_includes(content: str, filenames: set[str]):
    # C preprocessing splices lines before replacing comments. Keep literals
    # intact, so a URL or comment-looking text inside a string isn't stripped.
    logical = re.sub(r"\\\r?\n", "", content)
    token = re.compile(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|//[^\n]*|/\*[\s\S]*?\*/')
    clean = token.sub(lambda m: " " if m.group().startswith(("//", "/*")) else m.group(), logical)
    # Normalize the alternative preprocessor introducers too.
    clean = clean.replace("%:", "#").replace("??=", "#")
    for directive, rest in re.findall(r"(?m)^\s*#\s*(include_next|include|import|embed)\b([^\n]*)", clean):
        match = re.fullmatch(r'\s*(?:<([^>]+)>|"([^"\n]+)")\s*', rest)
        if directive != "include" or not match:
            raise ValueError("Only literal Arduino core or local file includes are supported")
        system, local = match.groups()
        header = system or local
        if header not in {"Arduino.h", "math.h", "stdint.h", "string.h"} and not (local and local in filenames):
            raise ValueError(f"Unsupported include: {header}; use Arduino core APIs")


def validate_electrical(project: Project):
    """Conservative topology checks, not a claim of electrical/behavioural proof."""
    parent: dict[str, str] = {}

    def find(pin):
        parent.setdefault(pin, pin)
        if parent[pin] != pin:
            parent[pin] = find(parent[pin])
        return parent[pin]

    def union(a, b):
        parent[find(a)] = find(b)

    def ep(e):
        return f"{e.componentId}:{e.pinName}"

    for wire in project.wires:
        union(ep(wire.start), ep(wire.end))
    for part in project.components:
        if part.metadataId == "pushbutton":
            union(f"{part.id}:1.l", f"{part.id}:1.r")
            union(f"{part.id}:2.l", f"{part.id}:2.r")
    if project.board:
        b = project.board.id
        for ground in ("GND.1", "GND.2", "GND.3"):
            union(f"{b}:GND", f"{b}:{ground}")
        rails = [find(f"{b}:{pin}") for pin in ("5V", "3.3V", "GND")]
        if len(set(rails)) != 3:
            raise ValueError("Power rails are shorted together")
    # Every external LED needs a series resistor on one terminal. A resistor
    # merely elsewhere on the same parallel net does NOT satisfy this rule.
    resistor_pins = {f"{p.id}:{pin}" for p in project.components if p.metadataId == "resistor" for pin in ("1", "2")}
    for part in project.components:
        if part.metadataId == "led":
            terminals = [f"{part.id}:A", f"{part.id}:C"]
            all_pins = set(parent) | resistor_pins | set(terminals)
            if not any(
                len(net := {p for p in all_pins if find(p) == find(t)}) == 2
                and bool((net - {t}) & resistor_pins)
                for t in terminals
            ):
                raise ValueError(f"LED {part.id} needs a series resistor (at least 100 ohms)")
