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
    monotonic_start: float = field(default_factory=time.monotonic)
    started_at: float = field(default_factory=time.time)  # wall clock (epoch s)
    finished: float | None = None
    outcome: str = "running"  # compiled | explained | failed | error | cancelled
    provider: str = ""  # which provider spec routed this run (bedrock is the only one)
    attempts: int = 0
    provider_calls: int = 0
    tool_calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    # Measured cache activity (Bedrock prompt caching). prompt_tokens above is
    # the TRUE full input basis (inputTokens + cacheRead + cacheWrite); these
    # two carry the split so the cost model can price real spend.
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    # Per-call trace (stage, attempt, ms, tokens incl. cached) — the answer
    # to "which round was slow". JSON-fix sub-calls are best-effort and are
    # not tracked individually; provider_calls/provider_ms cover them only in
    # aggregate.
    calls: list[dict] = field(default_factory=list)
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
        data["duration_s"] = round((r.finished or now) - r.monotonic_start, 2)
        data.pop("monotonic_start", None)
        data["finished_epoch"] = r.finished
        out.append(data)
    return out
