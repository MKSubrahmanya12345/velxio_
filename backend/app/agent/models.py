"""Strict agent protocol and deterministic, non-destructive patch application."""
from typing import Annotated, Literal
import re
import json
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, StringConstraints, model_validator

from app.agent import catalog

Id = Annotated[str, StringConstraints(pattern=r"^[a-zA-Z][a-zA-Z0-9_-]{0,63}$")]
Coordinate = Annotated[float, Field(ge=-5000, le=5000, allow_inf_nan=False)]

# The catalog (generated, see app/agent/catalog.py) is the single description of
# every part: pins (with property-driven variants), editable properties, wiring
# rules and whether the canvas can simulate it. These mirrors exist because tool
# code and tests read them by name.
PINS: dict[str, list[str]] = catalog.PINS
PROPERTIES: dict[str, set[str]] = catalog.PROPERTIES
BOARD_CAPABILITIES: dict[str, dict] = {bid: catalog.board_capabilities(bid) for bid in catalog.BOARDS.keys()}

# Largest designs the agent will build: enough for a class project, small enough
# that the live simulation stays interactive in a browser tab.
MAX_PARTS = 40
MAX_WIRES = 100
MAX_FILES = 12


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Board(StrictModel):
    id: Id
    boardKind: str = Field(default="arduino-uno", min_length=1, max_length=64)
    x: Coordinate = 100
    y: Coordinate = 120

    @model_validator(mode="after")
    def valid_board_kind(self):
        # A model often uses the board kind as the instance id (`id: "esp32"`)
        # and omits boardKind. Infer that only when the field was genuinely
        # omitted; an explicit boardKind remains authoritative.
        omitted_kind = "boardKind" not in self.model_fields_set
        normalized = catalog.normalize_board_kind(self.boardKind)
        if normalized:
            self.boardKind = normalized
        if omitted_kind:
            from_id = catalog.normalize_board_kind(self.id)
            if from_id:
                self.boardKind = from_id
        if self.boardKind not in catalog.BOARDS:
            supported = ", ".join(catalog.BOARDS)
            raise ValueError(
                f"Unsupported board kind {self.boardKind!r}. Choose one of the {len(catalog.BOARDS)} "
                f"Velxio boards: {supported}")
        return self


class Part(StrictModel):
    id: Id
    # Any placeable catalog part (157 of them). Boards and breadboards are in the
    # catalog too - they are searchable and documented, but the project's board is
    # a field, and row-based wiring is not modelled by the static analysis.
    metadataId: str = Field(min_length=1, max_length=60)
    x: Coordinate
    y: Coordinate
    properties: dict[str, str | float | bool] = Field(default_factory=dict, max_length=12)

    @model_validator(mode="after")
    def valid_part(self):
        spec = catalog.get(self.metadataId)
        if spec is None:
            near = ", ".join(s.id for s in catalog.PARTS.values()
                             if self.metadataId.split("-")[0] in s.id)[:200]
            raise ValueError(f"Unknown component {self.metadataId!r}. Closest catalog ids: {near}")
        if not spec.placeable:
            raise ValueError(f"{spec.name} cannot be placed: {spec.why or 'not supported by the agent'}")
        unsupported = sorted(set(self.properties) - set(spec.properties))
        if unsupported:
            raise ValueError(
                f"Unsupported properties for {self.metadataId}: {', '.join(unsupported)}. "
                f"Editable: {', '.join(sorted(spec.properties)) or 'none'}")
        for key, value in self.properties.items():
            if isinstance(value, str) and len(value) > 80:
                raise ValueError(f"{key} is too long (max 80 characters)")
            if isinstance(value, bool):
                continue
            if key == "rotation":
                n = _number(key, value)
                if not 0 <= n <= 270:
                    raise ValueError("rotation outside supported range 0..270")
            elif self.metadataId.startswith("resistor") and key == "value":
                n = _number(key, value)
                if not 100 <= n <= 1e7:
                    raise ValueError("value outside supported range 100..1e7 (ohms)")
            elif key in ("value", "angle", "digits", "stepSize", "refreshMs"):
                _number(key, value)
        return self

    @property
    def pins(self) -> list[str]:
        """Pin names for THIS instance (variant-aware: digits=4, pins=i2c …)."""
        return catalog.pins_for(self.metadataId, self.properties)

    @property
    def spec(self) -> "catalog.PartSpec":
        return catalog.PARTS[self.metadataId]


class Endpoint(StrictModel):
    componentId: Id
    pinName: str = Field(min_length=1, max_length=16)


class Connection(StrictModel):
    id: Id
    start: Endpoint
    end: Endpoint
    color: str = Field(default="#4ade80", pattern=r"^#[0-9a-fA-F]{6}$")


class Source(StrictModel):
    name: str = Field(pattern=r"^[A-Za-z0-9_-]+\.(ino|h|cpp|c|py)$", max_length=80)
    content: str = Field(max_length=40000)


class Project(StrictModel):
    # Set by apply_patch: the deterministic analysis findings for THIS candidate.
    # Private so it never reaches the wire format or the prompt schema.
    _findings: list = PrivateAttr(default_factory=list)

    @property
    def findings(self) -> list:
        """Deterministic analysis findings for this candidate (see analysis.py)."""
        return self._findings

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
        pins_by_id = {p.id: p.pins for p in self.components}
        if self.board:
            # Cursor-like: support all 30 boards, but never reinterpret a bad
            # kind as Uno just to make the graph appear valid.
            bkind = self.board.boardKind
            if bkind not in catalog.BOARDS:
                raise ValueError(f"Unsupported board kind {bkind!r}")
            pins_by_id[self.board.id] = catalog.board_pins(bkind)
        by_id = {p.id: p for p in self.components}
        for wire in self.wires:
            for end in (wire.start, wire.end):
                known = pins_by_id.get(end.componentId)
                resolved = None if known is None else catalog.resolve_pin(known, end.pinName)
                if resolved is None:
                    raise ValueError(endpoint_error(end, known, by_id.get(end.componentId)))
                if resolved != end.pinName:
                    end.pinName = resolved
            if wire.start == wire.end:
                raise ValueError("A wire must connect two different pins")
        if sum(len(f.content) for f in self.files) > 80000:
            raise ValueError("Project source too large")
        return self


def endpoint_error(end: "Endpoint", known: list[str] | None, part: "Part | None") -> str:
    """Why an endpoint was rejected, with the pins the model should have used."""
    if known is None:
        return (f"Invalid endpoint {end.componentId}:{end.pinName} — no component or board with "
                f"id {end.componentId!r} in this project. Use an existing id, or upsert that "
                "component in the same patch.")
    label = f"{part.spec.name} ({part.metadataId})" if part is not None else "the board"
    message = (f"Invalid endpoint {end.componentId}:{end.pinName} — {label} has pins: "
               + ", ".join(str(pin) for pin in known) + ".")
    if part is not None:
        # A pin that exists only in a property variant (DIG1 needs digits>1, the
        # I2C lcd's SDA needs pins="i2c") is a one-line fix, not a guessing game.
        variants = [variant for variant in part.spec.pin_variants
                    if catalog.resolve_pin(variant.get("pins") or (), end.pinName)]
        if variants:
            settings = " or ".join(
                "{" + ", ".join(f"{key}={value}" for key, value in variant["when"].items()) + "}"
                for variant in variants[:2])
            message += (f" {end.pinName} only exists with properties {settings} — this instance "
                        f"has {part.properties or 'no properties'}.")
    return message


def describe_error(exc: BaseException, limit: int = 8) -> str:
    """One actionable line per failure, instead of pydantic's input dump.

    `str(ValidationError)` embeds the offending input — for a rejected patch
    that is the whole project, firmware included — so the line that matters
    ("it has pins 1, 2") is buried and the repair prompt has nothing to act on.
    """
    errors = getattr(exc, "errors", None)
    if not callable(errors):
        return str(exc)
    lines = [f"- {'.'.join(str(part) for part in item.get('loc') or ()) or 'patch'}: "
             f"{str(item.get('msg') or 'invalid').replace('Value error, ', '')}"
             for item in errors()[:limit]]
    return "\n".join(lines) or str(exc)


class Patch(StrictModel):
    # Full replacement ONLY for explicitly named items. Everything else survives.
    board: Board | None = None
    upsert_components: list[Part] = Field(default_factory=list, max_length=40)
    remove_components: list[Id] = Field(default_factory=list, max_length=40)
    upsert_wires: list[Connection] = Field(default_factory=list, max_length=100)
    remove_wires: list[Id] = Field(default_factory=list, max_length=100)
    upsert_files: list[Source] = Field(default_factory=list, max_length=12)
    remove_files: list[str] = Field(default_factory=list, max_length=12)


class Interaction(StrictModel):
    """An input the verifier drives on the live simulation before sampling.

    One shape, five kinds — every kind is checked against the part's declared
    capabilities (`interactions` in the catalog) and against the circuit, so a
    request to press a resistor, or to set a stimulus key a sensor does not
    have, is rejected before anything runs:

      press     momentary switch (pushbutton, ky-040's SW): HIGH->LOW->HIGH
      pot       potentiometer/joystick axis: drive the wiper to `value` (0..1023)
      switch    SPST/SPDT slide, DIP or tilt: hold it `closed` (or open) at `at_ms`
      rotary    quadrature/step input: turn `delta` detents (>0 clockwise)
      stimulus  drive a sensor's own model (DHT22 temperature, HC-SR04 distance,
                LDR lux, IR remote command …) via the canvas sensor controls
    """

    kind: Literal["press", "pot", "switch", "stimulus", "rotary"]
    componentId: Id
    # Which pin of the part the input acts on, when the part has several
    # (a joystick's VERT/HORZ, a keypad row). Defaults to the part's primary pin.
    pin: str | None = Field(default=None, max_length=16)
    at_ms: int = Field(default=500, ge=0, le=60000)
    hold_ms: int = Field(default=500, ge=10, le=20000)
    value: int = Field(default=512, ge=0, le=1023)
    closed: bool = True
    delta: int = Field(default=1, ge=-40, le=40)
    values: dict[str, float] = Field(default_factory=dict, max_length=8)

    @model_validator(mode="after")
    def kind_specific(self):
        if self.kind == "stimulus":
            if not self.values:
                raise ValueError("A stimulus interaction needs at least one value")
        elif self.values:
            raise ValueError("values only apply to a stimulus interaction")
        if self.kind == "rotary" and self.delta == 0:
            raise ValueError("A rotary interaction needs a non-zero delta")
        return self


class PinExpectation(StrictModel):
    """A falsifiable claim about one board pin, checked against a real run."""

    pin: str = Field(min_length=1, max_length=8)
    expect: Literal["toggles", "high", "low"]
    min_transitions: int = Field(default=2, ge=1, le=10000)
    period_ms: tuple[int, int] | None = Field(default=None)

    @model_validator(mode="after")
    def sane_period(self):
        if self.period_ms is not None:
            low, high = self.period_ms
            if not 1 <= low <= high <= 120000:
                raise ValueError("period_ms must be an increasing range within 1..120000")
        if self.expect != "toggles" and self.min_transitions != 2:
            raise ValueError("min_transitions only applies to expect='toggles'")
        return self


class SerialExpectation(StrictModel):
    """A regex the firmware's serial output must match during the observation."""

    matches: str = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def compiles(self):
        try:
            re.compile(self.matches)
        except re.error as exc:
            raise ValueError(f"Invalid serial regex: {exc}") from None
        return self


class Expectations(StrictModel):
    """What 'it works' means for this proposal, in machine-checkable form.

    The browser runs these against the live AVR simulation and feeds every
    failure back as a repair diagnostic, so a proposal that compiles but does
    not behave gets another attempt instead of a green tick.
    """

    observe_ms: int = Field(default=3000, ge=500, le=20000)
    pins: list[PinExpectation] = Field(default_factory=list, max_length=12)
    serial: list[SerialExpectation] = Field(default_factory=list, max_length=6)
    interactions: list[Interaction] = Field(default_factory=list, max_length=8)


TOOL_NAMES = (
    "read_file",
    "list_files",
    "board_pinout",
    "component_info",
    "search_catalog",
    "netlist",
    "check_design",
    "draft_validate",
    "draft_compile",
    "draft_simulate",
    "search_libraries",
    "library_api",
    "physics_capabilities",
    "physics_simulate",
)
ToolName = Literal[TOOL_NAMES]

# Tools that take a candidate patch instead of plain scalars. They never mutate
# the workspace: they build the candidate, run the deterministic stack (and, for
# `draft_simulate`, the real emulator) and hand the observations back, so the
# model can debug its own proposal before the user ever sees it.
# `physics_simulate` follows the same pattern with an inline scene document
# instead of a project patch.
DRAFT_TOOLS = ("draft_validate", "draft_compile", "draft_simulate", "physics_simulate")


class ToolCall(StrictModel):
    """A tool the model wants run before it commits to a patch.

    Tool use rides on the same JSON response as the patch rather than the
    provider's native tool-calling API, so any OpenAI-compatible
    chat-completions endpoint (the only shape this adapter supports) works.
    """

    tool: ToolName
    # Scalars for the read-only tools; a nested `patch` object (same shape as
    # Proposal.patch) for the draft_* tools. Bounded so a runaway model cannot
    # stuff a megabyte into a tool call.
    args: dict = Field(default_factory=dict, max_length=12)

    @model_validator(mode="after")
    def bounded_args(self):
        import json as _json

        if len(_json.dumps(self.args, default=str)) > 24000:
            raise ValueError("Tool call arguments are too large")
        return self


class Proposal(StrictModel):
    summary: str = Field(min_length=1, max_length=5000)
    plan: list[str] = Field(default_factory=list, max_length=8)
    patch: Patch | None = None
    # Attached by the provider adapter (never sent by the model): token usage
    # of the call that produced this proposal, for run records.
    _usage: dict | None = PrivateAttr(default=None)

    @property
    def usage(self) -> dict | None:
        return self._usage
    # Falsifiable success criteria for the patch; checked by the live simulator.
    expectations: Expectations | None = None
    # When non-empty the run executes these tools and asks again; no patch is
    # applied on a tool round. Bounded by AGENT_MAX_TOOL_ROUNDS.
    tool_calls: list[ToolCall] = Field(default_factory=list, max_length=4)


class Message(StrictModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=6000)


class AgentRequest(StrictModel):
    prompt: str = Field(min_length=1, max_length=6000)
    project: Project
    messages: list[Message] = Field(default_factory=list, max_length=12)
    # Which server-side provider routes this run. Only ids listed in
    # Settings.providers() are accepted; the id never carries credentials.
    provider: Literal["opencode", "gemini", "bedrock"] = "bedrock"
    # Fast progressive build mode: stream canvas updates & bypass long toolchain compilation delays
    fast_mode: bool = True
    # Optional forge-memory session key (stable per browser workspace). Absent
    # or null disables nothing — "default" is used when forge is enabled.
    forge_session: Annotated[str, StringConstraints(pattern=r"^[a-zA-Z0-9_-]{1,80}$")] | None = None

    # Set by run_agent when the forge bridge returned a memory block; consumed
    # by _base_messages. Private attrs survive StrictModel(extra="forbid").
    _forge_context: str = PrivateAttr(default="")


def _number(key: str, value) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{key} must be numeric")
    try:
        return float(value)
    except (ValueError, TypeError):
        raise ValueError(f"{key} must be numeric") from None


def merge_items(old, new, removed, key):
    # Resolve deterministically instead of rejecting: an upsert is a full
    # replacement, so it wins over a removal of the same key, and a duplicate
    # upsert resolves to the last occurrence. Models often express "replace
    # this part" as remove+upsert or repeat an upsert while repairing; a hard
    # conflict error would silently burn every repair attempt.
    upserted = {}
    for item in new:
        upserted[getattr(item, key)] = item
    if set(removed) - {getattr(item, key) for item in old}:
        raise ValueError(f"Cannot remove unknown {key}")
    removed = [k for k in removed if k not in upserted]
    result = {getattr(item, key): item for item in old if getattr(item, key) not in removed}
    result.update(upserted)
    return list(result.values())


def apply_patch(project: Project, patch: Patch, expectations=None, board_hint: str | None = None) -> Project:
    if patch.board and project.board and patch.board.id != project.board.id:
        # Board kind may change in place, but changing the instance id would
        # orphan every existing wire and file group. Reject it instead of
        # silently rewriting the model's patch.
        raise ValueError(
            f"Cannot change the existing board ID from {project.board.id!r} to "
            f"{patch.board.id!r}; change boardKind in place.")

    components = merge_items(project.components, patch.upsert_components, patch.remove_components, "id")
    wires = merge_items(project.wires, patch.upsert_wires, patch.remove_wires, "id")
    files = merge_items(project.files, patch.upsert_files, patch.remove_files, "name")
    board = patch.board or project.board

    # A blank canvas has no board id for the model to copy. The model is told to
    # return `patch.board`, but a first draft that only supplies files/wires used
    # to die with the opaque "A build needs a board" error. Create the same
    # deterministic first-board shape as the browser (kind as id), using the
    # request/source only for an unambiguous family hint. An explicit board
    # always wins, including an explicitly selected Uno with no WiFi support.
    if board is None and (components or wires or files):
        hint = "\n".join([board_hint or "", *(file.content for file in files)])
        board_kind = catalog.infer_board_kind(hint)
        board_id = board_kind
        for endpoint in [end for wire in wires for end in (wire.start, wire.end)]:
            if catalog.normalize_board_kind(endpoint.componentId) == board_kind:
                board_id = endpoint.componentId
                break
        board = Board(id=board_id, boardKind=board_kind)

    candidate = Project(
        board=board,
        components=components,
        wires=wires,
        files=files,
    )
    # Velxio = Cursor: support every catalog board and source type. A project
    # has one entry file (.ino/.cpp/.c for Arduino-style targets or .py for
    # Linux/Pi) and may add flat headers beside it.
    if not candidate.board:
        raise ValueError(
            "A build needs at least one board. Return patch.board with a boardKind "
            f"from the {len(catalog.BOARDS)} supported Velxio boards.")
    sketch_entries = [f for f in candidate.files if f.name.endswith((".ino", ".py"))]
    native_entries = [f for f in candidate.files if f.name.endswith((".cpp", ".c"))]
    # A sketch may have helper .cpp/.c files; when there is no sketch entry,
    # the native C/C++ file itself is the entry (Pi/Linux projects use this).
    entry_files = sketch_entries if sketch_entries else native_entries
    if len(entry_files) != 1:
        raise ValueError(
            "A build needs exactly one entry source file (.ino, .py, .cpp, or .c); "
            f"received {[f.name for f in entry_files] or 'none'}.")
    has_code = any(f.name.endswith((".ino", ".py", ".cpp", ".c", ".h")) for f in candidate.files)
    if not has_code:
        raise ValueError("A build needs at least one source file (.ino, .py, .cpp)")
    # Restrict user includes to the common core, this board's native core APIs,
    # catalog part drivers, or explicit workspace headers. This is a capability
    # check, NOT a substitute for an OS compiler sandbox.
    filenames = {f.name for f in candidate.files}
    board_kind = candidate.board.boardKind if candidate.board else catalog.DEFAULT_BOARD
    for source in candidate.files:
        validate_includes(source.content, filenames, board_id=board_kind)
    # Coherence/short analysis runs BEFORE validate_electrical so a shorted LED
    # is reported as shorted, not as the vaguer downstream "needs a series
    # resistor". The compiler cannot see that the sketch drives pin 7 while the
    # LED sits on pin 13, and the electrical pre-flight cannot either (it
    # forces every wired GPIO HIGH). This pass can.
    from app.agent.analysis import assert_clean  # local import: analysis imports models

    candidate._findings = assert_clean(candidate, expectations)
    validate_electrical(candidate)
    return candidate


def allowed_include_headers(board_id: str = catalog.DEFAULT_BOARD) -> set[str]:
    """Common/catalog headers plus the native headers for ``board_id``."""
    return set(catalog.allowed_headers(board_id))


def validate_includes(
    content: str,
    filenames: set[str],
    allowed: set[str] | None = None,
    board_id: str = catalog.DEFAULT_BOARD,
):
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
        # Core headers and the drivers the catalog's parts need (Servo.h,
        # Wire.h, LiquidCrystal_I2C.h, DHT.h …) are allowed; a header no catalog
        # part uses is rejected before it wastes a compile round.
        permitted = allowed if allowed is not None else allowed_include_headers(board_id)
        if header not in permitted and not (local and local in filenames):
            label = catalog.board(board_id).get("label", board_id)
            raise ValueError(
                f"Unsupported include: {header} for {label}. Allowed headers are the common Arduino "
                f"core, this board's native APIs, and the drivers of parts in the catalog; use one of: "
                + ", ".join(sorted(permitted)))


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
        # Contacts that are joined inside the part (a pushbutton's 1.l/1.r) must
        # not be treated as two separate nets.
        for a, b in (catalog.get(part.metadataId).internal_pairs if catalog.get(part.metadataId) else ()):
            union(f"{part.id}:{a}", f"{part.id}:{b}")
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
