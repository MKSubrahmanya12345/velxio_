"""Offline planner — the built-in agent with no model behind it.

Deterministic, no network, no credentials. The prompt is parsed against the
same generated catalog the model reads (``catalog.json``), and the result is
the same ``Proposal`` a model would return: board, parts, pin assignment,
wiring, firmware, falsifiable expectations.

Nothing here bypasses a gate. The server still validates the patch and still
runs the real compiler; the browser still runs the electrical pre-flight and
the live-simulation expectations. This planner proposes — the toolchain
decides, and if it says no, the user gets that error instead of silence.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import lru_cache

from app.agent import catalog
from app.agent.models import (
    Board,
    Connection,
    Endpoint,
    Expectations,
    Part,
    Patch,
    PinExpectation,
    Proposal,
    SerialExpectation,
    Source,
)

MAX_PARTS = 40
MAX_WIRES = 100

# --------------------------------------------------------------------------
# prompt parsing
# --------------------------------------------------------------------------

# Tags that are real English words on their own. A tag is only usable as a
# match key when it names exactly one placeable part (see _phrases), which
# already kills "sensor"/"display"; these stay excluded even when unique
# because they describe a category, not a request.
_STOP_PHRASES = frozenset({
    "analog", "power", "source", "preset", "board", "module", "custom",
    "small", "big", "light", "driver", "audio", "logic", "output", "input",
    "digital", "serial", "uart", "i2c", "spi", "pwm", "clock", "position",
    "display", "sensor", "ic", "dip14", "quad", "linear", "sequential",
    "gate", "and", "or", "nand", "nor", "inverter", "flip-flop", "ff",
    "mosfet", "bjt", "npn", "pnp", "opamp", "amplifier", "regulator",
    "arduino", "stepper", "motor", "battery", "temperature",
    "ceramic", "electrolytic", "polarized", "epaper", "e-paper", "e-ink",
    "gxepd2", "74hc", "3-input", "4-input",
})

_NUMBER_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
}

# Part families the firmware knows how to drive, best match first.
_PRIMARY_ORDER = (
    "led", "rgb-led", "pushbutton", "pushbutton-6mm", "buzzer", "servo",
    "hc-sr04", "dht22", "ssd1306-i2c-4pin", "ssd1306", "lcd1602-i2c",
    "lcd2004-i2c", "neopixel", "neopixel-matrix", "led-ring", "7segment",
    "potentiometer", "slide-potentiometer", "analog-joystick",
    "photoresistor-sensor", "ntc-temperature-sensor", "flame-sensor",
    "gas-sensor", "small-sound-sensor", "big-sound-sensor",
    "slide-switch", "tilt-switch", "pir-motion-sensor", "rotary-dialer",
)


# Plain English a person writes that is neither a catalog id nor a tag. Kept
# explicit and tiny; every target is verified against the catalog (a bad id
# must fail in tests, not silently produce a blank canvas).
_ALIASES = {
    "button": "pushbutton",
    "buttons": "pushbutton",
    "switch": "slide-switch",
    "switches": "slide-switch",
    "pot": "potentiometer",
    "trimmer": "potentiometer",
    "ldr": "photoresistor-sensor",
    "light sensor": "photoresistor-sensor",
    "distance sensor": "hc-sr04",
    "ultrasonic": "hc-sr04",
    "ultrasonic sensor": "hc-sr04",
    "temp sensor": "dht22",
    "temperature sensor": "dht22",
    "humidity sensor": "dht22",
    "oled": "ssd1306-i2c-4pin",
    "oled display": "ssd1306-i2c-4pin",
    "lcd": "lcd1602",
    "lcd display": "lcd1602",
    "seven segment": "7segment",
    "seven segment display": "7segment",
    "7-segment": "7segment",
    "led strip": "neopixel",
    "ws2812": "neopixel",
    "servo motor": "servo",
    "motor driver": "motor-driver-l293d",
    "ir receiver": "ir-receiver",
    "motion sensor": "pir-motion-sensor",
    "rgb": "rgb-led",
}


def wireable(spec) -> bool:
    """True when the catalog's own wiring data names pins this part has.

    A few catalog entries carry rules for pins the part does not have (the
    I2C LCD's VCC/GND/SDA/SCL against a 16-pin HD44780 header). Placing one
    would produce a part on the canvas with no wires at all, so the planner
    treats the part as unplaceable and says why instead.
    """
    pins = set(spec.pins)
    for pin in spec.power:
        if pin in pins:
            return True
    for bus in spec.buses:
        if any(pin in pins for pin in bus.pins):
            return True
    return any(pin in pins for pin in spec.signals)


@lru_cache(maxsize=1)
def _phrases() -> tuple[tuple[str, str], ...]:
    """(phrase, part id) for every id and unambiguous tag, longest first."""
    owners: dict[str, list[str]] = {}
    for spec in catalog.PLACEABLE.values():
        # A part the planner will refuse still matches its own name: "a stepper
        # motor" earns an explanation about the driver it needs, not the
        # generic "say what you want" answer.
        if not wireable(spec) and not spec.external_driver:
            continue
        keys = [spec.id, *spec.tags,
                *(alias for alias, target in _ALIASES.items() if target == spec.id)]
        for key in keys:
            owners.setdefault(key.lower(), []).append(spec.id)
    pairs = []
    for phrase, ids in owners.items():
        if not phrase or len(phrase) < 2:
            continue
        # An id always means itself — checked before the stop list, so
        # "resistor" is the generic resistor rather than a preset.
        exact = catalog.PARTS.get(phrase)
        if exact is not None and exact.placeable:
            pairs.append((phrase, phrase))
            continue
        if phrase in _STOP_PHRASES:
            # A category or an interface, not a part: "serial" is a GPS tag,
            # and a request for a distance sensor over serial must not drag a
            # GPS module onto the canvas.
            continue
        # A tag shared by several parts ("led" → led, rgb-led, led-ring; "oled"
        # → both SSD1306s) resolves to the first owner the preference list
        # names, so a plain word still builds the plain thing.
        preferred = next((pid for pid in _PRIMARY_ORDER if pid in set(ids)), None)
        if preferred is not None:
            pairs.append((phrase, preferred))
        elif len(set(ids)) == 1:
            pairs.append((phrase, ids[0]))
    pairs.sort(key=lambda pair: (-len(pair[0]), pair[0]))
    return tuple(pairs)


def _count_before(prompt: str, start: int) -> int:
    """'3 leds' / 'two buttons' → 3 / 2. Defaults to one."""
    window = prompt[max(0, start - 24):start]
    match = re.search(r"(\d+|" + "|".join(_NUMBER_WORDS) + r")\s+(?:x\s+)?$", window)
    if not match:
        return 1
    token = match.group(1)
    value = int(token) if token.isdigit() else _NUMBER_WORDS[token]
    return value if 1 <= value <= 8 else 1


def wanted_parts(prompt: str) -> list[tuple[str, int]]:
    """Parts the prompt asks for, in the order they were mentioned.

    Longest phrase first, and a matched span is consumed, so "rgb led" is one
    RGB LED rather than an RGB LED plus a plain LED.
    """
    text = prompt.lower()
    taken: list[tuple[int, int]] = []
    found: dict[str, int] = {}
    order: list[str] = []
    # Parts with no wiring rules in the catalog (the preset passives) are not
    # matchable by tag, but naming one explicitly earns an explanation of why
    # it was not placed instead of the generic "say what you want" answer.
    explicit: list[tuple[str, int, int]] = []
    for spec in catalog.PLACEABLE.values():
        if wireable(spec):
            continue
        for match in re.finditer(r"(?<![a-z0-9])" + re.escape(spec.id) + r"(?![a-z0-9])", text):
            explicit.append((spec.id, *match.span()))
    for phrase, part_id in sorted(_phrases(), key=lambda pair: (-len(pair[0]), pair[0])):
        # Plural tolerance: "3 leds", "two buttons", "2 switches".
        pattern = r"(?<![a-z0-9])" + re.escape(phrase) + r"(?:e?s)?(?![a-z0-9])"
        for match in re.finditer(pattern, text):
            span = match.span()
            if any(span[0] < end and start < span[1] for start, end in taken):
                continue
            taken.append(span)
            count = _count_before(text, span[0])
            if part_id not in found:
                order.append(part_id)
                found[part_id] = count
            else:
                found[part_id] = min(8, found[part_id] + count)
    for part_id, start, end in explicit:
        if any(start < end_ and start_ < end for start_, end_ in taken):
            continue
        taken.append((start, end))
        if part_id not in found:
            order.append(part_id)
            found[part_id] = 1
    return [(part_id, found[part_id]) for part_id in order]


# Board names people actually type, where the catalog's label carries extra
# words ("Raspberry Pi 4 Model B") that stop a substring match from working.
_BOARD_ALIASES_EXTRA = {
    "raspberry pi 4": "raspberry-pi-4",
    "raspberry pi 3": "raspberry-pi-3",
    "raspberry pi 2": "raspberry-pi-2",
    "raspberry pi zero": "raspberry-pi-zero",
    "pi zero": "raspberry-pi-zero",
    "pi 4": "raspberry-pi-4",
    "pi 3": "raspberry-pi-3",
    "raspberry pi": "raspberry-pi-4",
    "arduino uno": "arduino-uno",
    "uno r3": "arduino-uno",
    "mega 2560": "arduino-mega",
    "nano": "arduino-nano",
}


@lru_cache(maxsize=1)
def _board_aliases() -> tuple[tuple[str, str], ...]:
    pairs: list[tuple[str, str]] = []
    for board_id, spec in catalog.BOARDS.items():
        for alias in (board_id, str(spec.get("label", "")).lower(), *spec.get("tags", [])):
            alias = str(alias).strip().lower()
            if len(alias) >= 3:
                pairs.append((alias, board_id))
    for alias, board_id in _BOARD_ALIASES_EXTRA.items():
        if board_id in catalog.BOARDS:
            pairs.append((alias, board_id))
    pairs.sort(key=lambda pair: (-len(pair[0]), pair[0]))
    return tuple(pairs)


def board_kind(request) -> str:
    """The board this request means: named, else inferred, else the current one."""
    text = request.prompt.lower()
    for alias, board_id in _board_aliases():
        if re.search(r"(?<![a-z0-9])" + re.escape(alias) + r"(?![a-z0-9])", text):
            return board_id
    inferred = catalog.infer_board_kind(request.prompt)
    if inferred != catalog.DEFAULT_BOARD:
        return inferred
    if request.project.board is not None:
        return request.project.board.boardKind
    return catalog.DEFAULT_BOARD


# --------------------------------------------------------------------------
# design assembly
# --------------------------------------------------------------------------

def _sort_key(pin: str) -> tuple[int, str]:
    text = str(pin)
    return (0, f"{int(text):04d}") if text.isdigit() else (1, text.upper())


# Preferred values, smallest first. The generic `resistor` part carries its
# ohms in the `value` property — the preset ids (resistor-220, …) are the same
# thing pre-filled, but the electrical gate for a series resistor matches the
# generic part, so that is the one the planner places.
_RESISTANCE_VALUES = (220, 330, 470, 1000, 2200, 4700, 10000, 47000, 100000, 1000000)


def _resistor_for(min_ohms: float) -> int:
    for ohms in _RESISTANCE_VALUES:
        if ohms >= min_ohms:
            return ohms
    return _RESISTANCE_VALUES[-1]


class _Allocator:
    """Hands out free board pins, capability first, never twice."""

    def __init__(self, kind: str, used: set[str]):
        self.kind = kind
        self.used = {str(pin) for pin in used}
        caps = catalog.board_capabilities(kind)
        self.pools: dict[str, list[str]] = {
            "pwm": [str(p) for p in caps.get("pwm", [])],
            "analog": [str(p) for p in caps.get("analog", [])],
            "i2c-sda": [str(caps.get("i2c", {}).get("SDA", ""))],
            "i2c-scl": [str(caps.get("i2c", {}).get("SCL", ""))],
            "spi-sck": [str(caps.get("spi", {}).get("SCK", ""))],
            "spi-mosi": [str(caps.get("spi", {}).get("MOSI", ""))],
            "spi-miso": [str(caps.get("spi", {}).get("MISO", ""))],
            "uart-tx": [str(caps.get("uart", {}).get("TX", ""))],
            "uart-rx": [str(caps.get("uart", {}).get("RX", ""))],
        }
        power = catalog.board_power_pins(kind)
        self.digital = sorted(
            (p for p in catalog.board_pins(kind)
             if p not in power and p not in {"0", "1"} and not str(p).startswith("A")),
            key=_sort_key,
        ) + [p for p in catalog.board_pins(kind) if str(p).startswith("A")]

    def _candidates(self, cap: str) -> list[str]:
        if cap == "pwm":
            return self.pools["pwm"] + self.digital
        if cap == "analog":
            return self.pools["analog"] + self.digital
        if cap.startswith(("i2c-", "spi-", "uart-")):
            return [p for p in self.pools.get(cap, []) if p]
        return self.digital

    def take(self, cap: str) -> str:
        cap = "gpio" if cap in (catalog.ANY_CAPABILITY, "", None) else cap
        for pin in self._candidates(cap):
            if pin and pin not in self.used and catalog.satisfies(pin, cap, self.kind):
                self.used.add(pin)
                return pin
        raise PlannerError(
            f"This board has no free pin left for a {cap} connection "
            f"(used: {', '.join(sorted(self.used, key=_sort_key)) or 'none'})."
        )


class PlannerError(Exception):
    """A request the offline planner cannot build honestly."""


@dataclass
class _Design:
    kind: str
    board_id: str
    board: Board
    alloc: _Allocator
    existing_ids: set[str]
    parts: list[Part] = field(default_factory=list)
    wires: list[Connection] = field(default_factory=list)
    # part id -> {part pin: board pin}, the firmware's pin map
    signals: dict[str, dict[str, str]] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)
    counters: dict[str, int] = field(default_factory=dict)

    def new_id(self, base: str) -> str:
        index = self.counters.get(base, 0) + 1
        while f"{base}{index}" in self.existing_ids:
            index += 1
        self.counters[base] = index
        part_id = f"{base}{index}"
        self.existing_ids.add(part_id)
        return part_id

    def wire_id(self) -> str:
        index = len(self.wires) + 1
        while f"w{index}" in self.existing_ids:
            index += 1
        self.existing_ids.add(f"w{index}")
        return f"w{index}"

    def connect(self, a: tuple[str, str], b: tuple[str, str], color: str) -> None:
        if len(self.wires) >= MAX_WIRES:
            raise PlannerError("This design needs more than 100 wires.")
        self.wires.append(Connection(
            id=self.wire_id(),
            start=Endpoint(componentId=a[0], pinName=a[1]),
            end=Endpoint(componentId=b[0], pinName=b[1]),
            color=color,
        ))

    def supply_pin(self) -> str:
        supply, _ = catalog.power_rails(self.kind)
        for name in ("5V", "3V3", "3.3V", "VBUS", "VSYS", "VIN"):
            if name in supply:
                return name
        return sorted(supply)[0]

    def ground_pin(self) -> str:
        _, ground = catalog.power_rails(self.kind)
        return "GND.1" if "GND.1" in ground else sorted(ground)[0]


def _place(index: int) -> tuple[float, float]:
    return (240 + (index % 5) * 150, 200 + (index // 5) * 130)


def _add_part(design: _Design, meta_id: str, count: int) -> list[Part]:
    spec = catalog.get(meta_id)
    if spec is None or not spec.placeable:
        raise PlannerError(f"{meta_id} is not a part the canvas can place.")
    if spec.external_driver:
        # "a stepper motor" — the honest answer names the missing driver, which
        # is more useful than a part sitting unconnected on the canvas.
        design.notes.append(
            f"{spec.name}: not added — {spec.external_driver.get('why', 'it needs an external driver')} "
            f"(pins {', '.join(spec.external_driver.get('pins', []))})."
        )
        return []
    if not wireable(spec):
        design.notes.append(
            f"{spec.name}: not added — the catalog has no wiring rules for its pins "
            f"({', '.join(spec.pins[:8])}), so it would sit on the canvas unconnected. "
            f"Place it by hand from the component list instead."
        )
        return []
    added: list[Part] = []
    for _ in range(max(1, count)):
        if len(design.parts) >= MAX_PARTS:
            raise PlannerError("The design would exceed 40 parts.")
        properties = {key: value for key, value in spec.defaults.items()
                      if key in spec.properties and key != "rotation"}
        part = Part(id=design.new_id(_id_base(meta_id)), metadataId=meta_id,
                    x=_place(len(design.parts))[0], y=_place(len(design.parts))[1],
                    properties=properties)
        design.parts.append(part)
        added.append(part)
        _wire_part(design, part, spec)
    return added


def _id_base(meta_id: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "", meta_id.lower())[:10] or "part"
    return base if base[0].isalpha() else "p" + base


# A part that declares a generic ("any") signal but is driven with analogWrite
# still needs a PWM-capable pin: the RGB LED's three channels are the case in
# the catalog today.
_CAP_OVERRIDES = {("rgb-led", "R"): "pwm", ("rgb-led", "G"): "pwm", ("rgb-led", "B"): "pwm"}


def _signal_cap(spec, pin: str) -> str:
    override = _CAP_OVERRIDES.get((spec.id, pin))
    if override:
        return override
    signal = spec.signals.get(pin)
    cap = getattr(signal, "cap", catalog.ANY_CAPABILITY) or catalog.ANY_CAPABILITY
    return "gpio" if cap == catalog.ANY_CAPABILITY else cap


def _series_for(spec, pin: str) -> float | None:
    rule = spec.series_resistor or {}
    if pin not in (rule.get("pins") or []):
        return None
    return float(rule.get("min", 220) or 220)


def _wire_part(design: _Design, part: Part, spec) -> None:
    board = design.board_id
    design.signals.setdefault(part.id, {})
    supply, ground = _ROLE_COLOR["supply"], _ROLE_COLOR["ground"]

    for pin, role in spec.power.items():
        if pin not in part.pins:
            continue
        target = design.supply_pin() if role == "supply" else design.ground_pin()
        design.connect((part.id, pin), (board, target), supply if role == "supply" else ground)

    for bus in spec.buses_for(part.properties):
        for pin, cap in bus.pins.items():
            if pin not in part.pins:
                continue
            board_pin = design.alloc.take(cap)
            design.connect((part.id, pin), (board, board_pin), _signal_color(cap))
            design.signals[part.id][pin] = board_pin

    for pin, signal in spec.signals.items():
        if pin not in part.pins or getattr(signal, "optional", False):
            continue
        if pin in design.signals[part.id]:
            continue
        cap = _signal_cap(spec, pin)
        board_pin = design.alloc.take(cap)
        minimum = _series_for(spec, pin)
        if minimum is not None:
            resistor = _add_series_resistor(design, minimum)
            design.connect((board, board_pin), (resistor.id, "1"), _signal_color(cap))
            design.connect((resistor.id, "2"), (part.id, pin), _signal_color(cap))
        elif spec.gate_resistor:
            resistor = _add_series_resistor(design, float(spec.gate_resistor.get("min", 1000)))
            design.connect((board, board_pin), (resistor.id, "1"), _signal_color(cap))
            design.connect((resistor.id, "2"), (part.id, pin), _signal_color(cap))
        else:
            design.connect((part.id, pin), (board, board_pin), _signal_color(cap))
        design.signals[part.id][pin] = board_pin


def _add_series_resistor(design: _Design, minimum: float) -> Part:
    ohms = _resistor_for(minimum)
    x, y = _place(len(design.parts))
    part = Part(id=design.new_id("r"), metadataId="resistor", x=x, y=y,
                properties={"value": str(ohms)})
    design.parts.append(part)
    return part


_ROLE_COLOR = {"supply": "#ef4444", "ground": "#1f2937"}


def _signal_color(cap: str) -> str:
    if cap.startswith("i2c"):
        return "#38bdf8"
    if cap.startswith("spi") or cap.startswith("uart"):
        return "#a78bfa"
    if cap == "pwm":
        return "#fbbf24"
    if cap == "analog":
        return "#34d399"
    return "#4ade80"


# --------------------------------------------------------------------------
# firmware
# --------------------------------------------------------------------------

HEADER = """// Written by the built-in Velxio planner (no model, no API key).
// {what}
"""


def _drivers(design: _Design) -> dict[str, str]:
    """part id -> the board pin its firmware side uses."""
    out: dict[str, str] = {}
    for part in design.parts:
        for pin, board_pin in design.signals.get(part.id, {}).items():
            if part.metadataId in {"led", "buzzer", "servo", "neopixel", "neopixel-matrix"}:
                out[part.id] = board_pin
            elif part.metadataId in {"pushbutton", "pushbutton-6mm", "slide-switch",
                                     "tilt-switch", "pir-motion-sensor"}:
                out[part.id] = board_pin
            elif "analog" in part.metadataId or pin in {"SIG", "AO", "VERT", "HORZ"}:
                out[part.id] = board_pin
            else:
                out.setdefault(part.id, board_pin)
    return out


def _serial_readiness(design: _Design, name: str) -> list[SerialExpectation]:
    return [SerialExpectation(matches=name)]


def _sketch(design: _Design) -> tuple[str, list[str], Expectations | None]:
    """Firmware for the primary part, plus what the live checks should see."""
    by_id = {part.id: part for part in design.parts}
    primary: Part | None = None
    for part_id in _PRIMARY_ORDER:
        match = next((p for p in design.parts if p.metadataId == part_id), None)
        if match is not None:
            primary = match
            break
    if primary is None:
        primary = next((p for p in design.parts if design.signals.get(p.id)), None)

    pins = _drivers(design)
    if primary is None:
        return _sketch_inert(design), ["Wired the parts; no firmware side"], None

    if design.kind and catalog.board_family(design.kind) == "python":
        raise PlannerError(
            "The built-in planner writes Arduino C++ only. Pick an Arduino, ESP32, "
            "RP2040 or STM32 board, or configure a model provider for Python targets."
        )

    builder = _SKETCHES.get(primary.metadataId)
    if builder is None:
        # An I2C part the planner has no driver for still gets useful firmware:
        # the bus scan that proves it is wired and answering.
        builder = _sketch_i2c_scan if catalog.PARTS[primary.metadataId].buses_for(primary.properties) \
            else _sketch_generic
    code, what, expect = builder(design, primary, pins)
    return code, [what], expect


def _sketch_inert(design: _Design) -> str:
    lines = [HEADER.format(what="Parts are wired for you; there is no signal for firmware to drive."),
             "void setup() {", "  Serial.begin(9600);"]
    for part in design.parts:
        lines.append(f"  // {part.metadataId} ({part.id})")
    lines += ['  Serial.println("READY");', "}", "", "void loop() {", "  delay(1000);", "}"]
    return "\n".join(lines)


def _pin_decl(design: _Design, pins: dict[str, str]) -> list[str]:
    lines = []
    for part in design.parts:
        pin = pins.get(part.id)
        if pin is None:
            continue
        name = _c_name(part.id)
        lines.append(f"const uint8_t {name}_PIN = {pin};  // {part.metadataId}")
    return lines


def _c_name(part_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]", "_", part_id).upper()


def _sketch_led(design: _Design, part: Part, pins: dict[str, str]) -> tuple[str, str, Expectations | None]:
    pin = pins[part.id]
    pwm = catalog.satisfies(pin, "pwm", design.kind)
    body = f"""{HEADER.format(what=f"Blinks the LED on pin {pin} and reports over serial.")}
const uint8_t LED_PIN = {pin};

void setup() {{
  pinMode(LED_PIN, OUTPUT);
  Serial.begin(9600);
  Serial.println("READY");
}}

void loop() {{
  digitalWrite(LED_PIN, HIGH);
  Serial.println("LED on");
  delay(500);
  digitalWrite(LED_PIN, LOW);
  Serial.println("LED off");
  delay(500);
}}"""
    if pwm:
        body = body.replace("""  digitalWrite(LED_PIN, HIGH);
  Serial.println("LED on");
  delay(500);
  digitalWrite(LED_PIN, LOW);
  Serial.println("LED off");
  delay(500);""", """  for (int level = 0; level <= 255; level += 5) {
    analogWrite(LED_PIN, level);
    delay(10);
  }
  Serial.println("LED bright");
  for (int level = 255; level >= 0; level -= 5) {
    analogWrite(LED_PIN, level);
    delay(10);
  }
  Serial.println("LED off");""")
    expectations = Expectations(
        observe_ms=4000,
        pins=[PinExpectation(pin=str(pin), expect="toggles", min_transitions=2)],
        serial=_serial_readiness(design, "LED"),
    )
    return body, f"Firmware fades/blinks the LED on pin {pin}", expectations


def _sketch_rgb(design: _Design, part: Part, pins: dict[str, str]) -> tuple[str, str, Expectations | None]:
    channels = {pin: board for pin, board in design.signals.get(part.id, {}).items()
                if pin in {"R", "G", "B"}}
    names = ", ".join(f"{pin}={board}" for pin, board in sorted(channels.items()))
    setup = "\n".join(
        f"  pinMode({board}, OUTPUT);" for _, board in sorted(channels.items())
    )
    code = f"""{HEADER.format(what=f"Colour-cycles the RGB LED ({names}).")}
{_pin_lines(channels)}

void setup() {{
{setup or "  "}
  Serial.begin(9600);
  Serial.println("READY");
}}

void loop() {{
{_rgb_steps(channels)}
}}"""
    expectations = Expectations(
        observe_ms=3000,
        pins=[PinExpectation(pin=str(board), expect="toggles", min_transitions=2)
              for _, board in sorted(channels.items())],
        serial=_serial_readiness(design, "READY"),
    )
    return code, "Firmware colour-cycles the RGB LED", expectations


def _pin_lines(channels: dict[str, str]) -> str:
    return "\n".join(
        f"const uint8_t {pin}_PIN = {board};" for pin, board in sorted(channels.items())
    )


def _rgb_steps(channels: dict[str, str]) -> str:
    """One colour at a time, so every used channel visibly toggles."""
    if not channels:
        return "  delay(500);"
    steps = []
    for lit in ("R", "G", "B"):
        for channel in sorted(channels):
            level = 255 if channel == lit else 0
            steps.append(f"  analogWrite({channel}_PIN, {level});"
                         + ("   // this colour" if channel == lit else ""))
        steps.append("  delay(400);")
    return "\n".join(steps)


def _sketch_buzzer(design: _Design, part: Part, pins: dict[str, str]) -> tuple[str, str, Expectations | None]:
    pin = pins[part.id]
    code = f"""{HEADER.format(what=f"Plays a scale on the buzzer on pin {pin}.")}
const uint8_t BUZZER_PIN = {pin};
const int NOTES[] = {{262, 294, 330, 349, 392, 440, 494, 523}};

void setup() {{
  pinMode(BUZZER_PIN, OUTPUT);
  Serial.begin(9600);
  Serial.println("READY");
}}

void loop() {{
  for (int i = 0; i < 8; i++) {{
    tone(BUZZER_PIN, NOTES[i], 220);
    delay(260);
  }}
  noTone(BUZZER_PIN);
  Serial.println("Scale played");
  delay(800);
}}"""
    expectations = Expectations(
        observe_ms=4000,
        pins=[PinExpectation(pin=str(pin), expect="toggles", min_transitions=2)],
        serial=_serial_readiness(design, "READY"),
    )
    return code, f"Firmware plays a scale on pin {pin}", expectations


def _sketch_button(design: _Design, part: Part, pins: dict[str, str]) -> tuple[str, str, Expectations | None]:
    button_pin = pins[part.id]
    leds = [p for p in design.parts if p.metadataId == "led" and pins.get(p.id)]
    led_pin = pins[leds[0].id] if leds else None
    led_decl = f"const uint8_t LED_PIN = {led_pin};\n" if led_pin else ""
    led_setup = "  pinMode(LED_PIN, OUTPUT);\n" if led_pin else ""
    led_loop = """
  digitalWrite(LED_PIN, pressed ? LOW : HIGH);""" if led_pin else ""
    code = f"""{HEADER.format(what=f"Reads the button on pin {button_pin} (INPUT_PULLUP) and reports it over serial.{' Drives the LED too.' if led_pin else ''}")}
const uint8_t BUTTON_PIN = {button_pin};
{led_decl}
void setup() {{
  pinMode(BUTTON_PIN, INPUT_PULLUP);
{led_setup}  Serial.begin(9600);
  Serial.println("READY");
}}

void loop() {{
  bool pressed = digitalRead(BUTTON_PIN) == LOW;{led_loop}
  Serial.println(pressed ? "pressed" : "released");
  delay(100);
}}"""
    expectations = Expectations(
        observe_ms=3000,
        serial=_serial_readiness(design, "READY"),
    )
    return code, f"Firmware reads the button on pin {button_pin} and reports it", expectations


def _sketch_servo(design: _Design, part: Part, pins: dict[str, str]) -> tuple[str, str, Expectations | None]:
    pin = pins[part.id]
    code = f"""{HEADER.format(what=f"Sweeps the servo on pin {pin}.")}
#include <Servo.h>

Servo arm;
const uint8_t SERVO_PIN = {pin};

void setup() {{
  arm.attach(SERVO_PIN);
  Serial.begin(9600);
  Serial.println("READY");
}}

void loop() {{
  for (int angle = 0; angle <= 180; angle += 5) {{
    arm.write(angle);
    delay(20);
  }}
  for (int angle = 180; angle >= 0; angle -= 5) {{
    arm.write(angle);
    delay(20);
  }}
  Serial.println("Swept 0-180-0");
}}"""
    expectations = Expectations(
        observe_ms=4000,
        pins=[PinExpectation(pin=str(pin), expect="toggles", min_transitions=2)],
        serial=_serial_readiness(design, "READY"),
    )
    return code, f"Firmware sweeps the servo on pin {pin}", expectations


def _analog_targets(design: _Design, pins: dict[str, str]) -> list[tuple[str, str]]:
    analog_ids = {"potentiometer", "slide-potentiometer", "photoresistor-sensor",
                  "ntc-temperature-sensor", "flame-sensor", "gas-sensor",
                  "small-sound-sensor", "big-sound-sensor", "analog-joystick"}
    out = []
    for part in design.parts:
        if part.metadataId not in analog_ids:
            continue
        for pin, board_pin in design.signals.get(part.id, {}).items():
            cap = _signal_cap(catalog.PARTS[part.metadataId], pin)
            if cap == "analog" and board_pin not in {p for _, p in out}:
                out.append((part.id, board_pin))
    return out


def _sketch_analog(design: _Design, part: Part, pins: dict[str, str]) -> tuple[str, str, Expectations | None]:
    targets = _analog_targets(design, pins) or [(part.id, pins[part.id])]
    decls = "\n".join(f"const uint8_t {_c_name(pid)}_PIN = {pin};" for pid, pin in targets)
    reads = "\n".join(
        f'  Serial.print(" {pid}="); Serial.print(analogRead({_c_name(pid)}_PIN));' for pid, _ in targets
    )
    setup = "\n".join(f"  pinMode({_c_name(pid)}_PIN, INPUT);" for pid, _ in targets)
    code = f"""{HEADER.format(what="Reads every analog input and prints it over serial (9600 baud).")}
{decls}

void setup() {{
{setup}
  Serial.begin(9600);
  Serial.println("READY");
}}

void loop() {{
  Serial.print("analog:");{reads}
  Serial.println();
  delay(250);
}}"""
    expectations = Expectations(observe_ms=3000, serial=_serial_readiness(design, "analog:"))
    return code, "Firmware reads the analog inputs and prints them", expectations


def _sketch_dht(design: _Design, part: Part, pins: dict[str, str]) -> tuple[str, str, Expectations | None]:
    pin = pins[part.id]
    code = f"""{HEADER.format(what=f"Reads the DHT22 on pin {pin} every 2 seconds.")}
#if __has_include(<DHT.h>)
#include <DHT.h>
#define HAVE_DHT 1
#else
#define HAVE_DHT 0
#endif

const uint8_t DHT_PIN = {pin};
#if HAVE_DHT
DHT sensor(DHT_PIN, DHT22);
#endif

void setup() {{
  Serial.begin(9600);
#if HAVE_DHT
  sensor.begin();
#else
  // Install "DHT sensor library" in Library Manager to read real values.
#endif
  Serial.println("READY");
}}

void loop() {{
#if HAVE_DHT
  float temperature = sensor.readTemperature();
  float humidity = sensor.readHumidity();
  Serial.print("temperature="); Serial.print(temperature);
  Serial.print(" humidity="); Serial.println(humidity);
#else
  (void)DHT_PIN;
  Serial.println("DHT library not installed; sensor is wired and waiting");
#endif
  delay(2000);
}}"""
    expectations = Expectations(observe_ms=3000, serial=_serial_readiness(design, "READY"))
    return code, f"Firmware reads the DHT22 on pin {pin}", expectations


def _sketch_ultrasonic(design: _Design, part: Part, pins: dict[str, str]) -> tuple[str, str, Expectations | None]:
    trig = design.signals.get(part.id, {}).get("TRIG", "")
    echo = design.signals.get(part.id, {}).get("ECHO", "")
    code = f"""{HEADER.format(what=f"HC-SR04: trigger {trig}, echo {echo}. Prints distance in cm.")}
const uint8_t TRIG_PIN = {trig or 0};
const uint8_t ECHO_PIN = {echo or 0};

void setup() {{
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  Serial.begin(9600);
  Serial.println("READY");
}}

void loop() {{
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  unsigned long duration = pulseIn(ECHO_PIN, HIGH, 30000UL);
  float cm = duration / 58.0;
  Serial.print("distance_cm=");
  Serial.println(cm, 1);
  delay(250);
}}"""
    expectations = Expectations(
        observe_ms=3000,
        pins=[PinExpectation(pin=str(trig), expect="toggles", min_transitions=2)] if trig else [],
        serial=_serial_readiness(design, "READY"),
    )
    return code, "Firmware pulses the HC-SR04 and prints the distance", expectations


def _i2c_pins(design: _Design, part: Part) -> tuple[str, str]:
    spec = catalog.PARTS[part.metadataId]
    i2c = catalog.board_capabilities(design.kind).get("i2c", {})
    sda = next(iter(spec.buses_for(part.properties)[0].pins.items())) if spec.buses_for(part.properties) else None
    mapped = design.signals.get(part.id, {})
    sda_pin = mapped.get("SDA") or mapped.get("DATA") or i2c.get("SDA", "")
    scl_pin = mapped.get("SCL") or mapped.get("CLK") or i2c.get("SCL", "")
    return str(sda_pin), str(scl_pin)


def _sketch_oled(design: _Design, part: Part, pins: dict[str, str]) -> tuple[str, str, Expectations | None]:
    code = f"""{HEADER.format(what="I2C SSD1306 OLED on the board's hardware SDA/SCL pins.")}
#include <Wire.h>
#if __has_include(<Adafruit_SSD1306.h>)
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#define HAVE_OLED 1
#else
#define HAVE_OLED 0
#endif

#if HAVE_OLED
Adafruit_SSD1306 display(128, 64, &Wire, -1);
#endif

void setup() {{
  Wire.begin();
{_i2c_pin_comment(design, part)}
  Serial.begin(9600);
#if HAVE_OLED
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {{
    Serial.println("SSD1306 not found at 0x3C");
  }} else {{
    display.clearDisplay();
    display.setTextSize(2);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 20);
    display.println("Velxio");
    display.display();
  }}
#else
  // Install Adafruit SSD1306 + Adafruit GFX to draw on the panel.
#endif
  Serial.println("READY");
}}

void loop() {{
  delay(1000);
}}"""
    expectations = Expectations(observe_ms=3000, serial=_serial_readiness(design, "READY"))
    return code, "Firmware initialises the I2C OLED", expectations


def _i2c_pin_comment(design: _Design, part: Part) -> str:
    sda, scl = _i2c_pins(design, part)
    if not sda or not scl:
        return "  // wired to the board's hardware I2C pins"
    return f"  // SDA {sda}, SCL {scl} (hardware I2C)"


def _sketch_lcd(design: _Design, part: Part, pins: dict[str, str]) -> tuple[str, str, Expectations | None]:
    code = f"""{HEADER.format(what="I2C 16x2 LCD on the board's hardware SDA/SCL pins.")}
#include <Wire.h>
#if __has_include(<LiquidCrystal_I2C.h>)
#include <LiquidCrystal_I2C.h>
#define HAVE_LCD 1
#else
#define HAVE_LCD 0
#endif

#if HAVE_LCD
LiquidCrystal_I2C lcd(0x27, 16, 2);
#endif

void setup() {{
  Wire.begin();
{_i2c_pin_comment(design, part)}
  Serial.begin(9600);
#if HAVE_LCD
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Velxio");
  lcd.setCursor(0, 1);
  lcd.print("ready");
#else
  // Install "LiquidCrystal I2C" in Library Manager to write on the LCD.
#endif
  Serial.println("READY");
}}

void loop() {{
  delay(1000);
}}"""
    expectations = Expectations(observe_ms=3000, serial=_serial_readiness(design, "READY"))
    return code, "Firmware initialises the I2C LCD", expectations


def _sketch_lcd_parallel(design: _Design, part: Part, pins: dict[str, str]) -> tuple[str, str, Expectations | None]:
    """16x2 / 20x4 HD44780 in 4-bit mode, using the pins the bus wired."""
    mapping = design.signals.get(part.id, {})
    columns = 20 if "2004" in part.metadataId else 16
    names = {}
    for pin in ("RS", "E", "D4", "D5", "D6", "D7"):
        if pin in mapping:
            names[pin] = str(mapping[pin])
    decls = "\n".join(f"const uint8_t {pin}_PIN = {board};" for pin, board in names.items())
    ctor = ", ".join(f"{pin}_PIN" for pin in ("RS", "E", "D4", "D5", "D6", "D7") if pin in names)
    code = f"""{HEADER.format(what="Parallel HD44780 LCD in 4-bit mode.")}
#include <LiquidCrystal.h>

{decls}
LiquidCrystal lcd({ctor});

void setup() {{
  lcd.begin({columns}, 2);
  lcd.print("Velxio");
  Serial.begin(9600);
  Serial.println("READY");
}}

void loop() {{
  lcd.setCursor(0, 1);
  lcd.print(millis() / 1000);
  lcd.print("s   ");
  delay(1000);
}}"""
    expectations = Expectations(observe_ms=3000, serial=_serial_readiness(design, "READY"))
    return code, "Firmware drives the parallel LCD", expectations


def _sketch_neopixel(design: _Design, part: Part, pins: dict[str, str]) -> tuple[str, str, Expectations | None]:
    pin = pins[part.id]
    count = int(part.properties.get("numLeds", 1) or 1) if "numLeds" in catalog.PARTS[part.metadataId].properties else 1
    count = max(1, min(60, count))
    code = f"""{HEADER.format(what=f"Drives the WS2812 data line on pin {pin}.")}
#if __has_include(<Adafruit_NeoPixel.h>)
#include <Adafruit_NeoPixel.h>
#define HAVE_LEDS 1
#else
#define HAVE_LEDS 0
#endif

const uint8_t DATA_PIN = {pin};
const uint16_t LED_COUNT = {count};

#if HAVE_LEDS
Adafruit_NeoPixel strip(LED_COUNT, DATA_PIN, NEO_GRB + NEO_KHZ800);
#endif

void setup() {{
  Serial.begin(9600);
#if HAVE_LEDS
  strip.begin();
  strip.show();
#else
  pinMode(DATA_PIN, OUTPUT);
#endif
  Serial.println("READY");
}}

void loop() {{
#if HAVE_LEDS
  for (int i = 0; i < LED_COUNT; i++) {{
    strip.setPixelColor(i, strip.Color(0, 120, 255));
  }}
  strip.show();
  delay(600);
  for (int i = 0; i < LED_COUNT; i++) {{
    strip.setPixelColor(i, strip.Color(0, 0, 0));
  }}
  strip.show();
  delay(600);
#else
  digitalWrite(DATA_PIN, HIGH);
  delay(500);
  digitalWrite(DATA_PIN, LOW);
  delay(500);
#endif
}}"""
    expectations = Expectations(
        observe_ms=3000,
        pins=[PinExpectation(pin=str(pin), expect="toggles", min_transitions=2)],
        serial=_serial_readiness(design, "READY"),
    )
    return code, f"Firmware drives the addressable LEDs on pin {pin}", expectations


_SEGMENTS = {"A": 0b0000001, "B": 0b0000010, "C": 0b0000100, "D": 0b0001000,
             "E": 0b0010000, "F": 0b0100000, "G": 0b1000000, "DP": 0b10000000}


# segment letter -> bit in the 0-F table below
_SEGMENT_BIT = {"A": 0, "B": 1, "C": 2, "D": 3, "E": 4, "F": 5, "G": 6, "DP": 7}
_DIGIT_MASK = {0: 0x3F, 1: 0x06, 2: 0x5B, 3: 0x4F, 4: 0x66,
               5: 0x6D, 6: 0x7D, 7: 0x07, 8: 0x7F, 9: 0x6F}


def _sketch_7segment(design: _Design, part: Part, pins: dict[str, str]) -> tuple[str, str, Expectations | None]:
    mapping = {seg: str(board) for seg, board in design.signals.get(part.id, {}).items()
               if seg in _SEGMENTS}
    decls = "\n".join(f"const uint8_t {seg}_PIN = {board};" for seg, board in sorted(mapping.items()))
    setup = "\n".join(f"  pinMode({seg}_PIN, OUTPUT);" for seg in sorted(mapping))
    rows = []
    for digit, mask in _DIGIT_MASK.items():
        lines = [f"  // {digit}"]
        for seg in sorted(mapping):
            level = "HIGH" if mask >> _SEGMENT_BIT[seg] & 1 else "LOW"
            lines.append(f"  digitalWrite({seg}_PIN, {level});")
        lines += [f'  Serial.println("{digit}");', "  delay(700);"]
        rows.append("\n".join(lines))
    body = "\n".join(rows)
    code = f"""{HEADER.format(what="Counts 0-9 on the 7-segment display and echoes each digit.")}

{decls}

void setup() {{
{setup}
  Serial.begin(9600);
  Serial.println("READY");
}}

void loop() {{
{body}
}}"""
    expectations = Expectations(observe_ms=3000, serial=_serial_readiness(design, "READY"))
    return code, "Firmware counts 0-9 on the 7-segment display", expectations


def _sketch_switch(design: _Design, part: Part, pins: dict[str, str]) -> tuple[str, str, Expectations | None]:
    pin = pins[part.id]
    polarity = "LOW" if part.metadataId != "pir-motion-sensor" else "HIGH"
    code = f"""{HEADER.format(what=f"Reads the {part.metadataId} on pin {pin} and reports it over serial.")}
const uint8_t INPUT_PIN = {pin};

void setup() {{
  pinMode(INPUT_PIN, {"INPUT_PULLUP" if polarity == "LOW" else "INPUT"});
  Serial.begin(9600);
  Serial.println("READY");
}}

void loop() {{
  bool active = digitalRead(INPUT_PIN) == {polarity};
  Serial.println(active ? "active" : "idle");
  delay(120);
}}"""
    expectations = Expectations(observe_ms=3000, serial=_serial_readiness(design, "READY"))
    return code, f"Firmware reads the switch/input on pin {pin}", expectations


def _sketch_i2c_scan(design: _Design, part: Part, pins: dict[str, str]) -> tuple[str, str, Expectations | None]:
    """Any I2C module without a dedicated driver gets a bus scan.

    It is the first thing anyone writes against an unknown I2C part, it needs
    only Wire.h (an Arduino core library, always present) and it proves the
    two bus wires and the pull-ups: the module's address shows up in the
    serial output.
    """
    code = f"""{HEADER.format(what=f"I2C bus scan — proves the {part.metadataId} answers at its address.")}
#include <Wire.h>

void setup() {{
  Wire.begin();
{_i2c_pin_comment(design, part)}
  Serial.begin(9600);
  Serial.println("I2C scan");
}}

void loop() {{
  for (uint8_t address = 1; address < 127; address++) {{
    Wire.beginTransmission(address);
    if (Wire.endTransmission() == 0) {{
      Serial.print("found 0x");
      Serial.println(address, HEX);
    }}
  }}
  Serial.println("scan done");
  delay(2000);
}}"""
    expectations = Expectations(observe_ms=4000, serial=_serial_readiness(design, "I2C scan"))
    return code, f"Firmware scans the I2C bus for {part.metadataId}", expectations


def _sketch_generic(design: _Design, part: Part, pins: dict[str, str]) -> tuple[str, str, Expectations | None]:
    """Everything wired, firmware toggles the digital lines and reports."""
    digital = [(pid, pin) for pid, pin in pins.items() if not str(pin).startswith("A")]
    if not digital:
        return _sketch_inert(design), "Wired the parts; no firmware side", None
    decls = "\n".join(f"const uint8_t {_c_name(pid)}_PIN = {pin};" for pid, pin in digital)
    setup = "\n".join(f"  pinMode({_c_name(pid)}_PIN, OUTPUT);" for pid, _ in digital)
    toggle = "\n".join(
        f"  digitalWrite({_c_name(pid)}_PIN, HIGH);" for pid, _ in digital
    ) + "\n  delay(500);\n" + "\n".join(
        f"  digitalWrite({_c_name(pid)}_PIN, LOW);" for pid, _ in digital
    )
    code = f"""{HEADER.format(what="Parts are wired; firmware toggles their signal pins so the wiring is testable.")}
{decls}

void setup() {{
{setup}
  Serial.begin(9600);
  Serial.println("READY");
}}

void loop() {{
{toggle}
  Serial.println("tick");
  delay(500);
}}"""
    expectations = Expectations(
        observe_ms=3000,
        pins=[PinExpectation(pin=str(pin), expect="toggles", min_transitions=2)
              for _, pin in digital[:2]],
        serial=_serial_readiness(design, "tick"),
    )
    return code, "Firmware toggles the wired signal pins", expectations


_SKETCHES = {
    "led": _sketch_led,
    "rgb-led": _sketch_rgb,
    "buzzer": _sketch_buzzer,
    "pushbutton": _sketch_button,
    "pushbutton-6mm": _sketch_button,
    "servo": _sketch_servo,
    "potentiometer": _sketch_analog,
    "slide-potentiometer": _sketch_analog,
    "analog-joystick": _sketch_analog,
    "photoresistor-sensor": _sketch_analog,
    "ntc-temperature-sensor": _sketch_analog,
    "flame-sensor": _sketch_analog,
    "gas-sensor": _sketch_analog,
    "small-sound-sensor": _sketch_analog,
    "big-sound-sensor": _sketch_analog,
    "dht22": _sketch_dht,
    "hc-sr04": _sketch_ultrasonic,
    "ssd1306": _sketch_oled,
    "ssd1306-i2c-4pin": _sketch_oled,
    "lcd1602-i2c": _sketch_lcd,
    "lcd2004-i2c": _sketch_lcd,
    "lcd1602": _sketch_lcd_parallel,
    "lcd2004": _sketch_lcd_parallel,
    "neopixel": _sketch_neopixel,
    "neopixel-matrix": _sketch_neopixel,
    "led-ring": _sketch_neopixel,
    "7segment": _sketch_7segment,
    "slide-switch": _sketch_switch,
    "tilt-switch": _sketch_switch,
    "pir-motion-sensor": _sketch_switch,
    "rotary-dialer": _sketch_switch,
}


# --------------------------------------------------------------------------
# entry points
# --------------------------------------------------------------------------

@dataclass
class _RequestView:
    prompt: str
    project: object
    mode: str


def _used_board_pins(project) -> set[str]:
    used: set[str] = set()
    board_id = project.board.id if project.board else catalog.DEFAULT_BOARD
    for wire in project.wires:
        for endpoint in (wire.start, wire.end):
            if endpoint.componentId == board_id:
                used.add(str(endpoint.pinName))
    return used


_QUESTION_OPENERS = (
    "what", "whats", "what's", "which", "how", "why", "who", "when", "where",
    "is ", "are ", "can ", "could ", "should ", "does ", "do ", "explain",
    "tell me", "describe", "difference between",
)

_BUILD_VERBS = (
    "add", "wire", "build", "connect", "make", "create", "set up", "setup",
    "hook up", "give me", "i want", "i need", "blink", "flash", "read",
    "display", "control", "drive", "sweep", "play", "count", "toggle", "scan",
    "sense", "detect", "measure", "turn on", "light up", "fade", "dim", "test",
)


def _is_question(prompt: str) -> bool:
    """True when the prompt asks about something rather than asking for it.

    "tell me about the MPU6050" and "what can you do?" must not silently build
    a circuit; "read a sensor" is a build request even though it says "read".
    """
    text = prompt.lower().strip()
    if not any(text.startswith(opener) for opener in _QUESTION_OPENERS) and "?" not in text:
        return False
    return not any(verb in text for verb in _BUILD_VERBS)


def _explain(request) -> Proposal:
    text = request.prompt.lower()
    mentioned = wanted_parts(request.prompt)
    if mentioned:
        spec = catalog.PARTS[mentioned[0][0]]
        lines = [f"{spec.name}: {spec.notes or spec.description or 'in the catalog.'}"]
        if spec.pins:
            lines.append("Pins: " + ", ".join(spec.pins))
        if spec.libraries:
            lines.append("Needs: " + ", ".join(spec.libraries))
        return Proposal(summary="\n\n".join(lines), plan=["Answered from the catalog"])
    return Proposal(
        summary=(
            "I can build a circuit without a model provider. Say what you want in plain words "
            "and I will place the parts, wire them and write the firmware — for example "
            "\"blink an LED on pin 8\", \"button and LED\", \"read a potentiometer on A0', "
            "\"HC-SR04 distance over serial\", \"DHT22 on pin 2\", \"sweep a servo\", "
            "\"NeoPixel strip on pin 6\" or \"I2C OLED\".\n\n"
            "You can also name any of the 157 catalog components and I will wire it, though the "
            "built-in firmware covers the common parts; for anything else, add a provider key in "
            "Agent settings and the model takes over."
        ),
        plan=["Explained what the built-in planner can build"],
    )


def _sketch_name(project) -> tuple[str, str]:
    """(file to write, warning or '').

    Arduino compiles every .ino in the sketch folder, so adding a second file
    with its own setup()/loop() would not build. The project's own sketch is
    rewritten instead — that is what "blink an LED" means on a canvas that
    already has code.
    """
    sketches = [f.name for f in project.files if f.name.endswith((".ino", ".cpp"))]
    if not sketches:
        return "sketch.ino", ""
    if len(sketches) == 1:
        return sketches[0], ""
    return sketches[0], (
        f"Rewrote {sketches[0]} and left {', '.join(sketches[1:])} alone — if one of those also "
        f"defines setup()/loop() the build will report it and you can delete the extra file."
    )


def plan(request) -> Proposal:
    """A Proposal for this request, built with no network and no credentials."""
    # Chat mode is for questions; a question in agent mode is still a question.
    if request.mode == "chat" or _is_question(request.prompt):
        return _explain(request)

    wanted = wanted_parts(request.prompt)
    if not wanted:
        return _explain(request)

    kind = board_kind(request)
    if catalog.board_family(kind) == "python":
        raise PlannerError(
            f"{catalog.BOARDS[kind]['label']} runs Python, and the built-in planner writes Arduino "
            "C++ only. Choose an Arduino/ESP32/RP2040/STM32 board, or configure a model provider."
        )

    project = request.project
    board_id = project.board.id if project.board else kind
    design = _Design(
        kind=kind,
        board_id=board_id,
        board=Board(id=board_id, boardKind=kind,
                    x=project.board.x if project.board else 100,
                    y=project.board.y if project.board else 120),
        alloc=_Allocator(kind, _used_board_pins(project)),
        existing_ids={p.id for p in project.components} | {w.id for w in project.wires}
        | ({board_id} if project.board else set()),
    )

    for part_id, count in wanted:
        _add_part(design, part_id, count)

    if not design.parts:
        # Every requested part was unplaceable (a bare stepper coil, a relay).
        # An honest answer naming the missing driver is worth more than a
        # blank canvas with an empty sketch on it.
        detail = " ".join(design.notes) or f"Nothing in {request.prompt!r} maps to a placeable part."
        raise PlannerError(detail)

    code, plans, expectations = _sketch(design) if design.parts else (
        _sketch_inert(design), ["Nothing to drive"], None
    )
    sketch_file, sketch_warning = _sketch_name(project)
    if sketch_warning:
        design.notes.append(sketch_warning)

    summary_lines = [
        f"Built this on {catalog.BOARDS[kind]['label']} (no model provider needed — this is the "
        f"built-in planner):",
        "",
        *[f"- {part.metadataId} ({part.id})" for part in design.parts],
        "",
        plans[0] + ".",
    ]
    if design.notes:
        summary_lines += ["", *design.notes]
    summary_lines += [
        "",
        "It still goes through the normal gates: the patch is validated, compiled on the server "
        "and checked against the live simulation before anything is applied.",
    ]

    patch = Patch(
        board=design.board if project.board is None or project.board.boardKind != kind else None,
        upsert_components=design.parts,
        upsert_wires=design.wires,
        upsert_files=[Source(name=sketch_file, content=code)],
    )
    return Proposal(summary="\n".join(summary_lines)[:5000],
                    plan=plans[:8], patch=patch, expectations=expectations)
