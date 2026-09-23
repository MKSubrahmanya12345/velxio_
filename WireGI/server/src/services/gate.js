// Gate — Jev-gated pre-LLM decisions (Gap 1 / optimization A).
//
// Core pattern (OpenRouter/Jev reference): "Route with Jev, compute in code,
// write with an LLM." Every part research used to be an unconditional LLM call.
// Now a single cheap Jev call (only when real Jev is configured) decides the
// cheapest safe path: reuse a sibling, skip (offload to human), use a cheap
// model, or do a full LLM pass.
//
// FAIL-SAFE RULE (user requirement): if Jev is unavailable, slow, or returns a
// bad decision, we route straight to the LLM. A missing/late decision never
// blocks the build — we use LLM knowledge.
import { choice, score, noul, num, answerValue, answerCertainty, noulTrue } from './jevQuestions.js';
import { getProfile, isSafetyCritical, DEFAULT_PROFILE } from './profiles.js';

const JEV_TIMEOUT_MS = 5000;

// NOTE: what counts as "safety-critical" is now PROFILE-DEFINED, not a single
// global regex — battery/ESC/KV for robotics, secrets/migrations for software,
// load/torque for mechanical. See profiles.js.

// Confidence policy — tune on your own traffic (OpenRouter guidance: start 0.8).
const REUSE_CONF = 0.75; // needed=no  → skip LLM
const DUP_CONF = 0.70; // dup=yes    → copy sibling
const SKIP_CONF = 0.70; // tier=skip  → offload to human
const ACT_CONF = 0.8; // general floor for acting on a typed answer

// Cheapest-capable model preference for the "light" tier.
const CHEAP_PREFERENCE = ['ollama', 'groq', 'openrouter', 'gemini', 'llm', 'bedrock'];

// Race a promise against a timeout; on timeout/throw, return null (→ fail safe).
// Exported so other services (reconcile) can apply the same rule.
export async function withTimeout(promise, ms) {
  let t;
  const guard = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error('jev-timeout')), ms);
  });
  try {
    const r = await Promise.race([promise, guard]);
    clearTimeout(t);
    return r;
  } catch {
    clearTimeout(t);
    return null;
  }
}

function cheapestPrefer(registry) {
  const cands = (registry && registry.candidates && registry.candidates()) || [];
  for (const p of CHEAP_PREFERENCE) {
    const hit = cands.find((c) => c.provider === p);
    if (hit) return hit.provider;
  }
  return undefined;
}

// Decide how to research ONE part.
// Returns { action:'dup'|'skip'|'light'|'full', source?, prefer?, reason, confidence, usedJev }.
export async function triagePart({ part, project, indexer, jev, registry, profile }) {
  const prof = profile || getProfile(project?.profileId) || DEFAULT_PROFILE;

  // Safety-critical FOR THIS DOMAIN → always full LLM, no gate. What counts as
  // dangerous is profile-defined: battery/ESC/KV for robotics, secrets/migrations
  // for software, load/torque for mechanical.
  if (isSafetyCritical(part.name, part.domain || '', prof)) {
    return {
      action: 'full',
      reason: `safety-critical in ${prof.label} — forced full LLM research`,
      confidence: 1,
      usedJev: false,
    };
  }
  // No real Jev → skip the gate, default LLM path.
  if (!jev || !jev.available) {
    return { action: 'full', reason: 'no Jev configured — default LLM path', confidence: 1, usedJev: false };
  }

  const indexed = (indexer && indexer.all ? Object.values(indexer.all()) : [])
    .slice(0, 12)
    .map((e) => ({ topic: e.topic, summary: e.summary }));
  const siblings = project.state.parts
    .filter((p) => p.id !== part.id)
    .map((p) => ({ name: p.name, hasData: !!p.current?.data }));

  const questions = {
    needed: noul(
      'Given the indexed prior findings, is a fresh LLM research call actually needed for this part, or do we already have enough? Answer LOW only if existing findings already adequately cover it.',
    ),
    tier: choice('Complexity/risk tier that should do the work for this part.', {
      skip: 'Trivial/boilerplate — no research needed, the human can fill this in',
      light: 'Simple, well-known — a cheap model can handle it',
      full: 'Complex or uncertain — needs the full research pass',
    }),
    risk: score(
      'How safety/performance-critical is this part? Wrong math on power, propulsion or firmware can destroy hardware.',
      ['trivial', 'low', 'medium', 'high', 'critical'],
    ),
    dup: noul('Does this part duplicate another already-researched part in this project?'),
  };
  const state = {
    operation: 'triage',
    part: part.name,
    domain: part.domain,
    idea: part.idea,
    indexed,
    siblings,
  };

  const res = await withTimeout(jev.decide({ state, questions }, { registry }), JEV_TIMEOUT_MS);
  if (!res || !res.answers) {
    return { action: 'full', reason: 'Jev decision unavailable/slow — routed to LLM', confidence: 1, usedJev: false };
  }
  const a = res.answers;
  const conf = (id) => answerCertainty(a[id]);
  const val = (id) => answerValue(a[id]);

  // Duplicate → copy sibling data (0 LLM).
  if (noulTrue(a.dup) && (conf('dup') ?? 0) >= DUP_CONF) {
    const src = siblings.find((s) => s.hasData);
    return {
      action: 'dup',
      source: src?.name,
      reason: 'duplicate of an already-researched part',
      confidence: conf('dup'),
      usedJev: true,
    };
  }
  // Not needed → skip LLM (offload trivial to human).
  if (!noulTrue(a.needed) && (conf('needed') ?? 0) >= REUSE_CONF) {
    return { action: 'skip', reason: 'prior findings sufficient — offloaded to human input', confidence: conf('needed'), usedJev: true };
  }
  const risk = num(val('risk')) ?? 1;
  const tier = String(val('tier') || 'full').toLowerCase();
  // High risk → force full.
  if (risk >= 4) return { action: 'full', reason: `high risk (${risk}) — full LLM`, confidence: conf('risk'), usedJev: true };
  if (tier === 'full') return { action: 'full', reason: 'Jev tier=full', confidence: conf('tier'), usedJev: true };
  if (tier === 'skip' && risk <= 2)
    return { action: 'skip', reason: 'trivial part — offloaded to human', confidence: conf('tier'), usedJev: true };
  if (tier === 'light')
    return {
      action: 'light',
      prefer: cheapestPrefer(registry),
      reason: 'Jev tier=light (cheaper model)',
      confidence: conf('tier'),
      usedJev: true,
    };
  // Below confidence floors → fail safe to full LLM.
  return {
    action: 'full',
    reason: 'below confidence floor — default LLM',
    confidence: Math.max(conf('tier') ?? 0, conf('needed') ?? 0),
    usedJev: true,
  };
}

// D2/D3: breadth + risk bias for decomposition. The LLM still writes the parts;
// Jev only steers how many and how carefully.
export async function decomposePlan({ goal, constraints, jev, registry }) {
  if (!jev || !jev.available) return { breadthHint: 0, riskBias: '', usedJev: false };
  const questions = {
    breadth: choice('How many distinct parts should this build be decomposed into?', {
      'minimal (~4)': 'Only the essential parts — a quick, cheap build',
      'standard (~8)': 'The normal set of parts for a working build',
      'detailed (~12)': 'Every part, including tools and verification steps',
    }),
    risk: score('Overall build risk if done wrong.', [
      'low',
      'moderate',
      'elevated',
      'high',
      'critical',
    ]),
  };
  const res = await withTimeout(
    jev.decide({ state: { operation: 'decompose', goal, constraints }, questions }, { registry }),
    JEV_TIMEOUT_MS,
  );
  if (!res || !res.answers) return { breadthHint: 0, riskBias: '', usedJev: false };
  const breadth = String(answerValue(res.answers.breadth) || '').toLowerCase();
  const hint = breadth.includes('minimal') ? 5 : breadth.includes('detailed') ? 12 : 8;
  const risk = num(answerValue(res.answers.risk)) ?? 2;
  return {
    breadthHint: hint,
    riskBias:
      risk >= 4 ? ' Pay special attention to safety-critical parts (power, propulsion, firmware).' : '',
    usedJev: true,
  };
}

// T5: which parts a constraint change actually touches.
export async function affectedParts({ project, text, jev, registry }) {
  const parts = project.state.parts;
  if (!jev || !jev.available || parts.length === 0) return parts.map((p) => p.id); // fail safe: all
  const questions = {};
  for (const p of parts) {
    questions[`aff_${p.id}`] = noul(
      `Does the user's latest message require re-researching the "${p.name}" part specifically? "${text}"`,
    );
  }
  const res = await withTimeout(
    jev.decide({ state: { operation: 'affected', goal: project.goal, message: text }, questions }, { registry }),
    JEV_TIMEOUT_MS,
  );
  if (!res || !res.answers) return parts.map((p) => p.id);
  const ids = parts.filter((p) => noulTrue(res.answers[`aff_${p.id}`])).map((p) => p.id);
  return ids.length ? ids : parts.map((p) => p.id); // if Jev says none, still re-run all (safe)
}

// T4: is gathered data sufficient? If not, push to human rather than auto-repair.
export async function isSufficient({ part, project, jev, registry }) {
  if (!jev || !jev.available) return true;
  const questions = {
    sufficient: noul(
      'Is the gathered data for this part complete enough to build from, with no blocking unknowns?',
    ),
  };
  const res = await withTimeout(
    jev.decide(
      { state: { operation: 'sufficiency', part: part.name, data: part.current?.data, openQuestions: part.openQuestions || [] }, questions },
      { registry },
    ),
    JEV_TIMEOUT_MS,
  );
  if (!res || !res.answers) return true;
  return noulTrue(res.answers.sufficient);
}
