"""Streaming, stall detection and run-deadline tests.

These cover the failure this file was written for: a provider that accepted
the connection and then went quiet used to hold the whole run open, because
`await client.post(...)` waits for the entire body and the per-call timeout
(500s) was larger than the run budget (240s) so it could never fire. The run
sat there emitting nothing until the outer deadline killed it with a generic
error. Incremental reads plus a stall timeout turn that into a fast, named,
retryable failure.
"""
import asyncio

import httpx
import pytest

from app.agent import service
from app.core.config import ProviderSpec


def spec() -> ProviderSpec:
    return ProviderSpec(id="openai", label="OpenAI-compatible",
                        base_url="https://example.test/v1",
                        model="test-model", api_key="test-key")


class _FakeStream:
    """An httpx `client.stream()` stand-in driven by a script of chunks.

    Each item is either a string (emitted as an SSE `data:` line) or a float
    (a delay in seconds, used to simulate a provider going silent).
    """


    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def __init__(self, script):
        self.script = script
        self.status_code = 200

    async def aiter_lines(self):
        for item in self.script:
            if isinstance(item, float):
                await asyncio.sleep(item)
                continue
            yield item

    async def aread(self) -> bytes:
        return b""


class _FakeClient:
    def __init__(self, script):
        self.script = script

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def stream(self, method, url, **kwargs):
        return _FakeStream(self.script)


def _sse(*texts):
    """Build SSE lines, terminated with [DONE]."""
    lines = []
    for text in texts:
        lines.append(
            'data: {"choices":[{"delta":{"content":'
            + _js(text)
            + '},"finish_reason":null}]}'
        )
    lines.append('data: {"choices":[{"delta":{},"finish_reason":"stop"}],'
                 '"usage":{"prompt_tokens":10,"completion_tokens":4}}')
    lines.append("data: [DONE]")
    return lines


def _js(text: str) -> str:
    import json
    return json.dumps(text)


@pytest.mark.asyncio
async def test_streamed_reply_is_reassembled(monkeypatch):
    """Chunks arriving separately are joined back into one reply."""
    script = _sse('{"summary":', '"Blink"', ',"plan":["Wire LED"]}')
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: _FakeClient(script))

    content, finish_reason, usage = await service._stream_chat_completion(
        spec(), "https://example.test/v1/chat/completions", {}, payload={})
    assert content == '{"summary":"Blink","plan":["Wire LED"]}'
    assert finish_reason == "stop"
    assert usage["prompt_tokens"] == 10


@pytest.mark.asyncio
async def test_silent_provider_fails_fast_instead_of_hanging(monkeypatch):
    """THE regression: no bytes at all -> transient error, not a hang.

    With the old buffered `post()` this call blocked until the outer deadline.
    Now the time-to-first-byte timeout fires and the failure is retryable.
    """
    monkeypatch.setattr(service.settings, "AGENT_STREAM_TTFB_S", 0.2)
    monkeypatch.setattr(service.settings, "AGENT_STREAM_STALL_S", 0.2)
    # Accepts the connection, then never sends a single chunk.
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: _FakeClient([5.0]))

    with pytest.raises(service.ProviderTransientError) as exc:
        await service._stream_chat_completion(
            spec(), "https://example.test/v1/chat/completions", {}, payload={})
    assert "sent nothing" in str(exc.value)


@pytest.mark.asyncio
async def test_mid_reply_stall_is_detected(monkeypatch):
    """A reply that starts and then stops is abandoned on the stall timeout."""
    monkeypatch.setattr(service.settings, "AGENT_STREAM_TTFB_S", 1.0)
    monkeypatch.setattr(service.settings, "AGENT_STREAM_STALL_S", 0.2)
    # One chunk arrives, then silence — before any [DONE] can end the stream.
    script = ['data: {"choices":[{"delta":{"content":"{\"summary\":\"Blink\"}"}}]}',
              5.0]
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: _FakeClient(script))

    with pytest.raises(service.ProviderTransientError) as exc:
        await service._stream_chat_completion(
            spec(), "https://example.test/v1/chat/completions", {}, payload={})
    assert "went quiet mid-reply" in str(exc.value)


@pytest.mark.asyncio
async def test_gateway_that_ignores_stream_is_recovered(monkeypatch):
    """A `stream: true` request answered with one plain JSON body still works."""
    import json
    body = json.dumps({
        "choices": [{"message": {"content": '{"summary":"Blink"}'},
                     "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 3, "completion_tokens": 2},
    })
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: _FakeClient([body]))

    content, finish_reason, usage = await service._stream_chat_completion(
        spec(), "https://example.test/v1/chat/completions", {}, payload={})
    assert content == '{"summary":"Blink"}'
    assert finish_reason == "stop"
    assert usage["completion_tokens"] == 2


@pytest.mark.asyncio
async def test_http_error_status_maps_to_retryable_or_fatal():
    """429/5xx are retried; other 4xx name what an admin can fix."""

    class _StatusClient(_FakeClient):
        def __init__(self, status):
            super().__init__([])
            self._status = status

        def stream(self, method, url, **kwargs):
            stream = _FakeStream([])
            stream.status_code = self._status  # type: ignore[attr-defined]
            return stream

    import unittest.mock as mock

    for status, expected in ((429, service.ProviderTransientError),
                             (503, service.ProviderTransientError),
                             (401, service.ProviderError)):
        with mock.patch.object(httpx, "AsyncClient",
                               lambda **kw: _StatusClient(status)):
            with pytest.raises(expected):
                await service._stream_chat_completion(
                    spec(), "https://example.test/v1/chat/completions", {},
                    payload={})


@pytest.mark.asyncio
async def test_retries_are_logged_and_reported(monkeypatch):
    """A retrying run must be visible: one log line and one UI event each."""
    monkeypatch.setattr(service.settings, "AGENT_PROVIDER_RETRIES", 2)
    async def fake_sleep(_seconds):
        return None

    monkeypatch.setattr(service.asyncio, "sleep", fake_sleep)

    attempts = {"n": 0}

    async def flaky(messages, spec_, max_tokens=None):
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise service.ProviderTransientError("rate limited")
        from app.agent.models import Proposal
        return Proposal(summary="ok")

    monkeypatch.setattr(service, "_propose_once", flaky)

    events: list[dict] = []
    token = service._retry_sink.set(events)
    try:
        await service.propose([], spec())
    finally:
        service._retry_sink.reset(token)

    assert attempts["n"] == 3
    assert len(events) == 2
    assert events[0]["type"] == "retry"
    assert events[0]["attempt"] == 1 and events[0]["of"] == 3
    assert "retrying" in events[0]["message"]


@pytest.mark.asyncio
async def test_per_call_timeout_is_clipped_to_the_run_deadline(monkeypatch):
    """A call may never outlive the run: it would be reported as a timeout."""
    monkeypatch.setattr(service.settings, "AGENT_PROVIDER_TIMEOUT_S", 500.0)
    token = service._run_deadline.set(service.time.monotonic() + 7.0)
    try:
        assert service._http_timeout(500.0) == pytest.approx(7.0, abs=0.5)
        # Never zero or negative: httpx reads 0 as "no timeout" — the hang.
        service._run_deadline.set(service.time.monotonic() - 30.0)
        assert service._http_timeout(500.0) >= 1.0
    finally:
        service._run_deadline.reset(token)


@pytest.mark.asyncio
async def test_a_slow_call_reports_heartbeats_instead_of_freezing(monkeypatch):
    """The UI must never sit on a completely silent run.

    While a provider call is in flight the run emits a heartbeat every
    AGENT_HEARTBEAT_S. Without it a slow model and a dead run are
    indistinguishable to the person watching.
    """
    from app.agent.models import AgentRequest, Project, Proposal

    # The tick has a 0.5s floor (so a misconfigured value cannot busy-loop),
    # so the call has to be slow enough for several of them to land.
    monkeypatch.setattr(service.settings, "AGENT_HEARTBEAT_S", 0.5)

    async def slow(messages, spec_=None, max_tokens=None):
        await asyncio.sleep(1.7)
        return Proposal(summary="It blinks")

    monkeypatch.setattr(service, "propose", slow)

    events = [e async for e in service.run_agent(
        AgentRequest(prompt="blink", project=Project()))]
    beats = [e for e in events if e.get("type") == "heartbeat"]
    assert len(beats) >= 3, [e.get("type") for e in events]
    assert "waiting for the first token" in beats[0]["message"]
    # The run still ends normally, with the answer as the terminal event.
    assert events[-1]["type"] == "answer"


@pytest.mark.asyncio
async def test_run_commits_instead_of_dying_when_time_runs_short(monkeypatch):
    """With little budget left the loop stops researching and commits.

    The deadline used to kill the run mid-round and apply nothing at all.
    """
    from app.agent.models import AgentRequest, Project, Proposal, ToolCall

    calls = {"n": 0}

    async def researching(messages, spec_=None, max_tokens=None):
        calls["n"] += 1
        if calls["n"] == 1:
            return Proposal(summary="researching",
                            tool_calls=[ToolCall(tool="board_pinout",
                                                 args={"board": "uno"})])
        return Proposal(summary="committed")

    monkeypatch.setattr(service, "propose", researching)
    # Pin the clock rather than the clock settings: the reserve is capped at
    # 40% of the run budget, so "nearly out of time" is expressed directly.
    monkeypatch.setattr(service, "_time_left", lambda: 1.0)

    events = [e async for e in service.run_agent(
        AgentRequest(prompt="blink", project=Project()))]
    kinds = [e.get("type") for e in events]
    # No tools ran: the round was skipped, not executed and then abandoned.
    assert "tools" not in kinds, kinds
    assert events[-1]["type"] == "answer"


@pytest.mark.asyncio
async def test_retry_storm_cannot_consume_the_run(monkeypatch):
    """15 retries of capped backoff is over a minute of the run asleep.

    The retry COUNT is not a time bound, so the backoff gets a budget too.
    """
    monkeypatch.setattr(service.settings, "AGENT_PROVIDER_RETRIES", 15)
    monkeypatch.setattr(service.settings, "AGENT_RETRY_TIME_BUDGET_S", 0.5)

    attempts = {"n": 0}

    async def always_fail(messages, spec_=None, max_tokens=None):
        attempts["n"] += 1
        raise service.ProviderTransientError("rate limited")

    monkeypatch.setattr(service, "_propose_once", always_fail)

    with pytest.raises(service.ProviderTransientError):
        await service.propose([], spec())
    # Gave up on the clock instead of grinding through all 16 attempts.
    assert attempts["n"] < 16
