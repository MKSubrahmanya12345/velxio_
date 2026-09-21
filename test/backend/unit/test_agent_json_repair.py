"""Tests for the JSON salvage pipeline that every provider path must share.

The bug these pin down: the Bedrock adapters called Proposal.model_validate_json()
directly, so all the salvage lived in a code path Bedrock never reached. A model
that wrote Serial.println("reading") with unescaped quotes — one missing
backslash — failed the run with

    Invalid JSON: expected `,` or `}` at line 1 column 7270

instead of being repaired, and the repair prompt quoted the first 2 KB of a
response whose error was at column 7270.
"""
import json

import pytest

# sys.path comes from test/backend/conftest.py (backend/ is added there).
from app.agent import jsonrepair, service
from app.agent.models import Proposal
from app.core.config import ProviderSpec


KIMI = ProviderSpec(id="bedrock", label="Amazon Bedrock", model="moonshotai.kimi-k2.5",
                    kind="bedrock", region="eu-north-1", api_key="key")

# The real-world failure: firmware source with C string literals, unescaped.
UNESCAPED = (
    '{"summary":"I have all the information I need","plan":["wire the sensor"],'
    '"patch":{"board":{"id":"uno","x":100,"y":140},"upsert_components":[],'
    '"remove_components":[],"upsert_wires":[],"remove_wires":[],'
    '"upsert_files":[{"name":"sketch.ino","content":'
    '"void setup() { Serial.begin(9600); }\\nvoid loop() { Serial.println("reading");\\n}\\n"}],'
    '"remove_files":[]},"expectations":null,"tool_calls":[]}'
)


# --- text-level repair -----------------------------------------------------


def test_repairs_unescaped_quotes_inside_source():
    salvaged = jsonrepair.salvage(UNESCAPED)
    assert salvaged.repairs == ["unescaped-quotes"]
    content = salvaged.value["patch"]["upsert_files"][0]["content"]
    assert content == 'void setup() { Serial.begin(9600); }\nvoid loop() { Serial.println("reading");\n}\n'


def test_repairs_quote_followed_by_a_second_argument():
    # `println("hello", DEC)` — the stray quote is followed by a comma, so the
    # loose rule sees a terminator; the strict pass has to notice that `DEC`
    # cannot start a JSON value.
    text = '{"summary":"s","plan":[],"patch":{"upsert_files":[{"name":"a.ino","content":"Serial.println("hello", DEC);"}]}}'
    value = jsonrepair.salvage(text).value
    assert value["patch"]["upsert_files"][0]["content"] == 'Serial.println("hello", DEC);'


def test_repairs_raw_newlines_and_trailing_commas():
    text = '{"summary":"s","plan":["a",],"patch":{"upsert_files":[{"name":"a.ino","content":"void setup() {\n}\n"}]}}'
    value = jsonrepair.salvage(text).value
    assert value["patch"]["upsert_files"][0]["content"] == "void setup() {\n}\n"


def test_repairs_dropped_comma_between_members():
    value = jsonrepair.salvage('{"summary":"s" "plan":["a"]}').value
    assert value == {"summary": "s", "plan": ["a"]}


def test_repairs_dropped_comma_between_array_strings():
    value = jsonrepair.salvage('{"summary":"s","plan":["wire it" "test it"]}').value
    assert value["plan"] == ["wire it", "test it"]


def test_bracket_after_a_quoted_key_is_source_not_a_terminator():
    # ArduinoJson: `doc["sensor"] = 1;` — the quote is followed by `]`, which
    # would otherwise close the JSON string and leave ` = 1;` dangling.
    text = ('{"summary":"s","plan":[],"patch":{"upsert_files":[{"name":"a.ino",'
            '"content":"doc["sensor"] = 1; if (doc["ok"]) {}"}]}}')
    value = jsonrepair.salvage(text).value
    assert value["patch"]["upsert_files"][0]["content"] == 'doc["sensor"] = 1; if (doc["ok"]) {}'


def test_valid_arrays_and_objects_are_not_confused_by_the_bracket_rule():
    text = json.dumps({"summary": "s", "plan": ["a", "b"],
                       "patch": {"upsert_files": [{"name": "a.ino", "content": "x"}],
                                 "remove_files": []},
                       "tool_calls": []})
    salvaged = jsonrepair.salvage(text)
    assert salvaged.repairs == []
    assert salvaged.value["plan"] == ["a", "b"]


def test_brace_inside_source_is_not_a_terminator():
    # `println("{")` — a quote followed by `{` is source code, not a new object.
    text = '{"summary":"s","plan":[],"patch":{"upsert_files":[{"name":"a.ino","content":"Serial.println("{");"}]}}'
    value = jsonrepair.salvage(text).value
    assert value["patch"]["upsert_files"][0]["content"] == 'Serial.println("{");'


def test_strips_fences_and_prose():
    text = 'Sure!\n```json\n{"summary":"s","plan":["a",],}\n```\nHope that helps.'
    assert jsonrepair.salvage(text).value == {"summary": "s", "plan": ["a"]}


def test_valid_json_is_never_rewritten():
    text = '{"summary":"ok","plan":[],"patch":null}'
    salvaged = jsonrepair.salvage(text)
    assert salvaged.repairs == []
    assert salvaged.text == text


def test_escaped_source_is_left_alone():
    # Already-correct escaping must survive byte-for-byte.
    content = 'Serial.println("hi");\nif (a && b) { c(); }'
    text = json.dumps({"summary": "s", "plan": [], "patch": {"upsert_files": [{"name": "a.ino", "content": content}]}})
    assert jsonrepair.salvage(text).value["patch"]["upsert_files"][0]["content"] == content


def test_windows_paths_and_lone_backslashes():
    value = jsonrepair.salvage('{"summary":"C:\\Users\\sketch","plan":[]}').value
    assert value["summary"] == "C:\\Users\\sketch"


def test_truncation_is_reported_not_guessed():
    # Completing a cut-off object would apply half a design, so it must raise
    # with truncated=True and say where it stopped.
    with pytest.raises(jsonrepair.SalvageError) as exc:
        jsonrepair.salvage('{"summary":"s","patch":{"upsert_files":[{"name":"a.ino","content":"void setup() {')
    assert exc.value.truncated is True
    assert "never closed" in str(exc.value)
    assert "container" in str(exc.value)


def test_no_json_at_all_says_so():
    with pytest.raises(jsonrepair.SalvageError) as exc:
        jsonrepair.salvage("there is no json here, sorry")
    assert "did not contain a JSON object" in str(exc.value)
    assert exc.value.truncated is False


# --- proposal parsing ------------------------------------------------------


def test_parse_proposal_salvages_the_unescaped_response():
    proposal = service._parse_proposal(UNESCAPED)
    assert isinstance(proposal, Proposal)
    assert proposal.patch is not None
    assert proposal.patch.upsert_files[0].content.endswith("}\n")


def test_full_sketch_with_braces_and_unescaped_quotes_round_trips():
    """The realistic shape: a whole .ino, braces everywhere, C string literals
    left unescaped by the model. The repaired source must be byte-identical —
    a salvage that quietly rewrote the firmware would be worse than failing."""
    sketch = (
        '#include <DHT.h>\n'
        'void setup() {\n  Serial.begin(9600);\n}\n'
        'void loop() {\n  float t = dht.readTemperature();\n'
        '  if (isnan(t)) { Serial.println("read failed"); return; }\n'
        '  Serial.println("temp " + String(t) + "C");\n}\n'
    )
    response = (
        '{"summary":"I have all the information I need.","plan":["Read the DHT22","Log it"],'
        '"patch":{"board":{"id":"uno","x":100,"y":140},"upsert_components":[],'
        '"remove_components":[],"upsert_wires":[],"remove_wires":[],'
        '"upsert_files":[{"name":"sketch.ino","content":"' + sketch.replace("\n", "\\n") + '"}],'
        '"remove_files":[]},'
        '"expectations":{"pins":[],"serial":[{"matches":"temp"}],"interactions":[],"observe_ms":3000},'
        '"tool_calls":[]}'
    )
    assert jsonrepair.salvage(response).repairs == ["unescaped-quotes"]
    proposal = service._parse_proposal(response)
    assert proposal.patch.upsert_files[0].content == sketch
    assert proposal.expectations.serial[0].matches == "temp"


def test_parse_proposal_rejects_truncation_with_a_truncation_diagnostic():
    with pytest.raises(service.MalformedResponse) as exc:
        service._parse_proposal('{"summary":"s","patch":{"upsert_files":[{"name":"a.ino","content":"void loop() {')
    assert exc.value.truncated is True
    short, repair = service._diagnostic_for(exc.value)
    assert "cut off" in short
    assert "COMPLETE JSON object" in repair


def test_provider_length_finish_reason_marks_truncation():
    # The object parsed but the schema failed, and the provider said it hit the
    # output limit — the repair prompt has to mention truncation or the model
    # just repeats the same over-long response.
    with pytest.raises(service.MalformedResponse) as exc:
        service._parse_proposal('{"summary":""}', finish_reason="length")
    assert exc.value.truncated is True


def test_repair_prompt_quotes_the_region_around_the_failure():
    # An error at column ~5100 of a long response: the old 2 KB head excerpt
    # showed the model nothing but its own innocent preamble.
    content = ('{"summary":"' + "a" * 5000
               + '","plan":["x"],"patch":{"upsert_files":[{"name":"s.ino","content":"BROKEN TAIL HERE')
    with pytest.raises(service.MalformedResponse) as exc:
        service._parse_proposal(content)
    _short, repair = service._diagnostic_for(exc.value)
    assert "BROKEN TAIL HERE" in repair
    assert "END OF YOUR RESPONSE" in repair
    assert '\\"' in repair  # the escaping rule is spelled out


def test_schema_error_still_lists_field_locations():
    with pytest.raises(service.MalformedResponse) as exc:
        service._parse_proposal('{"summary":"s","plan":[],"patch":{"upsert_components":"not-a-list"}}')
    assert "upsert_components" in str(exc.value)


# --- every provider goes through the same pipeline -------------------------


class _FakeResponse:
    def __init__(self, payload, status_code=200, text=""):
        self._payload = payload
        self.status_code = status_code
        self.text = text

    def json(self):
        return self._payload


def _install_fake_client(monkeypatch, responses, sent):
    """Swap httpx.AsyncClient for one that replays `responses` and records calls."""
    queue = list(responses) if isinstance(responses, list) else [responses]

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, headers=None, content=None, json=None):
            sent.append({"url": url, "headers": headers or {}, "content": content, "json": json})
            return queue.pop(0) if len(queue) > 1 else queue[0]

    monkeypatch.setattr(service.httpx, "AsyncClient", FakeClient)


def _completion(content, finish_reason="stop"):
    return _FakeResponse({
        "choices": [{"message": {"content": content}, "finish_reason": finish_reason}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
    })


@pytest.mark.asyncio
async def test_bedrock_mantle_salvages_instead_of_failing(monkeypatch):
    """Regression: this path used Proposal.model_validate_json() and died."""
    sent: list[dict] = []
    _install_fake_client(monkeypatch, _completion(UNESCAPED), sent)
    monkeypatch.setattr(service, "_mantle_headers",
                        lambda url, body, region: {"Authorization": "Bearer test"})

    async def no_fixer(*args, **kwargs):  # the local repair must be enough
        raise AssertionError("model-side JSON fixer should not be needed")

    monkeypatch.setattr(service, "_fix_json_via_model", no_fixer)
    proposal = await service._propose_once_mantle([{"role": "user", "content": "hi"}], KIMI)
    assert proposal.summary.startswith("I have all the information")
    assert proposal.patch.upsert_files[0].content == (
        'void setup() { Serial.begin(9600); }\nvoid loop() { Serial.println("reading");\n}\n')
    assert proposal.usage["completion_tokens"] == 20
    assert "bedrock-mantle.eu-north-1.api.aws" in sent[0]["url"]


@pytest.mark.asyncio
async def test_mantle_asks_for_json_mode(monkeypatch):
    sent: list[dict] = []
    _install_fake_client(monkeypatch, _completion('{"summary":"ok","plan":[]}'), sent)
    monkeypatch.setattr(service, "_mantle_headers", lambda *a: {"Authorization": "Bearer t"})
    monkeypatch.setattr(service, "_MANTLE_JSON_MODE", True)
    await service._propose_once_mantle([{"role": "user", "content": "hi"}], KIMI)
    assert json.loads(sent[0]["content"])["response_format"] == {"type": "json_object"}


@pytest.mark.asyncio
async def test_mantle_drops_json_mode_when_the_gateway_rejects_it(monkeypatch):
    rejected = _FakeResponse({"error": "bad request"}, status_code=400,
                             text="Unsupported parameter: response_format")
    sent: list[dict] = []
    _install_fake_client(monkeypatch, [rejected, _completion('{"summary":"ok","plan":[]}')], sent)
    monkeypatch.setattr(service, "_mantle_headers", lambda *a: {"Authorization": "Bearer t"})
    monkeypatch.setattr(service, "_MANTLE_JSON_MODE", True)
    proposal = await service._propose_once_mantle([{"role": "user", "content": "hi"}], KIMI)
    assert proposal.summary == "ok"
    assert len(sent) == 2
    assert json.loads(sent[0]["content"])["response_format"] == {"type": "json_object"}
    assert "response_format" not in json.loads(sent[1]["content"])
    # Remembered for the process, so later calls don't each pay for a 400.
    assert service._MANTLE_JSON_MODE is False


@pytest.mark.asyncio
async def test_mantle_drops_json_mode_on_operation_not_allowed(monkeypatch):
    """The other gateway phrasing of the same rejection: a bare 400
    'Operation not allowed' that never names response_format. The keyword
    match used to miss it, so EVERY Mantle call paid the 400 again — the exact
    'Bedrock error: 400 Operation not allowed' users hit on these deployments.
    """
    rejected = _FakeResponse({"error": {"message": "Operation not allowed"}}, status_code=400,
                             text='{"error":{"message":"Operation not allowed"}}')
    sent: list[dict] = []
    _install_fake_client(monkeypatch, [rejected, _completion('{"summary":"ok","plan":[]}')], sent)
    monkeypatch.setattr(service, "_mantle_headers", lambda *a: {"Authorization": "Bearer t"})
    monkeypatch.setattr(service, "_MANTLE_JSON_MODE", True)
    proposal = await service._propose_once_mantle([{"role": "user", "content": "hi"}], KIMI)
    assert proposal.summary == "ok"
    assert len(sent) == 2
    assert json.loads(sent[0]["content"])["response_format"] == {"type": "json_object"}
    assert "response_format" not in json.loads(sent[1]["content"])
    assert service._MANTLE_JSON_MODE is False


@pytest.mark.asyncio
async def test_mantle_persistent_400_names_the_checks(monkeypatch):
    """After the JSON-mode drop still fails, the error says what to check —
    without echoing the provider body."""
    body = _FakeResponse({}, status_code=400, text='{"message":"Operation not allowed"}')
    sent: list[dict] = []
    _install_fake_client(monkeypatch, [body, body], sent)
    monkeypatch.setattr(service, "_mantle_headers", lambda *a: {"Authorization": "Bearer t"})
    monkeypatch.setattr(service, "_MANTLE_JSON_MODE", True)
    with pytest.raises(service.ProviderError) as exc:
        await service._propose_once_mantle([{"role": "user", "content": "hi"}], KIMI)
    message = str(exc.value)
    assert "bedrock-mantle" in message and "eu-north-1" in message
    assert "Operation not allowed" not in message  # the body is never echoed


def test_kimi_variants_route_to_mantle_not_converse():
    """Converse answers 400 'Operation not allowed' for Moonshot ids; every
    kimi/moonshot spelling must pick the Mantle path, not just one literal."""
    assert service._is_mantle_model("moonshotai.kimi-k2.5")
    assert service._is_mantle_model("  MOONSHOTAI.KIMI-K2.5-TURBO ")
    assert service._is_mantle_model("kimi-k2.5")
    assert not service._is_mantle_model("anthropic.claude-sonnet-4")
    assert not service._is_mantle_model("amazon.nova-pro-v1:0")


@pytest.mark.asyncio
async def test_converse_path_salvages_too(monkeypatch):
    async def fake_converse(*args, **kwargs):
        return UNESCAPED, {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3}, "end_turn"

    monkeypatch.setattr(service.asyncio, "to_thread", fake_converse)
    proposal = await service._propose_once_converse([{"role": "user", "content": "hi"}], KIMI)
    assert proposal.patch.upsert_files[0].name == "sketch.ino"


# --- the model-side fixer talks to the provider that failed ----------------


@pytest.mark.asyncio
async def test_fixer_uses_the_failing_provider_not_the_default(monkeypatch):
    """Regression: the fixer was pinned to AGENT_BASE_URL/AGENT_API_KEY, so on a
    Bedrock deployment it POSTed to an endpoint with no key and returned None
    every time — the repair looked wired up but never ran."""
    seen = []

    async def fake_openai(prompt, base_url, model, api_key):
        seen.append((base_url, model, api_key))
        return None

    monkeypatch.setattr(service, "_fix_json_openai", fake_openai)
    spec = ProviderSpec(id="gemini", label="Gemini", model="gemini-2.5-flash",
                        base_url="https://generativelanguage.googleapis.com/v1beta/openai",
                        api_key="gemini-key")
    await service._fix_json_via_model('{"summary":', "Invalid JSON", spec, pos=11)
    assert seen == [(spec.base_url, "gemini-2.5-flash", "gemini-key")]


@pytest.mark.asyncio
async def test_fixer_routes_kimi_to_mantle_and_other_bedrock_to_converse(monkeypatch):
    routes = []

    async def fake_mantle(prompt, spec):
        routes.append("mantle")
        return None

    async def fake_converse(prompt, spec):
        routes.append("converse")
        return None

    monkeypatch.setattr(service, "_fix_json_mantle", fake_mantle)
    monkeypatch.setattr(service, "_fix_json_converse", fake_converse)
    await service._fix_json_via_model("{", "err", KIMI)
    await service._fix_json_via_model("{", "err",
                                      ProviderSpec(id="bedrock", label="b", model="anthropic.claude",
                                                   kind="bedrock", region="eu-north-1"))
    assert routes == ["mantle", "converse"]


@pytest.mark.asyncio
async def test_fixer_prompt_carries_the_broken_region_of_a_long_response(monkeypatch):
    seen = []

    async def fake_openai(prompt, base_url, model, api_key):
        seen.append(prompt)
        return None

    monkeypatch.setattr(service, "_fix_json_openai", fake_openai)
    long_response = '{"summary":"' + "a" * 60000 + '","plan":["BROKEN MARKER"'
    groq = ProviderSpec(id="groq", label="Groq", model="openai/gpt-oss-120b",
                        base_url="https://api.groq.com/openai/v1", api_key="k")
    await service._fix_json_via_model(long_response, "Invalid JSON", groq, pos=60020)
    assert len(seen) == 1
    assert "BROKEN MARKER" in seen[0]
    assert len(seen[0]) < 30000  # bounded, but positioned at the failure


@pytest.mark.asyncio
async def test_fixer_failure_never_breaks_the_run(monkeypatch):
    async def boom(*args, **kwargs):
        raise RuntimeError("provider exploded")

    monkeypatch.setattr(service, "_fix_json_mantle", boom)
    assert await service._fix_json_via_model("{", "err", KIMI) is None


# --- provider listing ------------------------------------------------------


def test_bedrock_is_configured_with_region_only():
    """SigV4 deployments have no BEDROCK_API_KEY; the provider must still list."""
    assert ProviderSpec(id="bedrock", label="b", model="moonshotai.kimi-k2.5",
                        kind="bedrock", region="eu-north-1").configured
    assert ProviderSpec(id="bedrock", label="b", model="moonshotai.kimi-k2.5",
                        kind="bedrock", api_key="k").configured
    assert not ProviderSpec(id="bedrock", label="b", model="", kind="bedrock").configured
    assert not ProviderSpec(id="bedrock", label="b", model="m", kind="bedrock").configured
