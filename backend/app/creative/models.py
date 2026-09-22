"""Pydantic contracts for the Velxio Create API.

Thin validation only — the creative pipeline (collections, ingest, ideas,
scripts, JEV review) runs inside Forge; this backend proxies to it. No
provider URLs or API keys are ever accepted from browsers.
"""
from __future__ import annotations

from pydantic import BaseModel, Field


class CollectionCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class IngestBody(BaseModel):
    url: str = Field(default="", max_length=2000)
    text: str = Field(default="", max_length=120000)
    title: str = Field(default="", max_length=200)


class NotePatch(BaseModel):
    text: str | None = Field(default=None, max_length=2000)
    kind: str | None = Field(default=None, max_length=16)
    domain: str | None = Field(default=None, max_length=16)


class IdeasBody(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    count: int = Field(default=5, ge=3, le=8)


class ScriptBody(BaseModel):
    idea: str | dict = Field()
    prompt: str = Field(default="", max_length=2000)
    format: str = Field(default="video-script", max_length=32)
