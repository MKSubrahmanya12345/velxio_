// Domain profiles — the layer that turns one generic engine into a specific
// build domain.
//
// The bottleneck for "anything buildable" was never the agent loop. It is that
// "buildable" means different SHAPES: hardware needs battery/wiring/config,
// software needs deps/tests/deploy, mechanical needs dimensions/material/joinery.
// A profile declares, per domain:
//
//   dataFields      what the research output must contain (drives the LLM schema)
//   decompose       how the work should be split
//   safetyCritical  what must NEVER be gated or skipped (wrong = hardware dies)
//   ladder          which verification rungs exist for this domain
//   verification    what "confirmed working" means here
//
// Adding a domain is adding an entry to this file — nothing else changes.

export const PROFILES = {
  electronics: {
    id: 'electronics',
    label: 'Electronics / Embedded',
    summary: 'PCBs, wiring, microcontrollers, power systems, firmware-bound hardware.',
    keywords: /arduino|esp-?32|esp8266|stm32|raspberry|pcb|solder|sensor|relay|micro ?controller|\bmcu\b|circuit|breadboard|led|motor driver|voltage regulator/i,
    decompose:
      'Cover every subsystem a builder must buy or make: power, control/logic, sensing, actuation, wiring/connectors, and the firmware that binds them. Include the firmware as its own part, not as a footnote.',
    dataFields: [
      {
        key: 'bomRow',
        type: 'string',
        desc: 'one-line BOM row — qty, exact part number, key specs (voltage/current/size), indicative price, source',
      },
      {
        key: 'wiring',
        type: 'string',
        desc: 'pin-to-pad connections, power rails, polarity, connector types, and the safety checks (continuity, short check before first power)',
      },
      {
        key: 'config',
        type: 'string',
        desc: 'firmware name + version, required libraries, or the exact code/config snippet that makes this part work',
      },
    ],
    safetyCritical:
      /battery|esc\b|electronic speed|\bmotor\b|\bkv\b|propulsion|propeller|power|current|voltage|regulator|polarity|short|flight controller|\bfc\b|firmware|solder|capacitor/i,
    ladder: ['research', 'sim', 'bench-test', 'human-eyes'],
    verification:
      'simulate the circuit/firmware where possible, then bench-test with a meter or scope, then human eyeball before first power. Wrong power math destroys hardware.',
  },

  mechanical: {
    id: 'mechanical',
    label: 'Mechanical / Fabrication',
    summary: 'Frames, enclosures, linkages, joints, material selection.',
    keywords: /frame|chassis|bracket|enclosure|mount|fastener|bolt|screw|bearing|gearbox|linkage|sheet metal|3d print|cnc|weld|joinery|fabricat/i,
    decompose:
      'Cover structure, motion/constraints, fastening and joining, material selection, tolerances, and the tools required. Include the measurement/check steps as parts.',
    dataFields: [
      {
        key: 'bomRow',
        type: 'string',
        desc: 'material/fastener line — stock form, size, grade, quantity, indicative price, source',
      },
      {
        key: 'wiring',
        type: 'string',
        desc: 'how this part joins to the rest: fasteners, adhesives, fits, torque values',
      },
      {
        key: 'config',
        type: 'string',
        desc: 'the numbers that make it work — key dimensions, tolerances, cut list, or drawing notes',
      },
    ],
    safetyCritical:
      /load|torque|pressure|safety factor|point of failure|structural|weight limit|stress|fatigue|hazard|sharp|clamp|pressur/i,
    ladder: ['research', 'cad-sim', 'load-test', 'human-eyes'],
    verification:
      'model the geometry and loads, then measure the real part against the drawing, then human inspection for fit and finish.',
  },

  software: {
    id: 'software',
    label: 'Software',
    summary: 'Apps, services, scripts, APIs, websites — anything that runs.',
    keywords: /app|website|web ?app|api|server|script|frontend|backend|database|bot|cli|service|deploy|saas|dashboard|mobile/i,
    decompose:
      'Cover the data model, the interfaces/contracts between components, configuration and secrets, dependencies, tests, and deployment. Do not decompose by file — decompose by responsibility.',
    dataFields: [
      {
        key: 'bomRow',
        type: 'string',
        desc: 'dependency line — package name, version constraint, licence, and why it is needed',
      },
      {
        key: 'wiring',
        type: 'string',
        desc: 'how this part connects to the others — interfaces, API shapes, data contracts, env vars it reads and writes',
      },
      {
        key: 'config',
        type: 'string',
        desc: 'the configuration, environment variables, or code snippet that makes this part work',
      },
    ],
    safetyCritical:
      /secret|credential|\bauth\b|password|token|payment|migration|data ?loss|destructive|backup|encrypt|permission|privacy/i,
    ladder: ['research', 'unit-test', 'integration-test', 'human-eyes'],
    verification:
      'run the tests, then exercise the real integration path, then human review of behaviour against the requirement.',
  },

  robotics: {
    id: 'robotics',
    label: 'Robotics / Control',
    summary: 'Machines that sense and act — drones, rovers, arms, servos.',
    keywords: /robot|drone|quadcopter|multirotor|rover|servo|actuator|kinemat|control loop|\bpid\b|autonomous|navigation|gimbal|\brc\b/i,
    decompose:
      'Cover the physical build, the power system, every sensor, every actuator, the control loop, and the firmware. State the control/estimation approach explicitly — it is usually the part that decides whether the machine works.',
    dataFields: [
      {
        key: 'bomRow',
        type: 'string',
        desc: 'one-line BOM row — qty, exact part number, key specs (voltage/current/torque/thrust/size), indicative price, source',
      },
      {
        key: 'wiring',
        type: 'string',
        desc: 'power and signal routing: rails, pin/pad map, bus (I²C/SPI/UART/CAN), polarity, and pre-power safety checks',
      },
      {
        key: 'config',
        type: 'string',
        desc: 'firmware name + version, PID/control parameters, tuning starting points, or the exact snippet required',
      },
    ],
    safetyCritical:
      /battery|esc\b|motor|\bkv\b|propeller|propulsion|thrust|current|voltage|power|thermal|arming|failsafe|geofence|servo|torque|limit switch/i,
    ladder: ['research', 'sim', 'bench-test', 'field-test', 'human-eyes'],
    verification:
      'simulate the control loop, bench-test with props off, field-test at reduced power in a safe area, then human confirmation. Never test a new machine at full authority.',
  },

  // Fallback for anything that does not clearly match — still useful, just generic.
  generic: {
    id: 'generic',
    label: 'General Build',
    summary: 'Anything that does not clearly match a specialised domain.',
    keywords: /.*/,
    decompose:
      'Cover everything a person must obtain or make, the method to assemble it, the configuration or parameters that make it work, and how to check it worked. Include tools and verification steps as parts.',
    dataFields: [
      {
        key: 'bomRow',
        type: 'string',
        desc: 'one-line materials/parts row — item, exact spec, quantity, indicative price, source',
      },
      {
        key: 'wiring',
        type: 'string',
        desc: 'how this part connects or attaches to the rest of the build',
      },
      {
        key: 'config',
        type: 'string',
        desc: 'the settings, parameters, recipe, or snippet that make this part work',
      },
    ],
    safetyCritical:
      /battery|power|current|voltage|load|pressure|weight|heat|fire|chemical|sharp|toxic|fall|structural|electrical/i,
    ladder: ['research', 'test', 'human-eyes'],
    verification:
      'research the facts, test the critical property, then human confirmation that it matches the intent.',
  },
};

export const DEFAULT_PROFILE = PROFILES.generic;

export function getProfile(id) {
  return PROFILES[String(id || '').toLowerCase()] || DEFAULT_PROFILE;
}

// Pick a profile from Jev's classification, the LLM's classification, and the
// goal text. Ordered: exact id → domain keywords → goal keywords → generic.
// Never throws; a bad classification just falls back.
export function pickProfile(classification, domains = [], goal = '') {
  const direct = String(classification || '').trim().toLowerCase();
  if (PROFILES[direct]) return PROFILES[direct];

  const hay = [direct, ...(domains || []), goal || ''].join(' ').toLowerCase();
  // Specialised profiles only — generic advertises /.*/ and would always match.
  for (const p of Object.values(PROFILES)) {
    if (p.id === 'generic') continue;
    if (p.keywords.test(hay)) return p;
  }
  return DEFAULT_PROFILE;
}

// Guards: wrong math on these parts destroys hardware. Profiles define their
// own set, so a software profile does not inherit battery semantics.
export function isSafetyCritical(name = '', domain = '', profile) {
  const p = profile || DEFAULT_PROFILE;
  const re = p.safetyCritical || DEFAULT_PROFILE.safetyCritical;
  return re.test(name) || re.test(domain);
}

// The JSON `data` block the research LLM must fill in for this domain.
export function schemaBlock(profile) {
  const p = profile || DEFAULT_PROFILE;
  const fields = p.dataFields
    .map((f) => `    "${f.key}": ${f.type}      // ${f.desc}`)
    .join(',\n');
  return `  "data": {\n${fields},\n    "checklist": [string]   // ordered build steps and pass/fail checks for this part\n  }`;
}

// Human-readable ladder, for prompts and the UI.
export function ladderText(profile) {
  return (profile || DEFAULT_PROFILE).ladder.join(' → ');
}
