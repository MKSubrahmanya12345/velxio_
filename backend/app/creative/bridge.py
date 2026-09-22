"""Thin proxy from /api/creative to the Forge server's creative routes.

Fail-open contract (same as the circuit agent's memory bridge): when Forge is
disabled or unreachable the endpoints answer 503 with an actionable message
instead of hanging or crashing. Long jobs (transcription, ingest, ideas,
scripts) share CREATIVE_JOB_TIMEOUT_S.
"""
from __future__ import annotations

import logging

import httpx
from fastapi import HTTPException

from app.agent import forge as forge_bridge
from app.core.config import settings

logger = logging.getLogger("velxio.creative")

FORMATS = [
    {"id": "video-script", "label": "Video script", "hint": "Hook + beats + CTA"},
    {"id": "blog-post", "label": "Blog post", "hint": "Headline + sections + takeaways"},
    {"id": "tutorial", "label": "Tutorial", "hint": "Parts + steps + checks"},
    {"id": "social-captions", "label": "Social pack", "hint": "X + Instagram + LinkedIn"},
    {"id": "product-copy", "label": "Product copy", "hint": "Pitch + bullets + README"},
]


async def _ensure_base_url() -> str:
    """Forge base URL, autostarting the server when configured to do so."""
    if not settings.FORGE_ENABLED:
        raise HTTPException(
            503,
            "Velxio Create needs the Forge memory service (FORGE_ENABLED=1 in "
            "backend/.env). Restart the API server after enabling it.",
        )
    live, _info = await forge_bridge.ensure_live()
    if not live:
        raise HTTPException(
            503,
            "Forge is unreachable. Start it with `npm start` in forge/server "
            "(or enable FORGE_AUTOSTART) and retry.",
        )
    return settings.FORGE_BASE_URL.rstrip("/")


async def forge_request(method: str, path: str, body: dict | None = None,
                        params: dict | None = None, timeout: float | None = None):
    """Proxied Forge call. Returns decoded JSON; maps Forge errors to HTTP."""
    base_url = await _ensure_base_url()
    timeout_s = timeout if timeout is not None else settings.CREATIVE_JOB_TIMEOUT_S
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            response = await client.request(
                method, f"{base_url}{path}", json=body, params=params)
    except httpx.HTTPError as exc:
        logger.warning("creative forge %s %s failed: %s", method, path, exc)
        raise HTTPException(503, "Forge did not answer. Retry in a moment.") from None
    if response.status_code >= 400:
        try:
            detail = response.json().get("error") or response.json()
        except ValueError:
            detail = f"Forge returned HTTP {response.status_code}."
        raise HTTPException(response.status_code, str(detail)[:500])
    try:
        return response.json()
    except ValueError:
        raise HTTPException(502, "Forge returned an invalid response.") from None
