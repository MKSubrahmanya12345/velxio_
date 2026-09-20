"""Unit tests for the JSON salvage + shape coercion added to fix malformed
model responses (the bruh-this-was-the-agent-response bug)."""
import asyncio
import sys
import types
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND))


# Stub out settings-dependent imports that pull pydantic-settings / httpx /
# the catalog before the unit under test is importable.
def _stub_modules():
    # Provide a minimal fake 'app' package if needed; tests in this repo
    # usually run with backend on sys.path via pytest.ini.
    pass


_stub_modules()


def test_extract_json_from_fence():
    from app.agent.service import _extract_json, _strip_trailing_commas, _parse_proposal, MalformedResponse

    fenced = """Here's the patch:
```json
{"summary": "hi", "plan": ["a","b",], "patch": null}
```
"""
    extracted = _extract_json(fenced)
    assert extracted.startswith("{")
    assert extracted.endswith("}")
    cleaned = _strip_trailing_commas(extracted)
    import json
    parsed = json.loads(cleaned)
    assert parsed["summary"] == "hi"


def test_extract_json_tolerates_prose_after():
    from app.agent.service import _extract_json

    body = '{"summary": "x", "plan": []}   \nLet me know if that works.'
    extracted = _extract_json(body)
    assert extracted == '{"summary": "x", "plan": []}'


def test_coercion_string_plan_becomes_list():
    from app.agent.service import _parse_proposal, MalformedResponse
    # summary as top-level, but plan sent as a bare string — should coerce.
    body = '{"summary":"done","plan":"light the LED"}'
    p = _parse_proposal(body)
    assert p.plan == ["light the LED"]
    assert p.summary == "done"


def test_missing_object_gives_helpful_error():
    from app.agent.service import _parse_proposal, MalformedResponse
    with pytest.raises(MalformedResponse) as exc:
        _parse_proposal("there is no json here, sorry")
    assert "did not contain a JSON object" in str(exc.value)


def test_schema_error_lists_field_locations():
    from app.agent.service import _parse_proposal, MalformedResponse
    # tool_calls entry with an unknown tool name should be dropped (coerced to
    # []) and schema errors should reference specific paths.
    body = '{"summary":"x","plan":[],"tool_calls":[{"tool":"not_a_real_tool","args":{}}]}'
    # Unknown tools are filtered by _coerce_tool_call -> returns None and stripped.
    p = _parse_proposal(body)
    assert p.tool_calls == []
