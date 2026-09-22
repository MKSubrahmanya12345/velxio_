"""Velxio Create — chat-only content creation backed by Forge memory.

Learn: ingest YouTube/articles/text into collections (transcripts stored,
notes JEV-governed). Create: ideas grounded in a collection, cross-compared
by JEV, expanded into full creator packs. Nodes are manually editable.
"""
import asyncio

from fastapi import APIRouter, HTTPException

from app.agent import forge as forge_bridge
from app.core.config import settings
from app.creative import bridge
from app.creative.models import CollectionCreate, IdeasBody, IngestBody, NotePatch, ScriptBody

router = APIRouter()

# Ingest/ideas/script jobs are slow (transcription, failover rounds); bound
# concurrency so one user cannot stack up Forge jobs.
_slots = asyncio.Semaphore(2)


@router.get("/status")
async def status():
    """Public status: Forge reachability, JEV/provider summary, formats."""
    live, info = (False, {})
    if settings.FORGE_ENABLED:
        try:
            live, info = await forge_bridge.ensure_live()
        except Exception:
            live, info = False, {}
    return {
        "enabled": settings.FORGE_ENABLED,
        "live": live,
        "base_url": settings.FORGE_BASE_URL,
        "forge": info,
        "formats": bridge.FORMATS,
    }


@router.post("/collections")
async def create_collection(body: CollectionCreate):
    return await bridge.forge_request(
        "POST", "/api/creative/collections", {"name": body.name}, timeout=15.0)


@router.get("/collections")
async def list_collections():
    return await bridge.forge_request(
        "GET", "/api/creative/collections", timeout=15.0)


@router.get("/collections/{collection_id}")
async def collection_detail(collection_id: str):
    return await bridge.forge_request(
        "GET", f"/api/creative/collections/{collection_id}", timeout=30.0)


@router.delete("/collections/{collection_id}")
async def delete_collection(collection_id: str):
    return await bridge.forge_request(
        "DELETE", f"/api/creative/collections/{collection_id}", timeout=15.0)


@router.post("/collections/{collection_id}/ingest")
async def ingest(collection_id: str, body: IngestBody):
    if not body.url.strip() and not body.text.strip():
        raise HTTPException(400, "Provide a URL or pasted text to ingest.")
    if _slots.locked():
        raise HTTPException(429, "Both creative slots are busy. Try again shortly.")
    await _slots.acquire()
    try:
        payload = {"url": body.url.strip(), "text": body.text,
                   "title": body.title.strip()}
        return await bridge.forge_request(
            "POST", f"/api/creative/collections/{collection_id}/ingest", payload)
    finally:
        _slots.release()


@router.get("/collections/{collection_id}/notes")
async def list_notes(collection_id: str, q: str = ""):
    params = {"q": q} if q.strip() else None
    return await bridge.forge_request(
        "GET", f"/api/creative/collections/{collection_id}/notes",
        params=params, timeout=15.0)


@router.patch("/collections/{collection_id}/notes/{note_id}")
async def patch_note(collection_id: str, note_id: str, body: NotePatch):
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if not patch:
        raise HTTPException(400, "Nothing to update.")
    return await bridge.forge_request(
        "PATCH", f"/api/creative/collections/{collection_id}/notes/{note_id}",
        patch, timeout=15.0)


@router.delete("/collections/{collection_id}/notes/{note_id}")
async def remove_note(collection_id: str, note_id: str):
    return await bridge.forge_request(
        "DELETE", f"/api/creative/collections/{collection_id}/notes/{note_id}",
        timeout=15.0)


@router.post("/collections/{collection_id}/ideas")
async def ideas(collection_id: str, body: IdeasBody):
    if _slots.locked():
        raise HTTPException(429, "Both creative slots are busy. Try again shortly.")
    await _slots.acquire()
    try:
        return await bridge.forge_request(
            "POST", f"/api/creative/collections/{collection_id}/ideas",
            {"prompt": body.prompt, "count": body.count})
    finally:
        _slots.release()


@router.post("/collections/{collection_id}/script")
async def script(collection_id: str, body: ScriptBody):
    if _slots.locked():
        raise HTTPException(429, "Both creative slots are busy. Try again shortly.")
    await _slots.acquire()
    try:
        idea = body.idea
        if isinstance(idea, dict):
            idea = f"{idea.get('title', '')}\n{idea.get('pitch', '')}".strip()
        return await bridge.forge_request(
            "POST", f"/api/creative/collections/{collection_id}/script",
            {"idea": idea, "prompt": body.prompt, "format": body.format})
    finally:
        _slots.release()
