#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// End-to-end smoke test of the Flow pipeline (server side).
//
// Starts the dev mock LLM, starts the WireGI server against it, runs one real
// "make me a drone" request over the ndjson stream, and checks the trace:
//
//   · a run start + run end event
//   · Jev/LLM decisions, decomposition with parts, per-part research
//   · provider events for every attempt (no raw type:'error' for an attempt)
//   · EVERY event has a non-empty string message (the `ERROR undefined` bug)
//   · the durable run log + errors are readable back over /api/projects/:id/debug
//
// Usage:  cd WireGI/server && npm run smoke      (or: node ../scripts/smoke.mjs)
// Env:    SMOKE_PORT (4399) SMOKE_MOCK_PORT (4598)
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '..', 'server');
const PORT = Number(process.env.SMOKE_PORT || 4399);
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 4598);
const DATA_FILE = './data/smoke-projects.json';

const children = [];
function cleanup() {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

function start(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  children.push(child);
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  return { child, logs };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await wait(250);
  }
  return false;
}

async function streamRun(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify(body),
  });
  const events = [];
  let buffer = '';
  for await (const chunk of r.body) {
    buffer += Buffer.from(chunk).toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line || line.startsWith(':')) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* ignore */
      }
    }
  }
  return { events, status: r.status };
}

const problems = [];
const check = (cond, label) => {
  if (cond) console.log(`  ✔ ${label}`);
  else {
    console.log(`  ✖ ${label}`);
    problems.push(label);
  }
};

async function main() {
  // clean slate
  const dataPath = path.resolve(SERVER_DIR, DATA_FILE);
  fs.rmSync(dataPath, { force: true });

  console.log(`\n▲ smoke: mock LLM on :${MOCK_PORT}, WireGI on :${PORT}\n`);
  const mock = start(process.execPath, [path.join(HERE, 'mock-llm.mjs')], {
    env: { ...process.env, MOCK_LLM_PORT: String(MOCK_PORT), MOCK_LLM_LATENCY_MS: '20' },
  });
  const server = start(process.execPath, ['src/index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      WIREGI_PORT: String(PORT),
      WIREGI_INHERIT_FORGE_ENV: 'false',
      LLM_API_KEY: 'dev-mock',
      LLM_API_BASE: `http://127.0.0.1:${MOCK_PORT}/v1`,
      LLM_MODEL: 'mock-model',
      DATA_FILE,
      WIREGI_LOG_LEVEL: 'debug',
      WIREGI_RETRIES: '1',
      WIREGI_RETRY_BASE_MS: '50',
      WIREGI_CONCURRENCY: '3',
    },
  });

  const upMock = await waitFor(`http://127.0.0.1:${MOCK_PORT}/v1/chat/completions`).catch(() => false);
  const upServer = await waitFor(`http://127.0.0.1:${PORT}/api/health`);
  if (!upServer || !upMock) {
    console.log(mock.logs.join(''), server.logs.join(''));
    throw new Error('servers did not come up');
  }

  // ── drive one run ──────────────────────────────────────────────────────────
  const res = await fetch(`http://127.0.0.1:${PORT}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify({ goal: 'make me a drone' }),
  });
  check(res.ok, `POST /api/projects → ${res.status}`);

  const events = [];
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += Buffer.from(chunk).toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line || line.startsWith(':')) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        problems.push(`unparseable stream line: ${line.slice(0, 80)}`);
      }
    }
  }

  const byType = (t) => events.filter((e) => e.type === t);
  const result = byType('result')[0]?.result;
  const runStart = byType('run').find((e) => e.stage === 'start');
  const runEnd = byType('run').find((e) => e.stage === 'end');
  const decomposed = byType('project').find((e) => e.stage === 'decomposed');
  const parts = byType('part');
  const partStarts = parts.filter((e) => e.stage === 'start');
  const partDone = parts.filter((e) => e.stage === 'done');
  const providers = byType('provider');

  console.log('\n  trace:');
  check(events.length > 20, `stream produced ${events.length} events`);
  check(Boolean(runStart) && Boolean(runEnd), `run start/end present (${runEnd?.status || '?'})`);
  check(byType('decision').length >= 3, `${byType('decision').length} decisions (D1, D2/D3, D4-D6…)`);
  check(Array.isArray(decomposed?.parts) && decomposed.parts.length >= 6, `decomposed into ${decomposed?.parts?.length} parts`);
  check(partStarts.length === decomposed?.parts?.length, `every part started (${partStarts.length})`);
  check(partDone.length === partStarts.length, `every part finished (${partDone.length})`);
  check(providers.length > 0, `${providers.length} provider events (attempts are not errors)`);
  check(
    byType('error').every((e) => e.error && typeof e.error.message === 'string' && e.error.message.length > 0),
    'error events carry a real message',
  );
  const traceEvents = events.filter((e) => e.type !== 'result');
  const emptyMessages = traceEvents.filter((e) => typeof e.message !== 'string' || !e.message.trim());
  check(emptyMessages.length === 0, `no event has an empty message (${emptyMessages.length} bad)`);
  const seqs = events.filter((e) => typeof e.seq === 'number').map((e) => e.seq);
  check(seqs.length > 0 && seqs.every((s, i) => i === 0 || s > seqs[i - 1]), 'sequence numbers are monotonic');
  const timed = traceEvents.filter((e) => typeof e.t === 'number');
  check(timed.length === traceEvents.length, `every trace event is time-stamped (${timed.length}/${traceEvents.length})`);

  const projectId = result?.id || decomposed?.projectId;
  check(Boolean(projectId), `project persisted (${projectId})`);

  // ── the debug endpoint ────────────────────────────────────────────────────
  const dbg = await (await fetch(`http://127.0.0.1:${PORT}/api/projects/${projectId}/debug`)).json();
  check(Array.isArray(dbg.runLog) && dbg.runLog.length > 10, `run log persisted (${dbg.runLog?.length} entries)`);
  check(Array.isArray(dbg.runs) && dbg.runs.length >= 1, `run record persisted (${dbg.runs?.[0]?.status}, ${dbg.runs?.[0]?.ms}ms)`);
  check(Boolean(dbg.env?.files?.length), 'debug endpoint reports the env files in use');

  const health = await (await fetch(`http://127.0.0.1:${PORT}/api/debug/health`)).json();
  check(health.providers?.count > 0, `health sees ${health.providers?.count} provider key(s)`);
  const llmTest = await (
    await fetch(`http://127.0.0.1:${PORT}/api/debug/llm-test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  ).json();
  check(llmTest.ok === true, `llm-test succeeded via ${llmTest.used?.provider}/${llmTest.used?.model}`);

  // ── failure isolation + resume + error reporting ──────────────────────────
  // Make the mock fail one part, run again, then resume with the fault cleared.
  await fetch(`http://127.0.0.1:${MOCK_PORT}/__control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ failParts: ['Motors'] }),
  });
  const failRun = await streamRun(`http://127.0.0.1:${PORT}/api/projects`, { goal: 'make me a drone' });
  const failedPart = failRun.events.find((e) => e.type === 'part' && e.stage === 'failed');
  const failedProject = failRun.events.find((e) => e.type === 'result')?.result;
  console.log('\n  failure isolation:');
  check(Boolean(failedPart), 'the injected failure is reported as part.failed');
  check(
    Boolean(failedPart?.error?.message) && !/undefined/i.test(failedPart?.error?.message || ''),
    `failure message is real: "${(failedPart?.error?.message || '').slice(0, 90)}…"`,
  );
  check(failRun.events.filter((e) => e.type === 'part' && e.stage === 'done').length === 9, 'the other 9 parts still finished');
  check(failedProject?.status === 'partial', `project status is "${failedProject?.status}"`);
  check((failedProject?.state?.errors || []).length >= 1, 'the error was recorded on the project (state.errors)');

  await fetch(`http://127.0.0.1:${MOCK_PORT}/__control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ failParts: [] }),
  });
  const resumeRun = await streamRun(`http://127.0.0.1:${PORT}/api/projects/${failedProject.id}/resume`, {});
  const resumedProject = resumeRun.events.find((e) => e.type === 'result')?.result;
  check(
    (resumedProject?.state?.parts || []).every((p) => p.status !== 'failed'),
    'resume fixed the failed part (no failed parts left)',
  );

  // ── the human checkpoint (the chat-driven exit from awaiting_human) ───────
  // No LLM is involved: approve, answer, re-run and reject must all work even
  // with providers configured to fail.
  console.log('\n  human checkpoint:');
  const awaiting = resumedProject;
  const waiting = (awaiting?.state?.parts || []).filter((p) => p.humanCheckpoint && !p.verified);
  const second = waiting[1] || waiting[0]; // tolerate fixtures with a single checkpoint
  check(waiting.length > 0, `project is awaiting human eyes on ${waiting.length} part(s)`);

  const approveRun = await streamRun(`http://127.0.0.1:${PORT}/api/projects/${awaiting.id}/human`, {
    decision: 'approve',
    partId: waiting[0]?.id,
    text: 'verified by eye',
  });
  const approved = approveRun.events.find((e) => e.type === 'result')?.result;
  const approvedPart = (approved?.state?.parts || []).find((p) => p.id === waiting[0]?.id);
  check(approvedPart?.verified === true, 'approve marks the part verified');
  check(approvedPart?.status === 'verified', 'approved part status is "verified"');
  check(
    (approvedPart?.evidence || []).some((e) => e.rung === 'human-eyes' && /verified by eye/.test(e.detail || '')),
    'approval is recorded on the evidence ladder (human-eyes + what you said)',
  );
  check(
    approveRun.events.some((e) => e.type === 'human' && e.stage === 'approve' && e.message),
    'the approval is a first-class flow event',
  );

  const provideRun = await streamRun(`http://127.0.0.1:${PORT}/api/projects/${awaiting.id}/human`, {
    decision: 'provide',
    partId: second?.id,
    text: 'use the 50A ESC variant',
  });
  const provided = provideRun.events.find((e) => e.type === 'result')?.result;
  const providedPart = (provided?.state?.parts || []).find((p) => p.id === second?.id);
  check(
    (providedPart?.humanInput || []).some((h) => /50A ESC/.test(h.text)),
    'your answer is stored on the part (humanInput)',
  );
  check(
    (provided?.state?.chat || []).some((m) => m.role === 'agent'),
    'the conversation records the outcome',
  );

  const rejectRun = await streamRun(`http://127.0.0.1:${PORT}/api/projects/${awaiting.id}/human`, {
    decision: 'reject',
    partId: second?.id,
    text: 'wrong connector — redo it',
  });
  const rejected = rejectRun.events.find((e) => e.type === 'result')?.result;
  const rejectedPart = (rejected?.state?.parts || []).find((p) => p.id === second?.id);
  check(
    rejectedPart?.status !== 'failed' && Boolean(rejectedPart?.current?.data),
    `reject re-ran the research (status "${rejectedPart?.status}")`,
  );
  check(
    (rejectedPart?.humanInput || []).some((h) => h.decision === 'reject'),
    'the rejection is recorded on the part',
  );

  const badDecision = await fetch(`http://127.0.0.1:${PORT}/api/projects/${awaiting.id}/human`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'burn-it' }),
  });
  check(badDecision.status === 400, 'an unknown decision is rejected with HTTP 400, not a silent no-op');

  console.log('');
  if (problems.length) {
    console.log(`✖ ${problems.length} problem(s):`);
    for (const p of problems) console.log(`   - ${p}`);
    console.log('\n--- server log tail ---\n' + server.logs.join('').split('\n').slice(-40).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('✔ smoke passed — flow, tracing and debug endpoints all healthy');
  }
  console.log(`\n  events by type: ${JSON.stringify(countByType(events))}\n`);
  cleanup();
}

function countByType(events) {
  const out = {};
  for (const e of events) {
    const k = e.type;
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

main().catch((err) => {
  console.error('smoke failed:', err);
  cleanup();
  process.exit(1);
});
