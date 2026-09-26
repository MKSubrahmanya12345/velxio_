"""The v2 agent loop: Bedrock-only, native tool use over a run-scoped workspace.

Shape of a run (docs/agent-architecture-v2.md rev 2.3):

  Bedrock configured? no -> error. Nothing else happens.
  Workspace materialized from the project (sketch.ino + diagram.json).
  Plain loop: write/edit -> check/compile -> read error -> fix -> repeat -> done().
  done() runs the intent check (mentioned parts must exist) and the final
  gates (build -> phone-page contract -> compile), then the workspace diff
  goes to the browser as a pending checkpoint.

Governance is three protections for the user: the run wall clock, the turn
cap (AGENT_MAX_TURNS) and the route's 2-slot semaphore. No attempt/round/
draft budgets, no salvage, no memo, no nudges: an error is a tool result the
model reads like a developer. ONE retry layer exists (propose()'s loop);
botocore surfaces transport errors immediately (max_attempts=1).

Every yielded event carries a run_id.
"""
import asyncio
import contextlib
import contextvars
import json
import logging
import random
import re
import time
import uuid
from typing import Callable

import httpx

from app.agent import catalog, toolspecs
from app.agent import workspace as wsmod
from app.agent.compile_service import compile_project, family_ceiling_s
from app.agent.feedback import register as register_feedback, push as push_feedback, unregister
from app.agent.models import AgentRequest, Project
from app.agent.phone_page import phone_page_note, phone_page_problems
from app.agent.runlog import RunRecord, start as start_run_record
from app.agent.workspace import DoneSignal, Workspace, WorkspaceError, build_project
from app.core.config import ProviderSpec, settings

logger = logging.getLogger("velxio.agent")

# Project source and prompts travel to the model provider verbatim. Sketches
# sometimes carry credentials someone pasted in (a WiFi password, a dashboard
# API key in a comment). Redact assignment-style values before they leave.
_SECRET_KEY = re.compile(
    r"(?i)\b(api_?key|api[-_]secret|secret|password|passwd|pwd|token|bearer|credentials?)\b"
    r"(\s*[:=]\s*)(\"|')([^\n{\"']{6,})(\3)"
)
_SECRET_REPLACEMENT = r"\1\2\3[REDACTED]\5"


def scrub_secrets(text: str) -> str:
    """Redact assignment-style credential values. Purely textual, best effort."""
    return _SECRET_KEY.sub(_SECRET_REPLACEMENT, text)


MODE_RULES = {
    "chat": "MODE chat: answer in plain text. No tools, no files.",
    "composer": "MODE composer: edit the workspace files to fulfil the request, verify, done().",
    "inline": "MODE inline: the user selected code - edit only what the request needs, verify, done().",
    "agent": "MODE agent: build the requested circuit and firmware in the workspace, verify, done().",
}

SYSTEM_TEMPLATE = """You are Velxio's hardware agent. You work on a real file workspace like a developer:

  list_files / read_file   see the workspace
  write_file / edit_file   change sketch.ino, .h headers, main.py (Pi) or diagram.json
  catalog(query)           part ids, pins, libraries; empty query = the board pinout
  check()                  electrical lint (auto-runs before every compile too)
  compile()                the real toolchain; stderr comes back like a normal command
  simulate()               AVR boards: run the firmware headless, watch pins
  done(summary, plan?, expectations?)   finish - the workspace goes to the user as a checkpoint

WORKSPACE
  diagram.json: {{"board":"<boardKind>","parts":[{{"id":"led1","type":"led","x":240,"y":200,"props":{{}}}}],"connections":[{{"from":"<boardId>:13","to":"r1:1","color":"red"}}]}}
  Connections reference a part by its id and a pin NAME from catalog(); the board by its id.
  Whole write_file for new files; edit_file (exact unique old_string) for one-wire/one-part fixes.

{mode_rules}

WORK LIKE A DEVELOPER, no ceremony:
  1. read what exists; 2. make the smallest correct edit; 3. check()/compile();
  4. fix what the errors say; 5. on AVR, simulate() the behaviour; 6. done().
  compile errors and check() problems are data - read them, fix them, compile again.

ORDERED / ONE-BY-ONE REQUESTS:
  * If the user explicitly asks for one-by-one, step-by-step, a sequence,
    "first X then Y", or gives an ordered workflow, follow that order exactly.
  * In that mode, perform AT MOST ONE MUTATING TOOL CALL per turn.
  * After the mutation returns, inspect its result and stop the turn. Do not
    jump ahead to the next stage in the same turn.
  * Use read_file/catalog/check as needed to observe the current state, but do
    not perform a later mutation until the requested earlier stage has completed.
  * Never output pseudo tool-call markup as prose. Use native tool calls.
  * For ordered requests, emit only the next tool action; do not perform a later mutation until the requested earlier stage has completed.

BOARDS: {board_count} catalog boards. Set diagram.json boardKind to the user's board (or the best fit); catalog("") returns its pinout.

RULES that are always true:
  * Every LED needs a series resistor (220-1000 ohm) on one terminal.
  * A pushbutton's four legs are TWO contacts (1.l=1.r, 2.l=2.r). GPIO INPUT_PULLUP on one contact, GND on the other; pressed reads LOW.
  * Analog sensors go to analog-capable pins; servo/RGB need PWM-capable pins.
  * I2C devices share SDA/SCL and must have distinct addresses.
  * Never wire a motor, relay or stepper coil straight to a GPIO - use the driver part.
  * Give every power and ground pin of a placed part a rail connection.
  * A phone on the user's WiFi cannot reach a simulated network. For phone pages: WiFi.begin("Velxio-GUEST"), never WiFi.softAP(), WebServer on port 80 - the canvas shows the link once the sim has an IP.

done() ends the run: a deterministic check verifies every catalog part the user NAMED exists in the circuit (missing -> add it, not explain it); what compiles-but-isn't-what-they-meant is caught by the user at the checkpoint. Keep the summary short and factual.
"""


def system_prompt(mode: str) -> str:
    return SYSTEM_TEMPLATE.format(
        mode_rules=MODE_RULES.get(mode, MODE_RULES["agent"]),
        board_count=len(catalog.BOARDS),
    ) + "\nBOARDS: " + ", ".join(sorted(catalog.BOARDS)) + "\n"


class ProviderError(Exception):
    """Safe user-facing provider failure, without provider response bodies."""


class ProviderTransientError(ProviderError):
    """Retryable provider failure: HTTP 429/5xx, timeouts, transport errors."""


class ProviderRejected(ProviderError):
    """A terminal 4xx from the provider, carrying status and a bounded body peek."""

    def __init__(self, message: str, status: int, body: str = "") -> None:
        super().__init__(message)
        self.status = status
        self.body = body


# --- run-scoped context ------------------------------------------------------

_run_deadline: contextvars.ContextVar[float | None] = contextvars.ContextVar(
    "velxio_agent_run_deadline", default=None)
_retry_sink: contextvars.ContextVar[list | None] = contextvars.ContextVar(
    "velxio_agent_retry_sink", default=None)
_stream_sink: contextvars.ContextVar[Callable[[int, str], None] | None] = (
    contextvars.ContextVar("velxio_agent_stream_sink", default=None))
# Live-typing animation: in-progress write_file content (name, content-so-far),
# extracted from the tool-call argument deltas as they arrive.
_file_sink: contextvars.ContextVar[Callable[[str, str], None] | None] = (
    contextvars.ContextVar("velxio_agent_file_sink", default=None))


def _http_timeout(ceiling: float) -> float:
    """HTTP timeout for one outbound call: `ceiling`, clipped to time left.

    Never returns <= 0: httpx reads 0 as "no timeout", which is precisely the
    hang this removes.
    """
    deadline = _run_deadline.get()
    if deadline is None:
        return max(1.0, ceiling)
    return max(1.0, min(ceiling, deadline - time.monotonic()))


def _time_left() -> float:
    deadline = _run_deadline.get()
    if deadline is None:
        return float("inf")
    return deadline - time.monotonic()


def _report_progress(chars: int, piece: str = "") -> None:
    sink = _stream_sink.get()
    if sink is not None:
        try:
            sink(chars, piece)
        except Exception:  # noqa: BLE001 - progress is decoration
            pass


def _report_file(name: str, content: str) -> None:
    sink = _file_sink.get()
    if sink is not None:
        try:
            sink(name, content)
        except Exception:  # noqa: BLE001 - the typing animation is decoration
            pass


_JSON_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\",
                 "/": "/", "b": "\b", "f": "\f"}


def _json_field(buf: str, field: str) -> tuple[str, bool] | None:
    """Value-so-far of one top-level string field in a PARTIAL JSON object.

    Returns (decoded_prefix, closed) — closed means the closing quote was
    seen; None when the field has not started. Built for streaming
    write_file arguments as they arrive from the provider: a truncated
    trailing escape simply holds those chars back. Display-only.
    """
    i = buf.find(json.dumps(field))
    if i < 0:
        return None
    i += len(field) + 2
    n = len(buf)
    while i < n and buf[i] in " \t\r\n":
        i += 1
    if i >= n or buf[i] != ":":
        return None
    i += 1
    while i < n and buf[i] in " \t\r\n":
        i += 1
    if i >= n or buf[i] != '"':
        return None
    i += 1
    out: list[str] = []
    while i < n:
        c = buf[i]
        if c == "\\":
            if i + 1 >= n:
                return "".join(out), False
            nxt = buf[i + 1]
            if nxt == "u":
                if i + 6 > n:
                    return "".join(out), False
                try:
                    out.append(chr(int(buf[i + 2:i + 6], 16)))
                except ValueError:
                    return "".join(out), False
                i += 6
                continue
            out.append(_JSON_ESCAPES.get(nxt, nxt))
            i += 2
            continue
        if c == '"':
            return "".join(out), True
        out.append(c)
        i += 1
    return "".join(out), False


def _stream_file_progress(args: str) -> None:
    """Report in-progress write_file content to the run's file sink (the
    editor typing animation). The file NAME must be a complete string; the
    CONTENT streams as it grows."""
    name = _json_field(args, "name")
    if not name or not name[1] or not name[0]:
        return
    body = _json_field(args, "content")
    if body and body[0]:
        _report_file(name[0], body[0])


def _latency_event(record: "RunRecord") -> dict:
    """The terminal trace: per-call latency + token accounting, including the
    measured cache split. cache_hit_pct is the share of input tokens the
    provider reported serving from cache — None unless it measured > 0."""
    hit = None
    if record.prompt_tokens and record.cache_read_tokens:
        hit = round(100.0 * record.cache_read_tokens / record.prompt_tokens, 1)
    return {"type": "latency_summary",
            "calls": list(record.calls)[-24:],
            "provider_ms": record.provider_ms,
            "compile_ms": record.compile_ms,
            "prompt_tokens": record.prompt_tokens,
            "completion_tokens": record.completion_tokens,
            "cache_hit_pct": hit}


def agent_run_budget_s(board_kind: str | None, fast: bool = False) -> float:
    """Wall budget for the whole run: base + headroom for one pooled compile.

    Fast Mode shrinks the compile ceiling, so it shrinks the headroom too —
    the budget tracks the compile it may actually wait on."""
    return settings.AGENT_RUN_TIMEOUT_S + max(
        0.0, family_ceiling_s(board_kind, fast) - 120.0)


# --- ChatResult: what one provider call returns ------------------------------


_COMPAT_TOOL_MARKER_RE = re.compile(
    r"<\|tool_call_begin\|>\s*"
    r"(?:functions\.)?(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*:\d+\s*"
    r"<\|tool_call_argument_begin\|>\s*"
    r"(?P<args>.*?)"
    r"\s*<\|tool_call_end\|>",
    re.DOTALL,
)


def _recover_provider_tool_calls(content: str) -> list[dict]:
    """Recover only explicit provider-emitted tool markers.

    No tool is inferred from prose. The provider must have emitted its tool
    marker, a registered tool name, and a JSON object as the arguments.
    """
    text = str(content or "")
    recovered: list[dict] = []
    seen: set[tuple[str, str]] = set()

    for match in _COMPAT_TOOL_MARKER_RE.finditer(text):
        name = match.group("name")
        if toolspecs.by_name(name) is None:
            continue

        raw = match.group("args").strip()
        try:
            args = json.loads(raw)
        except (TypeError, ValueError):
            continue
        if not isinstance(args, dict):
            continue

        # Gateway schema compatibility only: some providers call the
        # filename argument "file" while our registered tool uses "name".
        if name in {"read_file", "write_file", "edit_file"} and "name" not in args and "file" in args:
            args = {**args, "name": args["file"]}
            args.pop("file", None)

        key = (name, json.dumps(args, sort_keys=True, separators=(",", ":")))
        if key in seen:
            continue
        seen.add(key)
        recovered.append({
            "id": f"compat-{uuid.uuid4().hex[:10]}",
            "name": name,
            "arguments": json.dumps(args, separators=(",", ":")),
        })

    return recovered

class ChatResult:
    def __init__(self, content: str = "", tool_calls: list[dict] | None = None,
                 usage: dict | None = None, stop_reason: str | None = None) -> None:
        self.content = content or ""
        self.tool_calls = tool_calls or []
        self.usage = usage
        self.stop_reason = stop_reason


# --- Bedrock Converse transport ---------------------------------------------

def _converse_messages(messages: list[dict]) -> tuple[list[dict], list[dict]]:
    """Canonical messages -> (system, converse messages).

    Converse needs strict role alternation and block content. Consecutive
    same-role text turns are merged (a later text user turn joins even a
    tool-result user turn, as an extra text block — the two together stay one
    user message); a run of tool results becomes ONE user turn of toolResult
    blocks immediately after the assistant toolUse turn, which is the order
    the loop always emits.
    """
    system: list[dict] = []
    out: list[dict] = []
    for m in messages:
        role = m.get("role")
        if role == "system":
            system.append({"text": str(m.get("content") or "")})
            continue
        if role == "assistant":
            blocks: list[dict] = []
            if m.get("content"):
                blocks.append({"text": str(m["content"])})
            for tc in m.get("tool_calls") or []:
                try:
                    payload = json.loads(tc.get("arguments") or "{}")
                except ValueError:
                    payload = {}
                blocks.append({"toolUse": {"toolUseId": str(tc.get("id") or uuid.uuid4().hex[:12]),
                                           "name": str(tc.get("name") or ""),
                                           "input": payload if isinstance(payload, dict) else {}}})
            if not blocks:
                blocks = [{"text": ""}]
            if out and out[-1]["role"] == "assistant":
                out[-1]["content"].extend(blocks)
            else:
                out.append({"role": "assistant", "content": blocks})
        elif role == "tool":
            raw = str(m.get("content") or "{}")
            try:
                envelope = json.loads(raw)
            except ValueError:
                envelope = {"text": raw[:4000]}
            if not isinstance(envelope, dict):
                envelope = {"text": raw[:4000]}
            ok = bool(envelope.get("ok", True))
            result_block = {"toolResult": {
                "toolUseId": str(m.get("tool_call_id") or ""),
                "content": [{"json": envelope}],
                "status": "success" if ok else "error",
            }}
            if out and out[-1]["role"] == "user" and out[-1].get("_toolresults"):
                out[-1]["content"].append(result_block)
            else:
                out.append({"role": "user", "content": [result_block], "_toolresults": True})
        else:  # user
            text = str(m.get("content") or "")
            cache_block = ({"cachePoint": {"type": "default"}}
                           if m.get("_cache_boundary")
                           and settings.BEDROCK_PROMPT_CACHE == "on" else None)
            if out and out[-1]["role"] == "user":
                # The state block can merge into a history user turn; the
                # cachePoint still goes immediately before it, so the boundary
                # lands between history and state either way.
                if cache_block:
                    out[-1]["content"].append(cache_block)
                out[-1]["content"].append({"text": text})
            else:
                out.append({"role": "user",
                            "content": ([cache_block] if cache_block else [])
                            + [{"text": text}]})
    for item in out:
        item.pop("_toolresults", None)
    return system, out


def _converse_request(spec: ProviderSpec, max_tokens: int, tools,
                      system: list[dict], converse_messages: list[dict]) -> dict:
    """One Converse request body; the streaming call and the probe share it.

    With BEDROCK_PROMPT_CACHE=on, cachePoints go (a) after the system blocks
    and (b) at the history/state boundary (see _base_messages' marker) — the
    two prefixes that are byte-stable across turns. The workspace state and
    request stay OUTSIDE every cachePoint, so a changing summary can never
    buy a 1.25x cache-write for a prefix that will not repeat.
    """
    request: dict = {
        "modelId": spec.model,
        "messages": converse_messages,
        "inferenceConfig": {
            "maxTokens": max_tokens,
            "temperature": settings.BEDROCK_TEMPERATURE,
            "topP": settings.BEDROCK_TOP_P,
        },
    }
    if system:
        if settings.BEDROCK_PROMPT_CACHE == "on":
            system = system + [{"cachePoint": {"type": "default"}}]
        request["system"] = system
    if tools:
        request["toolConfig"] = {"tools": toolspecs.converse_tools(),
                                 "toolChoice": "auto"}
    return request


def _converse_usage(raw: dict) -> dict:
    """Normalize Converse usage to the runlog's accounting basis.

    When caching is active, Bedrock's inputTokens EXCLUDES cached tokens
    (AWS: total input = inputTokens + cacheReadInputTokens +
    cacheWriteInputTokens). prompt_tokens is therefore the true full input
    (what an uncached run would have cost), with the cache split kept
    alongside so records and the cost model can price real spend.
    """
    read_t = int(raw.get("cacheReadInputTokens") or 0)
    write_t = int(raw.get("cacheWriteInputTokens") or 0)
    usage = {"prompt_tokens": int(raw.get("inputTokens") or 0) + read_t + write_t,
             "completion_tokens": int(raw.get("outputTokens") or 0)}
    usage["total_tokens"] = usage["prompt_tokens"] + usage["completion_tokens"]
    if read_t or write_t:
        usage["cache_read_tokens"] = read_t
        usage["cache_write_tokens"] = write_t
    return usage


def _converse_client_error(spec: ProviderSpec, exc) -> ProviderError:
    """Map a Converse ClientError to the taxonomy. One classification, once."""
    # botocore's ClientError carries the parsed body ONLY as .response: it has
    # no .get() and no __getitem__, so exc.get(...) raises AttributeError from
    # inside this handler. That escaped to the probe's catch-all, which then
    # blamed region/credentials and buried the 4xx the provider had explained.
    response = getattr(exc, "response", None) or {}
    code = str((response.get("Error") or {}).get("Code") or "")
    status = int((response.get("ResponseMetadata") or {})
                 .get("HTTPStatusCode") or 0)
    if status == 429 or "Throttl" in code:
        return ProviderTransientError(f"{spec.label} is throttling requests. Retrying…")
    if status >= 500:
        return ProviderTransientError(f"{spec.label} returned HTTP {status}. Retrying…")
    return ProviderRejected(
        f"{spec.label} rejected the request (HTTP {status or '?'}). Check the model "
        "id, BEDROCK_TRANSPORT and account quota.", status or 400, str(exc)[:600])


def _bedrock_converse_streaming(messages: list[dict], spec: ProviderSpec,
                                max_tokens: int, tools) -> ChatResult:
    """One converse_stream call, consumed in a worker thread.

    THE one bound on this thread's life is botocore's read_timeout, set from
    AGENT_STREAM_TTFB_S: every socket read must complete inside it, so "no
    first token" and "went quiet mid-reply" are the SAME mechanism at ONE
    number. A cancelled asyncio task cannot kill a to_thread — it only stops
    listening — so the abandoned thread parks for at most one read timeout
    and then dies with the socket. Nothing else (no wait_for, no run-deadline
    kill) is counted on to stop it: stacking a second timer on the same
    hazard is the A.1 disease, and an uncancellable thread was D3's shape.

    Text deltas are reported through the run's stream sink (plain dict/list
    updates under the GIL — the same shape the Mantle path reports through),
    so heartbeats and the live preview work identically on both transports.
    """
    import boto3
    from botocore.config import Config
    from botocore.exceptions import BotoCoreError, ClientError

    client_kwargs: dict = {"region_name": spec.region}
    if settings.AWS_ACCESS_KEY_ID and settings.AWS_SECRET_ACCESS_KEY:
        client_kwargs.update(
            aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
            aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
            aws_session_token=settings.AWS_SESSION_TOKEN or None,
        )
    read_timeout = max(1.0, settings.AGENT_STREAM_TTFB_S)
    # ONE retry layer in the system (the D3 rule): botocore surfaces transport
    # errors immediately; propose()'s loop is the only retry counter.
    config = Config(retries={"max_attempts": 1},
                    connect_timeout=min(10.0, read_timeout),
                    read_timeout=read_timeout)
    client = boto3.client("bedrock-runtime", config=config, **client_kwargs)
    system, converse_messages = _converse_messages(messages)
    request = _converse_request(spec, max_tokens, tools,
                                system, converse_messages)
    content: list[str] = []
    calls: dict[int, dict] = {}
    usage: dict | None = None
    stop_reason = ""
    total = 0
    try:
        for event in client.converse_stream(**request)["stream"]:
            if "contentBlockDelta" in event:
                payload = event["contentBlockDelta"] or {}
                delta = payload.get("delta") or {}
                if "text" in delta:
                    piece = delta.get("text") or ""
                    content.append(piece)
                    total += len(piece)
                    _report_progress(total, piece)
                elif "toolUse" in delta:
                    index = int(payload.get("contentBlockIndex", 0))
                    slot = calls.setdefault(index, {"id": "", "name": "", "arguments": ""})
                    slot["arguments"] += str(delta["toolUse"].get("input") or "")
                    if slot["name"] == "write_file":
                        _stream_file_progress(slot["arguments"])
            elif "contentBlockStart" in event:
                payload = event["contentBlockStart"] or {}
                start = payload.get("start") or {}
                if "toolUse" in start:
                    index = int(payload.get("contentBlockIndex", 0))
                    slot = calls.setdefault(index, {"id": "", "name": "", "arguments": ""})
                    slot["id"] = str(start["toolUse"].get("toolUseId") or slot["id"])
                    slot["name"] = str(start["toolUse"].get("name") or slot["name"])
            elif "messageStop" in event:
                stop_reason = str((event.get("messageStop") or {}).get("stopReason") or "")
            elif "metadata" in event:
                raw = (event.get("metadata") or {}).get("usage") or {}
                if raw:
                    usage = _converse_usage(raw)
    except ClientError as exc:
        raise _converse_client_error(spec, exc) from None
    except (BotoCoreError, OSError, TimeoutError) as exc:
        # ReadTimeoutError / ConnectionClosedError mid-stream land here: the
        # read timeout is the one bound, and the failure is ordinary retry data.
        raise ProviderTransientError(
            f"{spec.label}'s stream stalled or dropped "
            f"({type(exc).__name__}, read bound {int(read_timeout)}s). Retrying…") from None
    except (KeyError, TypeError):
        raise ProviderError("Bedrock returned a malformed Converse stream") from None
    ordered = []
    for index in sorted(calls):
        slot = calls[index]
        if not slot["name"]:
            continue
        try:
            json.loads(slot["arguments"] or "{}")
        except ValueError:
            # A truncated toolUse JSON means the stream broke mid-call: the
            # same transient class as a dropped socket, not a tool error.
            raise ProviderTransientError(
                f"{spec.label} sent a truncated tool call. Retrying…") from None
        ordered.append({"id": slot["id"] or uuid.uuid4().hex[:12],
                        "name": slot["name"],
                        "arguments": slot["arguments"] or "{}"})
    return ChatResult("".join(content), ordered, usage, stop_reason)


# --- Bedrock Mantle transport (OpenAI-shaped, streamed) ----------------------

_DONE = object()
_MANTLE_URL = "https://bedrock-mantle.{region}.api.aws/v1/chat/completions"


async def _next_line(lines):
    try:
        return await lines.__anext__()
    except StopAsyncIteration:
        return _DONE


def _mantle_headers(url: str, body: bytes, spec: ProviderSpec) -> dict:
    if settings.AWS_ACCESS_KEY_ID and settings.AWS_SECRET_ACCESS_KEY:
        import boto3
        from botocore.awsrequest import AWSRequest
        from botocore.auth import SigV4Auth
        session = boto3.Session(
            aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
            aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
            aws_session_token=settings.AWS_SESSION_TOKEN or None,
            region_name=spec.region,
        )
        aws_request = AWSRequest(method="POST", url=url, data=body,
                                 headers={"Content-Type": "application/json"})
        SigV4Auth(session.get_credentials(), "bedrock-mantle", spec.region).add_auth(aws_request)
        return dict(aws_request.headers)
    return {"Authorization": f"Bearer {spec.api_key}"} if spec.api_key else {}


def _mantle_message(message: dict) -> dict:
    """One message in the gateway's OpenAI shape.

    A tool round is only valid with the tool fields intact: the assistant
    message must carry `tool_calls` and the tool result its `tool_call_id`
    (the gateway answers HTTP 400 "missing field `tool_call_id`" without
    them, which would kill the run on its second turn).
    """
    role = message.get("role")
    out: dict = {"role": role, "content": message.get("content") or ""}
    if role == "assistant" and message.get("tool_calls"):
        out["tool_calls"] = [
            {"id": str(call.get("id") or uuid.uuid4().hex[:12]),
             "type": "function",
             "function": {"name": str(call.get("name") or ""),
                          "arguments": str(call.get("arguments") or "{}")}}
            for call in message["tool_calls"]]
    if role == "tool":
        out["tool_call_id"] = str(message.get("tool_call_id") or "")
    return out


def _mantle_body(spec: ProviderSpec, messages: list[dict], max_tokens: int,
                 tools) -> dict:
    # `stream` is not optional: without it the gateway replies with ONE
    # application/json chat.completion, the SSE reader below sees no `data:`
    # line, and every turn silently degrades into an empty reply — no tool
    # calls, no usage — which the loop can only end with the turn cap.
    payload: dict = {"model": spec.model,
                     "messages": [_mantle_message(m) for m in messages],
                     "max_tokens": max_tokens,
                     "temperature": settings.BEDROCK_TEMPERATURE,
                     "top_p": settings.BEDROCK_TOP_P,
                     "stream": True,
                     "stream_options": {"include_usage": True}}
    # Canonical only: private markers (the cache boundary) must not reach the
    # gateway, and there is no Mantle cache marker to send — whether the
    # gateway caches is measured by the probe, not assumed here.
    if tools:
        payload["tools"] = toolspecs.mantle_tools()
    return payload


async def _mantle_stream(spec: ProviderSpec, url: str, body: dict) -> ChatResult:
    """One signed streaming POST; accumulates text AND tool-call deltas.

    Watchdogs: no first chunk within AGENT_STREAM_TTFB_S, or silence for
    AGENT_STREAM_STALL_S mid-reply, is a transient (retryable) error.
    """
    ttfb = max(1.0, settings.AGENT_STREAM_TTFB_S)
    stall = max(1.0, settings.AGENT_STREAM_STALL_S)
    content = ""
    calls: dict[int, dict] = {}
    finish_reason: str | None = None
    usage: dict | None = None
    started = False
    saw_sse = False
    total = 0
    timeout = httpx.Timeout(_http_timeout(settings.AGENT_PROVIDER_TIMEOUT_S), connect=10.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            payload = json.dumps(body).encode()
            headers = _mantle_headers(url, payload, spec)
            async with client.stream("POST", url, headers=headers,
                                     content=payload) as response:
                status = response.status_code
                if status == 429 or status >= 500:
                    raise ProviderTransientError(f"{spec.label} returned HTTP {status}. Retrying…")
                if status >= 400:
                    text = (await response.aread()).decode("utf-8", "replace")[:600]
                    logger.warning("propose %s http=%d body=%s", spec.id, status, text[:200])
                    raise ProviderRejected(
                        f"{spec.label} returned HTTP {status}. Check the model id, "
                        "BEDROCK_TRANSPORT and account quota.", status, text)
                lines = response.aiter_lines()
                budget = ttfb
                while True:
                    try:
                        line = await asyncio.wait_for(_next_line(lines), timeout=budget)
                    except asyncio.TimeoutError:
                        if not started:
                            raise ProviderTransientError(
                                f"{spec.label} accepted the request but sent nothing "
                                f"for {int(ttfb)}s. Retrying…") from None
                        raise ProviderTransientError(
                            f"{spec.label} went quiet mid-reply ({total} chars "
                            f"received, {int(stall)}s idle). Retrying…") from None
                    if line is _DONE:
                        break
                    started = True
                    budget = stall
                    text = line.strip() if isinstance(line, str) else ""
                    if not text.startswith("data:"):
                        continue
                    saw_sse = True
                    data = text[5:].strip()
                    if not data:
                        continue
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except ValueError:
                        continue
                    if not isinstance(chunk, dict):
                        continue
                    if isinstance(chunk.get("usage"), dict):
                        usage = chunk["usage"]
                    error = chunk.get("error")
                    if isinstance(error, dict):
                        detail = str(error.get("message") or "")[:200]
                        raise ProviderTransientError(
                            f"{spec.label} reported an error mid-stream"
                            f"{': ' + detail if detail else ''}. Retrying…")
                    for choice in (chunk.get("choices") or []):
                        if not isinstance(choice, dict):
                            continue
                        delta = choice.get("delta") or {}
                        piece = delta.get("content")
                        if isinstance(piece, str) and piece:
                            content += piece
                            total += len(piece)
                            _report_progress(total, piece)
                        for fragment in delta.get("tool_calls") or []:
                            try:
                                index = int(fragment.get("index", 0))
                            except (TypeError, ValueError):
                                index = 0
                            slot = calls.setdefault(index, {"id": "", "name": "", "arguments": ""})
                            if fragment.get("id"):
                                slot["id"] = fragment["id"]
                            fn = fragment.get("function") or {}
                            if fn.get("name"):
                                slot["name"] += str(fn["name"])
                            if fn.get("arguments"):
                                slot["arguments"] += str(fn["arguments"])
                            if slot["name"] == "write_file":
                                _stream_file_progress(slot["arguments"])
                        reason = choice.get("finish_reason")
                        if isinstance(reason, str) and reason:
                            finish_reason = reason
    except httpx.HTTPError:
        raise ProviderTransientError(f"{spec.label} is unreachable. Retrying…") from None
    if not saw_sse:
        # A 200 that is not an event stream means the gateway ignored
        # `stream: true`. Say so instead of returning an empty reply: the loop
        # reads "no tool calls" as the model chatting, and burns every turn
        # until the cap — the exact failure this branch used to cause.
        raise ProviderError(
            f"{spec.label} answered with a non-streaming body even though "
            "stream=true was sent. The gateway is not serving SSE on this "
            "endpoint — check BEDROCK_TRANSPORT and the model id.")
    ordered = [calls[i] for i in sorted(calls) if calls[i].get("name")]
    if usage and isinstance(usage.get("prompt_tokens_details"), dict):
        # OpenAI-shaped gateway cache report -> the same measured fields the
        # Converse path records (runlog never implies savings that were not
        # reported by the provider).
        cached = usage["prompt_tokens_details"].get("cached_tokens") or 0
        if cached:
            usage["cache_read_tokens"] = int(cached)
    return ChatResult(content, ordered, usage, finish_reason)


# --- transport selection: configuration + one-time probe ---------------------

_verified: set[str] = set()

# Measured caching state, surfaced on /api/agent/status. `active` is None
# until the probe has measured; it is never inferred from config alone.
_cache_status: dict = {"requested": settings.BEDROCK_PROMPT_CACHE == "on",
                       "active": None, "note": ""}


def cache_state() -> dict:
    return dict(_cache_status)


# Padding that clears every published minimum-cacheable-prefix floor
# (Claude on Bedrock: ~1k-2k tokens) so the probe can actually observe
# caching instead of false-failing on a too-small ping.
_PROBE_PAD = "You are a connectivity probe. " * 120


async def _converse_call(messages: list[dict], spec: ProviderSpec,
                         max_tokens: int, tools) -> ChatResult:
    """Converse in a worker thread — with NO asyncio timer around it.

    The run deadline's only job is to stop reading the sink; the thread's
    life is bounded by botocore's read timeout (see
    _bedrock_converse_streaming). A wait_for here would be a second timer on
    the same hazard, and an abandoned to_thread cannot be killed anyway.
    """
    return await asyncio.to_thread(
        _bedrock_converse_streaming, messages, spec, max_tokens, tools)


def _measure_cache_usage(usage: dict | None, transport: str) -> bool:
    """Did this call's usage actually report cache activity? OpenAI-shaped
    gateways may report it as prompt_tokens_details.cached_tokens."""
    if not usage:
        return False
    if usage.get("cache_read_tokens") or usage.get("cache_write_tokens"):
        return True
    details = usage.get("prompt_tokens_details") or {}
    return bool(details.get("cached_tokens")) if transport == "mantle" else False


async def _ensure_transport(spec: ProviderSpec) -> None:
    """BEDROCK_TRANSPORT picks the transport; a one-time probe proves the
    model/transport pair works and fails fast with the fix. No model-id
    substring matching anywhere — a rename can never reroute traffic.

    With BEDROCK_PROMPT_CACHE=on the probe also MEASURES caching:
    converse — a padded probe must report cache usage, else it's a hard
    config error (the API would take 1.25x writes or reject outright);
    mantle  — the gateway's usage payload is inspected and the result is
    recorded for /status. No marker is invented for a gateway whose
    caching contract is undocumented."""
    key = f"{spec.model}:{settings.BEDROCK_TRANSPORT}:{spec.region}"
    cache_on = settings.BEDROCK_PROMPT_CACHE == "on"
    _cache_status.update(requested=cache_on, active=None, note="")
    if key in _verified:
        return
    transport = settings.BEDROCK_TRANSPORT
    try:
        if transport == "mantle":
            result = await _mantle_stream(
                spec, _MANTLE_URL.format(region=spec.region),
                _mantle_body(spec, [{"role": "user", "content": "ping"}],
                             max_tokens=16, tools=None))
            if cache_on:
                if _measure_cache_usage(result.usage, "mantle"):
                    _cache_status.update(active=True,
                                         note="measured on the startup probe")
                else:
                    _cache_status.update(
                        active=False,
                        note="requested, but the Mantle gateway's usage reports "
                             "no cache activity — running uncached at list price")
        else:
            probe_messages = ([{"role": "system", "content": _PROBE_PAD},
                               {"role": "user", "content": "ping"}]
                              if cache_on else
                              [{"role": "user", "content": "ping"}])
            result = await _converse_call(probe_messages, spec, 16, None)
            if cache_on and not _measure_cache_usage(result.usage, "converse"):
                _cache_status.update(active=False, note="unsupported")
                raise ProviderError(
                    f"{spec.model} reported no cache usage on Converse even with a "
                    "padded prompt — it likely does not support prompt caching. "
                    "Set BEDROCK_PROMPT_CACHE=off.")
            if cache_on:
                _cache_status.update(active=True, note="measured on the startup probe")
    except ProviderRejected as exc:
        other = "mantle" if transport == "converse" else "converse"
        raise ProviderError(
            f"Bedrock rejected the probe (HTTP {exc.status}). If {spec.model!r} is a "
            f"gateway model, set BEDROCK_TRANSPORT={other} in backend/.env.") from None
    except (ProviderTransientError, ProviderError):
        raise
    except Exception as exc:  # noqa: BLE001 - probe must classify, not crash
        raise ProviderError(
            f"Bedrock transport probe failed ({type(exc).__name__}). Check "
            "AWS_REGION/credentials and BEDROCK_TRANSPORT.") from None
    _verified.add(key)
    logger.info("transport verified: %s via %s (%s) cache=%s", spec.model,
                transport, spec.region, _cache_status.get("active"))


async def _propose_once(messages: list[dict], spec: ProviderSpec,
                        max_tokens: int, tools: bool) -> ChatResult:
    await _ensure_transport(spec)
    if settings.BEDROCK_TRANSPORT == "mantle":
        return await _mantle_stream(
            spec, _MANTLE_URL.format(region=spec.region),
            _mantle_body(spec, messages, max_tokens,
                         toolspecs.mantle_tools() if tools else None))
    return await _converse_call(messages, spec, max_tokens,
                                "all" if tools else None)


def _resolve_provider(provider_id: str) -> ProviderSpec:
    spec = settings.provider(provider_id)
    if spec is None:
        raise ProviderError(
            "Bedrock is not configured on this server. Set BEDROCK_MODEL_ID "
            "(and AWS_REGION or credentials) in backend/.env.")
    return spec


def provider_available(spec: ProviderSpec) -> bool:
    return spec.configured


# --- the ONE retry layer ------------------------------------------------------

async def propose(messages: list[dict], spec: ProviderSpec, max_tokens: int,
                  tools: bool = True) -> ChatResult:
    """Bounded retry count, bounded time, every retry visible to the UI.

    This is the only retry mechanism in the system (the D3 rule): botocore
    runs with max_attempts=1 and never stacks under this loop.
    """
    last: ProviderTransientError | None = None
    retries = max(0, settings.AGENT_PROVIDER_RETRIES)
    sink = _retry_sink.get()
    retry_deadline = time.monotonic() + settings.AGENT_RETRY_TIME_BUDGET_S
    for try_index in range(retries + 1):
        try:
            return await _propose_once(messages, spec, max_tokens, tools)
        except ProviderTransientError as exc:
            last = exc
            logger.warning("propose %s attempt %d/%d failed: %s",
                           spec.id, try_index + 1, retries + 1, exc)
            if sink is not None:
                sink.append({"type": "retry", "provider": spec.id,
                             "attempt": try_index + 1, "of": retries + 1,
                             "message": f"{spec.label} is busy — retrying "
                                        f"({try_index + 1} of {retries + 1})"})
            if try_index >= retries:
                break
            delay = min(2 ** try_index, 4) + random.uniform(0, 0.5)
            if time.monotonic() + delay > retry_deadline or delay >= _time_left():
                logger.error("propose %s: retry budget exhausted after %d attempt(s)",
                             spec.id, try_index + 1)
                break
            await asyncio.sleep(delay)
    raise last  # type: ignore[misc]


# --- prompts -----------------------------------------------------------------

def _request_message(request: AgentRequest) -> str:
    text = "REQUEST:\n" + scrub_secrets(request.prompt)
    note = phone_page_note(request.prompt)
    if note:
        text += "\n\n" + note
    return text


def _workspace_summary(workspace: Workspace) -> str:
    lines = ["CURRENT WORKSPACE (files; read_file for any of them):"]
    for name in sorted(workspace.files):
        body = workspace.files[name]
        size = len(body.encode("utf-8"))
        shown = ""
        if name == wsmod.FILE_DIAGRAM and size <= 8000:
            shown = f"\n{body}"
        lines.append(f"- {name} ({size:,} bytes){shown}")
    return "\n".join(lines)


def _base_messages(request: AgentRequest, workspace: Workspace) -> list[dict]:
    # Layout: [system] → [history] → [state] → [request]. The state message
    # carries the cache boundary marker when caching is on AND there is real
    # history: everything above the boundary is byte-stable across turns, so
    # one cachePoint re-reads the whole prefix from cache on turn 2+. With no
    # history there is nothing stable above the state — a cachePoint there
    # would only buy 1.25x writes on a prefix that never repeats.
    head: list[dict] = [
        {"role": "system", "content": system_prompt(request.mode)},
        *[{"role": m.role, "content": scrub_secrets(m.content)} for m in request.messages],
    ]
    state: dict = {"role": "user", "content": _workspace_summary(workspace)}
    if request.messages and settings.BEDROCK_PROMPT_CACHE == "on":
        state["_cache_boundary"] = True
    return head + [state, {"role": "user", "content": _request_message(request)}]


# --- the run -----------------------------------------------------------------

async def run_agent(request: AgentRequest):
    run_id = uuid.uuid4().hex[:12]
    started = time.monotonic()
    logger.info("run %s start: prompt_chars=%d files=%d", run_id,
                len(request.prompt), len(request.project.files))
    record = start_run_record(run_id)
    rid, feedback_q = register_feedback(run_id)
    deadline_token = _run_deadline.set(
        time.monotonic() + agent_run_budget_s(
            request.project.board.boardKind if request.project.board else None,
            request.fast_mode) - 2.0)

    forge_task: asyncio.Task | None = None
    if request.mode != "chat":
        try:
            from app.agent import forge as forge_bridge
            if forge_bridge.is_enabled():
                forge_task = asyncio.create_task(_forge_turn(request))
        except Exception:  # noqa: BLE001 — the bridge import must not kill a run
            forge_task = None

    try:
        yield {"type": "run_started", "run_id": rid}
        async for ev in _run(request, run_id, started, record, feedback_q, forge_task):
            yield ev
    except (asyncio.CancelledError, GeneratorExit):
        logger.info("run %s cancelled after %.1fs", run_id, time.monotonic() - started)
        record.finish("cancelled")
        raise
    finally:
        if forge_task is not None and not forge_task.done():
            forge_task.cancel()
            forge_task.add_done_callback(_discard_task_result)
        _run_deadline.reset(deadline_token)
        unregister(rid)


async def _forge_turn(request: AgentRequest) -> dict:
    try:
        from app.agent import forge as forge_bridge
        return await asyncio.wait_for(
            forge_bridge.run_decision(request.prompt, request.forge_session or "default"),
            timeout=settings.AGENT_FORGE_DECIDE_WAIT_S + 5.0,
        )
    except Exception as exc:  # noqa: BLE001 — fail-open by design
        return {"ok": False, "context": "", "summary": {},
                "clarify": False, "decision": "answer",
                "error": f"forge decision failed: {type(exc).__name__}"}


def _discard_task_result(task: "asyncio.Task") -> None:
    if not task.cancelled():
        try:
            task.exception()
        except Exception:  # noqa: BLE001
            pass


def _drain_feedback(feedback_q) -> list[str]:
    notes: list[str] = []
    if feedback_q is None:
        return notes
    while True:
        try:
            notes.append(feedback_q.get_nowait())
        except asyncio.QueueEmpty:
            break
    return notes


async def _run(request: AgentRequest, run_id: str, started: float,
               record: RunRecord, feedback_q, forge_task: asyncio.Task | None):
    def event(payload: dict) -> dict:
        return {"run_id": run_id, **payload}

    try:
        spec = _resolve_provider(request.provider)
    except ProviderError as exc:
        # No fallback, ever (the v1 planner callback is gone for good).
        logger.error("run %s: %s", run_id, exc)
        record.finish("error", str(exc))
        yield event({"type": "error", "message": str(exc)})
        return
    record.provider = spec.id

    workspace = Workspace(request.project, request.prompt)
    ordered_request = bool(re.search(r"(?i)(one[- ]by[- ]one|step[- ]by[- ]step|first .+ then|in this order|ordered)", request.prompt))
    workspace.compile_fn = _compile_tool
    workspace.simulate_fn = _simulate_tool
    messages = _base_messages(request, workspace)
    use_tools = request.mode != "chat"
    max_tokens = settings.AGENT_MAX_TOKENS

    async def propose_counted(stage: str) -> ChatResult:
        t0 = time.monotonic()
        result = await propose(messages, spec, max_tokens, tools=use_tools)
        ms = int((time.monotonic() - t0) * 1000)
        record.provider_calls += 1
        record.provider_ms += ms
        usage = result.usage or {}
        record.prompt_tokens += usage.get("prompt_tokens", 0) or 0
        record.completion_tokens += usage.get("completion_tokens", 0) or 0
        record.cache_read_tokens += usage.get("cache_read_tokens", 0) or 0
        record.cache_write_tokens += usage.get("cache_write_tokens", 0) or 0
        record.calls.append({"stage": stage, "ms": ms,
                             "prompt_tokens": usage.get("prompt_tokens", 0),
                             "completion_tokens": usage.get("completion_tokens", 0),
                             "cache_read_tokens": usage.get("cache_read_tokens", 0)})
        logger.info("propose %s ok %s ms=%d out=%s",
                    spec.id, stage, ms,
                    {k: usage.get(k) for k in ("prompt_tokens", "completion_tokens")
                     if usage.get(k) is not None})
        return result

    async def call_provider(stage: str, result_slot: dict):
        """One provider call with heartbeat liveness + live text preview.

        Yields heartbeat/retry events; the ChatResult lands in result_slot
        (async generators cannot return values to `async for`)."""
        retries: list[dict] = []
        live: dict = {"chars": 0, "buf": [], "files": {}, "rev": 0}
        retry_token = _retry_sink.set(retries)

        def _sink(n: int, piece: str = "") -> None:
            live["chars"] = n
            if piece:
                live["buf"].append(piece)

        def _file(name: str, content: str) -> None:
            live["files"][name] = content
            live["rev"] += 1

        stream_token = _stream_sink.set(_sink)
        file_token = _file_sink.set(_file)
        task = asyncio.ensure_future(propose_counted(stage))
        tick = max(0.5, settings.AGENT_HEARTBEAT_S)
        waited, since_beat, last_chars, last_rev = 0.0, 0.0, -1, -1
        try:
            while True:
                # Fast ticks while anything is visibly moving (typing text or
                # code) — the typing animation is only as smooth as this loop.
                step = 0.15 if (live["chars"] > 0 or live["files"]) else tick
                done, _pending = await asyncio.wait({task}, timeout=step)
                if task in done:
                    result_slot["chat"] = task.result()
                    return
                waited += step
                since_beat += step
                for payload in retries:
                    yield event(payload)
                retries.clear()
                chars, rev = live["chars"], live["rev"]
                if since_beat < tick and chars == last_chars and rev == last_rev:
                    continue
                since_beat = 0.0
                last_chars, last_rev = chars, rev
                if live["files"]:
                    detail = "typing " + ", ".join(live["files"])
                elif chars:
                    detail = f"generating · {chars:,} chars"
                else:
                    detail = "waiting for the first token"
                payload = {"type": "heartbeat", "stage": stage, "turn": turns,
                           "waited": round(waited), "chars": chars,
                           "text": "".join(live["buf"])[-1500:],
                           "provider": spec.id,
                           "message": f"{spec.label} is {detail} · {int(waited)}s"}
                if live["files"]:
                    payload["files"] = dict(live["files"])
                yield event(payload)
        finally:
            _retry_sink.reset(retry_token)
            _stream_sink.reset(stream_token)
            _file_sink.reset(file_token)
            if not task.done():
                task.cancel()
                with contextlib.suppress(Exception, asyncio.CancelledError):
                    await task

    # forge decide (once, bounded, fails open)
    if forge_task is not None:
        yield event({"type": "stage", "stage": "planning", "message": "Deciding this turn"})
        if not forge_task.done():
            await asyncio.wait({forge_task}, timeout=settings.AGENT_FORGE_DECIDE_WAIT_S)
        if not forge_task.done():
            forge_task.cancel()
            forge_task.add_done_callback(_discard_task_result)
            yield event({"type": "forge", "status": "unavailable", "decision": "answer",
                         "message": "Decision timed out. Designing without project memory."})
        else:
            try:
                turn = forge_task.result() or {}
            except Exception:  # noqa: BLE001
                turn = {"ok": False, "context": ""}
            if turn.get("ok") and turn.get("context"):
                messages.append({"role": "user", "content": scrub_secrets(
                    "PROJECT MEMORY (binding user rules — do not contradict):\n"
                    + str(turn["context"]))})
            payload = {"type": "forge", "status": "ok" if turn.get("ok") else "unavailable",
                       "decision": turn.get("decision") or "answer"}
            if turn.get("clarify") and turn.get("clarification"):
                payload["clarification"] = str(turn["clarification"])[:1000]
            yield event(payload)
            if turn.get("clarify") and turn.get("clarification"):
                record.finish("explained")
                yield event(_latency_event(record))
                yield event({"type": "answer", "summary": str(turn["clarification"])[:4000]})
                return

    turns = 0
    stage = "designing"
    while True:
        # ---- user steering between turns --------------------------------
        notes = _drain_feedback(feedback_q)
        if notes:
            yield event({"type": "note", "message": " ".join(notes)[:1000]})
            messages.append({"role": "user", "content": (
                "USER NOTE WHILE YOU WERE WORKING (prioritize this):\n"
                + "\n---\n".join(scrub_secrets(n) for n in notes))})

        # ---- the budgets: wall clock and turn cap. Nothing else. --------
        if turns >= settings.AGENT_MAX_TURNS or _time_left() <= 5.0:
            reason = (f"the turn cap of {settings.AGENT_MAX_TURNS} was reached"
                      if turns >= settings.AGENT_MAX_TURNS else "the run ran out of time")
            logger.info("run %s stopped: %s after %.1fs", run_id, reason,
                        time.monotonic() - started)
            record.finish("failed", reason)
            yield event({"type": "error", "message": (
                f"Agent stopped: {reason}. The workspace was not applied. "
                "Retry with a smaller request.")})
            return

        turns += 1
        record.attempts = turns
        yield event({"type": "stage", "stage": stage, "turn": turns,
                     "message": "Designing in the workspace" if turns == 1
                     else f"Working in the workspace · turn {turns}"})
        try:
            result_slot: dict = {}
            async for ev in call_provider(stage, result_slot):
                yield ev
            chat = result_slot["chat"]
        except ProviderError as exc:
            logger.error("run %s: %s", run_id, exc)
            record.finish("error", str(exc))
            yield event({"type": "error", "message": str(exc)})
            return

        # ---- chat mode: text is the answer ------------------------------
        if not use_tools:
            record.finish("explained")
            yield event(_latency_event(record))
            yield event({"type": "answer", "summary": chat.content or "(empty response)"})
            return

        # ---- text without native tool calls ------------------------------
        # Some OpenAI-shaped gateways/models emit the exact tool call as text
        # (for example "functions.write_file: {...}") instead of populating the
        # native field. Recover ONLY that explicit, registered call; never infer
        # an action from ordinary prose.
        if not chat.tool_calls:
            recovered = _recover_provider_tool_calls(chat.content)
            if recovered:
                record.calls.append({
                    "stage": "compat_tool_recovery",
                    "ms": 0,
                    "prompt_tokens": 0,
                    "completion_tokens": 0,
                    "cache_read_tokens": 0,
                })
                yield event({
                    "type": "tool_compat",
                    "stage": "recovered",
                    "tools": [c["name"] for c in recovered],
                    "message": (
                        "Provider emitted an explicit tool marker; routing it "
                        "through the registered workspace tool."
                    ),
                })
                chat.tool_calls = recovered
                chat.content = ""
            else:
                messages.append({"role": "assistant", "content": chat.content})
                messages.append({"role": "user", "content": (
                    "Use the registered workspace tools. Text alone changes nothing. "
                    "Do not print functions.* or <|tool_call...|> markup.")})
                stage = "working"
                continue

        # ---- execute this turn's tool calls, in order -------------------
        messages.append({"role": "assistant", "content": chat.content,
                         "tool_calls": chat.tool_calls})
        done_signal: DoneSignal | None = None
        tool_events: list[dict] = []
        calls_to_execute = chat.tool_calls[:1] if ordered_request else chat.tool_calls[:8]
        for call in calls_to_execute:
            name = str(call.get("name", ""))
            try:
                args = json.loads(call.get("arguments") or "{}")
                if not isinstance(args, dict):
                    raise ValueError("arguments must be a JSON object")
            except ValueError as exc:
                envelope: dict = {"ok": False, "error": f"Bad tool arguments: {exc}"}
            else:
                try:
                    envelope = await _dispatch(workspace, name, args)
                except DoneSignal as sig:
                    done_signal = sig
                    envelope = {"ok": True, "data": "finishing the run"}
            messages.append({"role": "tool", "tool_call_id": str(call.get("id") or name),
                             "name": name,
                             "content": json.dumps(envelope, default=str)[:24000]})
            tool_events.append({"tool": name, "ok": bool(envelope.get("ok"))})
            if done_signal is not None:
                # Calls after done() in the same batch are dropped with a note;
                # the model is finished, the rest was speculative.
                for rest in chat.tool_calls[chat.tool_calls.index(call) + 1:][:8]:
                    messages.append({"role": "tool",
                                     "tool_call_id": str(rest.get("id") or rest.get("name")),
                                     "name": str(rest.get("name")),
                                     "content": json.dumps(
                                         {"ok": False,
                                          "error": "skipped: done() already ended the run"})})
                break
        record.tool_calls += len(tool_events)
        yield event({"type": "tools", "calls": tool_events})

        if done_signal is None:
            stage = "working"
            continue

        # ---- done(): explain or run the final gates ----------------------
        if done_signal.kind == "explain":
            logger.info("run %s done: explanation in %.1fs", run_id,
                        time.monotonic() - started)
            record.finish("explained")
            yield event(_latency_event(record))
            yield event({"type": "plan", "plan": done_signal.plan,
                         "summary": done_signal.summary})
            yield event({"type": "answer", "summary": done_signal.summary})
            return
        outcome: dict = {}
        async for ev in _finish(request, workspace, done_signal, run_id, started,
                                record, event, messages, turns, outcome):
            yield ev
        if outcome.get("retry"):
            # A final gate fed back to the model: the loop continues and the
            # model fixes, then calls done() again. Only the budgets (wall
            # clock, turn cap) end a run.
            stage = "working"
            continue
        return


async def _dispatch(workspace: Workspace, name: str, args: dict) -> dict:
    """One tool call -> envelope. done() raises DoneSignal (submit/explain);
    everything else never raises."""
    try:
        return await _run_tool(workspace, name, args)
    except DoneSignal:
        raise
    except Exception as exc:  # noqa: BLE001 - the contract is that a tool can
        # never end a run: an error here is a tool result the model reads.
        logger.exception("tool %s raised", name)
        return {"ok": False,
                "error": f"{name} failed: {type(exc).__name__}: {exc}"[:600]}


async def _run_tool(workspace: Workspace, name: str, args: dict) -> dict:
    if name == "list_files":
        return workspace.list_files()
    if name == "read_file":
        return workspace.read_file(str(args.get("name", "")))
    if name == "write_file":
        return workspace.write_file(str(args.get("name", "")), str(args.get("content", "")))
    if name == "edit_file":
        return workspace.edit_file(str(args.get("name", "")),
                                   str(args.get("old_string", "")),
                                   str(args.get("new_string", "")))
    if name == "catalog":
        return workspace.catalog(str(args.get("query", "")))
    if name == "check":
        return workspace.check()
    if name == "compile":
        return await workspace.compile(bool(args.get("fast", False)))
    if name == "simulate":
        return await workspace.simulate(
            observe_ms=int(args.get("observe_ms") or 3000),
            interactions=args.get("interactions") or [])
    if name == "done":
        return workspace.done(str(args.get("summary", "")),
                              plan=args.get("plan"),
                              expectations=args.get("expectations"))
    return {"ok": False, "error": f"Unknown tool {name!r}."}


async def _compile_tool(project: Project, fast: bool = False) -> dict:
    return await compile_project(project, fast)


async def _simulate_tool(project: Project, observe_ms: int,
                         interactions: list[dict]) -> dict:
    """Two enforcement mechanisms, nothing stacked: the tool's observe_ms
    (virtual time, clamped in Workspace.simulate) and one fixed wall-clock
    kill for the subprocess (AGENT_SIM_WALL_CLOCK_S)."""
    from app.agent import headless

    compiled = await compile_project(project)
    if not compiled.get("success"):
        return {"ok": False, "error": (
            "Compile first — simulate() runs the real hex: "
            + str(compiled.get("stderr") or compiled.get("error") or "compile failed")[-1500:])}
    hex_content = compiled.get("hex_content") or ""
    board_id = project.board.id if project.board else ""
    watch = sorted({end.pinName for wire in project.wires
                    for end in (wire.start, wire.end)
                    if end.componentId == board_id and end.pinName.isdigit()})[:24]
    stimulus, notes = headless.build_stimuli(project, interactions)
    result = await headless.run_headless(
        hex_content, observe_ms, watch, stimulus,
        timeout=settings.AGENT_SIM_WALL_CLOCK_S)
    if not result.get("supported", True):
        return {"ok": False, "error": str(result.get("error") or "simulator unavailable")}
    if result.get("error"):
        return {"ok": False, "error": str(result["error"])}
    summary = headless.summarise(result, notes, len(hex_content))
    return {"ok": True, "data": {"summary": summary,
                                 "serial": (result.get("serial") or [])[-20:],
                                 "notes": notes[:8],
                                 "observe_ms": observe_ms}}


async def _finish(request: AgentRequest, workspace: Workspace, sig: DoneSignal,
                  run_id: str, started: float, record: RunRecord, event,
                  messages: list[dict], turns: int, outcome: dict):
    """The final gates behind done(): build -> phone-page contract -> compile.

    A gate failure is fed back as the next user turn and the loop CONTINUES
    (`outcome["retry"] = True`) — the model fixes and calls done() again.
    There is no repair-attempt counter; there is only the loop.
    """
    outcome["retry"] = False

    def feedback(text: str) -> dict:
        workspace.finished = False  # the model may call done() again
        outcome["retry"] = True
        return event({"type": "stage", "stage": "validating", "message": text[:220]})

    logger.info("run %s finishing: %s", run_id, sig.summary[:120])
    yield event({"type": "plan", "plan": sig.plan, "summary": sig.summary})
    try:
        candidate = build_project(workspace.files)
    except WorkspaceError as exc:
        yield feedback(str(exc))
        messages.append({"role": "user", "content": (
            f"done() rejected — the workspace does not build. Fix it and call "
            f"done() again.\n{exc}")})
        return
    problem = phone_page_problems(request.prompt, candidate)
    if problem:
        yield feedback(problem)
        messages.append({"role": "user", "content": (
            f"done() rejected: {problem} Fix the workspace and call done() again.")})
        return
    # The linter runs here too: done() is the pre-commit hook for models that
    # never called check()/compile() themselves.
    from app.agent.workspace import analyse_project
    try:
        _candidate, problems = analyse_project(workspace.files)
    except WorkspaceError as exc:
        yield feedback(str(exc))
        messages.append({"role": "user", "content": (
            f"done() rejected — the workspace does not build. Fix it and call "
            f"done() again.\n{exc}")})
        return
    errors = [line for line in problems if line.startswith("error")]
    if errors:
        yield feedback(errors[0])
        messages.append({"role": "user", "content": (
            "done() rejected — the electrical lint found blocking problems. "
            "Fix them and call done() again.\n" + "\n".join(errors[:8]))})
        return
    board_kind = candidate.board.boardKind if candidate.board else None
    yield event({"type": "stage", "stage": "compiling",
                 "message": f"Compiling for {board_kind or 'the board'}"})
    t0 = time.monotonic()
    result = await compile_project(candidate, fast=request.fast_mode)
    record.compile_ms += int((time.monotonic() - t0) * 1000)
    diagnostics = str(result.get("stderr") or result.get("error") or "")[-10000:]
    yield event({"type": "compile", "success": bool(result.get("success")),
                 "stdout": str(result.get("stdout", ""))[-12000:],
                 "stderr": "" if result.get("success") else diagnostics})
    if result.get("success"):
        python_ok = result.get("kind") == "python"
        if python_ok or result.get("hex_content"):
            logger.info("run %s done: compiled in %.1fs (%d turns)",
                        run_id, time.monotonic() - started, turns)
            record.finish("compiled")
            yield event(_latency_event(record))
            yield event({"type": "result", "project": candidate.model_dump(),
                         "hex": "" if python_ok else result["hex_content"],
                         "runtime": "python" if python_ok else "hex",
                         "summary": sig.summary,
                         "attempts": turns,
                         "expectations": sig.expectations.model_dump()
                         if sig.expectations else None})
            return
        yield feedback("the board compiled but produced no runnable artifact")
        messages.append({"role": "user", "content": (
            "done() rejected: the board compiled but produced no runnable "
            "artifact. Fix the entry file and call done() again.")})
        return
    yield feedback("the final compile failed")
    messages.append({"role": "user", "content": (
        "done() rejected: the final compile failed. Fix and call done() again.\n"
        + (diagnostics[:4000] or "no compiler output"))})
