"""Opt-in AI endpoint. Never accepts provider URLs or API keys from browsers."""
import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.agent import catalog
from app.agent.feedback import push as push_feedback
from app.agent.models import AgentRequest
from app.agent.runlog import snapshot as run_snapshot
from app.agent.service import ProviderError, agent_run_budget_s, run_agent
from app.core.config import settings

router = APIRouter()
_slots = asyncio.Semaphore(2)


def configured():
    return (settings.AGENT_ENABLED
            and any(spec.configured for spec in settings.providers()))


def authorize():
    if not configured():
        raise HTTPException(503, "Agent is not configured. See docs/agent-workspace.md.")


# --- Simulation tools bridge (for external agents, e.g. WireGI) -------------
#
# The MCP server (app/mcp/server.py) holds every simulation capability:
# catalog/pinout lookups, circuit create/update, validation, the real
# arduino-cli compile, headless firmware simulation and the physics runner.
# These two endpoints expose that same toolset over plain JSON so an HTTP
# agent can DISCOVER what the simulator can do (GET /tools) and USE it
# (POST /tools/invoke) without speaking MCP. The tools are local and
# deterministic (no provider keys, no cost), so — like /mcp — they are not
# gated behind `authorize()`.

try:
    from app.mcp import server as _mcp_server
    _TOOLS_ERROR = ""
except Exception as _exc:  # noqa: BLE001 — mcp extras missing: degrade, don't crash the app
    _mcp_server = None
    _TOOLS_ERROR = f"MCP tool bridge unavailable: {type(_exc).__name__}: {_exc}"


@router.get("/tools")
async def tools_index():
    if _mcp_server is None:
        raise HTTPException(503, _TOOLS_ERROR)
    return {"ok": True, "tools": _mcp_server.tool_specs()}


class ToolInvokeBody(BaseModel):
    tool: str = Field(min_length=1, max_length=64)
    args: dict = Field(default_factory=dict)


@router.post("/tools/invoke")
async def tools_invoke(body: ToolInvokeBody):
    if _mcp_server is None:
        raise HTTPException(503, _TOOLS_ERROR)
    # Bound the payload: tool args are circuit documents / source files, which
    # are small; anything huge is a runaway agent, not a design.
    if len(json.dumps(body.args, default=str)) > 512_000:
        raise HTTPException(413, "Tool args too large (512 KB limit).")
    return await _mcp_server.call_tool(body.tool, body.args)


@router.get("/status")
async def status():
    # The browser reads model names/ids only; credentials never leave the server.
    providers = [{"id": p.id, "label": p.label, "model": p.model, "configured": p.configured}
                 for p in settings.providers()]
    default = settings.provider("bedrock")
    if default is None:
        default = next((spec for spec in settings.providers() if spec.configured), None)
    return {"configured": configured(),
            "providers": providers,
            "model": default.model if configured() else None,
            "scope": f"Velxio agent · {len(catalog.BOARDS)} boards · {len(catalog.PARTS)} catalog components · board-aware libraries"}


@router.get("/runs/records", dependencies=[Depends(authorize)])
async def run_records():
    """Recent agent run records (per-worker, in-memory, bounded to 100).

    Ops surface: outcome, attempts, provider/token usage and stage timings
    for the last N runs. Nothing here is persisted — restarts clear it.
    """
    return {"runs": run_snapshot()}


@router.post("/runs", dependencies=[Depends(authorize)])
async def run(body: AgentRequest, request: Request):
    if _slots.locked():
        raise HTTPException(429, "Both agent slots are busy. Try again shortly.")
    await _slots.acquire()

    async def stream():
        # Board-aware deadline: an ESP32/STM32 run compiles for minutes, so
        # the flat AGENT_RUN_TIMEOUT_S cap used to kill the run mid-compile
        # while the (longer) inner compile window was still legal.
        budget = agent_run_budget_s(
            body.project.board.boardKind if body.project.board else None,
            body.fast_mode)
        try:
            async with asyncio.timeout(budget):
                async for event in run_agent(body):
                    if await request.is_disconnected():
                        return
                    yield json.dumps(event, allow_nan=False) + "\n"
        except TimeoutError:
            yield json.dumps({"type": "error",
                              "message": f"Agent time limit reached after "
                                         f"{int(budget)}s. "
                                         f"Your workspace is unchanged. Try a smaller request."}) + "\n"
        except Exception as exc:
            # Only explicitly safe provider errors may be shown to the browser.
            message = str(exc) if isinstance(exc, ProviderError) else "Agent service failed. Check backend connectivity and model configuration, then retry."
            yield json.dumps({"type": "error", "message": message}) + "\n"
        finally:
            _slots.release()

    return StreamingResponse(stream(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


class FeedbackBody(BaseModel):
    note: str = Field(min_length=1, max_length=1000)


@router.get("/forge")
async def forge_status():
    """Forge memory state (toggle, liveness, provider labels — no secrets)."""
    from app.agent import forge as forge_bridge
    return await forge_bridge.status()


class ForgeToggleBody(BaseModel):
    enabled: bool


@router.post("/forge/toggle", dependencies=[Depends(authorize)])
async def forge_toggle(body: ForgeToggleBody):
    """Persist the runtime toggle (wins over the FORGE_ENABLED env default).

    Enabling also verifies the direct connection — when forge is not up and
    autostart is on, the bridge spawns `node --watch` on forge/server, so new
    forge code is live for the agent without touching velxio.
    """
    from app.agent import forge as forge_bridge
    await forge_bridge.set_enabled(body.enabled)
    if body.enabled:
        await forge_bridge.ensure_live()  # verify/start the direct connection now
    return await forge_bridge.status()


@router.get("/forge/memory", dependencies=[Depends(authorize)])
async def forge_memory(session: str = "default"):
    """Current notes + recent JEV checks for one browser workspace session."""
    from app.agent import forge as forge_bridge
    return await forge_bridge.memory_snapshot(session[:80])


@router.post("/runs/{run_id}/feedback", dependencies=[Depends(authorize)])
async def feedback(run_id: str, body: FeedbackBody):
    """Inject a mid-run user note. The running loop folds it into the next turn.

    Returns 404 once the run has finished (its queue is evicted), so a late note
    is a no-op instead of a crash. Notes are rate-limited by the queue cap (8).
    """
    ok = push_feedback(run_id, body.note)
    if not ok:
        raise HTTPException(404, "Run is not accepting feedback (it may have finished).")
    return {"ok": True}
