"""Static analysis tests: firmware ↔ circuit coherence, shorts, capabilities.

These are the failure modes the compiler cannot see and the electrical
pre-flight cannot see either (it forces every wired GPIO HIGH, so a sketch that
drives the wrong pin still lights the LED). Each test reproduces a design that
used to be accepted and reported to the user as "design validated".
"""
import pytest

from app.agent.analysis import Finding, analyse, firmware_pin_usage, pin_constants
from app.agent.models import (
    Board,
    Connection,
    Endpoint,
    Expectations,
    Interaction,
    Part,
    Patch,
    PinExpectation,
    Project,
    Source,
    apply_patch,
)

LED = Part(id="led1", metadataId="led", x=500, y=100, properties={"color": "red"})
RES = Part(id="res1", metadataId="resistor", x=500, y=220, properties={"value": "330"})
POT = Part(id="pot1", metadataId="potentiometer", x=620, y=220)
BTN = Part(id="btn1", metadataId="pushbutton", x=740, y=220)
BLINK_SRC = (
    "void setup(){pinMode(13,OUTPUT);}\n"
    "void loop(){digitalWrite(13,HIGH);delay(500);digitalWrite(13,LOW);delay(500);}"
)


def wire(wid, a, apin, b, bpin):
    return Connection(id=wid, start=Endpoint(componentId=a, pinName=apin),
                      end=Endpoint(componentId=b, pinName=bpin))


BLINK = [wire("w1", "uno", "13", "res1", "1"), wire("w2", "res1", "2", "led1", "A"),
         wire("w3", "led1", "C", "uno", "GND.1")]


def patch(components=(LED, RES), wires=BLINK, source=BLINK_SRC, **extra):
    return Patch(board=Board(id="uno"), upsert_components=list(components),
                 upsert_wires=list(wires),
                 upsert_files=[Source(name="sketch.ino", content=source)], **extra)


def codes(project, expectations=None):
    return {f.code: f for f in analyse(project, expectations)}


def build(p):
    return apply_patch(Project(), p)


def test_good_blink_is_clean():
    candidate = build(patch())
    assert candidate.findings == []


@pytest.mark.parametrize("led_pin, source, expected", [
    # LED on 13, code drives 7: the pre-flight forces 13 HIGH, so this used to
    # compile, pre-flight and simulate "successfully" (audit probe 5).
    ("13", "void setup(){pinMode(7,OUTPUT);}void loop(){digitalWrite(7,HIGH);}", "pin-unwired"),
    ("7", "void setup(){}void loop(){analogWrite(7,128);}", "not-pwm-capable"),
    ("3", "void setup(){}void loop(){analogRead(3);}", "not-analog-capable"),
    ("13", "void setup(){}void loop(){analogRead(13);}", "not-analog-capable"),
])
def test_firmware_pins_must_match_the_circuit(led_pin, source, expected):
    wires = [wire("w1", "uno", led_pin, "res1", "1"), wire("w2", "res1", "2", "led1", "A"),
             wire("w3", "led1", "C", "uno", "GND.1")]
    direct = Project(board=Board(id="uno"), components=[LED, RES], wires=wires,
                     files=[Source(name="sketch.ino", content=source)])
    # The finding carries the code the repair loop keys on.
    assert expected in {f.code for f in analyse(direct)}
    # apply_patch surfaces it as a rejection, never a half-applied patch.
    with pytest.raises(ValueError):
        apply_patch(Project(), patch(wires=wires, source=source))


def test_wrong_pin_rejected_with_actionable_message():
    with pytest.raises(ValueError, match="drives pin 7 but nothing is wired"):
        build(patch(source="void setup(){pinMode(7,OUTPUT);}void loop(){digitalWrite(7,HIGH);}"))


def test_analog_write_on_non_pwm_pin_rejected():
    wires = [wire("w1", "uno", "7", "res1", "1"), wire("w2", "res1", "2", "led1", "A"),
             wire("w3", "led1", "C", "uno", "GND.1")]
    with pytest.raises(ValueError, match="no PWM output"):
        build(patch(wires=wires, source="void setup(){}void loop(){analogWrite(7,128);}"))


def test_wired_but_unused_pin_is_a_warning_not_a_blocker():
    candidate = build(patch(source="void setup(){}void loop(){}"))
    assert [f.code for f in candidate.findings] == ["pin-unreferenced"]
    assert candidate.findings[0].severity == "warning"


@pytest.mark.parametrize("rail", ["GND.1", "5V", "3.3V"])
def test_gpio_shorted_to_a_rail_is_rejected(rail):
    with pytest.raises(ValueError, match="wired directly to"):
        build(patch(wires=BLINK + [wire("w9", "uno", "12", "uno", rail)]))


def test_two_gpios_bridged_are_rejected():
    wires = [wire("w1", "uno", "13", "res1", "1"), wire("w2", "res1", "2", "led1", "A"),
             wire("w3", "led1", "C", "uno", "GND.1"), wire("w4", "uno", "12", "uno", "13")]
    with pytest.raises(ValueError, match="wired together"):
        build(patch(wires=wires, source=BLINK_SRC + "\n// 12 unused"))


def test_button_bridged_across_its_own_contacts_is_rejected():
    # A wire across the button's own contacts (no GPIO or rail involved, so the
    # gpio-shorted check stays out of the way).
    bridge = [wire("w9", "btn1", "1.l", "btn1", "2.l")]
    direct = Project(board=Board(id="uno"), components=[LED, RES, BTN],
                     wires=BLINK + bridge,
                     files=[Source(name="sketch.ino", content=BLINK_SRC)])
    assert "button-shorted" in {f.code for f in analyse(direct)}
    with pytest.raises(ValueError, match="can never switch"):
        build(patch(components=(LED, RES, BTN), wires=BLINK + bridge))


def test_driven_pin_pulled_to_ground_by_a_button_warns():
    wires = BLINK + [wire("w7", "uno", "13", "btn1", "1.l"), wire("w8", "btn1", "2.r", "uno", "GND.1")]
    candidate = build(patch(components=(LED, RES, BTN), wires=wires))
    assert "button-shorts-pin" in codes(candidate)
    assert codes(candidate)["button-shorts-pin"].severity == "warning"


BUTTON_SRC = "void setup(){pinMode(2,INPUT_PULLUP);}void loop(){if(!digitalRead(2)){}}"


def test_button_gpio_on_one_contact_and_gnd_on_the_other_is_clean():
    # 1.l/1.r is contact 1 and 2.l/2.r is contact 2, so the GND belongs on the
    # *other* contact — not on the second leg of the pin's own contact.
    wires = [wire("w1", "uno", "2", "btn1", "1.l"), wire("w2", "btn1", "2.l", "uno", "GND.1")]
    candidate = build(patch(components=(BTN,), wires=wires, source=BUTTON_SRC))
    assert candidate.findings == []


def test_button_gpio_and_gnd_on_one_contact_names_the_wire_to_move():
    # The miswire a model actually emits when it reads "one side to a GPIO, the
    # opposite side to GND" as left/right instead of contact/contact. The
    # diagnostic has to name the button and the wire, because the old wording
    # ("put the load between the pin and the rail") reads as "add a component":
    # the repair loop rebuilt the same two wires until the attempts ran out and
    # the user got nothing.
    wires = [wire("w1", "uno", "2", "btn1", "1.l"), wire("w2", "btn1", "1.r", "uno", "GND.1")]
    direct = Project(board=Board(id="uno"), components=[BTN], wires=wires,
                     files=[Source(name="sketch.ino", content=BUTTON_SRC)])
    message = codes(direct)["gpio-shorted"].message
    assert "SAME contact" in message
    assert "Move the GND.1 wire from btn1.1.r to btn1.2.l" in message
    assert "no component in between" not in message
    with pytest.raises(ValueError, match="Move the GND.1 wire from btn1.1.r to btn1.2.l"):
        build(patch(components=(BTN,), wires=wires, source=BUTTON_SRC))


def test_every_error_reaches_the_repair_prompt_not_only_the_first():
    # Three identically miswired buttons used to cost one repair attempt per
    # button (assert_clean raised on the first finding), and the run ended with
    # nothing applied. Every error travels in one diagnostic now.
    buttons = [Part(id=f"btn{i}", metadataId="pushbutton", x=200 + i * 80, y=300) for i in (1, 2, 3)]
    wires = [wire(f"a{i}", "uno", str(1 + i), f"btn{i}", "1.l") for i in (1, 2, 3)] \
        + [wire(f"b{i}", f"btn{i}", "1.r", "uno", "GND.1") for i in (1, 2, 3)]
    source = ("void setup(){pinMode(2,INPUT_PULLUP);pinMode(3,INPUT_PULLUP);pinMode(4,INPUT_PULLUP);}"
              "void loop(){if(!digitalRead(2)){}if(!digitalRead(3)){}if(!digitalRead(4)){}}")
    with pytest.raises(ValueError) as excinfo:
        build(patch(components=tuple(buttons), wires=wires, source=source))
    diagnostics = str(excinfo.value)
    assert "Pin 2" in diagnostics and "Pin 3" in diagnostics  # not just the first
    assert "fix every occurrence" in diagnostics


def test_potentiometer_wiper_must_be_analog():
    wires = BLINK + [wire("w20", "pot1", "VCC", "uno", "5V"), wire("w21", "pot1", "GND", "uno", "GND.1"),
                     wire("w22", "pot1", "SIG", "uno", "13")]
    with pytest.raises(ValueError, match="not on an analog-capable pin"):
        build(patch(components=(LED, RES, POT), wires=wires))


def test_potentiometer_on_analog_pin_is_clean():
    wires = BLINK + [wire("w20", "pot1", "VCC", "uno", "5V"), wire("w21", "pot1", "GND", "uno", "GND.1"),
                     wire("w22", "pot1", "SIG", "uno", "A0")]
    source = "void setup(){}void loop(){int v=analogRead(A0);digitalWrite(13,v>512);}"
    assert build(patch(components=(LED, RES, POT), wires=wires, source=source)).findings == []


def test_led_with_both_terminals_on_one_net_is_rejected():
    wires = [wire("w1", "uno", "13", "res1", "1"), wire("w2", "res1", "2", "led1", "A"),
             wire("w3", "led1", "C", "uno", "GND.1"), wire("w4", "led1", "A", "led1", "C")]
    with pytest.raises(ValueError, match="can never light"):
        build(patch(wires=wires))


def test_shorted_resistor_is_rejected():
    wires = BLINK + [wire("w4", "res1", "1", "res1", "2")]
    with pytest.raises(ValueError, match="does nothing"):
        build(patch(wires=wires))


@pytest.mark.parametrize("source, pin", [
    ("const int LED = 13;\nvoid setup(){pinMode(LED,OUTPUT);}void loop(){digitalWrite(LED,HIGH);}", "13"),
    ("#define LED 13\nvoid setup(){pinMode(LED,OUTPUT);}void loop(){digitalWrite(LED,HIGH);}", "13"),
])
def test_named_pins_resolve(source, pin):
    assert build(patch(source=source)).findings == []
    assert pin_constants([source])["LED"] == pin


def test_pins_inside_comments_and_strings_are_ignored():
    source = (BLINK_SRC + '\n// digitalWrite(99, HIGH)\n'
              'const char *msg = "analogRead(A7)";\n')
    candidate = build(patch(source=source))
    assert "pin-unwired" not in codes(candidate)
    driven, read = firmware_pin_usage([source])
    assert driven == {"13"} and read == set()


def test_line_continuation_does_not_hide_a_pin():
    source = "void setup(){}void loop(){digitalWrite(\\\n  12, HIGH);}"
    driven, _ = firmware_pin_usage([source])
    assert driven == {"12"}


def test_expectations_must_reference_real_parts_and_pins():
    with pytest.raises(ValueError, match="not wired to anything"):
        apply_patch(Project(), patch(),
                    Expectations(pins=[PinExpectation(pin="A3", expect="high")]))
    with pytest.raises(ValueError, match="only a pushbutton"):
        apply_patch(Project(), patch(),
                    Expectations(interactions=[Interaction(kind="press", componentId="res1")]))
    with pytest.raises(ValueError, match="only a potentiometer"):
        apply_patch(Project(), patch(),
                    Expectations(interactions=[Interaction(kind="pot", componentId="led1")]))
    with pytest.raises(ValueError, match="not in the circuit"):
        apply_patch(Project(), patch(),
                    Expectations(interactions=[Interaction(kind="press", componentId="ghost")]))


def test_valid_expectations_survive():
    expectations = Expectations(
        observe_ms=3000,
        pins=[PinExpectation(pin="13", expect="toggles", min_transitions=2, period_ms=(800, 1200))],
        serial=[],
        interactions=[],
    )
    candidate = apply_patch(Project(), patch(), expectations)
    assert candidate.findings == []


def test_findings_never_reach_the_wire_format_or_prompt_schema():
    candidate = build(patch(source="void setup(){}void loop(){}"))
    assert candidate.findings and "findings" not in candidate.model_dump()
    assert "findings" not in Project.model_json_schema()["properties"]
    assert isinstance(candidate.findings[0], Finding)


# ── servo (second catalog expansion) ─────────────────────────────────────────

SERVO = Part(id="srv1", metadataId="servo", x=520, y=200)
SERVO_SRC = (
    "#include <Servo.h>\nServo s;\n"
    "void setup(){s.attach(9);}\n"
    "void loop(){s.write(0);delay(1000);s.write(180);delay(1000);}"
)
SERVO_WIRES = [wire("s1", "srv1", "PWM", "uno", "9"),
               wire("s2", "srv1", "V+", "uno", "5V"),
               wire("s3", "srv1", "GND", "uno", "GND.1")]


def servo_patch(wires, source=SERVO_SRC):
    return patch(components=(SERVO,), wires=wires, source=source)


def test_servo_on_a_pwm_pin_with_power_is_clean():
    candidate = build(servo_patch(SERVO_WIRES))
    assert candidate.findings == []


def test_servo_signal_on_a_non_pwm_pin_is_rejected():
    bad = [wire("s1", "srv1", "PWM", "uno", "7"),
           wire("s2", "srv1", "V+", "uno", "5V"),
           wire("s3", "srv1", "GND", "uno", "GND.1")]
    source = SERVO_SRC.replace("attach(9)", "attach(7)")
    with pytest.raises(ValueError, match="non-PWM pin 7"):
        build(servo_patch(bad, source=source))


def test_servo_signal_unwired_is_rejected():
    idle = "void setup(){}void loop(){}"
    with pytest.raises(ValueError, match="not wired to any board pin"):
        build(servo_patch([wire("s2", "srv1", "V+", "uno", "5V"),
                           wire("s3", "srv1", "GND", "uno", "GND.1")], source=idle))


def test_servo_without_power_warns_but_applies():
    wires = [wire("s1", "srv1", "PWM", "uno", "9"),
             wire("s3", "srv1", "GND", "uno", "GND.1")]
    candidate = build(servo_patch(wires))
    assert "servo-power-unwired" in codes(candidate)
    assert codes(candidate)["servo-power-unwired"].severity == "warning"


def test_servo_h_include_is_allowed():
    build(servo_patch(SERVO_WIRES))
