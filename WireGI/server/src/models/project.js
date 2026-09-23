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
    status: 'init', // init | researching | awaiting_human | complete
    state: {
      idea: { goal, constraints, parts: [] },
      current: { parts: [] },
      verified: { parts: [] },
      parts: [],
      decisions: [],
      researchLog: [],
      chat: [{ role: 'system', content: `Project created: ${goal}`, ts: now }],
    },
  };
}

export function makePart({ name, domain, idea = {} }) {
  return {
    id: newId('part'),
    name,
    domain,
    status: 'pending', // pending|researching|data_ready|awaiting_human|verified
    idea, // IDEA
    current: null, // CURRENT: gathered/understood/data
    verified: false, // VERIFIED
    humanCheckpoint: false,
    research: [],
    gathered: [],
    data: null,
    checklist: [],
    openQuestions: [],
    updatedAt: new Date().toISOString(),
  };
}
