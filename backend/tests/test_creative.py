"""Offline creative contract tests: proxy shaping, validation, fail-open status."""
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api.routes import creative
from app.creative import bridge
from app.creative.models import IdeasBody, IngestBody


@pytest.fixture()
def client():
    app = FastAPI()
    app.include_router(creative.router, prefix="/api/creative")
    return TestClient(app, raise_server_exceptions=False)


def test_ideas_count_bounds():
    assert IdeasBody(prompt="x", count=3).count == 3
    with pytest.raises(ValidationError):
        IdeasBody(prompt="x", count=9)
    with pytest.raises(ValidationError):
        IdeasBody(prompt="", count=5)


def test_ingest_body_defaults():
    body = IngestBody()
    assert body.url == "" and body.text == ""


def test_status_fail_open_when_forge_down(client, monkeypatch):
    async def down():
        return False, {}
    monkeypatch.setattr(creative.forge_bridge, "ensure_live", down)
    monkeypatch.setattr(creative.settings, "FORGE_ENABLED", True)
    res = client.get("/api/creative/status")
    assert res.status_code == 200
    payload = res.json()
    assert payload["live"] is False
    assert any(f["id"] == "video-script" for f in payload["formats"])


def test_status_disabled_reports_cleanly(client, monkeypatch):
    monkeypatch.setattr(creative.settings, "FORGE_ENABLED", False)
    res = client.get("/api/creative/status")
    assert res.json()["enabled"] is False
    assert res.json()["live"] is False


def test_ingest_rejects_empty_without_touching_forge(client, monkeypatch):
    proxy = AsyncMock()
    monkeypatch.setattr(bridge, "forge_request", proxy)
    res = client.post("/api/creative/collections/c1/ingest", json={})
    assert res.status_code == 400
    proxy.assert_not_called()


def test_ingest_proxies_payload(client, monkeypatch):
    proxy = AsyncMock(return_value={"notes": []})
    monkeypatch.setattr(bridge, "forge_request", proxy)
    res = client.post("/api/creative/collections/c1/ingest", json={"url": "https://youtu.be/x"})
    assert res.status_code == 200
    proxy.assert_called_once()
    args, _ = proxy.call_args
    assert args[0] == "POST"
    assert args[1] == "/api/creative/collections/c1/ingest"
    assert args[2]["url"] == "https://youtu.be/x"


def test_script_idea_dict_flattens_to_text(client, monkeypatch):
    proxy = AsyncMock(return_value={"script": "x" * 500})
    monkeypatch.setattr(bridge, "forge_request", proxy)
    res = client.post("/api/creative/collections/c1/script", json={
        "idea": {"title": "T", "pitch": "P"}, "format": "blog-post"})
    assert res.status_code == 200
    payload = proxy.call_args[0][2]
    assert payload["idea"] == "T\nP"
    assert payload["format"] == "blog-post"


def test_patch_note_drops_null_fields(client, monkeypatch):
    proxy = AsyncMock(return_value={"note": {}})
    monkeypatch.setattr(bridge, "forge_request", proxy)
    res = client.patch("/api/creative/collections/c1/notes/n1", json={"text": "edited"})
    assert res.status_code == 200
    assert proxy.call_args[0][2] == {"text": "edited"}


def test_patch_note_empty_is_400(client, monkeypatch):
    proxy = AsyncMock()
    monkeypatch.setattr(bridge, "forge_request", proxy)
    res = client.patch("/api/creative/collections/c1/notes/n1", json={})
    assert res.status_code == 400
    proxy.assert_not_called()


def test_ideas_count_validated_at_boundary(client, monkeypatch):
    proxy = AsyncMock(return_value={"ideas": []})
    monkeypatch.setattr(bridge, "forge_request", proxy)
    assert client.post("/api/creative/collections/c1/ideas", json={"prompt": "p", "count": 2}).status_code == 422
    assert client.post("/api/creative/collections/c1/ideas", json={"prompt": "p", "count": 8}).status_code == 200


@pytest.mark.asyncio()
async def test_bridge_refuses_when_forge_disabled(monkeypatch):
    from fastapi import HTTPException
    monkeypatch.setattr(bridge.settings, "FORGE_ENABLED", False)
    with pytest.raises(HTTPException) as exc:
        await bridge.forge_request("GET", "/api/creative/collections")
    assert exc.value.status_code == 503
