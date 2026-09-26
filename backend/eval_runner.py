#!/usr/bin/env python3
"""Golden-prompt eval runner (docs/agent-architecture-v2.md C.7).

Runs eval/golden.yaml against real Bedrock through the REAL run loop
(service.run_agent) and judges outcomes only:

  gate 1  the run ends in a compiled `result` (workspace build + electrical
          lint + real compile already passed behind done(); re-verified here)
  gate 2  the prompt's declared `expect` holds in the headless AVR sim:
          pin transition counts / median periods, serial regexes, and
          serial DISTINCT-integer minimums — the smoothness check that
          separates a real sweep from a 5-position select servo
          (must_mention is a diagnostic, never a gate)

Usage (from backend/, with BEDROCK_MODEL_ID + AWS creds in the env):
  python eval_runner.py                  # full suite
  python eval_runner.py --ids servo-sweep,blink-led
  python eval_runner.py --limit 3        # smoke tier

Writes eval/runs/<ts>-<model>.json with per-prompt detail and prints a
summary table. Baseline handling: with no eval/baseline.json the first run
WRITES the baseline and exits 0 ("baseline recorded"); afterwards a
success-rate drop >= 10 points exits 1 — the release gate.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

BACKEND = Path(__file__).resolve().parent
ROOT = BACKEND.parent
sys.path.insert(0, str(BACKEND))

import yaml  # noqa: E402  (pyyaml — in requirements.txt)

from app.agent import headless, service  # noqa: E402
from app.agent import catalog  # noqa: E402
from app.agent import workspace as wsmod  # noqa: E402
from app.agent.catalog import board_family  # noqa: E402
from app.agent.models import AgentRequest, Project, validate_electrical  # noqa: E402
from app.agent.runlog import snapshot  # noqa: E402
from app.core.config import settings  # noqa: E402

SUITE = ROOT / "eval" / "golden.yaml"
BASELINE = ROOT / "eval" / "baseline.json"
RUNS_DIR = ROOT / "eval" / "runs"
GATE_POINTS = 10.0

_EXPECT_KEYS = {"observe_ms", "pins", "serial_matches", "serial_distinct_min",
                "interactions"}
_PIN_KEYS = {"pin", "transitions_min", "period_ms", "last_state"}


# --- pure checkers (unit-tested in tests/test_eval_checks.py) ----------------

def distinct_ints(text: str) -> set[int]:
    """Distinct integers appearing in serial output (the smoothness metric)."""
    return {int(m) for m in re.findall(r"(?<![\w.])-?\d+(?![\w.])", text or "")}


def evaluate_expect(expect: dict, sim: dict) -> list[str]:
    """Golden `expect` block vs one headless run. Returns failure strings."""
    failures: list[str] = []
    pins = sim.get("pins") or {}
    for spec in expect.get("pins") or []:
        pin = str(spec.get("pin"))
        data = pins.get(pin)
        if not data:
            failures.append(f"pin {pin}: no transitions observed")
            continue
        transitions = int(data.get("transitions") or 0)
        want = int(spec.get("transitions_min", 1))
        if transitions < want:
            failures.append(f"pin {pin}: {transitions} transitions < {want}")
        bounds = spec.get("period_ms")
        period = data.get("median_period_ms")
        if bounds and period:
            if not (float(bounds[0]) <= float(period) <= float(bounds[1])):
                failures.append(
                    f"pin {pin}: median period {period:.0f}ms outside "
                    f"[{bounds[0]}, {bounds[1]}]")
        if spec.get("last_state"):
            got = str(data.get("last_state") or "").lower()
            if got != str(spec["last_state"]).lower():
                failures.append(f"pin {pin}: ended {got or '?'} "
                                f"≠ expected {spec['last_state']}")
    text = "\n".join(str(line) for line in (sim.get("serial") or []))
    for pattern in expect.get("serial_matches") or []:
        if not re.search(pattern, text, re.IGNORECASE):
            failures.append(f"serial never matched /{pattern}/")
    want_distinct = expect.get("serial_distinct_min")
    if want_distinct:
        got = len(distinct_ints(text))
        if got < int(want_distinct):
            failures.append(
                f"serial printed {got} distinct value(s) < {want_distinct} "
                "(behavior too coarse — right part, wrong motion?)")
    return failures


def resolve_interactions(project: Project, raw: list[dict] | None) -> list[dict]:
    """Golden interactions name a PART (metadataId); resolve to the component
    the model actually placed. Unknown part -> Interaction validation errors
    later, which is the honest outcome."""
    resolved: list[dict] = []
    for item in raw or []:
        out = {k: v for k, v in item.items() if k not in ("part",)}
        if item.get("part") and not item.get("componentId"):
            match = next((c for c in project.components
                          if c.metadataId == item["part"]), None)
            if match is None:
                match = next((c for c in project.components
                              if item["part"] in (catalog.get(c.metadataId).tags
                                                  if catalog.get(c.metadataId) else ())), None)
            if match is not None:
                out["componentId"] = match.id
        resolved.append(out)
    return resolved


def load_suite(path: Path) -> list[dict]:
    suite = yaml.safe_load(path.read_text())
    prompts = suite.get("prompts") or []
    ids = [p.get("id") for p in prompts]
    if len(ids) != len(set(ids)):
        raise SystemExit("golden.yaml: duplicate prompt ids")
    for p in prompts:
        if not p.get("id") or not p.get("prompt"):
            raise SystemExit(f"golden.yaml: prompt missing id/prompt: {p}")
        expect = p.get("expect")
        if expect:
            unknown = set(expect) - _EXPECT_KEYS
            if unknown:
                raise SystemExit(f"golden.yaml {p['id']}: unknown expect keys {unknown}")
            for spec in expect.get("pins") or []:
                unknown = set(spec) - _PIN_KEYS
                if unknown:
                    raise SystemExit(f"golden.yaml {p['id']}: unknown pin keys {unknown}")
                if not spec.get("pin"):
                    raise SystemExit(f"golden.yaml {p['id']}: pin spec without pin")
            if not any(expect.get(k) for k in
                       ("pins", "serial_matches", "serial_distinct_min")):
                raise SystemExit(
                    f"golden.yaml {p['id']}: expect with no behavioral teeth "
                    "(part-presence is not a gate)")
    return prompts


# --- one golden run ----------------------------------------------------------

async def run_prompt(golden: dict) -> dict:
    """Drive the REAL loop (all gates included) for one golden prompt."""
    request = AgentRequest(prompt=golden["prompt"],
                           project=Project(), mode="agent")
    run_id, turns = "", 0
    terminal: dict | None = None
    error = ""
    t0 = time.monotonic()
    try:
        async for ev in service.run_agent(request):
            kind = ev.get("type")
            if kind == "run_started":
                run_id = ev.get("run_id", "")
            elif kind == "stage":
                turns = max(turns, int(ev.get("turn") or 0))
            elif kind == "result":
                terminal = ev
            elif kind == "answer":
                if terminal is None:
                    terminal = {"type": "answer", "summary": ev.get("summary", "")}
            elif kind == "error":
                error = str(ev.get("message") or "")
    except Exception as exc:  # noqa: BLE001 - a crashed run is a failed run
        error = f"{type(exc).__name__}: {exc}"
    wall = time.monotonic() - t0
    record = next((s for s in snapshot() if s.get("run_id") == run_id), {})

    outcome: dict = {"passed": False, "failures": [], "notes": []}
    if error:
        outcome["failures"].append(f"run error: {error}")
    elif terminal is None:
        outcome["failures"].append("run ended without a result (answer/cap/timeout)")
    elif terminal.get("type") != "result":
        outcome["failures"].append(
            f"run answered instead of building: {str(terminal.get('summary'))[:120]}")
    else:
        try:
            project = Project.model_validate(terminal["project"])
            validate_electrical(project)  # cheap re-verify of the gated state
        except Exception as exc:  # noqa: BLE001
            outcome["failures"].append(f"final project failed re-verification: {exc}")
            project = None
        if project is not None:
            # must_mention: DIAGNOSTIC only — presence never passes a prompt.
            specs = {c.metadataId for c in project.components}
            tags: set[str] = set()
            for c in project.components:
                part = catalog.get(c.metadataId)
                if part:
                    tags.update(part.tags)
            for want in golden.get("must_mention") or []:
                if (want not in specs and want not in tags
                        and not any(want in s for s in specs)
                        and not any(want in t for t in tags)):
                    outcome["notes"].append(f"possibly missing part: {want}")
            expect = golden.get("expect")
            if expect:
                family = board_family(project.board.boardKind
                                      if project.board else None)
                hex_content = terminal.get("hex") or ""
                if family in {"arduino", "attiny"} and hex_content:
                    interactions = resolve_interactions(project, expect.get("interactions"))
                    stimulus, build_notes = headless.build_stimuli(project, interactions)
                    outcome["notes"] += build_notes[:3]
                    watch = [str(p.get("pin")) for p in expect.get("pins") or []]
                    sim = await headless.run_headless(
                        hex_content, int(expect.get("observe_ms") or 3000),
                        watch, stimulus, timeout=settings.AGENT_SIM_WALL_CLOCK_S)
                    if not sim.get("supported", True):
                        outcome["notes"].append(
                            "headless sim unavailable; behavioral gate skipped")
                    elif sim.get("error"):
                        outcome["failures"].append(f"sim error: {sim['error']}")
                    else:
                        outcome["failures"] += evaluate_expect(expect, sim)
                else:
                    outcome["notes"].append(
                        "non-AVR target (or no hex): behavioral gate not simulable; "
                        "compile-only gate")
    outcome["passed"] = not outcome["failures"]
    return {"id": golden["id"], "prompt": golden["prompt"], "run_id": run_id,
            "passed": outcome["passed"], "failures": outcome["failures"],
            "notes": outcome["notes"], "turns": turns,
            "wall_s": round(wall, 1),
            "prompt_tokens": record.get("prompt_tokens", 0),
            "completion_tokens": record.get("completion_tokens", 0),
            "cache_read_tokens": record.get("cache_read_tokens", 0),
            "outcome": record.get("outcome", "")}


# --- reporting / gate --------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--ids", help="comma-separated subset of prompt ids")
    parser.add_argument("--limit", type=int, help="first N prompts (smoke tier)")
    parser.add_argument("--suite", default=str(SUITE))
    args = parser.parse_args()

    prompts = load_suite(Path(args.suite))
    if args.ids:
        wanted = {s.strip() for s in args.ids.split(",")}
        prompts = [p for p in prompts if p["id"] in wanted]
        missing = wanted - {p["id"] for p in prompts}
        if missing:
            raise SystemExit(f"unknown prompt ids: {sorted(missing)}")
    prompts = prompts[:max(0, args.limit or len(prompts))]
    if not prompts:
        raise SystemExit("nothing to run")

    model = settings.BEDROCK_MODEL_ID or "unconfigured"
    print(f"velxio golden eval · {len(prompts)} prompt(s) · model {model}\n")
    results = [asyncio.run(run_prompt(g)) for g in prompts]

    width = max(len(r["id"]) for r in results)
    for r in results:
        mark = "PASS" if r["passed"] else "FAIL"
        line = (f"{r['id']:<{width}}  {mark}  turns={r['turns']:<3} "
                f"tokens={r['prompt_tokens'] + r['completion_tokens']:<7} "
                f"cache_r={r['cache_read_tokens']:<6} wall={r['wall_s']}s")
        print(line)
        for failure in r["failures"]:
            print(f"{' ' * width}  ✗ {failure}")
        for note in r["notes"]:
            print(f"{' ' * width}  · {note}")

    attempted = [r for r in results if r["outcome"] not in ("cancelled",)]
    passed = sum(1 for r in attempted if r["passed"])
    rate = round(100.0 * passed / len(attempted), 1) if attempted else 0.0
    walls = [r["wall_s"] for r in attempted] or [0.0]
    print(f"\nsuccess {passed}/{len(attempted)} = {rate}% · "
          f"turns avg {statistics.mean(r['turns'] for r in attempted or [0]):.1f} · "
          f"wall p50 {statistics.median(walls):.1f}s · "
          f"tokens total {sum(r['prompt_tokens'] + r['completion_tokens'] for r in results)}")

    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    safe_model = re.sub(r"[^A-Za-z0-9._-]+", "_", model)
    run_file = RUNS_DIR / f"{stamp}-{safe_model}.json"
    run_file.write_text(json.dumps(
        {"model": model, "suite": str(args.suite), "success_rate": rate,
         "gate": GATE_POINTS, "results": results}, indent=2))
    print(f"detail: {run_file}")

    if not BASELINE.exists():
        BASELINE.write_text(json.dumps({"model": model, "success_rate": rate},
                                       indent=2))
        print(f"baseline recorded ({rate}%); the ≥{GATE_POINTS:.0f}pt gate arms "
              "from the next run")
        return 0
    baseline = json.loads(BASELINE.read_text())
    drop = baseline.get("success_rate", 0.0) - rate
    if drop >= GATE_POINTS:
        print(f"REGRESSION: success rate {rate}% is {drop:.1f}pts below baseline "
              f"({baseline.get('success_rate')}%) — release gate FAILED")
        return 1
    if drop > 0:
        print(f"within gate: {drop:.1f}pts below baseline "
              f"({baseline.get('success_rate')}%), threshold {GATE_POINTS:.0f}pts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
