// Project + part domain models. Embodies the 3-state model:
//   IDEA (what the human wants) -> CURRENT (gathered/understood) -> VERIFIED.
//
// It also carries the debugging record for the project: which runs happened,
// what each one did (runLog) and every error that occurred (errors). That is
// what makes a failed run inspectable instead of a dead end.
import crypto from 'node:crypto';

export function newId(prefix = 'prj') {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

export function makeProject({ goal, constraints = {} }) {
  const now = new Date().toISOString();
  return {
    id: newId('prj'),
    createdAt: now,
    updatedAt: now,
    goal,
    constraints,
    status: 'init', // init | researching | awaiting_human | partial | complete | failed
    profileId: null, // domain profile — resolved in runProject (Jev D1 + goal)
    profileLabel: null,
    currentRunId: null,
    state: {
      idea: { goal, constraints, parts: [], revisions: [] }, // the living document
      current: { parts: [] },
      verified: { parts: [] },
      parts: [],
      decisions: [],
      researchLog: [],
      reconciliations: [], // cross-part integration passes
      // The simulation rung (services/velxio.js): the artifact the agent
      // built in the Velxio simulator — circuit, firmware files, tool log,
      // what was verified, and the human's next steps. null until a design
      // loop has run.
      sim: null,
      chat: [{ role: 'system', content: `Project created: ${goal}`, ts: now }],
      // ── debugger / observability ─────────────────────────────────────────
      runs: [], // one record per run: id, kind, status, startedAt, ms, events
      errors: [], // full error records (name, message, where, stack, attempts)
      runLog: [], // ordered trace of every event, newest last (ring buffer)
    },
  };
}

export function makePart({ name, domain, idea = {} }) {
  return {
    id: newId('part'),
    name,
    domain,
    // pending | researching | data_ready | awaiting_human | verified | failed
    status: 'pending',
    idea, // IDEA
    current: null, // CURRENT: gathered/understood/data
    verified: false, // VERIFIED
    humanCheckpoint: false, // needs your EYES (approval) — only when research is confident
    // needs your ANSWER: the agent's own gate found its data insufficient and
    // its self-repair pass could not close the gap. The human may answer (it
    // is folded into the next research pass) but may NOT approve — approving
    // data the agent itself doubts would forge the evidence ladder.
    needsInput: false,
    attempts: 0, // how many research passes have run (Gap B resumability)
    error: null, // last failure message when status === 'failed'
    errorDetail: null, // {name, message, where, stack, attempts[]} for the debugger
    // What the human answered at the checkpoint (approve note, correction,
    // rejection). Fed into the next research pass for this part, so the human's
    // own words shape the result instead of being lost in a chat message.
    humanInput: [],
    // Which path the gate chose for this part, and who answered.
    tier: null, // full | light | skip | dup
    triageReason: null,
    meta: null, // {provider, model, latencyMs, attempts, webEngine, webCount}
    startedAt: null,
    finishedAt: null,
    // Verification ladder evidence. VERIFIED is not a boolean — this is why it
    // is believed, in order: research → sim/test → human-eyes.
    evidence: [],
    research: [],
    gathered: [],
    data: null,
    checklist: [],
    openQuestions: [],
    updatedAt: new Date().toISOString(),
  };
}
