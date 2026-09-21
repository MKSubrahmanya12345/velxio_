// Forge — data model & constants. Plain ESM, zero dependencies.
//
// The ProjectState object is the single source of truth for a build — and it
// is also the `state` we send to Jev on every interaction. See forge/README.md
// ("Core idea") for why this dual role is the architectural center.

export const CATEGORIES = [
  'electronics', 'mechanical', 'robotics', 'software',
  'woodwork', 'craft', 'food', 'general',
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

// The API persists a Project envelope around the mutable ProjectState. Keeping
// this construction in one place prevents the state object from accidentally
// being returned at the project level (which makes the client look for
// `project.state` and find undefined).
export function makeProject(state, metadata = {}) {
  const createdAt = String(metadata.createdAt || now());
  return {
    id: String(metadata.id || crypto.randomUUID()),
    createdAt,
    updatedAt: String(metadata.updatedAt || createdAt),
    state,
  };
}

// Normalize the current envelope and the shape written by early Forge builds.
// Older versions persisted ProjectState directly, so accepting that shape here
// lets the server recover existing JSON/Mongo projects without a data wipe.
export function normalizeProject(raw, fallbackId = '') {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw;
  const id = value.id || value._id || fallbackId;
  const metadata = {
    id,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };

  if (value.state && typeof value.state === 'object' && Array.isArray(value.state.phases)) {
    return makeProject(value.state, metadata);
  }

  if (Array.isArray(value.phases)) {
    const {
      id: _id,
      _id: _mongoId,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...state
    } = value;
    return makeProject(state, metadata);
  }

  return null;
}

function strArr(v) {
  return Array.isArray(v)
    ? v.map((x) => String(x ?? '').trim()).filter(Boolean)
    : [];
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ── Step / BOM construction ──────────────────────────────────────────────────

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
    status: 'todo',
    failed: 0,
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
    status: 'pending',
  };
}

export function defaultAcceptance(goal) {
  return [
    `${String(goal).trim()} is assembled and structurally complete`,
    'It works as described in the original request',
    'All safety-critical steps were completed with proper care',
  ];
}

// Normalizes a raw plan (from the mock KB or an LLM) into the canonical shape.
// This is the trust boundary: anything the planner returns is coerced here.
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
  return state.phases.flatMap((p) => p.steps);
}

export function phaseIdOf(state, stepId) {
  return state.phases.find((p) => p.steps.some((s) => s.id === stepId))?.id ?? null;
}

export function activeStepRef(state) {
  const steps = flatSteps(state);
  if (!state.current?.stepId) return null;
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
  const all = flatSteps(state);
  const done = all.filter((s) => s.status === 'done').length;
  return { completed: done, total: all.length, pct: all.length ? done / all.length : 0 };
}

export function log(state, kind, text) {
  state.log.push({ at: now(), kind, text });
  if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
}
