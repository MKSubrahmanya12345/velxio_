"""Static analysis the compiler cannot do: firmware ↔ circuit coherence.

`arduino-cli` happily compiles a sketch that drives pin 7 while the LED is wired
to pin 13. The electrical pre-flight cannot catch that either: it deliberately
forces *every* wired GPIO HIGH ("the sketch will eventually digitalWrite HIGH"),
so the LED lights and the design looks verified.

This module closes that hole with a deterministic pass over the proposed
candidate — no model involved, no simulation needed:

  * every pin the firmware touches must actually be wired to something
  * every wired GPIO should be referenced by the firmware (warning, not error:
    a user may wire ahead of the code)
  * a GPIO must not be shorted to a power rail, or bridged to another GPIO
  * analogWrite/analogRead only on pins that can do it
  * a potentiometer wiper must land on an analog-capable pin
  * declared expectations must describe pins that exist in the circuit

`analyse()` returns findings; `assert_clean()` raises on the errors so
`apply_patch` keeps its existing "reject, never half-apply" contract.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from app.agent.models import BOARD_CAPABILITIES, PINS

Severity = Literal["error", "warning"]

# Board pins that are never a signal: they are power distribution.
POWER_PINS = {"5V", "3.3V", "GND", "GND.1", "GND.2", "GND.3", "VIN", "VCC"}

WRITE_CALLS = {"digitalWrite", "analogWrite", "tone", "noTone", "attach"}
READ_CALLS = {"digitalRead", "analogRead", "pulseIn"}

# Comments and string/char literals must not contribute pin references. The
# preprocessor splices continued lines before it replaces comments, so mirror
# that order (same reasoning as validate_includes in models.py).
_LITERAL = re.compile(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|//[^\\n]*|/\*[\s\S]*?\*/')
_CALL = re.compile(
    r"\b(pinMode|digitalWrite|digitalRead|analogRead|analogWrite|tone|noTone|pulseIn|attach)\s*\(\s*([^,()]+)")
_CONST = re.compile(r"(?m)^\s*(?:const\s+)?(?:static\s+)?(?:volatile\s+)?(?:unsigned\s+)?(?:int|byte|uint8_t|int8_t|int16_t)\s+([A-Za-z_]\w*)\s*=\s*(\d{1,2}|A[0-7])\s*;")
_DEFINE = re.compile(r"(?m)^\s*#\s*define\s+([A-Za-z_]\w*)\s+(\d{1,2}|A[0-7])\b")
_ANALOG_NAME = re.compile(r"^A([0-7])$")


@dataclass(frozen=True)
class Finding:
    severity: Severity
    code: str
    message: str


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


def _resolve(arg: str, consts: dict[str, str]) -> str | None:
    """Resolve a call's first argument to a board pin name, or None if unknown."""
    token = arg.strip().rstrip(";").strip()
    if re.fullmatch(r"\d{1,2}", token):
        return token
    if _ANALOG_NAME.fullmatch(token):
        return token
    if re.fullmatch(r"[A-Za-z_]\w*", token) and token in consts:
        return consts[token]
    return None


def firmware_pin_usage(sources: list[str]) -> tuple[set[str], set[str]]:
    """(pins the firmware drives, pins the firmware reads) by board pin name."""
    consts = pin_constants(sources)
    driven: set[str] = set()
    read: set[str] = set()
    for source in sources:
        text = _clean(source)
        for name, arg in _CALL.findall(text):
            pin = _resolve(arg, consts)
            if pin is None:
                continue
            if name in WRITE_CALLS:
                # attach() is Servo.h (or a library binding the pin as output).
                driven.add(pin)
            elif name in READ_CALLS:
                read.add(pin)
            else:  # pinMode: the mode argument decides the direction
                mode = text[text.find(name + "(") :]
                if "OUTPUT" in mode.split(")")[0]:
                    driven.add(pin)
                else:
                    read.add(pin)
    return driven, read


class Netlist:
    """Union-find over wire endpoints plus a pushbutton's internal contacts."""

    def __init__(self, project) -> None:
        self.parent: dict[str, str] = {}
        self.project = project
        for wire in project.wires:
            self.union(self.key(wire.start), self.key(wire.end))
        for part in project.components:
            if part.metadataId == "pushbutton":
                self.union(f"{part.id}:1.l", f"{part.id}:1.r")
                self.union(f"{part.id}:2.l", f"{part.id}:2.r")

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


def wired_gpio_pins(project) -> set[str]:
    """Board pins a wire actually touches, excluding power distribution."""
    if not project.board:
        return set()
    board = project.board.id
    pins = set()
    for wire in project.wires:
        for end in (wire.start, wire.end):
            if end.componentId == board and end.pinName not in POWER_PINS:
                pins.add(end.pinName)
    return pins


def analyse(project, expectations=None) -> list[Finding]:
    """Deterministic findings for a candidate project. Never raises."""
    findings: list[Finding] = []
    if not project.board:
        return findings
    board = project.board.id
    caps = BOARD_CAPABILITIES.get("arduino-uno", {})
    pwm = {str(p) for p in caps.get("pwm", [])}
    analog = {str(p) for p in caps.get("analog", [])}
    all_pins = set(PINS.get("arduino-uno", []))

    nets = Netlist(project)
    wired = wired_gpio_pins(project)
    sources = [f.content for f in project.files]
    driven, read = firmware_pin_usage(sources)

    # --- firmware ↔ circuit coherence -------------------------------------
    for pin in sorted(driven | read):
        if pin not in all_pins:
            findings.append(Finding("error", "unknown-pin",
                f"Firmware uses pin {pin}, which does not exist on the Arduino Uno."))
        elif pin not in wired:
            verb = "drives" if pin in driven else "reads"
            findings.append(Finding("error", "pin-unwired",
                f"Firmware {verb} pin {pin} but nothing is wired to it. Wire the part to "
                f"pin {pin} or change the sketch to the pin the part is on."))
    for pin in sorted(wired - driven - read):
        findings.append(Finding("warning", "pin-unreferenced",
            f"Pin {pin} is wired but the sketch never uses it."))

    # --- pin capability ----------------------------------------------------
    for pin in sorted(driven):
        # analogWrite is the only PWM writer we can see statically; tone/digital
        # work on any GPIO, so only flag analogWrite on a non-PWM pin.
        pass
    for source in sources:
        text = _clean(source)
        consts = pin_constants(sources)
        for call, arg in re.findall(r"\b(analogWrite|analogRead)\s*\(\s*([^,()]+)", text):
            pin = _resolve(arg, consts)
            if pin is None:
                continue
            if call == "analogWrite" and pin in all_pins and pin not in pwm:
                findings.append(Finding("error", "not-pwm-capable",
                    f"analogWrite() on pin {pin}: that pin has no PWM output on the Uno. "
                    f"Use one of {', '.join(sorted(pwm, key=lambda p: int(p)))}."))
            if call == "analogRead" and pin in all_pins and pin not in analog:
                findings.append(Finding("error", "not-analog-capable",
                    f"analogRead() on pin {pin}: that pin has no ADC input on the Uno. "
                    f"Use one of {', '.join(sorted(analog))}."))

    # --- shorts and contention --------------------------------------------
    rails = {p for p in ("GND", "GND.1", "GND.2", "GND.3", "5V", "3.3V") if p in PINS.get("arduino-uno", [])}
    for pin in sorted(wired):
        net = nets.net_of(f"{board}:{pin}")
        hit = sorted({p.split(":", 1)[1] for p in net if p.startswith(f"{board}:") and p.split(":", 1)[1] in rails})
        if hit:
            findings.append(Finding("error", "gpio-shorted",
                f"Pin {pin} is wired directly to {hit[0]} with no component in between. "
                f"That shorts the GPIO; put the load between the pin and the rail."))
    by_net: dict[str, list[str]] = {}
    for pin in sorted(wired):
        by_net.setdefault(nets.find(f"{board}:{pin}"), []).append(pin)
    for net, pins in by_net.items():
        if len(pins) > 1:
            findings.append(Finding("error", "gpio-bridged",
                f"Pins {' and '.join(pins)} are wired together. Two GPIOs on one net fight "
                f"each other; use one pin, or separate the nets."))

    for part in project.components:
        if part.metadataId == "pushbutton":
            left = nets.find(f"{part.id}:1.l")
            for side_a, side_b in (("1.l", "2.l"), ("1.r", "2.r"), ("1.l", "2.r"), ("1.r", "2.l")):
                a, b = f"{part.id}:{side_a}", f"{part.id}:{side_b}"
                if nets.same_net(a, b):
                    findings.append(Finding("error", "button-shorted",
                        f"Button {part.id} has both contacts on the same net, so it can never "
                        f"switch anything. Wire opposite sides (1.l and 2.r)."))
                    break
            # A driven pin that the button pulls to GND is a live short when pressed.
            for driven_pin in sorted(driven):
                node = f"{board}:{driven_pin}"
                if nets.find(node) == left or nets.find(node) == nets.find(f"{part.id}:1.r"):
                    other = nets.net_of(f"{part.id}:2.l") | nets.net_of(f"{part.id}:2.r")
                    if any(p.startswith(f"{board}:GND") for p in other):
                        findings.append(Finding("warning", "button-shorts-pin",
                            f"Pin {driven_pin} drives a net that button {part.id} connects to GND "
                            f"when pressed. Read it with INPUT_PULLUP instead of driving it."))
        if part.metadataId == "led" and nets.same_net(f"{part.id}:A", f"{part.id}:C"):
            findings.append(Finding("error", "led-shorted",
                f"LED {part.id} has both terminals on the same net; it can never light."))
        if part.metadataId == "resistor" and nets.same_net(f"{part.id}:1", f"{part.id}:2"):
            findings.append(Finding("error", "resistor-shorted",
                f"Resistor {part.id} has both legs on the same net, so it does nothing."))
        if part.metadataId == "servo":
            # The pulse train needs a timer/PWM pin; on digital pins Servo.h
            # either fails to compile or jitters unusably.
            net = nets.net_of(f"{part.id}:PWM")
            board_pins_on_net = {p.split(":", 1)[1] for p in net if p.startswith(f"{board}:")}
            if not board_pins_on_net:
                findings.append(Finding("error", "servo-unwired",
                    f"Servo {part.id} signal (PWM) is not wired to any board pin. "
                    f"Connect it to a PWM pin: {', '.join(sorted(pwm, key=lambda x: int(x)))}."))
            elif not (board_pins_on_net & pwm):
                findings.append(Finding("error", "servo-not-pwm",
                    f"Servo {part.id} signal is on non-PWM pin {sorted(board_pins_on_net)[0]}. "
                    f"Servo pulses need a PWM pin: {', '.join(sorted(pwm, key=lambda x: int(x)))}."))
            if not any(p.startswith(f"{board}:5V") for p in nets.net_of(f"{part.id}:V+")):
                findings.append(Finding("warning", "servo-power-unwired",
                    f"Servo {part.id} V+ is not wired to 5V; it cannot move without power."))
            if not any(p.startswith(f"{board}:GND") for p in nets.net_of(f"{part.id}:GND")):
                findings.append(Finding("warning", "servo-ground-unwired",
                    f"Servo {part.id} GND is not wired to a GND pin."))
        if part.metadataId == "potentiometer":
            net = nets.net_of(f"{part.id}:SIG")
            if not any(p.startswith(f"{board}:") and p.split(":", 1)[1] in analog for p in net):
                findings.append(Finding("error", "pot-not-analog",
                    f"Potentiometer {part.id} wiper is not on an analog-capable pin. Connect SIG "
                    f"to one of {', '.join(sorted(analog))}."))

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
            elif inter.kind == "press" and kind != "pushbutton":
                findings.append(Finding("error", "expectation-not-pressable",
                    f"{inter.componentId} is a {kind}; only a pushbutton can be pressed."))
            elif inter.kind == "pot" and kind != "potentiometer":
                findings.append(Finding("error", "expectation-not-a-pot",
                    f"{inter.componentId} is a {kind}; only a potentiometer can be set."))
    return findings


def assert_clean(project, expectations=None) -> list[Finding]:
    """Raise ValueError on the first error finding; return all findings."""
    findings = analyse(project, expectations)
    for finding in findings:
        if finding.severity == "error":
            raise ValueError(finding.message)
    return findings
