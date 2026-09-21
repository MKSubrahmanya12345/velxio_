"""Deterministic, text-level salvage for the JSON a chat model returns.

The agent asks for ONE Proposal object, but models wrap it in markdown fences,
add prose, leave trailing commas, drop a comma between members — and, the
failure that actually breaks firmware patches, emit UNESCAPED quotes inside a
source-code string:

    "content": "void loop(){ Serial.println("reading"); }"

That is neither truncation nor a schema slip. The string terminates early, the
parser hits `reading` where it wanted `,` or `}`, and the whole response dies
with `Invalid JSON: expected ',' or '}' at line 1 column 7270` — a position
nowhere near the head of the response, so an excerpt of the first 2 KB shows
the model nothing useful. One missing backslash is not worth a repair round,
so every common slip is repaired here, in escalating order, before anything is
sent back to the model:

  1. extract the balanced object (fences / prose stripped), retrying with (3)
     when the braces do not balance — the scan is fooled by the same stray quotes
  2. drop trailing commas
  3. re-escape stray quotes and raw control characters inside strings
  4. re-insert commas the model dropped between members

Truncation is deliberately NOT completed: a Proposal cut off mid-file would
apply half a design, so it is reported as truncation (with the exact place it
stopped) and the caller asks for the complete object instead.

Everything here is pure text in / value out — no schema knowledge, no I/O — so
it is cheap to run on every response and trivial to unit test.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

_FENCE_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)\s*```", re.IGNORECASE)
_TOKEN_RE = re.compile(r"[-+A-Za-z0-9_.]+")
_WHITESPACE = " \t\r\n"
# Only these may follow the closing quote of a JSON string.
_STRUCTURAL_AFTER_STRING = ":,}]"
_CONTROL_ESCAPES = {"\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f"}
_VALID_ESCAPES = ('"', "\\", "/", "b", "f", "n", "r", "t", "u")
_JSON_LITERALS = ("true", "false", "null")


class SalvageError(ValueError):
    """The text is not JSON and could not be repaired into JSON.

    Carries the failure position and the offending text so the caller can quote
    the broken byte range back to the model instead of the head of a 20 KB
    response (which never contains the error).
    """

    def __init__(self, message: str, text: str = "", pos: int = -1, truncated: bool = False):
        super().__init__(message)
        self.text = text or ""
        self.pos = pos
        self.truncated = truncated


@dataclass
class Salvaged:
    """A parsed value plus what had to be fixed to get it (for the log line)."""

    value: Any
    text: str
    repairs: list[str] = field(default_factory=list)


# --- extraction ------------------------------------------------------------


def _truncate_to_balanced(text: str) -> str | None:
    """The first balanced {...} in `text`, or None if the braces never close."""
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start: i + 1]
    return None


def extract_object(text: str) -> tuple[str | None, str, bool]:
    """(balanced JSON object, state, strings_repaired).

    `state` is `ok` / `unbalanced` / `none`; `strings_repaired` says the object
    only balanced once the stray quotes inside it were escaped, so the caller
    can report the repair it did not have to do itself.

    `unbalanced` means braces opened but never closed — the response was cut
    off, which is a different failure from "there was no JSON here" and gets a
    different repair prompt. Because that verdict sends the model off to
    rewrite the whole response, it is only reached after the string repair has
    been tried: the brace scan is itself fooled by stray quotes, since a `{`
    inside `Serial.println("{")` looks like a new object once the string is
    believed to have ended early.
    """
    if not text or not text.strip():
        return None, "none", False
    stripped = text.strip()
    candidates = []
    if stripped.startswith(("{", "[")):
        candidates.append(stripped)  # fast path: object first, prose after
    fence = _FENCE_RE.search(text)
    if fence:
        candidates.append(fence.group(1).strip())  # ```json fenced block
    candidates.append(text)  # last-ditch: first { to its matching }
    for candidate in candidates:
        body = _truncate_to_balanced(candidate)
        if body is not None:
            return body, "ok", False
    start = text.find("{")
    if start < 0:
        return None, "none", False
    # Unbalanced as written. Re-scan with the strings repaired (the repair is
    # idempotent, so salvage() running it again on the result is harmless).
    for strict in (False, True):
        body = _truncate_to_balanced(repair_strings(text[start:], strict=strict))
        if body is not None:
            return body, "ok", True
    return None, "unbalanced", False


def strip_trailing_commas(text: str) -> str:
    """Remove commas before ]/}, which JSON forbids but models emit constantly."""
    out: list[str] = []
    in_str = False
    escape = False
    i = 0
    while i < len(text):
        ch = text[i]
        if in_str:
            out.append(ch)
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            i += 1
            continue
        if ch == '"':
            in_str = True
            out.append(ch)
            i += 1
            continue
        if ch == ",":
            j = i + 1
            while j < len(text) and text[j] in _WHITESPACE:
                j += 1
            if j < len(text) and text[j] in "]}":
                i = j  # drop the comma, keep the bracket
                continue
        out.append(ch)
        i += 1
    return "".join(out)


# --- string repair ---------------------------------------------------------


def _skip_whitespace(text: str, j: int) -> int:
    while j < len(text) and text[j] in _WHITESPACE:
        j += 1
    return j


def _plausible_next_value(text: str, j: int) -> bool:
    """True when text[j:] could legitimately start the next JSON value.

    Used to tell a real terminator from a stray quote in `println("hi", DEC)`:
    there the quote is followed by `, DEC` and `DEC` is not a value, so the
    quote belongs to the source code and has to be escaped.
    """
    j = _skip_whitespace(text, j)
    if j >= len(text):
        return True
    ch = text[j]
    if ch in "{[":
        return True
    if ch == "-" or ch.isdigit():
        return True
    if any(text.startswith(literal, j) for literal in _JSON_LITERALS):
        return True
    if ch == '"':
        end = _scan_string(text, j)
        if end >= len(text):
            return False
        after = _skip_whitespace(text, end)
        # A string member is followed by `:` (key) or a structural token
        # (array element). Anything else means we are still inside source code.
        return after >= len(text) or text[after] in _STRUCTURAL_AFTER_STRING
    return False


def _plausible_after_brackets(text: str, i: int, limit: int = 24) -> bool:
    """True when the run of ]/} starting at `i` can legally be followed by more
    document. In valid JSON the only legal followers are `,` `}` `]` `:` or the
    end, so this never rejects a real terminator — it rejects `] = 1;`."""
    end = min(len(text), i + limit)
    while i < end and text[i] in "]}":
        i += 1
    after = _skip_whitespace(text, i)
    return after >= len(text) or text[after] in _STRUCTURAL_AFTER_STRING


def _ends_string(text: str, j: int, strict: bool = False) -> bool:
    """Decide whether the quote at `j - 1` really terminates the string.

    Loose mode accepts any structural follower (`: , } ]`), which fixes
    `println("reading")`. Strict mode additionally requires that a following
    comma actually introduces a plausible value, which also fixes
    `println("hello", DEC)` — at the cost of assuming a malformed document, so
    it is only ever tried after loose mode failed to parse.
    """
    after = _skip_whitespace(text, j)
    if after >= len(text):
        return True  # end of response: nothing else it could be
    ch = text[after]
    if ch == ":":
        return True
    if ch in "}]":
        # Brackets are ambiguous: they close a JSON container, but they also
        # appear in source (`doc["sensor"] = 1`, ArduinoJson). Only a document
        # that could legally continue past them counts as a real terminator.
        return _plausible_after_brackets(text, after)
    if ch == ",":
        if not strict:
            return True
        return _plausible_next_value(text, after + 1)
    if ch == '"':
        # The next member or array element starts here; a missing comma is a
        # different repair, so don't swallow that string into this one.
        return _plausible_next_value(text, after)
    return False


def _scan_string(text: str, i: int) -> int:
    """Index just past the closing quote of the string opened at `i`."""
    n = len(text)
    k = i + 1
    while k < n:
        ch = text[k]
        if ch == "\\":
            k += 2
            continue
        if ch == '"':
            return k + 1
        k += 1
    return n


def repair_strings(text: str, strict: bool = False) -> str:
    """Escape the quotes and control characters a model left raw inside strings.

    Only the interior of strings is touched: outside them every byte is copied
    verbatim, so already-valid JSON round-trips unchanged.
    """
    out: list[str] = []
    i = 0
    n = len(text)
    in_str = False
    while i < n:
        ch = text[i]
        if not in_str:
            out.append(ch)
            if ch == '"':
                in_str = True
            i += 1
            continue
        if ch == "\\":
            nxt = text[i + 1] if i + 1 < n else ""
            if nxt in _VALID_ESCAPES:
                out.append(ch)
                out.append(nxt)
                i += 2
            else:
                out.append("\\\\")  # lone backslash (C:\path, a stray escape)
                i += 1
            continue
        if ch == '"':
            if _ends_string(text, i + 1, strict=strict):
                out.append(ch)
                in_str = False
            else:
                out.append('\\"')
            i += 1
            continue
        code = ord(ch)
        if code < 0x20:
            out.append(_CONTROL_ESCAPES.get(ch) or "\\u%04x" % code)
            i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def insert_missing_commas(text: str) -> str:
    """Re-insert commas dropped between two members (`{"a": "x" "b": "y"}`).

    Runs after `repair_strings`, so every string is properly terminated and can
    be skipped wholesale. Never fires on valid JSON: a comma is only added
    where a complete value is immediately followed by another value inside a
    container, which no legal document does.
    """
    out: list[str] = []
    i = 0
    n = len(text)
    depth = 0
    after_value = False
    while i < n:
        ch = text[i]
        if ch in _WHITESPACE:
            out.append(ch)
            i += 1
            continue
        if ch == '"':
            end = _scan_string(text, i)
            if after_value and depth:
                out.append(",")
            out.append(text[i:end])
            i = end
            after_value = True
            continue
        if ch in "{[":
            out.append(ch)
            depth += 1
            after_value = False
            i += 1
            continue
        if ch in "}]":
            out.append(ch)
            depth = max(0, depth - 1)
            after_value = True
            i += 1
            continue
        if ch in ",:":
            out.append(ch)
            after_value = False
            i += 1
            continue
        match = _TOKEN_RE.match(text, i)
        if match is None:
            out.append(ch)
            after_value = False
            i += 1
            continue
        if after_value and depth:
            out.append(",")
        out.append(match.group(0))
        i = match.end()
        after_value = True
    return "".join(out)


# --- truncation ------------------------------------------------------------


def describe_truncation(text: str) -> str:
    """Where an unbalanced response stopped: open string, unclosed containers."""
    stack: list[str] = []
    string_start = -1
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if string_start >= 0:
            if ch == "\\":
                i += 2
                continue
            if ch == '"':
                string_start = -1
            i += 1
            continue
        if ch == '"':
            string_start = i
        elif ch in "{[":
            stack.append(ch)
        elif ch in "}]":
            if stack:
                stack.pop()
        i += 1
    notes = []
    if string_start >= 0:
        notes.append(f"a string opened {n - string_start} characters before the end was never closed")
    if stack:
        notes.append(f"{len(stack)} container(s) left open ({''.join(stack[-6:])})")
    if not notes:
        notes.append("the object is incomplete")
    return "; ".join(notes)


# --- entry point -----------------------------------------------------------


def _syntax_message(exc: json.JSONDecodeError | None, text: str) -> str:
    if exc is None:
        return "Invalid JSON."
    window = text[max(0, exc.pos - 80): exc.pos + 80]
    return f"Invalid JSON at position {exc.pos}: {exc.msg}. Near: {window!r}"


def salvage(text: str) -> Salvaged:
    """Parse model output into a value, repairing the common slips on the way.

    Raises SalvageError (with position + truncation flag) when nothing works, so
    the caller can build a repair prompt that points at the real broken spot.
    """
    body, state, pre_repaired = extract_object(text)
    raw = (text or "").strip()
    if state == "none":
        raise SalvageError(
            "Response did not contain a JSON object (expected one {...} document).", raw)
    if state == "unbalanced":
        start = (text or "").find("{")
        prefix = (text or "")[start:]
        raise SalvageError(
            f"Response was cut off mid-object: {describe_truncation(prefix)}.",
            raw, pos=len(prefix), truncated=True)

    base = strip_trailing_commas(body)  # type: ignore[arg-type]
    base_repairs = ["unescaped-quotes"] if pre_repaired else []
    if base != body:
        base_repairs.append("trailing-commas")
    # Escalating candidates: cheapest text change first, so a response that is
    # already valid is never rewritten.
    attempts: list[tuple[str, list[str]]] = [(base, list(base_repairs))]
    loose = repair_strings(base)
    if loose != base:
        attempts.append((loose, base_repairs + ["unescaped-quotes"]))
    tight = repair_strings(base, strict=True)
    if tight not in (base, loose):
        attempts.append((tight, base_repairs + ["unescaped-quotes"]))
    for candidate, repairs in list(attempts):
        commas = insert_missing_commas(candidate)
        if commas != candidate:
            attempts.append((commas, repairs + ["missing-commas"]))

    last_error: json.JSONDecodeError | None = None
    for candidate, repairs in attempts:
        try:
            # strict=False tolerates raw control characters in strings (a raw
            # newline in embedded source), which the repair pass also escapes.
            value = json.loads(candidate, strict=False)
        except json.JSONDecodeError as exc:
            last_error = exc
            continue
        return Salvaged(value=value, text=candidate, repairs=repairs)
    raise SalvageError(_syntax_message(last_error, base), raw,
                       pos=getattr(last_error, "pos", -1))
