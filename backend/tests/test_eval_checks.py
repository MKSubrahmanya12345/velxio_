"""Eval runner checks: the golden gate's teeth, pinned without any runs.

`evaluate_expect` is the thing that would have caught the servo-vs-select bug
class; these tests prove it fails coarse behavior and passes smooth behavior,
and that golden.yaml itself only ever declares expectations with teeth.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from eval_runner import distinct_ints, evaluate_expect, load_suite, resolve_interactions  # noqa: E402

ROOT = BACKEND.parent


# --- evaluate_expect ----------------------------------------------------------

def sim(pins=None, serial=None):
    return {"pins": pins or {}, "serial": serial or []}


def test_smooth_sweep_passes_and_select_servo_fails():
    expect = {"serial_matches": ["\\d+"], "serial_distinct_min": 25}
    # A smooth 0..180 sweep: many distinct printed angles.
    smooth = sim(serial=[str(a) for a in range(0, 181, 5)])
    assert evaluate_expect(expect, smooth) == []
    # A 5-position select servo prints only five values — the exact bug class.
    select = sim(serial=["0", "45", "90", "135", "180"] * 4)
    failures = evaluate_expect(expect, select)
    assert failures and "distinct" in failures[0]


def test_pin_period_bounds_catch_a_wrong_rate():
    expect = {"pins": [{"pin": "13", "transitions_min": 3,
                        "period_ms": [700, 1300]}]}
    ok = sim(pins={"13": {"transitions": 3, "median_period_ms": 1000.0}})
    assert evaluate_expect(expect, ok) == []
    slow = sim(pins={"13": {"transitions": 3, "median_period_ms": 2400.0}})
    assert any("outside" in f for f in evaluate_expect(expect, slow))
    dead = sim(pins={"13": {"transitions": 1, "median_period_ms": 1000.0}})
    assert any("transitions" in f for f in evaluate_expect(expect, dead))
    gone = sim(pins={})
    assert any("no transitions" in f for f in evaluate_expect(expect, gone))


def test_serial_regex_gate():
    expect = {"serial_matches": ["pressed"]}
    assert evaluate_expect(expect, sim(serial=["pressed"])) == []
    failures = evaluate_expect(expect, sim(serial=["button down"]))
    assert any("/pressed/" in f for f in failures)


def test_part_presence_is_never_a_gate():
    """An `expect` of pins=[] with no serial criteria is rejected at load; a
    sim with empty everything fails any real criterion."""
    expect = {"serial_matches": ["\\d"], "serial_distinct_min": 2}
    assert evaluate_expect(expect, sim())  # fails loudly, not vacuously


# --- distinct ints --------------------------------------------------------------

def test_distinct_ints_ignores_non_integer_tokens():
    text = "angle 90, then -5; ms=12.5 and 0x1F and v1.2 -> 90 again"
    assert distinct_ints(text) == {90, -5, 12, 1, 2}


# --- resolve_interactions ---------------------------------------------------------

def test_interactions_resolve_part_to_placed_component():
    from app.agent.models import Part, Project
    project = Project(components=[Part(id="btn1", metadataId="pushbutton",
                                       x=0, y=0)])
    resolved = resolve_interactions(project, [
        {"kind": "press", "part": "pushbutton", "at_ms": 500, "hold_ms": 300}])
    assert resolved == [{"kind": "press", "at_ms": 500, "hold_ms": 300,
                         "componentId": "btn1"}]
    # An unplaced part stays unresolved: the downstream validation is the
    # honest failure, not a silent skip.
    unresolved = resolve_interactions(project, [{"kind": "press", "part": "servo"}])
    assert "componentId" not in unresolved[0]


# --- golden.yaml itself -----------------------------------------------------------

def test_golden_suite_is_wellformed_and_has_teeth():
    prompts = load_suite(ROOT / "eval" / "golden.yaml")
    assert len(prompts) >= 15
    behavioral = [p for p in prompts if p.get("expect")]
    # The suite's reason to exist: most prompts gate on BEHAVIOR, not compile.
    assert len(behavioral) >= len(prompts) * 0.6
    # The discriminator pair both exist and both gate on printed values.
    ids = {p["id"] for p in prompts}
    assert {"servo-sweep", "servo-two-positions"} <= ids
    sweep = next(p for p in prompts if p["id"] == "servo-sweep")
    assert sweep["expect"]["serial_distinct_min"] >= 20


def test_golden_max_turns_bounded():
    for p in load_suite(ROOT / "eval" / "golden.yaml"):
        assert 4 <= p.get("max_turns", 99) <= 24
