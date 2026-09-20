"""Bounded in-memory run records for the agent.

The OSS backend is deliberately stateless (no DB), so these are per-worker
diagnostics — enough to answer "what did the agent do and what did it cost?"
across the last N runs, exposed at GET /agent/runs/records (same bearer token
as the run endpoint). They are NOT persisted: restarts clear them, and the
structured logs remain the durable trail.
"""
from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass, field, asdict


@dataclass
class RunRecord:
    run_id: str
    started: float = field(default_factory=time.monotonic)
    finished: float | None = None
    outcome: str = "running"  # compiled | explained | failed | error | cancelled
    attempts: int = 0
    provider_calls: int = 0
    tool_calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    provider_ms: int = 0
    compile_ms: int = 0
    verified: bool | None = None  # behavioural verification result, if declared
    error: str = ""

    def finish(self, outcome: str, error: str = "") -> dict:
        self.outcome = outcome
        self.error = error[:300]
        self.finished = time.monotonic()
        return asdict(self)


_RECORDS: deque[RunRecord] = deque(maxlen=100)
_LOCK = threading.Lock()


def start(run_id: str) -> RunRecord:
    record = RunRecord(run_id=run_id)
    with _LOCK:
        _RECORDS.append(record)
    return record


def snapshot() -> list[dict]:
    with _LOCK:
        records = list(_RECORDS)
    now = time.monotonic()
    out = []
    for r in records:
        data = asdict(r)
        data["duration_s"] = round((r.finished or now) - r.started, 2)
        data["started_epoch"] = data.pop("started")
        data["finished_epoch"] = r.finished
        out.append(data)
    return out
