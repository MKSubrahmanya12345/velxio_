"""Phone-page contract for the hardware agent.

A phone on the user's WiFi cannot join the simulated board network, and it
cannot open this computer's localhost. The working path is a station-mode
server on port 80, reached through the canvas phone link. This module tells
the model that, and rejects a commit that would send the user down the
unreachable path (Uno, softAP, Adafruit OLED that is not installed).
"""
from __future__ import annotations

import re

from app.agent import catalog

_PAGE = re.compile(
    r"\b(phones?|website|web\s*pages?|webpage|browser|same\s+wi-?fi)\b",
    re.I,
)
_ACT = re.compile(
    r"\b(type|typed|typing|show|oleds?|ssd1306|screens?|control|button|form|server|esp32)\b",
    re.I,
)
_OLED = re.compile(r"\b(oleds?|ssd1306|screens?)\b", re.I)
_GUEST = ('WiFi.begin("Velxio-GUEST")', "WiFi.begin('Velxio-GUEST')")

# Self-contained on purpose. Adafruit_SSD1306 is not part of the ESP32 core,
# and the canvas paints SSD1306 frames from Wire bytes, not from that library.
OLED_SKETCH = r"""#include <WiFi.h>
#include <WebServer.h>
#include <Wire.h>

static const uint8_t OLED_ADDR = 0x3C;
static const int SDA_PIN = 21;
static const int SCL_PIN = 22;

WebServer server(80);
String shown = "Velxio";

// 3x5 glyphs, '#' on, '.' off, five rows. ASCII 32..90. Lower case is drawn as capitals.
static const char GLYPHS[][16] = {
  "..." "..." "..." "..." "...",
  ".#." ".#." ".#." "..." ".#.",
  "#.#" "#.#" "..." "..." "...",
  ".#." "###" ".#." "###" ".#.",
  ".#." "###" "##." ".##" ".#.",
  "#.#" "..#" ".#." "#.." "#.#",
  ".#." "#.#" ".#." "#.#" ".##",
  ".#." ".#." "..." "..." "...",
  ".#." "#.." "#.." "#.." ".#.",
  ".#." "..#" "..#" "..#" ".#.",
  "#.#" ".#." "###" ".#." "#.#",
  "..." ".#." "###" ".#." "...",
  "..." "..." "..." ".#." "#..",
  "..." "..." "###" "..." "...",
  "..." "..." "..." "..." ".#.",
  "..#" "..#" ".#." "#.." "#..",
  "###" "#.#" "#.#" "#.#" "###",
  ".#." "##." ".#." ".#." "###",
  "###" "..#" "###" "#.." "###",
  "###" "..#" "###" "..#" "###",
  "#.#" "#.#" "###" "..#" "..#",
  "###" "#.." "###" "..#" "###",
  "###" "#.." "###" "#.#" "###",
  "###" "..#" "..#" ".#." ".#.",
  "###" "#.#" "###" "#.#" "###",
  "###" "#.#" "###" "..#" "###",
  "..." ".#." "..." ".#." "...",
  "..." ".#." "..." ".#." "#..",
  "..#" ".#." "#.." ".#." "..#",
  "..." "###" "..." "###" "...",
  "#.." ".#." "..#" ".#." "#..",
  "###" "..#" ".#." "..." ".#.",
  "###" "#.#" "###" "#.." "###",
  ".#." "#.#" "###" "#.#" "#.#",
  "##." "#.#" "##." "#.#" "##.",
  ".##" "#.." "#.." "#.." ".##",
  "##." "#.#" "#.#" "#.#" "##.",
  "###" "#.." "##." "#.." "###",
  "###" "#.." "##." "#.." "#..",
  ".##" "#.." "#.#" "#.#" ".##",
  "#.#" "#.#" "###" "#.#" "#.#",
  "###" ".#." ".#." ".#." "###",
  "..#" "..#" "..#" "#.#" ".#.",
  "#.#" "##." "#.." "##." "#.#",
  "#.." "#.." "#.." "#.." "###",
  "#.#" "###" "###" "#.#" "#.#",
  "##." "#.#" "#.#" "#.#" "#.#",
  ".#." "#.#" "#.#" "#.#" ".#.",
  "##." "#.#" "##." "#.." "#..",
  ".#." "#.#" "#.#" ".##" "..#",
  "##." "#.#" "##." "#.#" "#.#",
  ".##" "#.." ".#." "..#" "##.",
  "###" ".#." ".#." ".#." ".#.",
  "#.#" "#.#" "#.#" "#.#" ".#.",
  "#.#" "#.#" "#.#" ".#." ".#.",
  "#.#" "#.#" "###" "###" "#.#",
  "#.#" "#.#" ".#." "#.#" "#.#",
  "#.#" "#.#" ".#." ".#." ".#.",
  "###" "..#" ".#." "#.." "###",
};

void oledCmd(uint8_t c) {
  Wire.beginTransmission(OLED_ADDR);
  Wire.write(0x00);
  Wire.write(c);
  Wire.endTransmission();
}

void oledCursor(uint8_t page, uint8_t col) {
  oledCmd(0xB0 | (page & 7));
  oledCmd(col & 0x0F);
  oledCmd(0x10 | ((col >> 4) & 0x0F));
}

void oledClear() {
  uint8_t blank[16] = {0};
  for (uint8_t page = 0; page < 8; page++) {
    oledCursor(page, 0);
    for (uint8_t n = 0; n < 8; n++) {
      Wire.beginTransmission(OLED_ADDR);
      Wire.write(0x40);
      for (uint8_t i = 0; i < 16; i++) Wire.write(blank[i]);
      Wire.endTransmission();
    }
  }
}

void oledInit() {
  Wire.begin(SDA_PIN, SCL_PIN);
  delay(40);
  const uint8_t init[] = {
    0xAE, 0xD5, 0x80, 0xA8, 0x3F, 0xD3, 0x00, 0x40,
    0x8D, 0x14, 0x20, 0x02, 0xA1, 0xC8, 0xDA, 0x12,
    0x81, 0xCF, 0xD9, 0xF1, 0xDB, 0x40, 0xA4, 0xA6, 0xAF
  };
  for (uint8_t c : init) oledCmd(c);
  oledClear();
}

void drawGlyph(uint8_t page, uint8_t col, char ch) {
  if (ch >= 'a' && ch <= 'z') ch = (char)(ch - 32);
  uint8_t idx = 0;
  if (ch >= 32 && ch <= 90) idx = (uint8_t)(ch - 32);
  uint8_t cols[3] = {0, 0, 0};
  for (uint8_t row = 0; row < 5; row++) {
    for (uint8_t c = 0; c < 3; c++) {
      if (GLYPHS[idx][row * 3 + c] == '#') cols[c] |= (uint8_t)(1 << row);
    }
  }
  oledCursor(page, col);
  Wire.beginTransmission(OLED_ADDR);
  Wire.write(0x40);
  Wire.write(cols[0]);
  Wire.write(cols[1]);
  Wire.write(cols[2]);
  Wire.endTransmission();
}

void drawMessage(const String &text) {
  oledClear();
  uint8_t col = 0;
  uint8_t page = 0;
  for (unsigned i = 0; i < text.length() && page < 8; i++) {
    if (col > 124) {
      col = 0;
      page++;
      if (page >= 8) break;
    }
    drawGlyph(page, col, text[i]);
    col = (uint8_t)(col + 4);
  }
}

String htmlEscape(const String &in) {
  String out;
  out.reserve(in.length() + 8);
  for (unsigned i = 0; i < in.length(); i++) {
    char c = in[i];
    if (c == '&') out += F("&amp;");
    else if (c == '<') out += F("&lt;");
    else if (c == '"') out += F("&quot;");
    else if (c >= 32) out += c;
  }
  return out;
}

void sendPage() {
  String page;
  page.reserve(480);
  page += F("<!doctype html><html><head><meta charset=utf-8>");
  page += F("<meta name=viewport content=\"width=device-width,initial-scale=1\">");
  page += F("<title>OLED</title></head><body>");
  page += F("<form method=POST action=/text>");
  page += F("<p>Type something. It shows on the OLED while the simulation is running.</p>");
  page += F("<input name=msg maxlength=64 value=\"");
  page += htmlEscape(shown);
  page += F("\"><button>Show</button></form></body></html>");
  server.send(200, "text/html", page);
}

void handleText() {
  if (server.hasArg("msg")) {
    shown = server.arg("msg");
    shown.replace("\r", "");
    shown.replace("\n", " ");
    if (shown.length() > 64) shown.remove(64);
    drawMessage(shown);
  }
  sendPage();
}

void setup() {
  oledInit();
  drawMessage(shown);
  WiFi.mode(WIFI_STA);
  WiFi.begin("Velxio-GUEST");
  for (uint8_t n = 0; n < 50 && WiFi.status() != WL_CONNECTED; n++) delay(200);
  server.on("/", HTTP_GET, sendPage);
  server.on("/text", HTTP_GET, handleText);
  server.on("/text", HTTP_POST, handleText);
  server.begin();
}

void loop() {
  server.handleClient();
}
"""


def wants_phone_page(prompt: str) -> bool:
    text = prompt or ""
    return bool(_PAGE.search(text) and _ACT.search(text))


def wants_oled(prompt: str) -> bool:
    return bool(_OLED.search(prompt or ""))


def phone_page_note(prompt: str) -> str:
    """Binding note appended to the request. Empty when this request is not a phone page."""
    if not wants_phone_page(prompt):
        return ""
    lines = [
        "PHONE PAGE (binding for this request — the phone is not on the simulated WiFi):",
        "The phone cannot join the board network, and it cannot open this computer's localhost or 192.168.4.x.",
        "Do not call WiFi.softAP(). Do not tell the user to port-forward, to join the board WiFi, or to open localhost on the phone.",
        "Use an ESP32-family board. Keep an ESP32-family board or a Pico W already on the canvas. Never switch this request to Uno.",
        'The sketch must call WiFi.begin("Velxio-GUEST") and serve HTTP on port 80.',
        "On ESP32 that server is WebServer (WebServer.h). On a Pico W already on the canvas, WiFiServer on port 80 is acceptable.",
        "Once the simulation has an IP, the canvas shows a phone link. Point the user at that card. Do not invent a URL.",
        "Do not declare AVR pin traces in expectations. ESP32 is not live-verified that way.",
    ]
    if wants_oled(prompt):
        lines.extend([
            "This request shows typed text on an OLED. Place ssd1306-i2c-4pin (i2cAddress 0x3c).",
            "Wire its SDA to the board I2C SDA, SCL to SCL, VCC to 3.3V, GND to a board GND.",
            "On esp32 those signal pins are 21 and 22. If the board's I2C pins differ, use those pins in the wires and in Wire.begin.",
            "Do not include Adafruit_SSD1306.h or Adafruit_GFX.h. The canvas paints Wire bytes. Those libraries are not required.",
            "Use the sketch below as sketch.ino. If the user asked for extra controls, keep this WiFi, server, and Wire path and add only those controls.",
            "If the board I2C pins are not 21 and 22, change SDA_PIN and SCL_PIN to match. Do not redirect the form to /. Return the HTML page from the POST handler.",
            "SKETCH:",
            OLED_SKETCH.rstrip(),
        ])
    else:
        lines.append(
            "Build the page the user asked for on that server. Do not add an OLED unless they asked for a screen."
        )
    return "\n".join(lines)


def _guest_begin(text: str) -> bool:
    return any(token in text for token in _GUEST)


def _oled_wiring_problem(project) -> str | None:
    oleds = [c for c in project.components if c.metadataId == "ssd1306-i2c-4pin"]
    if not oleds:
        return (
            "Place ssd1306-i2c-4pin with i2cAddress 0x3c. "
            "Wire SDA and SCL to the board I2C pins, VCC to 3.3V, and GND to a board GND."
        )
    board = project.board
    if board is None:
        return "This request needs an ESP32 board for the OLED page."
    pins = catalog.board_pins(board.boardKind)
    i2c = (catalog.BOARDS.get(board.boardKind) or {}).get("i2c") or {}
    sda_pin = str(i2c.get("SDA") or "")
    scl_pin = str(i2c.get("SCL") or "")
    oled_ids = {c.id for c in oleds}

    def linked(part_pin: str, board_pins: set[str]) -> bool:
        if not board_pins:
            return True
        for wire in project.wires:
            ends = (
                (wire.start.componentId, wire.start.pinName),
                (wire.end.componentId, wire.end.pinName),
            )
            for part, other in (ends, (ends[1], ends[0])):
                if part[0] in oled_ids and part[1] == part_pin and other[0] == board.id and other[1] in board_pins:
                    return True
        return False

    missing = []
    if sda_pin and not linked("SDA", {sda_pin}):
        missing.append(f"SDA to board pin {sda_pin}")
    if scl_pin and not linked("SCL", {scl_pin}):
        missing.append(f"SCL to board pin {scl_pin}")
    if "3.3V" in pins and not linked("VCC", {"3.3V"}):
        missing.append("VCC to 3.3V")
    grounds = {pin for pin in pins if pin == "GND" or pin.startswith("GND.")}
    if grounds and not linked("GND", grounds):
        missing.append("GND to a board GND")
    if missing:
        return "OLED wiring is incomplete: " + "; ".join(missing) + "."
    return None


def phone_page_problems(prompt: str, project) -> str | None:
    """None when the commit can be compiled. A string is a repair, not a user-facing essay."""
    if not wants_phone_page(prompt):
        return None
    board = getattr(project, "board", None)
    if board is None:
        return (
            'A phone page needs an ESP32 board, WiFi.begin("Velxio-GUEST"), '
            "and WebServer on port 80. Do not use Uno or WiFi.softAP()."
        )
    kind = board.boardKind
    family = catalog.board_family(kind)
    text = "\n".join(source.content for source in project.files)
    if "softAP" in text:
        return (
            'Do not call WiFi.softAP(). The simulated access point is not reachable. '
            'Use WiFi.begin("Velxio-GUEST") and serve port 80.'
        )
    if not _guest_begin(text):
        return 'The sketch must call WiFi.begin("Velxio-GUEST"). No other SSID is forwarded to the phone.'
    if family == "esp32":
        if "WebServer" not in text or "(80)" not in text:
            return "ESP32 phone page must use WebServer on port 80 (include WebServer.h). The gateway forwards port 80 only."
    elif kind == "pi-pico-w":
        if "(80)" not in text or ("WiFiServer" not in text and "WebServer" not in text):
            return "Pico W phone page must listen on port 80."
    else:
        return (
            f"{kind} cannot serve this phone page. Use an ESP32-family board "
            '(WiFi.begin("Velxio-GUEST"), WebServer on port 80).'
        )
    if wants_oled(prompt):
        if "Adafruit_SSD1306" in text or "Adafruit_GFX" in text:
            return (
                "Do not include Adafruit_SSD1306.h or Adafruit_GFX.h. "
                "Drive the OLED with Wire to address 0x3C. Use the sketch in the phone-page note."
            )
        if "Wire" not in text:
            return "The OLED path must use Wire (Wire.h) to address 0x3C."
        i2c = (catalog.BOARDS.get(kind) or {}).get("i2c") or {}
        sda_pin = str(i2c.get("SDA") or "")
        scl_pin = str(i2c.get("SCL") or "")
        if sda_pin and scl_pin and (sda_pin not in text or scl_pin not in text):
            return f"Wire.begin must use this board's I2C pins, SDA {sda_pin} and SCL {scl_pin}."
        return _oled_wiring_problem(project)
    return None
