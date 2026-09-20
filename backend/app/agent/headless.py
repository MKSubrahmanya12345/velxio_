"""Headless AVR observation: compile a candidate and RUN it, on the server.

The browser already verifies declared expectations against the live canvas
(`frontend/src/agent/expectations.ts`). That is the right place for the final
gate — but it happens *after* the model has committed to an answer, which makes
it a verdict rather than a debugging tool.

This module gives the model the same power inside its own loop: `draft_simulate`
compiles a candidate and executes it on the same avr8js core the canvas uses
(`app/mcp/avr_sim.cjs`), with the declared interactions translated into real
electrical stimuli — a button pulling its GPIO low, a potentiometer holding an
ADC channel at a voltage, a switch thrown mid-run, a rotary encoder clocked.
The observations (per-pin transitions with simulated timestamps, serial output)
come back as tool results, so the model can fix its own wiring and firmware
before proposing them.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any

from app.agent import catalog
from app.agent.analysis import Netlist, _pins_of
from app.agent.models import Project, Source

logger = logging.getLogger("velxio.agent.headless")

_AVR_SIM_SCRIPT = Path(__file__).resolve().parents[1] / "mcp" / "avr_sim.cjs"

# Arduino pin name -> pin number on an Uno (A0..A5 are digital 14..19).
_BOARD_PIN_NUMBERS: dict[str, int] = {str(i): i for i in range(14)}
_BOARD_PIN_NUMBERS.update({f"A{i}": 14 + i for i in range(6)})

# Which part pin a generic interaction acts on when the model does not say.
_DEFAULT_PINS = {
    "press": ("1.l", "1.r", "2.l", "2.r", "SW", "SEL", "OUT"),
    "pot": ("SIG", "VERT", "HORZ", "AO", "AOUT", "OUT"),
    "switch": ("2", "1", "OUT"),
    "rotary": ("CLK", "PULSE"),
}


def pin_number(board_pin: str) -> int | None:
    return _BOARD_PIN_NUMBERS.get(str(board_pin))


def _candidate_pin_names(project: Project, component_id: str, kind: str) -> list[str]:
    """Part pins an interaction of this kind could act on, best guess first."""
    part = next((p for p in project.components if p.id == component_id), None)
    if part is None:
        return []
    spec = catalog.get(part.metadataId)
    if spec is None:
        return []
    pins = _pins_of(project, part)
    preferred = _DEFAULT_PINS.get(kind, ())
    ordered = [pin for pin in preferred if pin in pins]
    if kind == "rotary" and spec.rotary:
        ordered = [pin for pin in spec.rotary.values() if pin in pins] + ordered
    ordered += [pin for pin in pins if pin not in ordered]
    return ordered


def resolve_board_pin(project: Project, component_id: str, pin_name: str) -> str | None:
    """Board pin NAME a component pin reaches, walking through series parts."""
    nets = Netlist(project)
    reachable = nets.board_pins_on(nets.signal_net(f"{component_id}:{pin_name}"))
    if not reachable:
        return None
    # Prefer a plain GPIO over an analog-named alias (A4.2 vs A4 are the same pad).
    return sorted(reachable, key=lambda p: (len(p), p))[0]


def resolve_component_pin(project: Project, component_id: str, kind: str,
                          requested: str | None = None) -> tuple[str, str] | None:
    """(part pin name, board pin name) for an interaction, or None."""
    names = [requested] if requested else _candidate_pin_names(project, component_id, kind)
    for name in names:
        if not name:
            continue
        board_pin = resolve_board_pin(project, component_id, name)
        if board_pin:
            return name, board_pin
    return None


def _rail_side(project: Project, component_id: str, pin_name: str) -> bool | None:
    """For a switch: True if closing it pulls the signal LOW (to ground).

    Walks the switch's *other* contact; a switch between a GPIO and GND closes to
    LOW, one between a GPIO and 5V closes to HIGH. Returns None when the other
    side is not a rail (the caller then falls back to toggling the pin).
    """
    part = next((p for p in project.components if p.id == component_id), None)
    if part is None or project.board is None:
        return None
    spec = catalog.get(part.metadataId)
    if spec is None:
        return None
    nets = Netlist(project)
    supply, ground = catalog.power_rails()
    board_id = project.board.id
    for a, b in spec.trace_pairs or ():
        if pin_name not in (a, b):
            continue
        other = b if pin_name == a else a
        net = nets.net_of(f"{part.id}:{other}")
        if any(pin.partition(":")[0] == board_id and pin.partition(":")[2] in ground for pin in net):
            return True
        if any(pin.partition(":")[0] == board_id and pin.partition(":")[2] in supply for pin in net):
            return False
    return None


def build_stimuli(project: Project, interactions: list[dict[str, Any]]) -> tuple[dict, list[str]]:
    """Translate declared interactions into avr_sim's stimulus format.

    Returns (stimulus, notes). Unresolvable interactions come back as notes —
    never silently dropped, because a verification that quietly skipped its input
    would report "verified" for behaviour that never happened.
    """
    digital: list[dict[str, Any]] = []
    analog_static: dict[str, float] = {}
    analog_events: list[dict[str, Any]] = []
    notes: list[str] = []

    for index, raw in enumerate(interactions):
        kind = str(raw.get("kind", ""))
        component_id = str(raw.get("componentId", ""))
        at_ms = max(0, int(raw.get("at_ms", 500)))
        label = f"interaction {index + 1} ({kind} {component_id})"

        if kind == "stimulus":
            notes.append(
                f"{label} was NOT applied: a sensor stimulus needs the canvas sensor model, "
                f"so it can only be verified in the browser (declare it in expectations)."
            )
            continue

        resolved = resolve_component_pin(project, component_id, kind, raw.get("pin"))
        if resolved is None:
            notes.append(
                f"{label} could not be traced to a board pin — it was NOT applied. "
                f"Check the wiring for {component_id}."
            )
            continue
        part_pin, board_pin = resolved
        number = pin_number(board_pin)

        if kind == "press":
            hold = max(10, int(raw.get("hold_ms", 500)))
            digital.append({"at_ms": at_ms, "pin": number, "state": False})
            digital.append({"at_ms": at_ms + hold, "pin": number, "state": True})
            notes.append(f"{label}: {component_id}.{part_pin} (pin {board_pin}) held LOW "
                         f"for {hold} ms at t={at_ms} ms.")
        elif kind == "switch":
            closed = bool(raw.get("closed", True))
            pull_low = _rail_side(project, component_id, part_pin)
            if pull_low is None:
                notes.append(f"{label}: {component_id}.{part_pin} is not wired to a rail, "
                             f"so the switch state was not applied.")
                continue
            level = (not closed) if pull_low else closed
            digital.append({"at_ms": at_ms, "pin": number, "state": level})
            notes.append(f"{label}: {component_id}.{part_pin} (pin {board_pin}) "
                         f"{'closed' if closed else 'opened'} at t={at_ms} ms.")
        elif kind == "pot":
            value = max(0, min(1023, int(raw.get("value", 512))))
            channel = number - 14 if number is not None and number >= 14 else None
            if channel is None:
                notes.append(f"{label}: {component_id}.{part_pin} is on pin {board_pin}, "
                             f"which has no ADC channel — the value was not applied.")
                continue
            volts = round(value / 1023 * 5.0, 3)
            analog_static[str(channel)] = volts
            analog_events.append({"at_ms": at_ms, "channel": channel, "volts": volts})
            notes.append(f"{label}: {component_id}.{part_pin} (A{channel}) held at {volts} V "
                         f"from t={at_ms} ms.")
        elif kind == "rotary":
            delta = int(raw.get("delta", 1))
            pulses = min(40, abs(delta))
            spec_pins = _candidate_pin_names(project, component_id, "rotary")
            partners = [p for p in spec_pins if p != part_pin][:1]
            partner_number = None
            if partners:
                partner_board = resolve_board_pin(project, component_id, partners[0])
                partner_number = pin_number(partner_board) if partner_board else None
            step = 2
            for index_ in range(pulses):
                start = at_ms + index_ * step
                # One detent: clock the pin high then low, and flip the partner
                # first so the firmware sees a real quadrature edge.
                if partner_number is not None:
                    digital.append({"at_ms": start, "pin": partner_number,
                                    "state": bool(index_ % 2)})
                digital.append({"at_ms": start, "pin": number, "state": True})
                digital.append({"at_ms": start + 1, "pin": number, "state": False})
            notes.append(f"{label}: {component_id}.{part_pin} (pin {board_pin}) clocked "
                         f"{pulses} step(s) from t={at_ms} ms.")

    stimulus: dict[str, Any] = {}
    if digital:
        stimulus["interactions"] = digital
    if analog_static:
        stimulus["analog"] = analog_static
    if analog_events:
        stimulus["analog_events"] = analog_events
    return stimulus, notes


async def run_headless(hex_content: str, observe_ms: int, watch_pins: list[str],
                       stimulus: dict[str, Any], timeout: float = 45.0) -> dict[str, Any]:
    """Run compiled firmware on avr8js and report what it did."""
    if not _AVR_SIM_SCRIPT.exists():
        return {"supported": False, "error": "The headless simulator helper is missing."}
    payload = {
        "hex": hex_content,
        "observe_ms": max(100, min(int(observe_ms), 10000)),
        "watch_pins": [str(p)[:4] for p in watch_pins][:24],
        **stimulus,
    }
    try:
        process = await asyncio.create_subprocess_exec(
            "node", str(_AVR_SIM_SCRIPT),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=os.name != "nt",
        )
    except FileNotFoundError:
        return {"supported": False,
                "error": "Node.js is not installed on the server, so headless simulation is unavailable."}
    try:
        out, err = await asyncio.wait_for(process.communicate(json.dumps(payload).encode()), timeout)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        return {"supported": True, "error": "Headless simulation timed out."}
    if process.returncode != 0:
        detail = err.decode(errors="replace").strip()[:300]
        supported = "avr8js-not-found" not in detail
        return {"supported": supported, "error": "Headless simulation failed." +
                (f" {detail}" if detail else "")}
    try:
        return json.loads(out.decode())
    except ValueError:
        return {"supported": True, "error": "The simulator returned unparseable output."}


def summarise(result: dict[str, Any], notes: list[str], hex_size: int) -> str:
    """One compact line per observation for the model (and the UI event log)."""
    pins = result.get("pins") or {}
    lines: list[str] = []
    for pin, stats in sorted(pins.items(), key=lambda kv: int(kv[0]) if kv[0].isdigit() else 99):
        period = stats.get("median_period_ms")
        lines.append(
            f"pin {pin}: {stats.get('transitions', 0)} transitions, ended "
            f"{'HIGH' if stats.get('last_state') else 'LOW'}"
            + (f", median period {period} ms" if period else "")
        )
    if not lines:
        lines.append("no pin activity observed")
    return f"{hex_size} byte hex · " + "; ".join(lines[:8])


def flatten_firmware_violations(files: list[Source]) -> list[str]:
    """Cheap guard: an empty sketch compiles but proves nothing."""
    if not any(source.content.strip() for source in files):
        return ["The sketch is empty; nothing can be observed."]
    return []
