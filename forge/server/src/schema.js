import { normalizeMemory } from './memory/model.js';
// Forge — data model & constants. Plain ESM, zero dependencies.
// Now chat-first: Conversation is primary, ProjectState is embedded when planning happens.
// Human is a tool the agent can call.

export const CATEGORIES = [
  'electronics', 'mechanical', 'robotics', 'software',
  'woodwork', 'craft', 'food', 'general',
];

export const CHAT_INTENTS = [
  'build_request', 'question', 'status_update', 'human_tool_result', 'general', 'scope_change', 'claim_done'
];

export const INTENTS = [
  'step_done', 'step_failed', 'question', 'deviation', 'substitute_request',
  'scope_change', 'claim_done', 'blocked', 'off_topic',
];

export const CHIP_LABELS = {
  done: 'Chip: step done',
  failed: 'Chip: step failed',
  substitute: 'Chip: I have a different part than the plan calls for',
  question: 'Chip: question about the current step',
  claim_done: 'Chip: I think the whole project is done',
  safety_ack: 'Chip: safety acknowledged',
  accept_proposal: 'Chip: accept proposal',
  decline_proposal: 'Chip: decline proposal',
};

const now = () => new Date().toISOString();
export const nowIso = now;

const uid = (p = 'id') => `${p}_${crypto.randomUUID().slice(0, 8)}`;

// ── Legacy Project envelope (kept for backward compat) ──────────────────────
export function makeProject(state, metadata = {}) {
  const createdAt = String(metadata.createdAt || now());
  return {
    id: String(metadata.id || crypto.randomUUID()),
    createdAt,
    updatedAt: String(metadata.updatedAt || createdAt),
    state,
  };
}

export function normalizeProject(raw, fallbackId = '') {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw;
  const id = value.id || value._id || fallbackId;
  const metadata = { id, createdAt: value.createdAt, updatedAt: value.updatedAt };
  if (value.state && typeof value.state === 'object' && Array.isArray(value.state.phases)) {
    return makeProject(value.state, metadata);
  }
  if (Array.isArray(value.phases)) {
    const { id: _id, _id: _mongoId, createdAt: _createdAt, updatedAt: _updatedAt, ...state } = value;
    return makeProject(state, metadata);
  }
  return null;
}

// ── Chat types ───────────────────────────────────────────────────────────────

function strArr(v) {
  return Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function makeMessage(role, content, extra = {}) {
  return {
    id: extra.id || uid('msg'),
    role, // user | assistant | system | tool
    content: String(content || ''),
    at: extra.at || now(),
    decisions: extra.decisions || [],
    toolCalls: extra.toolCalls || [],
    toolCallId: extra.toolCallId || null,
    plan: extra.plan || null, // optional embedded plan for rendering
    meta: extra.meta || {},
  };
}

export function makeConversation(input = {}) {
  const id = input.id || crypto.randomUUID();
  const createdAt = input.createdAt || now();
  return {
    id,
    createdAt,
    updatedAt: input.updatedAt || createdAt,
    title: input.title || (input.goal ? String(input.goal).slice(0, 60) : 'New build chat'),
    messages: Array.isArray(input.messages) ? input.messages : [],
    memory: normalizeMemory(input.memory),
    // ProjectState when a build has been planned
    projectState: input.projectState || input.state || null,
    // Human tool pending calls
    pendingHumanTools: Array.isArray(input.pendingHumanTools) ? input.pendingHumanTools : [],
    counters: input.counters || { messages: 0, jevCalls: 0, humanCalls: 0, plans: 0 },
    // For backward compat, also expose state alias
    get state() { return this.projectState; },
  };
}

export function normalizeConversation(raw, fallbackId = '') {
  if (!raw || typeof raw !== 'object') return null;
  // If it's old project shape, convert to conversation
  const proj = normalizeProject(raw, fallbackId);
  if (proj && !raw.messages) {
    return makeConversation({
      id: proj.id,
      createdAt: proj.createdAt,
      updatedAt: proj.updatedAt,
      title: proj.state?.goal || 'Imported project',
      messages: [],
      projectState: proj.state,
      counters: proj.state?.counters ? { ...proj.state.counters, humanCalls: 0, plans: 1 } : undefined,
    });
  }
  // Already a conversation
  if (Array.isArray(raw.messages)) {
    return makeConversation({
      id: raw.id || raw._id || fallbackId,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      title: raw.title,
      messages: raw.messages,
      projectState: raw.projectState || raw.state || null,
      pendingHumanTools: raw.pendingHumanTools,
      memory: raw.memory,
      counters: raw.counters,
    });
  }
  return null;
}

// ── Step / BOM construction (same as before, used by planner) ───────────────

export function makeStep(raw, i) {
  const safety = Array.isArray(raw.safety)
    ? raw.safety.filter(Boolean).map((s) => ({
        hazard: String(s.hazard || s.note || 'hazard').toLowerCase(),
        severity: ['info', 'warn', 'high'].includes(s.severity) ? s.severity : 'warn',
        note: s.note ? String(s.note) : undefined,
      }))
    : [];
  const dod = strArr(raw.definition_of_done);
  return {
    id: raw.id || uid('step'),
    title: String(raw.title || `Step ${i + 1}`),
    track: raw.track === 'sim' ? 'sim' : 'physical',
    instructions: String(raw.instructions || ''),
    materials: strArr(raw.materials),
    tools: strArr(raw.tools),
    safety,
    definition_of_done: dod.length ? dod : ['Step visibly complete and matching its title'],
    skills: strArr(raw.skills).length ? strArr(raw.skills) : ['general'],
    status: raw.status || 'todo',
    failed: Number(raw.failed) || 0,
    sim: null,
  };
}

export function makeBomItem(raw, i) {
  return {
    id: raw.id || uid('bom'),
    name: String(raw.name || `Part ${i + 1}`),
    qty: Number.isFinite(Number(raw.qty)) && Number(raw.qty) > 0 ? Number(raw.qty) : 1,
    cost_usd: num(raw.cost_usd ?? raw.cost) ?? 0,
    spec: raw.spec ? String(raw.spec) : undefined,
    status: raw.status || 'pending',
  };
}

export function defaultAcceptance(goal) {
  return [
    `${String(goal).trim()} is assembled and structurally complete`,
    'It works as described in the original request',
    'All safety-critical steps were completed with proper care',
  ];
}

export function sanitizePlan(raw, goal) {
  if (!raw || !Array.isArray(raw.phases) || raw.phases.length === 0) {
    throw new Error('plan: phases[] missing');
  }
  const phases = raw.phases
    .map((p, pi) => ({
      id: p.id || uid('phase'),
      name: String(p.name || `Phase ${pi + 1}`),
      steps: (Array.isArray(p.steps) ? p.steps : []).map((s, si) => makeStep(s, si)),
    }))
    .filter((p) => p.steps.length > 0);
  if (!phases.length) throw new Error('plan: no steps');

  const bom = (Array.isArray(raw.bom) ? raw.bom : []).map((b, i) => makeBomItem(b, i));
  const seen = new Set(bom.map((b) => b.name.toLowerCase()));
  for (const p of phases) {
    for (const s of p.steps) {
      for (const m of s.materials) {
        if (!seen.has(m.toLowerCase())) {
          bom.push(makeBomItem({ name: m, qty: 1 }, bom.length));
          seen.add(m.toLowerCase());
        }
      }
    }
  }

  const acceptance = Array.isArray(raw.acceptance) && raw.acceptance.length
    ? raw.acceptance.map(String).slice(0, 12)
    : defaultAcceptance(goal);

  return { goal: String(goal), phases, bom, acceptance };
}

export function normalizeConstraints(c = {}) {
  return {
    budget_usd: num(c.budget_usd),
    time: ['weekend', 'multi_day', 'multi_week'].includes(c.time) ? c.time : 'multi_day',
    skill: ['novice', 'intermediate', 'expert'].includes(c.skill) ? c.skill : 'intermediate',
    notes: String(c.notes || ''),
  };
}

// ── State helpers ────────────────────────────────────────────────────────────

export function flatSteps(state) {
  if (!state) return [];
  return state.phases.flatMap((p) => p.steps);
}

export function phaseIdOf(state, stepId) {
  return state?.phases.find((p) => p.steps.some((s) => s.id === stepId))?.id ?? null;
}

export function activeStepRef(state) {
  if (!state) return null;
  const steps = flatSteps(state);
  if (!state.current?.stepId) {
    const first = steps.find((s) => s.status !== 'done');
    if (!first) return null;
    return { step: first, index: steps.indexOf(first), total: steps.length, phase: state.phases.find((p) => p.steps.some((s) => s.id === first.id)) };
  }
  let idx = steps.findIndex((s) => s.id === state.current.stepId);
  if (idx < 0) idx = steps.findIndex((s) => s.status !== 'done');
  if (idx < 0) return null;
  const step = steps[idx];
  return {
    step,
    index: idx,
    total: steps.length,
    phase: state.phases.find((p) => p.steps.some((s) => s.id === step.id)),
  };
}

export function nextIncompleteStep(state) {
  return flatSteps(state).find((s) => s.status !== 'done') ?? null;
}

export function progress(state) {
  if (!state) return { completed: 0, total: 0, pct: 0 };
  const all = flatSteps(state);
  const done = all.filter((s) => s.status === 'done').length;
  return { completed: done, total: all.length, pct: all.length ? done / all.length : 0 };
}

export function log(state, kind, text) {
  if (!state) return;
  if (!state.log) state.log = [];
  state.log.push({ at: now(), kind, text });
  if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
}

// ── Human tool helpers ───────────────────────────────────────────────────────

export function makeHumanToolCall(stepRef, extra = {}) {
  const step = stepRef?.step;
  if (!step) return null;
  return {
    id: uid('human'),
    name: 'human',
    status: 'requires_action',
    at: now(),
    arguments: {
      task: step.title,
      instructions: step.instructions,
      materials: step.materials,
      tools: step.tools,
      safety: step.safety,
      definition_of_done: step.definition_of_done,
      track: step.track,
      phase: stepRef.phase?.name || '',
      stepId: step.id,
      ...extra,
    },
    result: null,
  };
}

export function completeHumanToolCall(toolCall, resultText, success = true) {
  toolCall.status = success ? 'completed' : 'failed';
  toolCall.result = resultText;
  toolCall.completedAt = now();
  return toolCall;
}
