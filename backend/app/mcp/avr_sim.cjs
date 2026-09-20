/*
 * Headless AVR firmware observer for the Velxio MCP server.
 *
 * Runs compiled Intel HEX in avr8js (the same emulator core the browser uses)
 * and reports what the firmware ACTUALLY did: per-pin transitions with
 * simulated timestamps, final levels and the serial bytes it printed. This is
 * what lets an external agent close the loop — compile, then observe behaviour
 * — without a browser.
 *
 * Protocol: reads one JSON object from stdin:
 *   { "hex": "<Intel HEX>", "observe_ms": 2000, "watch_pins": ["13"], "analog": {"0": 2.5},
 *     "interactions": [{ "at_ms": 500, "pin": 2, "state": false }],     // digital drives
 *     "analog_events": [{ "at_ms": 800, "channel": 0, "volts": 3.3 }] } // scheduled ADC
 * and prints one JSON result to stdout. Always exits 0 with a JSON body.
 *
 * avr8js resolution order: $VELXIO_AVR8JS_PATH, the repo's
 * frontend/node_modules/avr8js, then bare 'avr8js'.
 */
const fs = require('fs');
const path = require('path');

function loadAvr8js() {
  const candidates = [
    process.env.VELXIO_AVR8JS_PATH,
    path.resolve(__dirname, '../../../frontend/node_modules/avr8js'),
    'avr8js',
    path.resolve(__dirname, '../../node_modules/avr8js'),
    path.resolve(__dirname, '../node_modules/avr8js'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    for (const target of [
      path.join(candidate, 'dist', 'cjs', 'index.js'),
      path.join(candidate, 'dist', 'esm', 'index.js'),
      candidate,
    ]) {
      try {
        return require(path.resolve(target));
      } catch {
        /* try next */
      }
    }
  }
  throw new Error('avr8js-not-found');
}

function hexToProgram(text) {
  const program = new Uint16Array(16384); // ATmega328P: 32 KB
  let high = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(':')) continue;
    const count = parseInt(line.substr(1, 2), 16);
    const offset = parseInt(line.substr(3, 4), 16) + (high << 16);
    const type = parseInt(line.substr(7, 2), 16);
    if (type === 0) {
      for (let i = 0; i < count; i += 2) {
        const lo = parseInt(line.substr(9 + i * 2, 2), 16);
        const hi = parseInt(line.substr(9 + i * 2 + 2, 2), 16);
        const wordAddr = (offset + i) >> 1;
        if (wordAddr >= 0 && wordAddr < program.length) program[wordAddr] = lo | (hi << 8);
      }
    } else if (type === 4) {
      high = parseInt(line.substr(9, 4), 16);
    } else if (type === 1) {
      break;
    }
  }
  return program;
}

function fail(error, supported = true) {
  console.log(JSON.stringify({ supported, success: false, error }));
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  fail('Invalid JSON payload on stdin.');
}
if (!payload || typeof payload.hex !== 'string' || !payload.hex.trim()) {
  fail('hex_content (Intel HEX string) is required.');
}

let avr;
try {
  avr = loadAvr8js();
} catch {
  fail(
    'avr8js module not found on the server. Install it with "npm install avr8js" '
      + 'and point VELXIO_AVR8JS_PATH at the package directory '
      + '(the repo layout frontend/node_modules/avr8js works out of the box).',
    false,
  );
}

const observeMs = Math.min(Math.max(Number(payload.observe_ms) || 2000, 100), 10000);
const CYCLES_PER_MS = 16000; // ATmega328P @ 16 MHz

const cpu = new avr.CPU(hexToProgram(payload.hex), 8192);
// Ports + timers: timer0 drives Arduino millis()/delay(), so it must tick.
const ports = {
  B: new avr.AVRIOPort(cpu, avr.portBConfig),
  C: new avr.AVRIOPort(cpu, avr.portCConfig),
  D: new avr.AVRIOPort(cpu, avr.portDConfig),
};
new avr.AVRTimer(cpu, avr.timer0Config);
new avr.AVRTimer(cpu, avr.timer1Config);
new avr.AVRTimer(cpu, avr.timer2Config);

let serial = '';
try {
  const usart = new avr.AVRUSART(cpu, avr.usart0Config, 16000000);
  usart.onByteTransmit = (value) => {
    serial += String.fromCharCode(value & 0xff);
    if (serial.length > 8000) serial = serial.slice(-8000);
  };
} catch {
  /* serial observation is best-effort */
}

let adc = null;
try {
  if ((payload.analog && typeof payload.analog === 'object')
      || (Array.isArray(payload.analog_events) && payload.analog_events.length)) {
    adc = new avr.AVRADC(cpu, avr.adcConfig);
  }
  if (adc && payload.analog && typeof payload.analog === 'object') {
    for (const [channel, volts] of Object.entries(payload.analog)) {
      const index = Number(channel);
      if (Number.isInteger(index) && index >= 0 && index <= 15) {
        adc.channelValues[index] = Math.max(0, Math.min(5, Number(volts) || 0));
      }
    }
  }
} catch {
  /* analog stimulus is best-effort */
}

// A potentiometer turned, a sensor value changed mid-run: same idea, on a clock.
const analogEvents = (Array.isArray(payload.analog_events) ? payload.analog_events : [])
  .map((event) => ({
    atMs: Number(event.at_ms) || 0,
    channel: Number(event.channel),
    volts: Math.max(0, Math.min(5, Number(event.volts) || 0)),
  }))
  .filter((event) => adc && Number.isInteger(event.channel) && event.channel >= 0 && event.channel <= 15)
  .sort((a, b) => a.atMs - b.atMs);

// External digital drives (a button pressed, a switch thrown) at simulated times.
function setDigitalPin(pin, state) {
  if (pin >= 0 && pin <= 7) ports.D.setPin(pin, state);
  else if (pin >= 8 && pin <= 13) ports.B.setPin(pin - 8, state);
  else if (pin >= 14 && pin <= 19) ports.C.setPin(pin - 14, state);
}
const interactions = (Array.isArray(payload.interactions) ? payload.interactions : [])
  .map((event) => ({
    atMs: Number(event.at_ms) || 0,
    pin: Number(event.pin),
    state: !!event.state,
  }))
  .filter((event) => Number.isInteger(event.pin) && event.pin >= 0 && event.pin <= 19)
  .sort((a, b) => a.atMs - b.atMs);
let nextInteraction = 0;
let nextAnalogEvent = 0;

// Arduino pin mapping (Uno/Nano): PORTD→0..7, PORTB→8..13, PORTC→14..21 (A0..A5).
const PIN_OFFSET = { B: 8, C: 14, D: 0 };
const stats = new Map();
function record(pin, state, timeMs) {
  let entry = stats.get(pin);
  if (!entry) {
    entry = { transitions: 0, lastState: null, firstMs: null, lastMs: null, recent: [] };
    stats.set(pin, entry);
  }
  if (entry.lastState !== state) {
    entry.transitions += 1;
    entry.lastState = state;
    if (entry.firstMs === null) entry.firstMs = timeMs;
    entry.lastMs = timeMs;
    entry.recent.push(timeMs);
    if (entry.recent.length > 32) entry.recent.shift();
  }
}
for (const [name, port] of Object.entries(ports)) {
  const offset = PIN_OFFSET[name];
  port.addListener((value) => {
    const timeMs = cpu.cycles / CYCLES_PER_MS;
    for (let bit = 0; bit < 8; bit++) record(offset + bit, (value & (1 << bit)) !== 0, timeMs);
  });
}

const endCycles = observeMs * CYCLES_PER_MS;
while (cpu.cycles < endCycles) {
  const nowMs = cpu.cycles / CYCLES_PER_MS;
  while (nextInteraction < interactions.length && interactions[nextInteraction].atMs <= nowMs) {
    const event = interactions[nextInteraction++];
    setDigitalPin(event.pin, event.state);
  }
  while (nextAnalogEvent < analogEvents.length && analogEvents[nextAnalogEvent].atMs <= nowMs) {
    const event = analogEvents[nextAnalogEvent++];
    adc.channelValues[event.channel] = event.volts;
  }
  const sliceEnd = Math.min(cpu.cycles + 200000, endCycles);
  while (cpu.cycles < sliceEnd) {
    avr.avrInstruction(cpu);
    cpu.tick();
  }
}

const result = {
  supported: true,
  success: true,
  simulated_ms: Math.round(cpu.cycles / CYCLES_PER_MS),
  pins: {},
  serial: serial.slice(-4000),
};
// An empty/absent watch list means 'report every pin that changed'.
const watch = Array.isArray(payload.watch_pins) && payload.watch_pins.length ? payload.watch_pins.map(String) : null;
for (const [pin, entry] of stats) {
  if (watch && !watch.includes(String(pin)) && !watch.includes('A' + Math.max(0, pin - 14))) continue;
  const intervals = entry.recent.slice(1).map((t, i) => t - entry.recent[i]);
  const sorted = intervals.slice().sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  result.pins[String(pin)] = {
    transitions: entry.transitions,
    last_state: entry.lastState,
    first_change_ms: entry.firstMs === null ? null : Math.round(entry.firstMs),
    last_change_ms: entry.lastMs === null ? null : Math.round(entry.lastMs),
    median_period_ms: median === null ? null : Math.round(median * 100) / 100,
  };
}
console.log(JSON.stringify(result));
