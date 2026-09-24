#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// DEV FIXTURE — an OpenAI-compatible stand-in for a real provider.
//
// This is NOT part of the product and the server never starts it. Forge's rule
// stands: a real run uses a real provider. This exists so the *flow* — Jev
// questions, decomposition, parallel research, reconciliation, retries, errors,
// the debugger UI — can be exercised end-to-end without keys, and so a
// UI/plumbing change can be tested deterministically.
//
//   node WireGI/scripts/mock-llm.mjs                 # :4599
//   MOCK_LLM_PORT=4599 MOCK_LLM_FAILS=2 node WireGI/scripts/mock-llm.mjs
//
// Then point WireGI at it for one shell (nothing is written to your .env):
//
//   cd WireGI/server
//   LLM_API_KEY=dev-mock LLM_API_BASE=http://127.0.0.1:4599/v1 npm start
//
// Knobs (all optional):
//   MOCK_LLM_PORT=4599          port to listen on
//   MOCK_LLM_LATENCY_MS=120     artificial latency per call
//   MOCK_LLM_FAILS=0            fail the FIRST n calls with HTTP 429 (tests retry)
//   MOCK_LLM_FAIL_PARTS=Motors  comma-separated part names that always fail (500)
//   MOCK_LLM_BAD_JSON=          comma-separated part names that answer with junk
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';

const PORT = Number(process.env.MOCK_LLM_PORT || 4599);
const LATENCY = Math.max(0, Number(process.env.MOCK_LLM_LATENCY_MS || 120));
const FAILS = Math.max(0, Number(process.env.MOCK_LLM_FAILS || 0));
const failParts = String(process.env.MOCK_LLM_FAIL_PARTS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const badJsonParts = String(process.env.MOCK_LLM_BAD_JSON || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

let calls = 0;
let failuresLeft = FAILS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const partFrom = (text) => {
  const m = String(text).match(/PART:\s*([^\n(]+)/i) || String(text).match(/"part"\s*:\s*"([^"]+)"/i);
  return m ? m[1].trim() : '';
};

const DRONE_PARTS = [
  ['Frame', 'mechanical', '5-inch carbon frame, 220mm wheelbase, stack + motor mounting pattern'],
  ['Motors', 'hardware', '4 × 2207 brushless motors, 1750KV-6S, 5mm shaft'],
  ['Electronic Speed Controllers (ESCs)', 'hardware', '4-in-1 45A BLHeli_32 ESC, 3-6S, with current sensor'],
  ['Flight Controller', 'hardware', 'STM32H743 FC running Betaflight, 5 UARTs, barometer'],
  ['Propellers', 'hardware', '5.1x4.6 tri-blade props, PC material, 2 CW + 2 CCW'],
  ['Radio Receiver and Transmitter', 'hardware', 'ELRS 2.4GHz receiver + radio transmitter, 500Hz packet rate'],
  ['Video System', 'hardware', 'Analog or digital VTX + FPV camera, 5.8GHz, ≤ 25mW for bench'],
  ['Battery', 'hardware', '6S 1300mAh 100C LiPo, XT60, with balance lead'],
  ['Firmware and Configuration', 'firmware', 'Betaflight 4.5 target, rates, failsafe, ELRS binding, motor order'],
  ['Tools and Pre-flight Verification', 'tools', 'Soldering iron, smoke stopper, prop-off test, range check, maiden plan'],
];

const DECOMPOSE_TEMPLATE = (goal) => ({
  classification: /drone|quad|fpv|uav/i.test(goal) ? 'robotics' : 'mixed',
  domains: ['hardware', 'firmware'],
  parts: (/drone|quad|fpv|uav/i.test(goal) ? DRONE_PARTS : DRONE_PARTS.slice(0, 6)).map(([name, domain, idea]) => ({
    name,
    domain,
    idea,
  })),
});

// Parse the typed questions out of a rendered decision prompt and answer them
// the way a real decision model would.
function answerQuestions(user) {
  const answers = {};
  const blocks = String(user).split(/\n(?=- id: )/);
  const part = partFrom(user).toLowerCase();
  const risky = /battery|firmware|esc|electronic speed/i.test(part);
  for (const block of blocks) {
    const id = (block.match(/- id:\s*([A-Za-z0-9_]+)/) || [])[1];
    if (!id) continue;
    const type = (block.match(/type:\s*(\w+)/) || [])[1] || 'noul';
    if (type === 'choice') {
      const opts = (block.match(/choose exactly one key from:\s*(\[[^\]]*\])/) || [])[1];
      let keys = [];
      try {
        keys = JSON.parse(opts || '[]');
      } catch {
        keys = [];
      }
      let pick = keys[0];
      if (keys.includes('robotics')) pick = 'robotics';
      else if (keys.includes('full') && risky) pick = 'full';
      else if (keys.includes('light')) pick = 'light';
      else if (keys.includes('standard (~8)')) pick = 'standard (~8)';
      else if (keys.includes('hardware')) pick = 'hardware';
      else if (keys.includes('approve') && /approve|confirm|looks good|verified/i.test(user)) pick = 'approve';
      else if (keys.includes('ask')) pick = 'ask';
      else if (keys.includes('none')) pick = 'none';
      answers[id] = { type: 'choice', choice: pick, confidence: 0.86 };
    } else if (type === 'score') {
      const list = (block.match(/0-based index into:\s*(\[[^\]]*\])/) || [])[1];
      let len = 5;
      try {
        len = JSON.parse(list || '[]').length || 5;
      } catch {
        len = 5;
      }
      const score = risky ? len - 1 : Math.min(2, len - 1);
      answers[id] = { type: 'score', score, confidence: 0.8 };
    } else {
      // noul — a calibrated yes/no
      const low = /dup|duplicate/i.test(id);
      answers[id] = { type: 'noul', noul: low ? 0.08 : risky ? 0.92 : 0.86, confidence: 0.8 };
    }
  }
  return { answers };
}

const researchReply = (part, risky) => ({
  research: [
    `${part}: chosen from current 2026 part catalogues; specs cross-checked against two vendor listings.`,
    `Compatibility note recorded for ${part} against the rest of the build.`,
  ],
  gathered: [
    { field: 'part', value: `${part} — reference model`, source: 'model knowledge' },
    { field: 'spec', value: risky ? 'rated 3-6S, 45A continuous, 60A burst' : 'standard spec, see datasheet', source: 'model knowledge' },
    { field: 'price', value: risky ? '$38.90' : '$12.50', source: 'model knowledge' },
  ],
  understand: {
    validation: [`${part} spec is consistent with a 6S 5-inch build.`],
    openQuestions: risky ? [] : [`Confirm exact connector/variant for ${part} before ordering.`],
    conflicts: [],
  },
  data: {
    bomRow: `${part} · reference model · 1 pc · ~$20`,
    wiring: `${part}: VCC → 5V rail, GND → common ground, signal → FC pad (verify before solder)`,
    config: `${part} config:\n  protocol: default\n  failsafe: enabled\n  notes: bench-test with props removed`,
    checklist: [`Verify ${part} polarity`, `Smoke-stop first power-up`, `Record serial/part number`],
  },
  humanCheckpoint: risky ? true : false,
});

function reconcileReply() {
  return {
    coherent: false,
    summary:
      'The nine researched parts form a buildable whole; the strongest coupling checked is battery 6S → ESC rating and motor KV.',
    conflicts: [
      {
        severity: 'warning',
        parts: ['Electronic Speed Controllers (ESCs)', 'Propellers'],
        issue: 'ESC current rating leaves ~15% margin at the chosen prop load — acceptable but tight.',
        resolution: 'Keep the 45A ESC, or step up to 50A for headroom at full throttle.',
        patches: [
          {
            part: 'Electronic Speed Controllers (ESCs)',
            field: 'bomRow',
            value: 'Electronic Speed Controllers (ESCs) · 4-in-1 45A BLHeli_32 (50A recommended for margin)',
          },
        ],
      },
    ],
  };
}

const server = http.createServer(async (req, res) => {
  // Runtime control (used by scripts/smoke.mjs to inject failures mid-test).
  //   POST /__control {"failParts":["Motors"],"badJsonParts":[],"fails":0}
  if (req.url?.includes('/__control')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      /* ignore */
    }
    if (Array.isArray(body.failParts)) failParts.splice(0, failParts.length, ...body.failParts.map((x) => String(x).toLowerCase()));
    if (Array.isArray(body.badJsonParts)) badJsonParts.splice(0, badJsonParts.length, ...body.badJsonParts.map((x) => String(x).toLowerCase()));
    if (typeof body.fails === 'number') failuresLeft = Math.max(0, body.fails);
    if (body.resetCalls) calls = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, calls, failParts, badJsonParts, failuresLeft }));
    return;
  }
  if (!req.url?.includes('/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'mock-llm: only /chat/completions is served' } }));
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  calls += 1;
  let body = {};
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    /* keep {} */
  }
  const system = body?.messages?.find((m) => m.role === 'system')?.content || '';
  const user = body?.messages?.find((m) => m.role === 'user')?.content || '';
  const part = partFrom(user);
  const partLower = part.toLowerCase();

  await sleep(LATENCY);

  const send = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  const reply = (text) =>
    send(200, { choices: [{ message: { role: 'assistant', content: text } }], usage: { total_tokens: 0 } });

  // Failure injection first — that is the point of a harness.
  if (failuresLeft > 0) {
    failuresLeft -= 1;
    return send(429, { error: { message: `mock-llm: injected rate limit (call ${calls})` } });
  }
  if (failParts.includes(partLower)) {
    return send(500, { error: { message: `mock-llm: injected failure for part "${part}"` } });
  }
  if (badJsonParts.includes(partLower)) {
    return reply('Sure! Here is a friendly paragraph instead of JSON.');
  }

  if (/You decompose a build request/.test(system)) {
    const goal = (user.match(/GOAL:\s*(.*)/) || [])[1] || 'build';
    return reply('```json\n' + JSON.stringify(DECOMPOSE_TEMPLATE(goal), null, 2) + '\n```');
  }
  if (/You are the research lead/.test(system)) {
    const risky = /battery|firmware|esc|electronic speed/i.test(part);
    return reply(JSON.stringify(researchReply(part || 'Part', risky), null, 2));
  }
  if (/typed decision model/.test(system)) {
    return reply(JSON.stringify(answerQuestions(user)));
  }
  if (/integration lead/.test(system)) {
    return reply(JSON.stringify(reconcileReply(), null, 2));
  }
  if (/Extract updated constraints/.test(system)) {
    return reply(JSON.stringify({ constraints: { budget: 'under $400', size: '5-inch' } }));
  }
  if (/Summarize these web results|Answer the query from your knowledge/.test(system)) {
    return reply('- Mock summary point one.\n- Mock summary point two.\n- (dev fixture, not live web)');
  }
  if (/You are WireGI, an agentic build assistant/.test(system)) {
    return reply('Mock assistant reply: the parts are researched; say "approve all" to verify them.');
  }
  return reply('{"ok":true}');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`mock-llm listening on http://0.0.0.0:${PORT}/v1  (dev fixture — not a real provider)`);
  if (FAILS) console.log(`  first ${FAILS} call(s) will fail with HTTP 429`);
  if (failParts.length) console.log(`  parts that always fail: ${failParts.join(', ')}`);
});
