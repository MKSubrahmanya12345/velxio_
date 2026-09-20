"""Opt-in AI endpoint. Never accepts provider URLs or API keys from browsers."""
import asyncio
import json
import secrets

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.agent.models import AgentRequest
from app.agent.runlog import snapshot as run_snapshot
from app.agent.service import ProviderError, run_agent
from app.core.config import settings

router = APIRouter()
_slots = asyncio.Semaphore(2)


def configured():
    return bool(settings.AGENT_ENABLED and settings.AGENT_API_KEY and settings.AGENT_MODEL
                and (settings.AGENT_ACCESS_TOKEN or settings.AGENT_ALLOW_ANONYMOUS))


def authorize(authorization: str | None = Header(default=None)):
    if not configured():
        raise HTTPException(503, "Agent is not configured. See docs/agent-workspace.md.")
    if settings.AGENT_ACCESS_TOKEN and not secrets.compare_digest(
        (authorization or "").encode(), ("Bearer " + settings.AGENT_ACCESS_TOKEN).encode()
    ):
        raise HTTPException(401, "Enter the workspace access token configured by your administrator.")


@router.get("/status")
async def status():
    return {"configured": configured(), "requires_token": bool(settings.AGENT_ACCESS_TOKEN),
            "model": settings.AGENT_MODEL if configured() else None,
            "scope": "Arduino Uno · LED · resistor · button · potentiometer · buzzer · servo"}


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
        try:
            async with asyncio.timeout(240):
                async for event in run_agent(body):
                    if await request.is_disconnected():
                        return
                    yield json.dumps(event, allow_nan=False) + "\n"
        except TimeoutError:
            yield json.dumps({"type": "error", "message": "Agent time limit reached. Your workspace is unchanged; try a smaller request."}) + "\n"
        except Exception as exc:
            # Only explicitly safe provider errors may be shown to the browser.
            message = str(exc) if isinstance(exc, ProviderError) else "Agent service failed. Check backend connectivity and model configuration, then retry."
            yield json.dumps({"type": "error", "message": message}) + "\n"
        finally:
            _slots.release()

    return StreamingResponse(stream(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
