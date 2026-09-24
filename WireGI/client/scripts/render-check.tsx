// ─────────────────────────────────────────────────────────────────────────────
// Render regression check (no test runner, no browser needed).
//
// Renders the real panels to static markup with a fixture that contains exactly
// the things that used to break the UI: a failed part, a provider 429, a fatal
// run error, live activity. It then asserts that NO rendered output contains
// "undefined" — the class of bug that produced "ERROR undefined".
//
//   cd WireGI/client && npm run test:render
// ─────────────────────────────────────────────────────────────────────────────
import { renderToStaticMarkup } from 'react-dom/server';
import ChatPanel from '../src/components/ChatPanel';
import HumanCheckpoint from '../src/components/HumanCheckpoint';
import FlowPanel from '../src/components/FlowPanel';
import PartCard from '../src/components/PartCard';
import OverviewPanel from '../src/components/OverviewPanel';
import InspectorPanel from '../src/components/InspectorPanel';
import { Markdown } from '../src/lib/markdown';
import type { FlowEntry, Part, Project, Health } from '../src/types';

const parts: Part[] = [
  { id: 'part_0', name: 'ESC', domain: 'hardware', status: 'awaiting_human', tier: 'full', humanCheckpoint: true,
    openQuestions: ['Confirm the 50A variant before ordering?'],
    current: { gathered: [], data: { bomRow: 'ESC · 4-in-1 45A', wiring: 'VCC → 5V rail', config: '', checklist: [] } },
    humanInput: [{ at: new Date().toISOString(), text: 'use the 50A variant', decision: 'provide' }] },
  { id: 'part_1', name: 'Motors', domain: 'hardware', status: 'failed', attempts: 2,
    error: 'Every configured provider failed after 10 attempts',
    errorDetail: { name: 'Error', message: 'Every configured provider failed after 10 attempts across 10 of 10 rounds.',
      where: 'part:Motors', status: 502, provider: 'groq', attempts: [{ provider: 'groq', model: 'llama', status: 429, latencyMs: 120, message: 'rate limited' }],
      stack: 'Error: nope\n    at researchOne (agent.js:220)' }, tier: 'light', triageReason: 'Jev tier=light (cheaper model)' },
  { id: 'part_2', name: 'Frame', domain: 'mechanical', status: 'data_ready', tier: 'full', humanCheckpoint: true,
    meta: { provider: 'openai', model: 'gpt-4o', latencyMs: 900, webEngine: 'tavily', webCount: 5, llmMs: 880, totalMs: 1200 },
    current: { gathered: [{ field: 'spec', value: '220mm', source: 'web' }], data: { bomRow: 'frame · x', wiring: 'none', config: 'cfg', checklist: ['a'] } },
    checklist: ['a'], openQuestions: ['q?'], evidence: [{ rung: 'research', detail: 'tavily × 5' }], research: ['note'] },
  { id: 'part_3', name: 'Battery', domain: 'hardware', status: 'researching', attempts: 1, tier: 'full' },
];

const flow: FlowEntry[] = [
  { seq: 1, t: 12, type: 'run', stage: 'start', kind: 'build', level: 'info', message: 'Run started — build' },
  { seq: 2, t: 40, type: 'project', stage: 'decomposed', parts: [{ id: 'part_2', name: 'Frame', domain: 'mechanical' }], level: 'info', message: 'Decomposed into 10 parts' },
  { seq: 3, t: 60, type: 'provider', stage: 'fail', provider: 'groq', model: 'llama', status: 429, latencyMs: 120, level: 'warn', message: '✖ Groq HTTP 429 — rate limited' },
  { seq: 4, t: 90, type: 'part', stage: 'failed', part: 'Motors', partId: 'part_1', level: 'error', message: 'Motors failed — providers exhausted',
    error: { name: 'Error', message: 'Every configured provider failed after 10 attempts', where: 'part:Motors', stack: 'Error: x\n at y' } },
  { seq: 5, t: 120, type: 'error', stage: 'run', where: 'runProject', fatal: true, level: 'error', message: 'Run failed — Error: no keys', error: { name: 'Error', message: 'no generation providers are configured', where: 'runProject' } },
  { seq: 6, t: 130, type: 'log', level: 'debug', message: 'provider attempt' },
];

const project: Project = {
  id: 'prj_1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), goal: 'make me a drone',
  constraints: { budget: 400 }, status: 'partial', profileId: 'robotics', profileLabel: 'robotics',
  state: {
    idea: { classification: 'robotics', domains: ['hardware'], profile: { label: 'robotics', ladder: ['research', 'sim', 'bench', 'human-eyes'] }, revisions: [{ revision: 1, kind: 'created', note: 'x', at: new Date().toISOString() }] },
    current: { parts: [] }, verified: { parts: [] }, parts,
    decisions: [{ label: 'D1 classify', at: new Date().toISOString(), source: 'jev', answers: { classification: { choice: 'robotics', confidence: 0.9 } } }],
    researchLog: [{ part: 'Frame', web: { engine: 'tavily', count: 5 }, ts: new Date().toISOString(), meta: { provider: 'openai', llmMs: 880 } },
                  { part: 'Motors', web: { engine: 'failed', count: 0 }, ts: new Date().toISOString(), error: 'boom' }],
    reconciliations: [{ at: new Date().toISOString(), coherent: false, summary: 'tight margin', conflicts: [{ severity: 'warning', parts: ['ESC', 'Props'], issue: 'x', resolution: 'y', patchesApplied: ['ESC.bomRow'] }], patchesApplied: 1 }],
    chat: [
      { role: 'system', content: 'Project created: make me a drone', ts: new Date().toISOString() },
      { role: 'user', content: 'add a budget of $400', ts: new Date().toISOString() },
      { role: 'agent', content: '# make me a drone\n\nStatus: **partial**\n\n## Parts\n\n- **Motors** (hardware) — failed · ✖ nope\n    - BOM: x\n\n## Errors during the run (last 1)\n\n- `part:Motors`: ERROR: boom\n', ts: new Date().toISOString() },
    ],
    runs: [{ id: 'run_1', kind: 'build', status: 'partial', startedAt: new Date().toISOString(), ms: 1200, events: 158,
             error: 'Every configured provider failed after 10 attempts' }],
    errors: [{ at: new Date().toISOString(), where: 'part:Motors', name: 'Error', message: 'Every configured provider failed after 10 attempts', stack: 'Error: x\n at y' }],
    runLog: flow.slice(0, 4),
  },
};

const health: Health = { ok: true, service: 'wiregi-server', version: '0.2.0', ports: { server: 4322, client: 5175 },
  jev: 'llm-fallback', providers: 0, activeProvider: null, webSearch: null, time: new Date().toISOString(),
  env: { files: [], inheritForge: true, llmConfigured: false, llmKeys: [] }, debug: { enabled: true, level: 'debug' } };

const run = { running: true, kind: 'build', runId: 'run_1', startedAt: Date.now(), status: 'researching', currentPhase: 'research', phases: [{ name: 'classify', ms: 12, at: Date.now() }], total: 10, done: 4, failed: 1, lastMessage: 'x' };

const out = [
  renderToStaticMarkup(<ChatPanel project={project} flow={flow} run={run as any} parts={parts} busy
    checkpointParts={parts.filter((p) => p.humanCheckpoint && !p.verified)} failedParts={[parts[0]]} pendingParts={[parts[2]]} onSend={() => {}} onResume={() => {}} onCancel={() => {}} onOpenFlow={() => {}} />),
  renderToStaticMarkup(<FlowPanel flow={flow} project={project} health={health} onClear={() => {}} />),
  renderToStaticMarkup(<PartCard part={parts[0]} defaultOpen />),
  renderToStaticMarkup(<PartCard part={parts[1]} />),
  renderToStaticMarkup(<OverviewPanel project={project} parts={parts} run={run as any} />),
  renderToStaticMarkup(<InspectorPanel tab="flow" setTab={() => {}} project={project} parts={parts} run={run as any} flow={flow} health={health} busy onResume={() => {}} onClearFlow={() => {}} />),
  renderToStaticMarkup(<Markdown text={'# h\n- a **b** `c`\n\ntext'} />),
  // chat after a run finished but parts still need eyes → the checkpoint card must appear
  renderToStaticMarkup(<ChatPanel project={{ ...project, status: 'awaiting_human' }} flow={flow} run={{ ...run, running: false } as any} parts={parts} busy={false}
    checkpointParts={parts.filter((p) => p.humanCheckpoint && !p.verified)}
    failedParts={[parts[1]]} pendingParts={[]} onSend={() => {}} onResume={() => {}} onCancel={() => {}} onOpenFlow={() => {}} onRespond={() => {}} />),
  // single checkpoint part → the card opens by default, so the action row renders
  renderToStaticMarkup(<HumanCheckpoint parts={[parts[0]]} busy={false} onRespond={() => {}} onApproveAll={() => {}} />),
  // two checkpoint parts → collapsed list, plus the "approve all" button
  renderToStaticMarkup(<HumanCheckpoint parts={parts.filter((p) => p.humanCheckpoint)} busy={false} onRespond={() => {}} onApproveAll={() => {}} />),
].join('\n<!-- ---------------- -->\n');

const checks = [
  ['no ERROR undefined', !/ERROR undefined/.test(out)],
  ['no literal "undefined"', !/\bundefined\b/.test(out)],
  ['chat bubble rendered', out.includes('class="bubble')],
  ['flow row rendered', out.includes('class="flow-row')],
  ['error message surfaced', out.includes('Every configured provider failed')],
  ['attempt table rendered', out.includes('rate limited')],
  ['status badges', out.includes('badge failed')],
  ['checkpoint card rendered', out.includes('checkpoint-item')],
  ['checkpoint actions rendered', out.includes('checkpoint-actions') && out.includes('Reject')],
  ['checkpoint answer box rendered', out.includes('Answer the questions above')],
  ['approve-all offered for several parts', out.includes('Approve all')],
  ['checkpoint surfaces when the run is over (not a dead end)', /waiting on your eyes/.test(out)],
  ['render bytes', out.length > 5000],
];
let bad = 0;
for (const [label, ok] of checks) { if (!ok) bad++; console.log(`${ok ? '✔' : '✖'} ${label}`); }
if (bad) {
  console.log('\n--- output ---\n' + out.slice(0, 3000));
  process.exit(1);
}
console.log(`\n✔ render check passed (${out.length} bytes of markup)`);
