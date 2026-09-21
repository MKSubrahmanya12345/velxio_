"""Velxio ↔ Forge bridge — optional JEV-governed project memory for the agent.

A *direct connection*, by design: nothing from ``<repo>/forge`` is copied or
re-implemented here. Forge is a standalone Node service (``forge/server``) and
the bridge talks to its HTTP API live on every turn, so any change to the forge
codebase is immediately the behavior the agent sees — especially when the bridge
autostarts it as ``node --watch``, which restarts on every forge edit.

Guarantees:
- Fail-open. Forge unreachable/disabled/failed ⇒ the agent runs exactly as
  before, with no memory context. A memory layer must never break a build run.
- No secrets. The bridge never forwards provider keys; it only relays text and
  reads forge's public health shape.
- Runtime toggle: the browser can flip memory on/off without a backend restart.
  The toggle persists to ``backend/data/forge_state.json`` (file wins over the
  ``FORGE_ENABLED`` env default).

State kept here: session → forge-conversation ids, the runtime toggle, and the
autostarted child pid. All atomic writes; a corrupt state file resets in-memory
rather than crashing startup.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
from pathlib import Path

import httpx

from app.core.config import settings

REPO_ROOT = Path(__file__).resolve().parents[3]
FORGE_SERVER_DIR = REPO_ROOT / "forge" / "server"


class ForgeUnavailable(Exception):
    """Forge is not reachable right now (never raised to the agent loop)."""


# ── persisted state (toggle override + session → conversation ids) ──────────

def _state_path() -> Path:
    return REPO_ROOT / "backend" / "data" / "forge_state.json"


_lock = asyncio.Lock()


def _load_state() -> dict:
    try:
        data = json.loads(_state_path().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_state(state: dict) -> None:
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def is_enabled() -> bool:
    """The browser toggle wins; otherwise the FORGE_ENABLED env default."""
    state = _load_state()
    if isinstance(state.get("enabled"), bool):
        return state["enabled"]
    return bool(settings.FORGE_ENABLED)


async def set_enabled(enabled: bool) -> None:
    async with _lock:
        state = _load_state()
        state["enabled"] = bool(enabled)
        _save_state(state)


def _base_url() -> str:
    return (settings.FORGE_BASE_URL or "http://127.0.0.1:4321").rstrip("/")


# ── forge server lifecycle (autostart + --watch keeps it live against edits) ─

_proc: asyncio.subprocess.Process | None = None


def _proc_alive() -> bool:
    return _proc is not None and _proc.returncode is None


async def _spawn() -> bool:
    """Start `node --watch src/index.js` in forge/server. Returns whether a
    server is now ours to wait for. Missing forge or node is a quiet no.

    The child is a repo-shipped file run detached (own session), logged to
    backend/data/forge_server.log, and never spawned unless FORGE_AUTOSTART is
    on. asyncio's subprocess primitive keeps the event loop free while node
    boots; a backend restart orphans only a dev convenience — set
    FORGE_AUTOSTART=false (or run forge yourself) to opt out entirely.
    """
    global _proc
    if _proc_alive():
        return True
    if not settings.FORGE_AUTOSTART:
        return False
    if not (FORGE_SERVER_DIR / "src" / "index.js").exists():
        return False
    node = shutil.which("node")
    if not node:
        return False
    log_path = _state_path().parent / "forge_server.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        raw_port = _base_url().rsplit(":", 1)[-1]
        env = dict(os.environ)
        if raw_port.isdigit():
            env["PORT"] = raw_port
        with log_path.open("ab") as log:
            _proc = await asyncio.create_subprocess_exec(
                node, "--watch", "src/index.js",
                cwd=str(FORGE_SERVER_DIR), stdout=log, stderr=log,
                stdin=asyncio.subprocess.DEVNULL, env=env,
                **({} if os.name == "nt" else {"start_new_session": True}),
            )
        state = _load_state()
        state["pid"] = _proc.pid
        state["pid_started_at"] = time.time()
        _save_state(state)
        return True
    except OSError:
        return False


async def _wait_live(deadline_s: float) -> bool:
    end = time.monotonic() + max(0.0, deadline_s)
    while time.monotonic() < end:
        if await _probe(timeout=1.5) is not None:
            return True
        if _proc is not None and _proc.returncode is not None:
            return False  # our spawn exited (e.g. node deps not installed)
        await asyncio.sleep(0.4)
    return False


async def ensure_live() -> tuple[bool, dict]:
    """(live, health). Probes once; autostarts and waits only when configured."""
    health = await _probe()
    if health is not None:
        return True, health
    if not await _spawn():
        return False, {}
    if await _wait_live(settings.FORGE_SPAWN_WAIT_S):
        return True, await _probe() or {}
    return False, {}


async def _probe(timeout: float = 2.0) -> dict | None:
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.get(f"{_base_url()}/api/health")
            if res.status_code == 200:
                data = res.json()
                return data if isinstance(data, dict) else {}
    except (httpx.HTTPError, ValueError, OSError):
        return None
    return None


# ── HTTP helpers against the live forge API ─────────────────────────────────

async def _request(method: str, path: str, body: dict | None = None,
                   timeout: float = 8.0) -> dict:
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.request(method, f"{_base_url()}{path}", json=body)
    except httpx.HTTPError as exc:
        raise ForgeUnavailable(f"forge is not reachable at {_base_url()} ({type(exc).__name__})") from None
    if res.status_code >= 400:
        raise ForgeUnavailable(f"forge returned HTTP {res.status_code} for {path}")
    try:
        data = res.json()
    except ValueError:
        raise ForgeUnavailable(f"forge returned a non-JSON response for {path}") from None
    return data if isinstance(data, dict) else {}


def _sessions() -> dict:
    state = _load_state()
    sessions = state.get("sessions")
    return sessions if isinstance(sessions, dict) else {}


async def _conversation_for(session: str, first_prompt: str) -> str:
    """Reuse this session's forge conversation, creating it on first use."""
    sessions = _sessions()
    conv_id = sessions.get(session)
    if isinstance(conv_id, str) and conv_id:
        return conv_id
    data = await _request("POST", "/api/chat", {"goal": first_prompt[:12000]},
                          timeout=settings.FORGE_TURN_TIMEOUT_S)
    conv = data.get("conversation") if isinstance(data.get("conversation"), dict) else data
    conv_id = str(conv.get("id") or data.get("id") or "")
    if not conv_id:
        raise ForgeUnavailable("forge created a conversation without an id")
    state = _load_state()
    state.setdefault("sessions", {})[session] = conv_id
    _save_state(state)
    return conv_id


def _notes_of(conversation: dict) -> list[dict]:
    memory = conversation.get("memory") if isinstance(conversation.get("memory"), dict) else {}
    notes = memory.get("notes") if isinstance(memory.get("notes"), list) else []
    return [n for n in notes if isinstance(n, dict)]


def _context_block(active: list[dict], tentative: list[dict]) -> str:
    """Prompt text for the agent: what the user has established, per JEV."""
    if not active and not tentative:
        return ""
    lines = ["PROJECT MEMORY (user-established, JEV-reviewed; rules are binding):"]
    for note in active[:30]:
        kind = str(note.get("kind", "note"))[:12]
        text = str(note.get("text", ""))[:300].replace("\n", " ")
        if text:
            lines.append(f"- [{kind}] {text}")
    if tentative:
        lines.append("Open, unconfirmed items (never treat as established):")
        for note in tentative[:10]:
            text = str(note.get("text", ""))[:160].replace("\n", " ")
            if text:
                lines.append(f"- [{str(note.get('kind', 'note'))[:12]}?] {text}")
    block = "\n".join(lines)
    return block[:2500]


def _turn_summary(conversation: dict, response: dict) -> dict:
    notes = _notes_of(conversation)
    active = [n for n in notes if n.get("status") == "active"]
    guard = next((d for d in conversation.get("decisions", []) or response.get("decisions", []) or []
                  if isinstance(d, dict) and d.get("kind") == "memory_guard"), None)
    if guard is None:
        guard = next((d for d in (response.get("decisions") or [])
                      if isinstance(d, dict) and d.get("kind") == "memory_guard"), None)
    return {
        "conversation_id": str(conversation.get("id", "")),
        "active_notes": len(active),
        "open_notes": len([n for n in notes if n.get("status") in ("pending", "proposed")]),
        "withheld": bool((response.get("meta") or {}).get("withheld")),
        "jev_calls": conversation.get("counters", {}).get("jevCalls") if isinstance(conversation.get("counters"), dict) else None,
        "guard": str((guard or {}).get("summary", ""))[:400],
    }


async def run_turn(prompt: str, session: str = "default") -> dict:
    """One guarded forge turn for the agent's user prompt.

    Returns {ok, context, summary} — on any failure ok=False and context=""
    so the caller can fail open. Never raises to the agent loop.
    """
    if not is_enabled() or not str(prompt or "").strip():
        return {"ok": False, "context": "", "summary": {}, "error": "forge memory is disabled"}
    live, _health = await ensure_live()
    if not live:
        return {"ok": False, "context": "", "summary": {},
                "error": "forge service is not reachable and autostart is off or failed"}
    try:
        conv_id = await _conversation_for(session, prompt)
        data = await _request("POST", f"/api/chat/{conv_id}/messages",
                              {"text": prompt[:12000]}, timeout=settings.FORGE_TURN_TIMEOUT_S)
        conversation = data.get("conversation") if isinstance(data.get("conversation"), dict) else {}
        response = data.get("response") if isinstance(data.get("response"), dict) else {}
        notes = _notes_of(conversation)
        active = [n for n in notes if n.get("status") == "active"]
        tentative = [n for n in notes if n.get("status") in ("pending", "proposed")]
        return {"ok": True, "context": _context_block(active, tentative),
                "summary": _turn_summary({**conversation, "id": conv_id}, response)}
    except ForgeUnavailable as exc:
        return {"ok": False, "context": "", "summary": {}, "error": str(exc)[:300]}
    except Exception as exc:  # a memory layer must never sink a build run
        return {"ok": False, "context": "", "summary": {}, "error": f"forge turn failed: {type(exc).__name__}"}


async def memory_snapshot(session: str) -> dict:
    """Notes + recent checks for one session, for the panel UI."""
    conv_id = _sessions().get(session)
    if not is_enabled():
        return {"enabled": False, "conversation_id": None, "notes": []}
    if not isinstance(conv_id, str) or not conv_id:
        return {"enabled": True, "conversation_id": None, "notes": [],
                "message": "Memory starts on your first agent prompt in this workspace."}
    try:
        data = await _request("GET", f"/api/chat/{conv_id}")
        conversation = data.get("conversation") if isinstance(data.get("conversation"), dict) else data
        notes = [{
            "kind": n.get("kind"), "status": n.get("status"), "domain": n.get("domain"),
            "text": str(n.get("text", ""))[:300], "reason": str(n.get("reason", ""))[:220],
        } for n in _notes_of(conversation) if n.get("status") in ("active", "pending", "proposed")]
        events = (conversation.get("memory") or {}).get("events") if isinstance(conversation.get("memory"), dict) else []
        checks = [e for e in (events or [])[-12:] if isinstance(e, dict) and e.get("stage") in ("review", "check")]
        return {"enabled": True, "conversation_id": conv_id, "notes": notes[:60],
                "checks": [{"stage": c.get("stage"), "status": c.get("status"),
                            "label": str(c.get("label", ""))[:240]} for c in checks]}
    except ForgeUnavailable as exc:
        return {"enabled": True, "conversation_id": conv_id, "notes": [], "error": str(exc)[:300]}


async def status() -> dict:
    """What the settings UI shows. Public: no secrets, only lability facts.
    Never spawns here — autostart belongs to the explicit toggle and to the
    first agent turn, not to every status poll."""
    state = _load_state()
    health = await _probe() or {}
    providers = health.get("providers") if isinstance(health.get("providers"), dict) else {}
    return {
        "enabled": is_enabled(),
        "base_url": _base_url(),
        "live": bool(health),
        "autostart": bool(settings.FORGE_AUTOSTART),
        "forge_present": (FORGE_SERVER_DIR / "src" / "index.js").exists(),
        "managed_pid": _proc.pid if _proc_alive() else state.get("pid"),
        "providers": {"jev": providers.get("jev", "unknown"), "planner": providers.get("planner", "unknown")},
        "sessions": len(_sessions()),
    }
