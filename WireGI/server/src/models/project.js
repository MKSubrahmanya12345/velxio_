// Project + part domain models. Embodies the 3-state model:
//   IDEA (what the human wants) -> CURRENT (gathered/understood) -> VERIFIED.
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
    status: 'init', // init | researching | awaiting_human | partial | complete
    profileId: null, // domain profile — resolved in runProject (Jev D1 + goal)
    profileLabel: null,
    state: {
      idea: { goal, constraints, parts: [], revisions: [] }, // the living document
      current: { parts: [] },
      verified: { parts: [] },
      parts: [],
      decisions: [],
      researchLog: [],
      reconciliations: [], // cross-part integration passes
      chat: [{ role: 'system', content: `Project created: ${goal}`, ts: now }],
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
    humanCheckpoint: false,
    attempts: 0, // how many research passes have run (Gap B resumability)
    error: null, // last failure message when status === 'failed'
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
