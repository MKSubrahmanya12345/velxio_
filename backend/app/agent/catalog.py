"""The component catalog: one description of every part, loaded from JSON.

`catalog.json` is GENERATED (scripts/generate-agent-catalog.mjs) from the
frontend's own component metadata, a measured pin map and a hand-authored rule
file, so the model, the validator, the MCP surface and the browser all describe
the same 157 parts. Nothing in this module is hand-maintained per part.

What a spec carries (see scripts/agent-part-rules.json for the vocabulary):
pins (plus property-driven variants), editable properties, whether the part can
be placed, whether the canvas can simulate it, and the wiring rules the static
analysis enforces (power rails, required signal pins and their capabilities,
bus alternatives, series/gate resistors, self-shorting pins, external drivers).
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable, Iterator

_CATALOG_PATH = Path(__file__).with_name("catalog.json")
_CATALOG: dict[str, Any] = json.loads(_CATALOG_PATH.read_text(encoding="utf-8"))

VERSION: int = int(_CATALOG.get("version", 1))
BOARDS: dict[str, dict] = _CATALOG["boards"]
DEFAULT_BOARD = "arduino-uno"
SEVERITY: dict[str, str] = _CATALOG.get("severity", {})

# Capabilities that mean "any board pin will do".
ANY_CAPABILITY = "any"


@dataclass(frozen=True)
class Signal:
    pin: str
    cap: str = ANY_CAPABILITY
    direction: str = "bidir"
    optional: bool = False
    severity: str | None = None


@dataclass(frozen=True)
class BusAlternative:
    type: str
    pins: dict[str, str]
    optional: bool = False
    when: dict[str, Any] = field(default_factory=dict)

    def applies(self, properties: dict[str, Any] | None) -> bool:
        properties = properties or {}
        return all(str(properties.get(k, "")) == str(v) for k, v in self.when.items())


@dataclass(frozen=True)
class PartSpec:
    id: str
    name: str
    tag: str
    category: str
    cls: str
    pins: tuple[str, ...]
    properties: tuple[str, ...]
    defaults: dict[str, Any]
    placeable: bool
    sim: bool
    tags: tuple[str, ...]
    notes: str | None = None
    description: str | None = None
    why: str | None = None
    power: dict[str, str] = field(default_factory=dict)
    signals: dict[str, Signal] = field(default_factory=dict)
    buses: tuple[BusAlternative, ...] = ()
    power_out: tuple[str, ...] = ()
    source_pins: tuple[str, ...] = ()
    self_short: tuple[tuple[str, str], ...] = ()
    internal_pairs: tuple[tuple[str, str], ...] = ()
    trace_pairs: tuple[tuple[str, str], ...] = ()
    series_resistor: dict[str, Any] | None = None
    gate_resistor: dict[str, Any] | None = None
    external_driver: dict[str, Any] | None = None
    address_property: str | None = None
    interactions: tuple[str, ...] = ()
    stimulus_keys: tuple[str, ...] = ()
    rotary: dict[str, str] | None = None
    pot_pins: tuple[str, ...] = ()
    pin_variants: tuple[dict[str, Any], ...] = ()
    libraries: tuple[str, ...] = ()

    def buses_for(self, properties: dict[str, Any] | None = None) -> tuple[BusAlternative, ...]:
        return tuple(bus for bus in self.buses if bus.applies(properties))

    def pins_for(self, properties: dict[str, Any] | None = None) -> tuple[str, ...]:
        """Pins for this part with a given property set (7segment digits=4 …)."""
        properties = properties or {}
        for variant in self.pin_variants:
            when = variant.get("when", {})
            if all(str(properties.get(k, "")) == str(v) for k, v in when.items()):
                return tuple(variant["pins"])
        return self.pins

    def as_dict(self) -> dict[str, Any]:
        """Wire shape for tools/MCP: what the model gets to read."""
        return {
            "id": self.id,
            "name": self.name,
            "category": self.category,
            "class": self.cls,
            "pins": list(self.pins),
            "properties": list(self.properties),
            "defaults": self.defaults,
            "simulated": self.sim,
            **({"notes": self.notes} if self.notes else {}),
        }


def _build(part_id: str, raw: dict[str, Any]) -> PartSpec:
    signals = {
        pin: Signal(
            pin=pin,
            cap=rule.get("cap", ANY_CAPABILITY),
            direction=rule.get("dir", "bidir"),
            optional=bool(rule.get("optional", False)),
            severity=rule.get("severity"),
        )
        for pin, rule in (raw.get("signal") or {}).items()
    }
    buses = tuple(
        BusAlternative(
            type=bus.get("type", "custom"),
            pins=dict(bus.get("pins") or {}),
            optional=bool(bus.get("optional", False)),
            when=dict(bus.get("when") or {}),
        )
        for bus in (raw.get("bus") or [])
    )
    pairs = lambda key: tuple((a, b) for a, b in (raw.get(key) or []))  # noqa: E731
    return PartSpec(
        id=part_id,
        name=raw.get("name", part_id),
        tag=raw.get("tag", ""),
        category=raw.get("category", "other"),
        cls=raw.get("class", "misc"),
        pins=tuple(raw.get("pins") or ()),
        properties=tuple(raw.get("properties") or ()),
        defaults=dict(raw.get("defaults") or {}),
        placeable=bool(raw.get("placeable", True)),
        sim=bool(raw.get("sim", False)),
        tags=tuple(raw.get("tags") or ()),
        notes=raw.get("notes"),
        description=raw.get("description"),
        why=raw.get("why"),
        power=dict(raw.get("power") or {}),
        signals=signals,
        buses=buses,
        power_out=tuple(raw.get("powerOut") or ()),
        source_pins=tuple(raw.get("sourcePins") or ()),
        self_short=pairs("selfShortPairs"),
        internal_pairs=pairs("internalPairs"),
        trace_pairs=pairs("tracePairs"),
        series_resistor=raw.get("seriesResistor"),
        gate_resistor=raw.get("gateResistor"),
        external_driver=raw.get("externalDriver"),
        address_property=raw.get("addressProperty"),
        interactions=tuple(raw.get("interactions") or ()),
        stimulus_keys=tuple(raw.get("stimulusKeys") or ()),
        rotary=raw.get("rotary"),
        pot_pins=tuple(raw.get("potPins") or ()),
        pin_variants=tuple(raw.get("pinVariants") or ()),
        libraries=tuple(raw.get("libraries") or ()),
    )


PARTS: dict[str, PartSpec] = {
    part_id: _build(part_id, raw) for part_id, raw in _CATALOG["parts"].items()
}
PLACEABLE: dict[str, PartSpec] = {k: v for k, v in PARTS.items() if v.placeable}
UNPLACEABLE_NOTES: dict[str, str] = {
    k: v.why for k, v in PARTS.items() if not v.placeable and v.why
}

# Convenience mirrors of the old hardcoded tables (kept for readability at call
# sites; both are derived, so they cannot drift from the catalog).
PINS: dict[str, list[str]] = {k: list(v.pins) for k, v in PARTS.items()}
PROPERTIES: dict[str, set[str]] = {k: set(v.properties) for k, v in PARTS.items()}


def get(part_id: str) -> PartSpec | None:
    return PARTS.get(part_id)


def pins_for(part_id: str, properties: dict[str, Any] | None = None) -> list[str]:
    spec = PARTS.get(part_id)
    return list(spec.pins_for(properties)) if spec else []


def editable(part_id: str) -> set[str]:
    spec = PARTS.get(part_id)
    return set(spec.properties) if spec else set()


def _pin_key(name: Any) -> str:
    """Pin-name key: case and punctuation carry no meaning (COM.1 == com1)."""
    return re.sub(r"[^a-z0-9]", "", str(name).strip().lower())


def resolve_pin(pins: Iterable[str], name: Any) -> str | None:
    """Canonical pin name for `name`, or None when it names no pin of this part.

    Models spell pins the way their training data does: "pin1" for a resistor's
    "1", "D13" for the Uno's "13", "com1" for "COM.1". Those are unambiguous
    misspellings of a pin that exists, so repair them instead of failing the
    patch. A name is accepted only when it matches exactly ONE pin (the catalog
    has parts whose "+"/"-" pins collapse to the same loose key), so anything
    else returns None and the caller reports the real problem.
    """
    known = [str(pin) for pin in pins]
    raw = str("" if name is None else name).strip()
    if not raw:
        return None
    if raw in known:
        return raw
    by_key: dict[str, list[str]] = {}
    for pin in known:
        by_key.setdefault(_pin_key(pin), []).append(pin)
    candidates = [raw]
    without_prefix = re.sub(r"^pin[_\-\s]*", "", raw, flags=re.IGNORECASE)  # "pin1" -> "1"
    if without_prefix and without_prefix != raw:
        candidates.append(without_prefix)
    uno_style = re.fullmatch(r"[dD]\s*(\d{1,2})", raw)  # "D13" -> "13"
    if uno_style:
        candidates.append(uno_style.group(1))
    for candidate in candidates:
        hits = by_key.get(_pin_key(candidate))
        if hits and len(hits) == 1:
            return hits[0]
    return None


def board(board_id: str = DEFAULT_BOARD) -> dict[str, Any]:
    return BOARDS.get(board_id, BOARDS[DEFAULT_BOARD])


def board_pins(board_id: str = DEFAULT_BOARD) -> list[str]:
    return list(board(board_id).get("pins", []))


def board_capabilities(board_id: str = DEFAULT_BOARD) -> dict[str, Any]:
    return {k: v for k, v in board(board_id).items() if k not in {"pins", "label"}}


@lru_cache(maxsize=8)
def _capability_map(board_id: str = DEFAULT_BOARD) -> dict[str, frozenset[str]]:
    """board pin name -> capabilities it satisfies."""
    spec = board(board_id)
    analog = {str(p) for p in spec.get("analog", [])}
    pwm = {str(p) for p in spec.get("pwm", [])}
    i2c = {str(v): ("i2c-sda" if k == "SDA" else "i2c-scl") for k, v in spec.get("i2c", {}).items()}
    spi = {str(v): f"spi-{k.lower()}" for k, v in spec.get("spi", {}).items()}
    uart = {str(v): f"uart-{'rx' if k == 'RX' else 'tx'}" for k, v in spec.get("uart", {}).items()}
    caps: dict[str, set[str]] = {}
    for pin in spec.get("pins", []):
        name = str(pin)
        caps.setdefault(name, set()).add("gpio")
        if name in analog:
            caps[name].add("analog")
        if name in pwm:
            caps[name].add("pwm")
        if name in i2c:
            caps[name].add(i2c[name])
        if name in spi:
            caps[name].add(spi[name])
        if name in uart:
            caps[name].add(uart[name])
    return {name: frozenset(values) for name, values in caps.items()}


def satisfies(board_pin: str, capability: str, board_id: str = DEFAULT_BOARD) -> bool:
    if capability == ANY_CAPABILITY:
        return True
    return capability in _capability_map(board_id).get(str(board_pin), frozenset())


def capability_label(capability: str, board_id: str = DEFAULT_BOARD) -> str:
    """Human wording for a capability failure ('PWM', 'analog-capable', …)."""
    spec = board(board_id)
    if capability == "pwm":
        return "a PWM pin, one of " + ", ".join(str(p) for p in sorted(spec.get("pwm", []), key=int))
    if capability == "analog":
        return "an analog-capable pin, one of " + ", ".join(str(p) for p in spec.get("analog", []))
    if capability.startswith("i2c-"):
        pin = spec.get("i2c", {}).get("SDA" if capability.endswith("sda") else "SCL", "?")
        return f"the I2C {'SDA' if capability.endswith('sda') else 'SCL'} pin ({pin})"
    if capability.startswith("spi-"):
        key = capability.split("-", 1)[1].upper()
        pin = spec.get("spi", {}).get(key, "?")
        return f"the SPI {key} pin ({pin})"
    if capability.startswith("uart-"):
        key = capability.split("-", 1)[1].upper()
        pin = spec.get("uart", {}).get(key, "?")
        return f"the hardware serial {key} pin ({pin})"
    return "any GPIO"


def power_rails(board_id: str = DEFAULT_BOARD) -> tuple[set[str], set[str]]:
    """(supply, ground) board pin names that count as rails."""
    spec = board(board_id)
    supply = {str(p) for p in ("5V", "3.3V", "VIN") if str(p) in [str(x) for x in spec.get("pins", [])]}
    ground = {str(p) for p in spec.get("pins", []) if str(p).startswith("GND")}
    return supply, ground


def source_part_ids() -> dict[str, tuple[str, ...]]:
    """Parts that produce a rail (a battery or a regulator): id -> output pins.

    The supply check accepts these as rails, so a 9V battery can power a relay
    coil without the analysis insisting on the board's 5V pin.
    """
    return {p.id: p.power_out for p in PARTS.values() if p.power_out}


def resolve_id(name: str) -> str | None:
    """Map any external part name to a catalog id.

    MCP clients and Wokwi diagrams spell parts as `wokwi-led`, `wokwi_lcd1602`,
    `led` or `wokwi-arduino-uno`; the catalog uses its own ids. This is the one
    place that translates, so a part can never be "in the catalog" for one
    surface and unknown to another.
    """
    if not name:
        return None
    raw = str(name).strip()
    candidates = [raw, raw.lower()]
    for prefix in ("wokwi-", "wokwi_", "velxio-", "velxio_"):
        if raw.lower().startswith(prefix):
            stripped = raw[len(prefix):]
            candidates += [stripped, stripped.lower()]
    for candidate in candidates:
        if candidate in PARTS:
            return candidate
        for spec in PARTS.values():
            if candidate == spec.tag or candidate == spec.tag.removeprefix("wokwi-"):
                return spec.id
    return None


def _haystack(spec: PartSpec) -> str:
    return " ".join(
        [spec.id, spec.name, spec.category, spec.cls, " ".join(spec.tags), spec.notes or ""]
    ).lower()


def search(query: str, category: str | None = None, limit: int = 12) -> list[PartSpec]:
    """Rank catalog parts for a free-text query (id/name/tag substring match).

    Deliberately simple and deterministic: the model reads the returned notes and
    picks; there is no fuzzy scoring that could silently hide a part.
    """
    words = [w for w in re.split(r"[^a-z0-9+]+", query.lower()) if w]
    scored: list[tuple[int, str, PartSpec]] = []
    for spec in PARTS.values():
        if category and spec.category != category:
            continue
        hay = _haystack(spec)
        score = 0
        for word in words:
            if spec.id == word:
                score += 100
            elif word == spec.id.replace("-", ""):
                score += 80
            elif word in spec.id:
                score += 60
            elif word in spec.name.lower():
                score += 40
            elif word in hay:
                score += 10
        if score == 0 and words:
            continue
        scored.append((-score, spec.id, spec))
    scored.sort()
    return [spec for _, _, spec in scored[:limit]]


def list_category(category: str) -> list[PartSpec]:
    return [spec for spec in PARTS.values() if spec.category == category]


def categories() -> dict[str, int]:
    counts: dict[str, int] = {}
    for spec in PARTS.values():
        counts[spec.category] = counts.get(spec.category, 0) + 1
    return dict(sorted(counts.items()))


def iter_parts() -> Iterator[PartSpec]:
    return iter(PARTS.values())


def allowed_headers() -> frozenset[str]:
    """Headers a sketch may include, from the catalog's per-part drivers.

    `CORE_HEADERS` ship inside every arduino:avr install (the AVR core and its
    bundled libraries), so they need no library manager. Everything else is a
    library a catalog part needs — the build still has to find it, and a missing
    library fails loudly at compile time rather than being hidden here.
    """
    headers = set(CORE_HEADERS)
    for spec in PARTS.values():
        headers.update(spec.libraries)
    return frozenset(headers)


CORE_HEADERS = frozenset({
    "Arduino.h", "math.h", "stdint.h", "string.h", "stdlib.h", "stdio.h",
    "avr/pgmspace.h", "avr/interrupt.h", "avr/io.h", "avr/wdt.h", "util/delay.h",
    # Bundled with the AVR core (no library installation required):
    "Servo.h", "Wire.h", "SPI.h", "EEPROM.h", "SoftwareSerial.h", "HID.h",
})


def simulator_coverage() -> dict[str, int]:
    """Counts for the UI/status text: placeable and live-simulatable parts."""
    return {
        "total": len(PARTS),
        "placeable": len(PLACEABLE),
        "simulated": sum(1 for spec in PARTS.values() if spec.sim),
    }
