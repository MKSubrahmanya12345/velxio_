"""Compile as a service (v2): pooled, cached, family-bounded.

`compile()` tool and the final gate share this one path. The pool caps
concurrency (a run can never queue two heavy builds against each other),
the result cache means recompiling an unchanged workspace is free, and the
per-family ceiling is enforced HERE by the pool — never as part of the
agent's reasoning budget. A cold first build of the day queues with the run
alive on heartbeats; that is an ops property, not a governor.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import signal
import subprocess
import sys
from collections import OrderedDict
from pathlib import Path

from app.agent import catalog
from app.agent.models import Project

_POOL = asyncio.Semaphore(2)
_CACHE: "OrderedDict[str, dict]" = OrderedDict()
_CACHE_MAX = 32
_WORKER = Path(__file__).resolve().parents[1] / "agent" / "compile_worker.py"


def family_ceiling_s(board_kind: str | None, fast: bool = False) -> float:
    """Per-family compile budget, enforced by the pool."""
    try:
        family = catalog.board_family(board_kind) if board_kind else "arduino"
    except ValueError:
        family = "arduino"
    if family in {"esp32", "stm32"}:
        return 180.0 if fast else 420.0
    if family == "rp2040":
        return 60.0 if fast else 200.0
    if family == "python":
        return 15.0
    return 30.0 if fast else 120.0


async def compile_project(project: Project, fast: bool = False) -> dict:
    """Compile once per identical project per process; pooled and bounded."""
    key = hashlib.blake2b(
        (project.model_dump_json() + ("|fast" if fast else "")).encode("utf-8"),
        digest_size=16).hexdigest()
    hit = _CACHE.get(key)
    if hit is not None:
        _CACHE.move_to_end(key)
        return hit
    async with _POOL:
        try:
            result = await asyncio.wait_for(
                _compile_uncached(project), timeout=family_ceiling_s(
                    project.board.boardKind if project.board else None, fast))
        except asyncio.TimeoutError:
            result = {"success": False,
                      "error": ("Compilation timed out. The toolchain's build "
                                "cache is warm now — the same design usually "
                                "compiles on the next call.")}
    if result.get("success"):
        _CACHE[key] = result
        if len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)
    return result


async def _compile_uncached(project: Project) -> dict:
    """One disposable worker subprocess so cancellation also terminates
    compiler children (the existing isolation, kept)."""
    backend_root = Path(__file__).resolve().parents[2]
    # Running a script by path puts the SCRIPT's directory on sys.path, not the
    # cwd, so the worker's `from app.agent import ...` needs the backend root
    # on PYTHONPATH — without it the worker dies on import and every compile
    # reports "Compiler process failed".
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(backend_root), *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])])
    process = await asyncio.create_subprocess_exec(
        sys.executable, str(_WORKER),
        cwd=str(backend_root),
        env=env,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE, start_new_session=os.name != "nt",
    )
    try:
        stdout, stderr = await process.communicate(project.model_dump_json().encode())
        marker = b"__VELXIO_AGENT_RESULT__"
        if process.returncode or marker not in stdout:
            # The worker's own traceback is the only diagnosis there is: never
            # discard it behind a generic sentence.
            detail = stderr.decode("utf-8", "replace").strip()[-1200:]
            return {"success": False,
                    "error": "Compiler process failed. Check the Arduino toolchain."
                             + (f"\n{detail}" if detail else "")}
        return json.loads(stdout.rsplit(marker, 1)[1])
    finally:
        if process.returncode is None:
            if os.name != "nt":
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
            else:  # pragma: no cover - Windows CI path
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                               capture_output=True)
            await process.wait()
