"""The built-in offline planner: parse the request, pass every gate.

These tests run with no provider, no network and no arduino-cli. They assert
what the planner *proposes* — the compiler and the browser remain the judges of
whether it builds and behaves, which is the same contract a model's proposal
has.
"""
import json

import pytest

from app.agent import catalog, planner
from app.agent.models import AgentRequest, Project, apply_patch


def build(prompt: str, project: Project | None = None, mode: str = "agent"):  # noqa: D103
    """Plan + apply, i.e. everything up to the compile gate."""
    request = AgentRequest(prompt=prompt, project=project or Project(),
                           provider="local", mode=mode)
    proposal = planner.plan(request)
    if proposal.patch is None:
        return None, proposal
    candidate = apply_patch(request.project, proposal.patch, proposal.expectations,
                            board_hint=request.prompt)
    return candidate, proposal


def kinds(project) -> list[str]:
    return [part.metadataId for part in project.components]


# --- parsing ---------------------------------------------------------------

@pytest.mark.parametrize("prompt, expected", [
    ("blink an LED", [("led", 1)]),
    ("3 leds on my arduino uno", [("led", 3)]),
    ("two buttons and an LED", [("pushbutton", 2), ("led", 1)]),
    ("read a potentiometer", [("potentiometer", 1)]),
    ("HC-SR04 distance over serial", [("hc-sr04", 1)]),
])
def test_wanted_parts_reads_plain_english(prompt, expected):
    assert planner.wanted_parts(prompt) == expected


def test_plural_and_number_words():
    assert planner.wanted_parts("5 servos") == [("servo", 5)]
    assert planner.wanted_parts("a servo") == [("servo", 1)]


def test_a_longer_phrase_wins_over_a_shorter_one():
    # "rgb led" must not also register a plain LED.
    assert planner.wanted_parts("an rgb led") == [("rgb-led", 1)]


def test_generic_interface_words_do_not_pull_in_a_part():
    # "serial" is a tag of the GPS module; a distance sensor over serial is
    # a distance sensor, not a GPS.
    assert planner.wanted_parts("HC-SR04 distance over serial") == [("hc-sr04", 1)]


@pytest.mark.parametrize("prompt, expected", [
    ("blink an led on a raspberry pi pico", "raspberry-pi-pico"),
    ("use an arduino mega", "arduino-mega"),
    ("esp32 with a dht22", "esp32"),
    ("arduino nano and an led", "arduino-nano"),
    ("blink an led", catalog.DEFAULT_BOARD),
])
def test_board_selection(prompt, expected):
    request = AgentRequest(prompt=prompt, project=Project(), provider="local")
    assert planner.board_kind(request) == expected


# --- building --------------------------------------------------------------

@pytest.mark.parametrize("prompt, expected_parts", [
    ("blink an LED", ["led", "resistor"]),
    ("button and LED", ["pushbutton", "led", "resistor"]),
    ("sweep a servo", ["servo"]),
    ("DHT22 on pin 2", ["dht22"]),
    ("I2C OLED showing hello", ["ssd1306-i2c-4pin"]),
    ("neopixel strip", ["neopixel"]),
])
def test_builds_the_asked_for_circuit(prompt, expected_parts):
    candidate, proposal = build(prompt)
    assert kinds(candidate) == expected_parts
    assert candidate.files and candidate.files[0].name.endswith(".ino")
    assert "setup()" in candidate.files[0].content


def test_every_led_gets_a_series_resistor():
    candidate, _ = build("2 leds")
    assert kinds(candidate).count("led") == 2
    assert kinds(candidate).count("resistor") == 2
    # The electrical gate is what rejected the first draft of this planner for
    # using the preset `resistor-220` instead of the generic part.
    values = [part.properties["value"] for part in candidate.components
              if part.metadataId == "resistor"]
    assert all(float(value) >= 100 for value in values)


def test_signals_land_on_pins_the_board_actually_has():
    candidate, _ = build("button and LED")
    board = candidate.board
    pins = set(catalog.board_pins(board.boardKind))
    for wire in candidate.wires:
        for endpoint in (wire.start, wire.end):
            if endpoint.componentId == board.id:
                assert endpoint.pinName in pins


def test_no_board_pin_is_used_twice():
    candidate, _ = build("3 leds and a button")
    board = candidate.board
    used = [wire.start.pinName for wire in candidate.wires
            if wire.start.componentId == board.id] + \
           [wire.end.pinName for wire in candidate.wires
            if wire.end.componentId == board.id]
    signal = [pin for pin in used if pin not in {"5V", "3.3V", "GND", "GND.1", "GND.2", "GND.3"}]
    assert len(signal) == len(set(signal))


def test_rgb_channels_use_pwm_pins():
    """Each channel goes through its own series resistor to a PWM pin.

    A non-PWM pin here is the failure the analysis reports as
    "analogWrite() on pin 2: that pin has no PWM output".
    """
    candidate, _ = build("rgb led")
    rgb = next(part for part in candidate.components if part.metadataId == "rgb-led")
    neighbours = {}
    for wire in candidate.wires:
        for start, end in ((wire.start, wire.end), (wire.end, wire.start)):
            neighbours.setdefault(start.componentId, []).append((start.pinName, end.componentId, end.pinName))

    channels = ("R", "G", "B")
    for channel in channels:
        targets = neighbours.get(rgb.id, [])
        assert any(pin == channel for pin, _, _ in targets), f"{channel} is not wired"
        resistor_id = next(component for pin, component, _ in targets if pin == channel)
        board_pin = next(pin for _, component, pin in neighbours[resistor_id]
                         if component == candidate.board.id)
        assert catalog.satisfies(board_pin, "pwm", candidate.board.boardKind), \
            f"{channel} is on {board_pin}, which is not a PWM pin"


def test_expectations_are_against_the_live_simulation():
    candidate, proposal = build("blink an LED")
    assert proposal.expectations is not None
    assert proposal.expectations.pins, "a blink must declare a pin to watch"
    for expectation in proposal.expectations.pins:
        wires = [wire for wire in candidate.wires
                 if expectation.pin in (wire.start.pinName, wire.end.pinName)]
        assert wires, f"expectation on pin {expectation.pin} is not wired to anything"


def test_existing_manual_edits_are_kept():
    project = Project(files=[])
    project = apply_patch(project, planner.plan(
        AgentRequest(prompt="blink an LED", project=project, provider="local")).patch)
    # A second request adds to the same workspace instead of replacing it.
    candidate, _ = build("add a buzzer", project=project)
    assert kinds(candidate) == ["led", "resistor", "buzzer"]


def test_the_workspace_sketch_is_rewritten_not_duplicated():
    # Two setup()/loop() in one sketch folder do not compile, so a request on a
    # canvas that already has code rewrites that file.
    first, _ = build("blink an LED")
    candidate, _ = build("now add a buzzer", project=first)
    assert [file.name for file in candidate.files] == ["sketch.ino"]


# --- refusing, instead of pretending ---------------------------------------

def test_a_bare_stepper_is_refused_with_the_reason():
    with pytest.raises(planner.PlannerError, match="driver"):
        planner.plan(AgentRequest(prompt="a stepper motor", project=Project(),
                                  provider="local"))


def test_a_question_is_answered_not_built():
    candidate, proposal = build("tell me about the MPU6050")
    assert candidate is None and proposal.patch is None
    assert "MPU6050" in proposal.summary


def test_chat_mode_never_edits_the_project():
    candidate, proposal = build("blink an LED", mode="chat")
    assert candidate is None and proposal.patch is None


@pytest.mark.parametrize("prompt", [
    "blink an led on a raspberry pi 4",
    "read a dht22 on a raspberry pi 3",
])
def test_python_boards_are_refused_honestly(prompt):
    # The planner writes Arduino C++; a Pi needs a .py file, so say so instead
    # of shipping an .ino that board can never run.
    with pytest.raises(planner.PlannerError, match="Arduino"):
        planner.plan(AgentRequest(prompt=prompt, project=Project(), provider="local"))


def test_unwireable_catalog_entries_are_explained():
    # The catalog's I2C LCD rules name pins the 16-pin part does not have; the
    # planner says so rather than placing a part with no wires.
    with pytest.raises(planner.PlannerError, match="wiring rules"):
        planner.plan(AgentRequest(prompt="a cap-100n", project=Project(),
                                  provider="local"))


def test_every_alias_target_exists_and_is_wireable():
    for alias, target in planner._ALIASES.items():
        spec = catalog.PARTS.get(target)
        assert spec is not None, f"{alias} -> {target} is not a catalog id"
        assert spec.placeable, f"{alias} -> {target} cannot be placed"
        assert planner.wireable(spec), f"{alias} -> {target} has no wiring rules"


def test_the_proposal_matches_the_schema_a_model_returns():
    """The wire contract is identical: the frontend needs no special case."""
    _, proposal = build("blink an LED")
    dumped = json.loads(proposal.model_dump_json())
    assert set(dumped) <= set(json.loads(
        __import__("app.agent.models", fromlist=["Proposal"]).Proposal.model_json_schema()
        and json.dumps({"summary": "", "plan": [], "patch": None, "expectations": None,
                        "tool_calls": []})))
