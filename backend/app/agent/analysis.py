"""Static analysis the compiler cannot do: firmware ↔ circuit coherence.

`arduino-cli` happily compiles a sketch that drives pin 7 while the LED is wired
to pin 13. The electrical pre-flight cannot catch that either: it deliberately
forces *every* wired GPIO HIGH ("the sketch will eventually digitalWrite HIGH"),
so the LED lights and the design looks verified.

This module closes that hole with a deterministic pass over the proposed
candidate — no model involved, no simulation needed. The rules themselves live
in the generated catalog (`app/agent/catalog.py`): every part declares which pins
need power, which pins must reach a board pin and with what capability, which
buses it can attach to, what needs a series resistor, and what must never touch a
GPIO. Adding a component therefore adds its wiring checks; this file only knows
how to walk nets and phrase findings.

  * every pin the firmware touches must actually be wired to something
  * every wired GPIO should be referenced by the firmware (warning, not error:
    a user may wire ahead of the code)
  * a GPIO must not be shorted to a power rail, or bridged to another GPIO
  * analogWrite/analogRead only on pins that can do it
  * required part pins must reach the board, on a pin of the right capability
    (a pot wiper on an analog pin, an I2C device on A4/A5, a servo on PWM)
  * part pins that are outputs must not be driven by the firmware as well
  * LEDs need a series resistor; motor/relay/stepper coils need a driver
  * declared expectations must describe pins and interactions that exist

`analyse()` returns findings; `assert_clean()` raises a ValueError carrying every
error (and the wording that says which wire to move) so `apply_patch` keeps its
existing "reject, never half-apply" contract and the repair loop has something
actionable to work with on its first repair turn.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable, Literal

from app.agent import catalog
from app.agent.catalog import DEFAULT_BOARD, PartSpec

Severity = Literal["error", "warning"]

# Board pins that are never a signal: they are power distribution.
POWER_PINS = {"5V", "3.3V", "3V3", "VBUS", "VSYS", "GND", "GND.1", "GND.2", "GND.3", "VIN", "VCC", "AREF", "IOREF"}

# How many distinct error messages the repair prompt carries (see assert_clean).
_MAX_ERROR_LINES = 6

WRITE_CALLS = {"digitalWrite", "analogWrite", "tone", "noTone", "attach"}
READ_CALLS = {"digitalRead", "analogRead", "pulseIn"}

# Comments and string/char literals must not contribute pin references. The
# preprocessor splices continued lines before it replaces comments, so mirror
# that order (same reasoning as validate_includes in models.py).
_LITERAL = re.compile(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|//[^\n]*|/\*[\s\S]*?\*/')
_CALL = re.compile(
    r"\b(pinMode|digitalWrite|digitalRead|analogRead|analogWrite|tone|noTone|pulseIn|attach)\s*\(\s*([^,()]+)")
_CONST = re.compile(r"(?m)^\s*(?:const\s+)?(?:static\s+)?(?:volatile\s+)?(?:unsigned\s+)?(?:int|byte|uint8_t|int8_t|int16_t)\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z_][A-Za-z0-9_.]*|\d{1,2})\s*;")
_DEFINE = re.compile(r"(?m)^\s*#\s*define\s+([A-Za-z_]\w*)\s+([A-Za-z_][A-Za-z0-9_.]*|\d{1,2})\b")
_ANALOG_NAME = re.compile(r"^A([0-9]+)$")

# Opening/instantiation of a part's own API (servos, libraries) - used for one
# thing only: noticing that the firmware drives a pin a part also drives.
_LIBRARY_CALL = re.compile(r"\b([A-Za-z_]\w*)\s*\.\s*(attach|write|writeMicroseconds)\s*\(\s*(?:(\d{1,2})\s*,?)?")


@dataclass(frozen=True)
class Finding:
    severity: Severity
    code: str
    message: str


# ── wording ──────────────────────────────────────────────────────────────────
# Messages keep the wording earlier versions used for the original six parts
# (they are what users have already seen in the repair loop) and fall back to a
# generic phrasing for the rest of the catalog.

_SHORT_CODES = {
    "led": "led-shorted",
    "passive": "resistor-shorted",
    "diode": "diode-shorted",
    "switch": "button-shorted",
    "logic": "part-shorted",
}
_SHORT_PHRASES = {
    "led": "has both terminals on the same net; it can never light",
    "passive": "has both legs on the same net, so it does nothing",
    "diode": "has its anode and cathode on the same net, so it can never conduct",
    "switch": "has both contacts on the same net, so it can never switch anything",
}


def _short_finding(spec: PartSpec, part_id: str, a: str, b: str) -> Finding:
    phrase = _SHORT_PHRASES.get(spec.cls)
    if phrase is None:
        phrase = f"has pins {a} and {b} on the same net, so it can never do anything"
    code = _SHORT_CODES.get(spec.cls, "part-shorted")
    hint = ""
    if spec.cls == "switch":
        hint = " Wire opposite sides (1.l and 2.r)."
    return Finding("error", code, f"{spec.name} {part_id} {phrase}.{hint}")


def _power_code(spec: PartSpec, kind: str) -> str:
    if spec.cls == "actuator-pwm":
        return "servo-power-unwired" if kind == "supply" else "servo-ground-unwired"
    return "power-unwired" if kind == "supply" else "ground-unwired"


# ── source scanning ──────────────────────────────────────────────────────────


def _clean(source: str) -> str:
    """Strip comments, blank out literals, splice line continuations."""
    logical = re.sub(r"\\\r?\n", "", source)
    return _LITERAL.sub(
        lambda m: " " if m.group().startswith(("//", "/*")) else '""', logical
    )


def pin_constants(sources: list[str]) -> dict[str, str]:
    """`const int LED = 13;` / `#define LED 13` → {'LED': '13'} across all files."""
    consts: dict[str, str] = {}
    for source in sources:
        text = _clean(source)
        for pattern in (_CONST, _DEFINE):
            for name, value in pattern.findall(text):
                consts.setdefault(name, value)
    return consts


def _resolve(arg: str, consts: dict[str, str], known_pins: set[str] | None = None) -> str | None:
    """Resolve a call's first argument to a board pin name, or None if unknown."""
    token = arg.strip().rstrip(";").strip()
    if known_pins and token in known_pins:
        return token
    if re.fullmatch(r"\d{1,2}", token):
        return token
    if _ANALOG_NAME.fullmatch(token):
        return token
    if re.fullmatch(r"[A-Za-z_]\w*", token) and token in consts:
        value = consts[token]
        if not known_pins or value in known_pins:
            return value
        # Keep numeric/A aliases useful for the historical Uno scanner; the
        # caller will report a board-specific unknown pin if it is not present.
        return value
    return None


def firmware_pin_usage(
    sources: list[str], known_pins: Iterable[str] | None = None,
) -> tuple[set[str], set[str]]:
    """(pins the firmware drives, pins the firmware reads) by board pin name."""
    consts = pin_constants(sources)
    board_pins = set(known_pins or ())
    driven: set[str] = set()
    read: set[str] = set()
    for source in sources:
        text = _clean(source)
        for match in _CALL.finditer(text):
            name, arg = match.group(1), match.group(2)
            pin = _resolve(arg, consts, board_pins)
            if pin is None:
                continue
            if name in WRITE_CALLS:
                # attach() is Servo.h (or a library binding the pin as output).
                driven.add(pin)
            elif name in READ_CALLS:
                read.add(pin)
            else:  # pinMode: the mode argument decides the direction
                # Slice from the END OF THIS match: searching for the first
                # "pinMode(" in the file reported the mode of the FIRST pinMode
                # call for every later call, so a sketch with one OUTPUT and one
                # INPUT pinMode claimed the input pin was driven too ("Pin 3 is
                # driven by the firmware and also driven by HC-SR04 ECHO").
                mode = text[match.end():]
                if "OUTPUT" in mode.split(")")[0]:
                    driven.add(pin)
                else:
                    read.add(pin)
    return driven, read


# ── topology ─────────────────────────────────────────────────────────────────


class Netlist:
    """Union-find over wire endpoints, part-internal contacts and pass-throughs.

    Two traversals matter and they are deliberately different:

      * `net_of` (wires + internal contacts) answers "is this pin wired straight
        to a rail / to another GPIO" — a resistor in between must still count as
        a component, so it does NOT pass through parts.
      * `signal_net` additionally walks through pass-through terminals
        (`tracePairs`: a series resistor, a diode, an opto's input LED) so that
        "the LED's anode reaches pin 13" is recognised as wired.

    `internal_pairs` are contacts that are physically joined inside a part (a
    pushbutton's 1.l↔1.r), so a button wired across its own contacts is caught
    with one pair test instead of four.
    """

    def __init__(self, project) -> None:
        self.project = project
        self.parent: dict[str, str] = {}
        self.kinds: dict[str, str] = {p.id: p.metadataId for p in project.components}
        if project.board:
            self.kinds[project.board.id] = project.board.boardKind
        self.trace: dict[str, set[str]] = {}
        for wire in project.wires:
            self.union(self.key(wire.start), self.key(wire.end))
        for part in project.components:
            spec = catalog.get(part.metadataId)
            if spec is None:
                continue
            for a, b in spec.internal_pairs:
                self.union(f"{part.id}:{a}", f"{part.id}:{b}")
            for a, b in spec.trace_pairs:
                self.trace.setdefault(f"{part.id}:{a}", set()).add(f"{part.id}:{b}")
                self.trace.setdefault(f"{part.id}:{b}", set()).add(f"{part.id}:{a}")

    @staticmethod
    def key(endpoint) -> str:
        return f"{endpoint.componentId}:{endpoint.pinName}"

    def find(self, pin: str) -> str:
        self.parent.setdefault(pin, pin)
        while self.parent[pin] != pin:
            self.parent[pin] = self.parent[self.parent[pin]]
            pin = self.parent[pin]
        return pin

    def union(self, a: str, b: str) -> None:
        self.parent[self.find(a)] = self.find(b)

    def same_net(self, a: str, b: str) -> bool:
        return self.find(a) == self.find(b)

    def net_of(self, pin: str) -> set[str]:
        root = self.find(pin)
        return {p for p in self.parent if self.find(p) == root}

    def signal_net(self, pin: str) -> set[str]:
        """Net reachable from `pin`, walking through series pass-throughs."""
        seen = {pin}
        stack = [pin]
        while stack:
            current = stack.pop()
            for node in self.net_of(current) | self.trace.get(current, set()):
                if node not in seen:
                    seen.add(node)
                    stack.append(node)
        return seen

    def board_pins_on(self, pins: Iterable[str], include_power: bool = False) -> set[str]:
        """Board pin names in `pins` (excluding this board's rails by default)."""
        board_id = self.project.board.id if self.project.board else DEFAULT_BOARD
        board_kind = self.project.board.boardKind if self.project.board else DEFAULT_BOARD
        power_pins = catalog.board_power_pins(board_kind) | POWER_PINS
        found = set()
        for pin in pins:
            component, _, name = pin.partition(":")
            if component == board_id and (include_power or name not in power_pins):
                found.add(name)
        return found

    def supply_rails(self) -> set[str]:
        """Board pins that count as a supply, plus other parts' power outputs."""
        board_id = self.project.board.id if self.project.board else DEFAULT_BOARD
        board_kind = self.project.board.boardKind if self.project.board else DEFAULT_BOARD
        supply, _ = catalog.power_rails(board_kind)
        return {f"{board_id}:{pin}" for pin in supply}

    def ground_rails(self) -> set[str]:
        """Board GND pins plus the ground pin of any part that supplies a rail.

        A 9V battery's `\u2212` or a bench supply's GND is a real return path, so a
        relay coil fed from a battery does not have to touch the board's GND to be
        a complete circuit.
        """
        board_id = self.project.board.id if self.project.board else DEFAULT_BOARD
        board_kind = self.project.board.boardKind if self.project.board else DEFAULT_BOARD
        _, ground = catalog.power_rails(board_kind)
        rails = {f"{board_id}:{pin}" for pin in ground}
        for part in self.project.components:
            spec = catalog.get(part.metadataId)
            if spec is None or not spec.power_out:
                continue
            rails.update(f"{part.id}:{pin}" for pin, kind in spec.power.items() if kind == "ground")
        return rails

    def regulator_outputs(self) -> set[str]:
        """Pins that are a regulated supply rail (a 7805's VOUT, a PSU's SIG)."""
        out = set()
        for part in self.project.components:
            spec = catalog.get(part.metadataId)
            if spec is None:
                continue
            for pin in spec.power_out:
                out.add(f"{part.id}:{pin}")
        return out


def wired_gpio_pins(project) -> set[str]:
    """Board pins a wire actually touches, excluding that board's rails."""
    if not project.board:
        return set()
    board = project.board.id
    power_pins = catalog.board_power_pins(project.board.boardKind) | POWER_PINS
    pins = set()
    for wire in project.wires:
        for end in (wire.start, wire.end):
            if end.componentId == board and end.pinName not in power_pins:
                pins.add(end.pinName)
    return pins


def _pins_of(project, part) -> list[str]:
    spec = catalog.get(part.metadataId)
    return list(spec.pins_for(part.properties)) if spec else []


def _expectation_kind_ok(spec: PartSpec, kind: str) -> bool:
    return kind in spec.interactions


# ── the analysis ─────────────────────────────────────────────────────────────



def _pin_satisfies(nets: Netlist, pin: str, capability: str) -> bool:
    if capability == catalog.ANY_CAPABILITY:
        return True
    board_kind = nets.project.board.boardKind if nets.project.board else DEFAULT_BOARD
    return any(catalog.satisfies(bp, capability, board_kind)
               for bp in nets.board_pins_on(nets.signal_net(pin)))


def _bus_satisfied(nets: Netlist, spec: PartSpec, bus, key) -> bool:
    return all(_pin_satisfies(nets, key(pin), capability) for pin, capability in bus.pins.items())


def _wired_straight_to(project, board: str, pin: str, key: str) -> bool:
    """True when one wire runs straight between board pin `pin` and `key`."""
    return any(
        {Netlist.key(wire.start), Netlist.key(wire.end)} == {f"{board}:{pin}", key}
        for wire in project.wires
    )


def _shorted_contact_hint(project, net: set[str], gpio: str, rail: str) -> str:
    """Explain the *part* when a rail shares a joined contact with a GPIO.

    The failure this exists for: a pushbutton's four legs are two contacts joined
    inside the part (1.l=1.r, 2.l=2.r). Wiring the GPIO to 1.l and GND to 1.r is
    *both legs of one contact* — a dead short, and the switch can never do
    anything. The generic wording ("put the load between the pin and the rail")
    instead reads as "add another component", so a repair loop rebuilt the same
    two wires until its attempts ran out. Naming the part, the contact and the
    exact wire to move is what makes this diagnostic actionable.
    """
    board = project.board.id if project.board else DEFAULT_BOARD
    fallback = ""
    for part in project.components:
        spec = catalog.get(part.metadataId)
        if spec is None:
            continue
        names = list(spec.pins_for(part.properties))
        for a, b in spec.internal_pairs:
            if f"{part.id}:{a}" not in net or f"{part.id}:{b}" not in net:
                continue
            free = [name for name in names if f"{part.id}:{name}" not in net]
            if not free:
                return (f" {a} and {b} of {spec.name} {part.id} are joined inside the part, so they "
                        f"are one single contact — nothing separates pin {gpio} from {rail}.")
            target = f"{part.id}.{free[0]}"
            # Which leg holds which wire, when the model wired them straight through.
            rail_leg = next((f"{part.id}.{name}" for name in (a, b)
                             if _wired_straight_to(project, board, rail, f"{part.id}:{name}")), None)
            gpio_leg = next((f"{part.id}.{name}" for name in (a, b)
                             if _wired_straight_to(project, board, gpio, f"{part.id}:{name}")), None)
            move = (f"Move the {rail} wire from {rail_leg} to {target}" if rail_leg
                    else f"Move the {rail} wire to the part's other contact, {target}")
            keep = (f", and keep the pin on {gpio_leg}." if gpio_leg and gpio_leg != rail_leg
                    else f", so the pin and {rail} end up on opposite contacts.")
            message = (f" {a} and {b} of {spec.name} {part.id} are joined inside the part, so pin "
                       f"{gpio} and {rail} share the SAME contact — a dead short, not a switch; the "
                       f"switch closes between that contact and {target}. {move}{keep}")
            if gpio_leg:
                return message  # this is the part the pin is actually wired to
            fallback = fallback or message  # another part shares this net (a common GND)
    return fallback


def _series_resistor_present(project, nets: Netlist, terminals: list[str]) -> bool:
    """True when a resistor is genuinely in series with one of `terminals`.

    Three ways a "resistor" must NOT count:

      * both legs on the terminal's net — the resistors is bypassed, it is a short;
      * the far leg is on its own, unconnected net — a dangling resistor in series
        with nothing (an LED wired straight to the pin with a spare part parked
        next to it is still an LED without a resistor, and that is the failure
        this check exists for);
      * the same resistor counted twice because both legs touch the net.
    """
    for part in project.components:
        if not part.metadataId.startswith("resistor"):
            continue
        resistor_pins = _pins_of(project, part)
        if len(resistor_pins) < 2:
            continue
        a, b = f"{part.id}:{resistor_pins[0]}", f"{part.id}:{resistor_pins[1]}"
        for terminal in terminals:
            near, far = None, None
            if nets.same_net(terminal, a) and not nets.same_net(terminal, b):
                near, far = a, b
            elif nets.same_net(terminal, b) and not nets.same_net(terminal, a):
                near, far = b, a
            if near is None:
                continue
            # The far leg must reach something else (a pin, a rail) for this to be
            # a series resistor rather than a parked part.
            if len(nets.net_of(far)) > 1:
                return True
    return False


def analyse(project, expectations=None) -> list[Finding]:
    """Deterministic findings for a candidate project. Never raises."""
    findings: list[Finding] = []
    if not project.board:
        return findings
    board = project.board.id
    board_kind = project.board.boardKind
    caps = catalog.board_capabilities(board_kind)
    pwm = {str(p) for p in caps.get("pwm", [])}
    analog = {str(p) for p in caps.get("analog", [])}
    all_pins = set(catalog.board_pins(board_kind))
    power_pins = catalog.board_power_pins(board_kind) | POWER_PINS

    nets = Netlist(project)
    wired = wired_gpio_pins(project)
    sources = [f.content for f in project.files]
    driven, read = firmware_pin_usage(sources, all_pins)

    # --- firmware ↔ circuit ------------------------------------------------
    for pin in sorted(driven | read):
        if pin not in all_pins:
            findings.append(Finding("error", "unknown-pin",
                f"Firmware uses pin {pin}, which does not exist on {catalog.board(board_kind).get('label', board_kind)}."))
        elif pin not in wired:
            verb = "drives" if pin in driven else "reads"
            findings.append(Finding("error", "pin-unwired",
                f"Firmware {verb} pin {pin} but nothing is wired to it. Wire the part to "
                f"pin {pin} or change the sketch to the pin the part is on."))
    for pin in sorted(wired - driven - read):
        findings.append(Finding("warning", "pin-unreferenced",
            f"Pin {pin} is wired but the sketch never uses it."))

    # --- pin capability -----------------------------------------------------
    for source in sources:
        text = _clean(source)
        consts = pin_constants(sources)
        for call, arg in re.findall(r"\b(analogWrite|analogRead)\s*\(\s*([^,()]+)", text):
            pin = _resolve(arg, consts)
            if pin is None:
                continue
            label = catalog.board(board_kind).get("label", board_kind)
            if call == "analogWrite" and pin in all_pins and pin not in pwm:
                findings.append(Finding("error", "not-pwm-capable",
                    f"analogWrite() on pin {pin}: that pin has no PWM output on {label}. "
                    f"Use {catalog.capability_label('pwm', board_kind)}."))
            if call == "analogRead" and pin in all_pins and pin not in analog:
                findings.append(Finding("error", "not-analog-capable",
                    f"analogRead() on pin {pin}: that pin has no ADC input on {label}. "
                    f"Use {catalog.capability_label('analog', board_kind)}."))

    # --- shorts and contention (raw wire nets: a part in between is a load) --
    rails = {p for p in power_pins if p in all_pins}
    for pin in sorted(wired):
        net = nets.net_of(f"{board}:{pin}")
        hit = sorted({p.split(":", 1)[1] for p in net if p.startswith(f"{board}:") and p.split(":", 1)[1] in rails})
        if hit:
            # A rail on the same net is a short — but when the net also sits on
            # both legs of one internally-joined contact the message has to name
            # that part and the wire to move, or the repair loop "fixes" it by
            # regenerating the identical wiring.
            hint = _shorted_contact_hint(project, net, pin, hit[0])
            if hint:
                message = f"Pin {pin} is wired directly to {hit[0]}." + hint
            else:
                message = (f"Pin {pin} is wired directly to {hit[0]} with no component in between. "
                           f"That shorts the GPIO; put the load between the pin and the rail.")
            findings.append(Finding("error", "gpio-shorted", message))
    by_net: dict[str, list[str]] = {}
    for pin in sorted(wired):
        by_net.setdefault(nets.find(f"{board}:{pin}"), []).append(pin)
    for net, pins in by_net.items():
        if len(pins) > 1:
            findings.append(Finding("error", "gpio-bridged",
                f"Pins {' and '.join(pins)} are wired together. Two GPIOs on one net fight "
                f"each other; use one pin, or separate the nets."))

    # --- per-part rules from the catalog ------------------------------------
    # Two passes on purpose: structural faults (a part shorted across its own
    # terminals, a power output on a GPIO, a coil on a pin) are reported before
    # the "is it wired correctly" rules, so the first error a repair loop sees is
    # the most fundamental one.
    sim_flagged: set[str] = set()
    supply_pins = nets.supply_rails() | nets.regulator_outputs()
    ground_pins = nets.ground_rails()
    i2c_claims: dict[str, list[str]] = {}
    key_of = lambda part, name: f"{part.id}:{name}"  # noqa: E731

    def spec_of(part):
        return catalog.get(part.metadataId)

    for part in project.components:
        spec = spec_of(part)
        if spec is None:
            continue
        pins = _pins_of(project, part)
        key = lambda name: key_of(part, name)  # noqa: E731
        if not spec.sim and part.metadataId not in sim_flagged:
            sim_flagged.add(part.metadataId)
            findings.append(Finding("warning", "sim-unverifiable",
                f"{spec.name} has no live simulation, so a design using it can be "
                f"compiled but its behaviour cannot be verified automatically."))
        for a, b in spec.self_short:
            if a in pins and b in pins and nets.same_net(key(a), key(b)):
                findings.append(_short_finding(spec, part.id, a, b))
        for pin in spec.power_out:
            if pin not in pins:
                continue
            touched = nets.board_pins_on(nets.net_of(key(pin)))
            if touched:
                findings.append(Finding(catalog.SEVERITY.get("powerOut", "error"), "power-out-to-gpio",
                    f"{spec.name} {part.id} {pin} is a power output but is wired to GPIO "
                    f"{sorted(touched)[0]}. Feed a rail or a load, not a pin."))
        if spec.external_driver:
            gpio_pins = {f"{board}:{pin}" for pin in wired}
            bad = [p for p in spec.external_driver["pins"] if p in pins and (nets.net_of(key(p)) & gpio_pins)]
            if bad:
                findings.append(Finding(catalog.SEVERITY.get("externalDriver", "error"), "needs-driver",
                    f"{spec.name} {part.id} pin {bad[0]}: {spec.external_driver['why']}"))

    for part in project.components:
        spec = spec_of(part)
        if spec is None:
            continue
        pins = _pins_of(project, part)
        key = lambda name: key_of(part, name)  # noqa: E731
        buses = spec.buses_for(part.properties)
        bus_pins = {pin for bus in buses for pin in bus.pins}

        for pin, kind in spec.power.items():
            if pin not in pins:
                continue
            targets = supply_pins if kind == "supply" else ground_pins
            if not (nets.net_of(key(pin)) & targets):
                want = "a supply rail (5V, or a battery/regulator output)" if kind == "supply" else "GND"
                findings.append(Finding(catalog.SEVERITY.get("power", "warning"),
                    _power_code(spec, kind),
                    f"{spec.name} {part.id} {pin} is not wired to {want}, so the part has no "
                    f"{'power' if kind == 'supply' else 'return path'}."))

        for pin, rule in spec.signals.items():
            if pin not in pins:
                continue
            net = nets.signal_net(key(pin))
            board_pins = nets.board_pins_on(net)
            if not board_pins:
                if rule.optional:
                    continue
                code = "servo-unwired" if spec.cls == "actuator-pwm" else "signal-unwired"
                findings.append(Finding(
                    rule.severity or catalog.SEVERITY.get("signal", "error"), code,
                    f"{spec.name} {part.id} {pin} is not wired to any board pin. Connect it to "
                    f"{catalog.capability_label(rule.cap, board_kind)}."))
                continue
            if rule.cap != catalog.ANY_CAPABILITY and not any(
                catalog.satisfies(p, rule.cap, board_kind) for p in board_pins
            ):
                code = {"pwm": "not-pwm-capable", "analog": "not-analog-capable"}.get(
                    rule.cap, f"signal-not-{rule.cap}")
                if spec.cls == "input-analog" and rule.cap == "analog":
                    findings.append(Finding(
                        rule.severity or "error", code,
                        f"Potentiometer {part.id} {pin} is not on an analog-capable pin. Connect "
                        f"{pin} to one of {', '.join(sorted(analog))}."))
                else:
                    label = (
                        f"non-PWM pin {sorted(board_pins)[0]}" if rule.cap == "pwm"
                        else f"non-analog pin {sorted(board_pins)[0]}" if rule.cap == "analog"
                        else f"a pin that is not {rule.cap}"
                    )
                    findings.append(Finding(
                        rule.severity or "error", code,
                        f"{spec.name} {part.id} {pin} is on {label}. Use "
                        f"{catalog.capability_label(rule.cap, board_kind)}."))
            # Direction: `out` means the part is the source on that net, so the
            # firmware must read it. Bus pins are excluded (I2C/SPI are driven by
            # both sides by definition).
            if rule.direction == "out" and pin not in bus_pins and (board_pins & driven):
                pin_name = sorted(board_pins & driven)[0]
                if spec.cls == "switch":
                    findings.append(Finding("warning", "button-shorts-pin",
                        f"Pin {pin_name} drives a net that {spec.name.lower()} {part.id} connects "
                        f"to a rail. Read it with INPUT_PULLUP instead of driving it."))
                else:
                    findings.append(Finding("error", "drive-conflict",
                        f"Pin {pin_name} is driven by the firmware and also driven by "
                        f"{spec.name} {part.id} {pin}. Read it instead of writing to it."))

        if buses:
            # `net_of` auto-creates a singleton net for any name, so "is this pin
            # wired at all" means "its net has more than itself in it".
            wired_bus_pins = [p for p in buses[0].pins if len(nets.net_of(key(p))) > 1]
            if wired_bus_pins:
                if not any(_bus_satisfied(nets, spec, bus, key) for bus in buses):
                    bus = buses[0]
                    missing = [
                        f"{p}->{catalog.capability_label(cap, board_kind)}"
                        for p, cap in bus.pins.items()
                        if not _pin_satisfies(nets, key(p), cap)
                    ]
                    findings.append(Finding(
                        catalog.SEVERITY.get("bus", "error"), "bus-mismatch",
                        f"{spec.name} {part.id} is wired but does not match a supported bus pinout. "
                        f"{bus.type.upper()} needs " + "; ".join(missing) + "."))
                if spec.address_property and "i2c" in {b.type for b in buses}:
                    address = str(part.properties.get(spec.address_property)
                                  or spec.defaults.get(spec.address_property, "")).lower()
                    i2c_claims.setdefault(address, []).append(part.id)

        if spec.gate_resistor:
            for pin in spec.gate_resistor["pins"]:
                if pin not in pins:
                    continue
                raw = nets.net_of(key(pin))
                on_gpio = nets.board_pins_on(raw)
                if on_gpio:
                    findings.append(Finding(catalog.SEVERITY.get("gateResistor", "error"),
                        "needs-gate-resistor",
                        f"{spec.name} {part.id} {pin} is wired straight to GPIO {sorted(on_gpio)[0]}. "
                        f"Put a {int(spec.gate_resistor.get('min', 100))}-10000 ohm resistor in "
                        f"series with the base/gate."))

        rule = spec.series_resistor
        if rule:
            targets = [p for p in rule["pins"] if p in pins]
            each = bool(rule.get("each"))
            severity = rule.get("severity") or catalog.SEVERITY.get("seriesResistor", "error")
            minimum = int(rule.get("min", 100))
            if each:
                for pin in targets:
                    if not _series_resistor_present(project, nets, key(pin)):
                        findings.append(Finding(severity, "needs-series-resistor",
                            f"{spec.name} {part.id} pin {pin} has no series resistor "
                            f"(at least {minimum} ohms); the segment will either be dim or "
                            f"burn out."))
            elif targets and not _series_resistor_present(
                    project, nets, [key(pin) for pin in targets]):
                findings.append(Finding(severity, "led-needs-resistor",
                    f"{spec.name} {part.id} needs a series resistor (at least {minimum} ohms) on "
                    f"one terminal."))

    # two I2C devices on one address: they would answer each other's traffic
    for address, ids in i2c_claims.items():
        if len(ids) > 1 and address not in {"", "none"}:
            findings.append(Finding(catalog.SEVERITY.get("busAddressClash", "error"), "i2c-address-clash",
                f"{', '.join(ids)} are all on I2C address {address}. Two devices cannot share an "
                f"address; change one part's address property (or its AD0/SDO pin)."))

    # --- expectations must describe the real circuit ------------------------
    if expectations is not None:
        kinds = {p.id: p.metadataId for p in project.components}
        for exp in expectations.pins:
            if exp.pin not in wired:
                findings.append(Finding("error", "expectation-unwired-pin",
                    f"Expectation targets pin {exp.pin}, which is not wired to anything."))
        for inter in expectations.interactions:
            kind = kinds.get(inter.componentId)
            if kind is None:
                findings.append(Finding("error", "expectation-unknown-part",
                    f"Interaction targets {inter.componentId}, which is not in the circuit."))
                continue
            spec = catalog.get(kind)
            if spec is None:
                continue
            supported = spec.interactions
            if inter.kind not in supported:
                if inter.kind == "press":
                    findings.append(Finding("error", "expectation-not-pressable",
                        f"{inter.componentId} is a {kind}; only a pushbutton or another "
                        f"momentary switch can be pressed."))
                elif inter.kind == "pot":
                    findings.append(Finding("error", "expectation-not-a-pot",
                        f"{inter.componentId} is a {kind}; only a potentiometer or a joystick "
                        f"axis can be set."))
                elif inter.kind == "stimulus":
                    findings.append(Finding("error", "expectation-not-stimulatable",
                        f"{inter.componentId} is a {kind}, which takes no stimulus. Stimulus parts: "
                        + ", ".join(sorted(p.id for p in catalog.PARTS.values() if p.stimulus_keys)) + "."))
                elif inter.kind == "switch":
                    findings.append(Finding("error", "expectation-not-a-switch",
                        f"{inter.componentId} is a {kind}; only a switch can be toggled."))
                elif inter.kind == "rotary":
                    findings.append(Finding("error", "expectation-not-rotary",
                        f"{inter.componentId} is a {kind}; only a rotary part can be turned."))
                continue
            if inter.kind == "stimulus":
                allowed = set(spec.stimulus_keys)
                bad = sorted(set(inter.values) - allowed)
                if bad:
                    findings.append(Finding("error", "expectation-unknown-stimulus",
                        f"{inter.componentId} ({spec.name}) does not accept stimulus "
                        f"{', '.join(bad)}. Available: {', '.join(sorted(allowed))}."))
    return findings


def assert_clean(project, expectations=None) -> list[Finding]:
    """Raise ValueError describing every error finding; return all findings.

    Every error, not just the first: three identically miswired buttons are
    three findings, and reporting one per attempt spent three repair turns on a
    fix that fits in one (the loop is capped, so the run ended with nothing
    applied). Messages are grouped per code and capped, so one mistake repeated
    across twenty pins cannot flood the repair prompt.
    """
    findings = analyse(project, expectations)
    errors = [f for f in findings if f.severity == "error"]
    if not errors:
        return findings
    lines: list[str] = []
    per_code: dict[str, int] = {}
    dropped = 0
    for finding in errors:
        per_code[finding.code] = per_code.get(finding.code, 0) + 1
        if per_code[finding.code] <= 2 and len(lines) < _MAX_ERROR_LINES:
            lines.append(finding.message)
        else:
            dropped += 1
    if dropped:
        lines.append(f"({dropped} more error{'s' if dropped != 1 else ''} of "
                     f"{'these kinds were' if dropped != 1 else 'this kind was'} also found — "
                     f"fix every occurrence, not only the first.)")
    raise ValueError("\n".join(lines))


def netlist_summary(project) -> list[dict[str, Any]]:
    """Nets as data, for the agent's `netlist` tool: what is connected to what."""
    nets = Netlist(project)
    grouped: dict[str, list[str]] = {}
    for part in project.components:
        for pin in _pins_of(project, part):
            grouped.setdefault(nets.find(f"{part.id}:{pin}"), []).append(f"{part.id}.{pin}")
    if project.board:
        for pin in catalog.board_pins(project.board.boardKind):
            key = f"{project.board.id}:{pin}"
            if key in nets.parent:
                grouped.setdefault(nets.find(key), []).append(f"{project.board.id}.{pin}")
    out = []
    for _root, members in grouped.items():
        if len(members) < 2:
            continue
        out.append({"pins": sorted(members),
                    "board_pins": sorted(nets.board_pins_on(members, include_power=True))})
    out.sort(key=lambda net: net["pins"])
    return out
