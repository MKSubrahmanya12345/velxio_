"""Bedrock Converse streaming + prompt-cache contract tests.

No network, no paid calls: boto3/botocore are faked at the module boundary and
the streaming consumer (`_bedrock_converse_streaming`) is driven directly with
event sequences. Pins the two properties that matter:

  - the ONE thread bound: the boto3 config carries read_timeout from
    AGENT_STREAM_TTFB_S and retries max_attempts=1 — no second timer exists
  - cache tokens are MEASURED, never implied: prompt_tokens is the true full
    input basis (inputTokens + cacheRead + cacheWrite), the split is kept,
    and the probe fails fast when a model reports no cache usage
"""
from __future__ import annotations

import json
import sys
import types
from unittest.mock import AsyncMock

import pytest

from app.agent import service
from app.core.config import settings


# --- a fake boto3/botocore ----------------------------------------------------

class FakeConfig:
    def __init__(self, **kwargs):
        self.kwargs = kwargs


class FakeBotoCoreError(Exception):
    pass


class FakeClientError(Exception):
    def __init__(self, code="InvalidRequest", status=400):
        super().__init__(code)
        self.response = {"Error": {"Code": code},
                         "ResponseMetadata": {"HTTPStatusCode": status}}


def install_fake_boto3(monkeypatch, client):
    boto3 = types.ModuleType("boto3")
    boto3.client = lambda *a, **k: client
    botocore = types.ModuleType("botocore")
    config_mod = types.ModuleType("botocore.config")
    config_mod.Config = FakeConfig
    exc_mod = types.ModuleType("botocore.exceptions")
    exc_mod.BotoCoreError = FakeBotoCoreError
    exc_mod.ClientError = FakeClientError
    botocore.config = config_mod
    botocore.exceptions = exc_mod
    for name, mod in {"boto3": boto3, "botocore": botocore,
                      "botocore.config": config_mod,
                      "botocore.exceptions": exc_mod}.items():
        monkeypatch.setitem(sys.modules, name, mod)


class FakeConverseClient:
    """converse_stream(**request) -> {"stream": <iterable of events>}."""

    def __init__(self, events=None, error=None):
        self.events = events or []
        self.error = error
        self.requests: list[dict] = []

    def converse_stream(self, **request):
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        return {"stream": iter(self.events)}


def spec() -> "service.ProviderSpec":
    return service.ProviderSpec(id="bedrock", label="Amazon Bedrock",
                                model="test-model", region="us-east-1")


def text_event(piece: str, index: int = 0) -> dict:
    return {"contentBlockDelta": {"contentBlockIndex": index,
                                  "delta": {"text": piece}}}


def metadata_event(**usage) -> dict:
    return {"metadata": {"usage": usage}}


# --- the streaming consumer ----------------------------------------------------

def test_tool_use_deltas_assemble_into_calls(monkeypatch):
    events = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"contentBlockIndex": 1,
                               "start": {"toolUse": {"toolUseId": "t1",
                                                     "name": "write_file"}}}},
        text_event("hello ", 0), text_event("world", 0),
        {"contentBlockDelta": {"contentBlockIndex": 1,
                               "delta": {"toolUse": {"input": '{"name":'}}}},
        {"contentBlockDelta": {"contentBlockIndex": 1,
                               "delta": {"toolUse": {"input": ' "sketch.ino"}'}}}},
        {"messageStop": {"stopReason": "tool_use"}},
        metadata_event(inputTokens=100, outputTokens=20),
    ]
    client = FakeConverseClient(events)
    install_fake_boto3(monkeypatch, client)
    seen: list[str] = []
    token = service._stream_sink.set(lambda n, piece="": seen.append(piece))
    try:
        result = service._bedrock_converse_streaming(
            [{"role": "user", "content": "hi"}], spec(), 1000, "all")
    finally:
        service._stream_sink.reset(token)
    assert result.content == "hello world"
    assert result.tool_calls == [{"id": "t1", "name": "write_file",
                                  "arguments": '{"name": "sketch.ino"}'}]
    assert result.usage == {"prompt_tokens": 100, "completion_tokens": 20,
                            "total_tokens": 120}
    assert "".join(seen) == "hello world"


def test_read_timeout_is_the_one_thread_bound(monkeypatch):
    """max_attempts=1 + read_timeout=AGENT_STREAM_TTFB_S, nothing else."""
    monkeypatch.setattr(settings, "AGENT_STREAM_TTFB_S", 45.0)
    client = FakeConverseClient([{"messageStart": {"role": "assistant"}}])
    captured: dict = {}

    def fake_client(service_name, config=None, **kwargs):
        captured["config"] = config
        return client

    install_fake_boto3(monkeypatch, client)
    sys.modules["boto3"].client = fake_client
    service._bedrock_converse_streaming([{"role": "user", "content": "x"}],
                                        spec(), 16, None)
    cfg = captured["config"]
    assert isinstance(cfg, FakeConfig)
    assert cfg.kwargs["retries"] == {"max_attempts": 1}
    assert cfg.kwargs["read_timeout"] == 45.0


def test_cache_tokens_make_prompt_tokens_the_full_basis(monkeypatch):
    """inputTokens EXCLUDES cached tokens on Bedrock: prompt_tokens must be
    input + cacheRead + cacheWrite, with the split kept alongside."""
    events = [metadata_event(inputTokens=300, outputTokens=50,
                             cacheReadInputTokens=900,
                             cacheWriteInputTokens=1200)]
    client = FakeConverseClient(events)
    install_fake_boto3(monkeypatch, client)
    result = service._bedrock_converse_streaming([{"role": "user", "content": "x"}],
                                                 spec(), 16, None)
    assert result.usage == {"prompt_tokens": 2400, "completion_tokens": 50,
                            "total_tokens": 2450,
                            "cache_read_tokens": 900,
                            "cache_write_tokens": 1200}


def test_throttling_is_transient_and_4xx_is_rejected(monkeypatch):
    client = FakeConverseClient(error=FakeClientError("ThrottlingException", 429))
    install_fake_boto3(monkeypatch, client)
    with pytest.raises(service.ProviderTransientError):
        service._bedrock_converse_streaming([{"role": "user", "content": "x"}],
                                            spec(), 16, None)
    client = FakeConverseClient(error=FakeClientError("AccessDeniedException", 403))
    install_fake_boto3(monkeypatch, client)
    with pytest.raises(service.ProviderRejected):
        service._bedrock_converse_streaming([{"role": "user", "content": "x"}],
                                            spec(), 16, None)


def test_dropped_stream_is_transient(monkeypatch):
    client = FakeConverseClient([text_event("partial")])
    install_fake_boto3(monkeypatch, client)
    client.converse_stream = lambda **k: (_ for _ in ()).throw(FakeBotoCoreError("read timed out"))
    with pytest.raises(service.ProviderTransientError):
        service._bedrock_converse_streaming([{"role": "user", "content": "x"}],
                                            spec(), 16, None)


def test_truncated_tool_call_is_transient_not_a_tool_error(monkeypatch):
    events = [
        {"contentBlockStart": {"contentBlockIndex": 0,
                               "start": {"toolUse": {"toolUseId": "t9",
                                                     "name": "write_file"}}}},
        {"contentBlockDelta": {"contentBlockIndex": 0,
                               "delta": {"toolUse": {"input": '{"name":'}}}},
        metadata_event(inputTokens=10, outputTokens=5),
    ]
    client = FakeConverseClient(events)
    install_fake_boto3(monkeypatch, client)
    with pytest.raises(service.ProviderTransientError):
        service._bedrock_converse_streaming([{"role": "user", "content": "x"}],
                                            spec(), 16, None)


# --- live typing: write_file content streams out of the tool deltas -----------

def test_partial_json_field_extracts_growing_content():
    from app.agent.service import _json_field
    buf = '{"name": "sketch.ino", "content": "void se'
    assert _json_field(buf, "name") == ("sketch.ino", True)
    assert _json_field(buf, "content") == ("void se", False)
    assert _json_field('{"other": 1}', "content") is None
    assert _json_field('{"content":', "content") is None  # not started
    # escapes decode as they complete; a partial escape holds back
    assert _json_field('{"content": "a\\nb\\\"c"}', "content") == ('a\nb"c', True)
    assert _json_field('{"content": "abc\\u0', "content") == ("abc", False)
    # a field whose value is not a string is never reported
    assert _json_field('{"content": null}', "content") is None


def test_write_file_deltas_stream_through_the_file_sink(monkeypatch):
    """The editor typing animation's server half: name (closed) + content
    (growing) land in the file sink on every delta that grows the body."""
    events = [
        {"contentBlockStart": {"contentBlockIndex": 0,
                               "start": {"toolUse": {"toolUseId": "t1",
                                                     "name": "write_file"}}}},
        {"contentBlockDelta": {"contentBlockIndex": 0,
                               "delta": {"toolUse": {"input": '{"name": "sketch.ino", '}}}},
        {"contentBlockDelta": {"contentBlockIndex": 0,
                               "delta": {"toolUse": {"input": '"content": "void s'}}}},
        {"contentBlockDelta": {"contentBlockIndex": 0,
                               "delta": {"toolUse": {"input": 'etup(){}"}'}}}},
        metadata_event(inputTokens=10, outputTokens=5),
    ]
    client = FakeConverseClient(events)
    install_fake_boto3(monkeypatch, client)
    seen: list[tuple[str, str]] = []
    token = service._file_sink.set(lambda n, c: seen.append((n, c)))
    try:
        result = service._bedrock_converse_streaming(
            [{"role": "user", "content": "x"}], spec(), 100, "all")
    finally:
        service._file_sink.reset(token)
    # nothing reported before the content field started; growth is monotonic
    assert seen == [("sketch.ino", "void s"), ("sketch.ino", "void setup(){}")]
    # and the finished call still assembles into a normal tool call
    assert result.tool_calls[0]["name"] == "write_file"


def test_non_write_file_deltas_do_not_touch_the_file_sink(monkeypatch):
    events = [
        {"contentBlockStart": {"contentBlockIndex": 0,
                               "start": {"toolUse": {"toolUseId": "t2",
                                                     "name": "read_file"}}}},
        {"contentBlockDelta": {"contentBlockIndex": 0,
                               "delta": {"toolUse": {"input": '{"name": "sketch.ino"}'}}}},
    ]
    client = FakeConverseClient(events)
    install_fake_boto3(monkeypatch, client)
    seen: list[tuple[str, str]] = []
    token = service._file_sink.set(lambda n, c: seen.append((n, c)))
    try:
        service._bedrock_converse_streaming([{"role": "user", "content": "x"}],
                                            spec(), 100, "all")
    finally:
        service._file_sink.reset(token)
    assert seen == []


# --- cache points: measured, placed at the stable boundary ---------------------

def test_cache_off_sends_no_cache_points(monkeypatch):
    monkeypatch.setattr(settings, "BEDROCK_PROMPT_CACHE", "off")
    messages = service._base_messages(_request(), _ws())
    client = FakeConverseClient([metadata_event(inputTokens=10, outputTokens=1)])
    install_fake_boto3(monkeypatch, client)
    service._bedrock_converse_streaming(messages, spec(), 16, None)
    request = client.requests[0]
    assert not any("cachePoint" in block for block in request["system"])
    assert not any("cachePoint" in block
                   for m in request["messages"] for block in m["content"])


def test_cache_on_places_points_at_system_and_history_boundary(monkeypatch):
    monkeypatch.setattr(settings, "BEDROCK_PROMPT_CACHE", "on")
    messages = service._base_messages(_request(), _ws())
    client = FakeConverseClient([metadata_event(inputTokens=10, outputTokens=1)])
    install_fake_boto3(monkeypatch, client)
    service._bedrock_converse_streaming(messages, spec(), 16, None)
    request = client.requests[0]
    # system: cachePoint is the LAST block
    assert "cachePoint" in request["system"][-1]
    # exactly one message-level cachePoint, sitting between history text and
    # the CURRENT WORKSPACE state text
    flat = [block for m in request["messages"] for block in m["content"]]
    points = [i for i, b in enumerate(flat) if "cachePoint" in b]
    assert len(points) == 1
    at = points[0]
    assert any("CURRENT WORKSPACE" in b.get("text", "") for b in flat[at + 1:])


def test_cache_on_without_history_skips_the_message_point(monkeypatch):
    """No history => nothing stable above the state; only the system point
    (which the system prompt alone justifies) may be emitted."""
    monkeypatch.setattr(settings, "BEDROCK_PROMPT_CACHE", "on")
    request = _request(history=False)
    messages = service._base_messages(request, _ws())
    client = FakeConverseClient([metadata_event(inputTokens=10, outputTokens=1)])
    install_fake_boto3(monkeypatch, client)
    service._bedrock_converse_streaming(messages, spec(), 16, None)
    request_body = client.requests[0]
    assert "cachePoint" in request_body["system"][-1]
    assert not any("cachePoint" in block
                   for m in request_body["messages"] for block in m["content"])


def test_mantle_body_strips_private_markers(monkeypatch):
    monkeypatch.setattr(settings, "BEDROCK_PROMPT_CACHE", "on")
    messages = service._base_messages(_request(), _ws())
    body = service._mantle_body(spec(), messages, 1000, None)
    assert all(set(m.keys()) == {"role", "content"} for m in body["messages"])


# --- the probe measures caching; it never assumes it ---------------------------

@pytest.mark.asyncio
async def test_probe_fails_fast_when_cache_requested_but_unreported(monkeypatch):
    monkeypatch.setattr(settings, "BEDROCK_PROMPT_CACHE", "on")
    # Probe response reports NO cache fields -> hard config error with the fix.
    client = FakeConverseClient([metadata_event(inputTokens=2000, outputTokens=5)])
    install_fake_boto3(monkeypatch, client)
    service._verified.clear()
    with pytest.raises(service.ProviderError) as excinfo:
        await service._ensure_transport(spec())
    assert "BEDROCK_PROMPT_CACHE=off" in str(excinfo.value)
    assert service.cache_state()["active"] is False


@pytest.mark.asyncio
async def test_probe_passes_when_cache_usage_is_reported(monkeypatch):
    monkeypatch.setattr(settings, "BEDROCK_PROMPT_CACHE", "on")
    client = FakeConverseClient([metadata_event(
        inputTokens=500, outputTokens=5, cacheWriteInputTokens=1500)])
    install_fake_boto3(monkeypatch, client)
    service._verified.clear()
    await service._ensure_transport(spec())
    state = service.cache_state()
    assert state["requested"] is True and state["active"] is True


@pytest.mark.asyncio
async def test_probe_without_cache_flag_does_not_require_cache_fields(monkeypatch):
    monkeypatch.setattr(settings, "BEDROCK_PROMPT_CACHE", "off")
    client = FakeConverseClient([metadata_event(inputTokens=10, outputTokens=1)])
    install_fake_boto3(monkeypatch, client)
    service._verified.clear()
    await service._ensure_transport(spec())
    assert service.cache_state()["requested"] is False


# --- fixtures ------------------------------------------------------------------

def _request(history: bool = True):
    from app.agent.models import AgentRequest, Message, Project
    messages = [Message(role="user", content="make it blink")] if history else []
    return AgentRequest(prompt="make it blink", project=Project(), messages=messages)


def _ws():
    from app.agent import workspace as wsmod
    from app.agent.models import Project
    return wsmod.Workspace(Project(), "make it blink")
