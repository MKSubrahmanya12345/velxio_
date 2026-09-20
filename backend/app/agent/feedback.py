"""Mid-run user feedback channel.

HTTP is a one-way stream from server to browser, but users need to be able to
steer a long-running agent ("actually use pin 9, not 13", "skip the buzzer")
without waiting for all repair attempts to finish.

We expose a tiny in-memory registry keyed by run_id: a running loop can
`register()` a queue, `await get()` between turns, and the HTTP endpoint
`POST /runs/{run_id}/feedback` calls `push()`. Feedback older than 5 minutes
is evicted so a stale run_id can't leak memory.
"""
import asyncio
import time
import uuid
from typing import Optional

_TTL_S = 300
_registry: dict[str, tuple[asyncio.Queue[str], float]] = {}


def _sweep() -> None:
    now = time.monotonic()
    stale = [k for k, (_, t) in _registry.items() if now - t > _TTL_S]
    for k in stale:
        _registry.pop(k, None)


def register(run_id: Optional[str] = None) -> tuple[str, asyncio.Queue[str]]:
    _sweep()
    rid = run_id or uuid.uuid4().hex[:12]
    _registry[rid] = (asyncio.Queue(maxsize=8), time.monotonic())
    return rid, _registry[rid][0]


def push(run_id: str, note: str) -> bool:
    _sweep()
    entry = _registry.get(run_id)
    if entry is None:
        return False
    q, _ = entry
    try:
        q.put_nowait(note.strip()[:1000])
    except asyncio.QueueFull:
        return False
    return True


def unregister(run_id: str) -> None:
    _registry.pop(run_id, None)
