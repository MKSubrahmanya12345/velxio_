// Forge — the synthesis & message pipeline.
//
// This is the "skeleton": deterministic orchestration of Jev decisions (the
// nervous system) and the planner (the prefrontal cortex). Every branch here
// is a straight-line rule over structured verdicts — no free-form LLM text is
// ever parsed for control flow. The response `text` is for the human; the
// decisions array is for transparency (rendered in the UI).
//
// J5 — confidence gating — is the meta-rule: when a Jev verdict's confidence
// falls below the threshold for its stakes, the pipeline either clarifies
// (ask the human), refuses to act, or escalates (full mode: wake the LLM).

import {
  activeStepRef, normalizeConstraints, sanitizePlan, progress, log,
  nowIso, CHIP_LABELS, flatSteps,
} from './schema.js';
import { runDecision } from './decisions/catalog.js';
import { markStepComplete, advanceStep, skillOutcome, needsAck } from './stateMachine.js';

const INTENT_THRESHOLD = 0.55; // below: don't act, ask for rephrase
const VERIFY_THRESHOLD = 0.6;  // below: verified but not certain → confirm
const ACCEPT_MIN_CERTAINTY = 0.8; // J9 uses its own; mirrored here for text

// ── Intake: goal → feasibility gate → plan → first step ─────────────────────

export async function synthesizeProject(deps, input) {
  const goal = String(input.goal || '').trim();
  const constraints = normalizeConstraints(input.constraints);
  const decisions = [];

  const j1 = await runDecision(
    'J1',
    { goal, constraints, jevState: { goal, constraints } },
    deps,
  );
  decisions.push(j1);

  const feasibility = {
    category: j1.detail.category,
    buildability: j1.detail.buildability,
    risk_tier: j1.detail.risk_tier,
    complexity: j1.detail.complexity,
  };

  const state = {
    goal,
    constraints,
    feasibility,
    status: 'active',
    phases: [],
    current: { phaseId: null, stepId: null },
    inventory: [],
    bom: [],
    acceptance: [],
    log: [],
    skill: {},
    safetyAcks: {},
    safetyGate: null,
    counters: { messages: 0, jevCalls: 0, escalations: 0, stepsCompleted: 0, substitutions: 0 },
    confidence: {},
    proposal: null,
  };

  if (feasibility.buildability === 'no') {
    state.status = 'aborted';
    log(state, 'jev', `J1 feasibility: ${j1.summary}`);
    log(state, 'system', 'Feasibility gate: buildability "no" — project not started.');
    return {
      state,
      decisions,
      response: {
        text:
          `I can't take this build on as stated — the feasibility gate flagged it as not practical or not safe (risk tier ${feasibility.risk_tier}). ` +
          'If you re-scope the goal — a non-functional replica, or a safer variant — I\'ll plan that one.',
        suggestions: [],
      },
    };
  }

  const rawPlan = await deps.planner(goal, constraints, feasibility);
  const plan = sanitizePlan(rawPlan, goal);
  Object.assign(state, {
    phases: plan.phases,
    bom: plan.bom,
    acceptance: plan.acceptance,
    current: { phaseId: plan.phases[0].id, stepId: plan.phases[0].steps[0].id },
  });

  log(state, 'jev', `J1 feasibility: ${j1.summary}`);
  log(
    state, 'plan',
    `Plan synthesized: ${state.phases.length} phases · ${flatSteps(state).length} steps · ${state.bom.length} parts. ` +
      `Category: ${feasibility.category} · risk ${feasibility.risk_tier} · planner: ${deps.cfg.planner.provider}.`,
  );

  const stepRef = activeStepRef(state);
  await ensureSafetyGate(deps, state, stepRef, decisions);
  state.confidence.J1 = j1.confidence;

  const est = state.bom.reduce((s, b) => s + b.cost_usd, 0);
  return {
    state,
    decisions,
    response: {
      text:
        `Plan ready: ${state.phases.length} phases, ${flatSteps(state).length} steps, ${state.bom.length} parts (est. $${est.toFixed(0)}). ` +
        'We\'ll work it one step at a time — I verify each one as you report back.\n\n' +
        `First up: "${stepRef.step.title}" (${stepRef.step.track === 'sim' ? 'sim track — Velxio emulator' : 'physical'}).` +
        safetyLine(state, stepRef.step),
      suggestions: [
        'Add the parts you already have to your inventory (sidebar) — it powers substitute matching.',
        'Report each step with a chip plus a short sentence; I keep one step in front of you at a time.',
      ],
    },
  };
}

// ── The hot path: one human message → Jev decisions → state transition ─────

export async function handleMessage(deps, project, input) {
  const state = project.state;
  const decisions = [];
  const text = String(input?.text || '').trim();
  const chip = input?.chip || null;
  const message = text || (chip ? CHIP_LABELS[chip] || chip : '');
  state.counters.messages += 1;

  if (state.status === 'complete') {
    return { project, decisions, response: { text: 'This project is complete. Start a new one to build something else.', suggestions: [] } };
  }
  if (state.status === 'aborted') {
    return { project, decisions, response: { text: 'This project was never started (feasibility gate said no). Create a new project with a re-scoped goal.', suggestions: [] } };
  }

  // 1) Chip-only structural actions (no Jev needed for these).
  if (chip === 'accept_proposal' && state.proposal) {
    applyProposal(state);
    state.proposal = null;
    if (!text) return { project, decisions, response: { text: 'Proposal applied — see the log. Continue with the current step.', suggestions: [] } };
  } else if (chip === 'decline_proposal' && state.proposal) {
    log(state, 'system', `Proposal declined: ${state.proposal.type}.`);
    state.proposal = null;
    if (!text) return { project, decisions, response: { text: 'Proposal declined. Back to the current step — report back when you have an update.', suggestions: [] } };
  }
  if (chip === 'safety_ack') {
    const stepRef = activeStepRef(state);
    if (stepRef) {
      state.safetyAcks[stepRef.step.id] = true;
      log(state, 'system', `Safety acknowledged for "${stepRef.step.title}".`);
    }
    if (!text) return { project, decisions, response: { text: 'Noted — safety acknowledged. Proceed with the step and report back when done.', suggestions: [] } };
  }

  if (!message) {
    return { project, decisions, response: { text: 'Send a report-back — a chip plus a short sentence works best.', suggestions: [] } };
  }

  log(state, 'user', text ? text : `(${chip})`);

  const stepRef = activeStepRef(state);
  await ensureSafetyGate(deps, state, stepRef, decisions);

  const ctx = { state, message, chip, stepRef, jevState: buildJevState(state, message, chip) };

  // 2) Triage (J2) — one batched call: intent + safety + frustration.
  const j2 = await runDecision('J2', ctx, deps);
  decisions.push(j2);
  const intent = j2.detail.intent;
  const intentConf = j2.detail.intent_confidence;
  state.confidence.triage = intentConf;

  let response;
  if (intentConf < INTENT_THRESHOLD) {
    // J5: uncertain triage → do not act (full mode: escalate to the LLM).
    deps.counters.escalations += 1;
    log(state, 'jev', `J2 triage: intent=${intent} but confidence ${intentConf} < ${INTENT_THRESHOLD} — not acting (full mode would escalate to the LLM).`);
    response = {
      text: `I'm only ${Math.round(intentConf * 100)}% sure what that meant. Could you rephrase — or use a chip (done / failed / substitute / question)?`,
      suggestions: [],
    };
  } else {
    switch (intent) {
      case 'step_done': {
        if (!stepRef) {
          response = { text: 'No active step — all steps are complete. Hit "I think it\'s done" to run the acceptance check.', suggestions: [] };
          break;
        }
        if (needsAck(state, stepRef.step)) {
          response = {
            text: `Before "${stepRef.step.title}" can count as done, acknowledge its safety notes — the button is on the step card.`,
            suggestions: [],
          };
          break;
        }
        const j3 = await runDecision('J3', ctx, deps);
        decisions.push(j3);
        state.confidence.verify = j3.detail.certainty;
        if (!j3.detail.verified) {
          stepRef.step.failed += 1;
          skillOutcome(state, stepRef.step, false);
          log(state, 'jev', `J3 verify: not verified (certainty ${j3.detail.certainty}) — step "${stepRef.step.title}" retried (fail ${stepRef.step.failed}).`);
          if (stepRef.step.failed >= 2) {
            response = await offerSubstitution(deps, state, stepRef, decisions,
              `This step has failed twice — before you retry, tell me what parts you actually have and I'll score substitutes. `);
          } else {
            response = { text: retryText(stepRef), suggestions: [] };
          }
        } else if (j3.detail.certainty < VERIFY_THRESHOLD) {
          // J5: verified but not certain → confirm, don't auto-advance.
          log(state, 'jev', `J3 verify: verified but certainty ${j3.detail.certainty} < ${VERIFY_THRESHOLD} — asking for confirmation.`);
          response = {
            text: `I'm only ${Math.round(j3.detail.certainty * 100)}% sure that's actually done. Quick re-check: ${stepRef.step.definition_of_done[0]}`,
            suggestions: [],
          };
        } else {
          markStepComplete(state, stepRef.step);
          skillOutcome(state, stepRef.step, true);
          const doneRef = stepRef;
          const next = advanceStep(state);
          log(state, 'system', `Step ${doneRef.index + 1}/${doneRef.total} complete: "${doneRef.step.title}".`);
          if (next) {
            const nextRef = activeStepRef(state);
            await ensureSafetyGate(deps, state, nextRef, decisions);
            const j8 = await runDecision('J8', { state, stepRef: nextRef, message, jevState: buildJevState(state, message, chip) }, deps);
            decisions.push(j8);
            response = { text: advanceText(doneRef, nextRef, state), suggestions: j8.detail.suggestions };
          } else {
            response = {
              text: 'That was the last step. If everything works, hit "I think it\'s done" and I\'ll run the acceptance check.',
              suggestions: [],
            };
          }
        }
        break;
      }
      case 'step_failed': {
        if (!stepRef) {
          response = { text: 'No active step to fail — all steps are complete. Claim done to run acceptance.', suggestions: [] };
          break;
        }
        stepRef.step.failed += 1;
        skillOutcome(state, stepRef.step, false);
        const j10 = await runDecision('J10', ctx, deps);
        decisions.push(j10);
        log(state, 'jev', `J10 difficulty: level ${j10.detail.level}/3 (fail ${stepRef.step.failed} on this step)`);
        if (stepRef.step.failed >= 2) {
          response = await offerSubstitution(deps, state, stepRef, decisions,
            `Two failures on "${stepRef.step.title}" — `);
        } else if (j10.detail.level >= 2.5) {
          state.proposal = {
            type: 'replan', confidence: j10.confidence,
            text: `The plan may be above your current comfort level for "${stepRef.step.title}". Re-plan at a finer, easier granularity?`,
          };
          response = {
            text: 'This is landing harder than it should. I can re-plan at a finer, easier granularity — confirm in the proposal card.',
            suggestions: [],
          };
        } else {
          response = { text: failureText(stepRef), suggestions: [] };
        }
        break;
      }
      case 'substitute_request':
      case 'deviation': {
        if (!stepRef) {
          response = { text: 'No active step right now — tell me which part you\'re swapping and I\'ll note it.', suggestions: [] };
          break;
        }
        const { need } = extractNeed(message, stepRef);
        response = await offerSubstitution(deps, state, stepRef, decisions, null, need);
        break;
      }
      case 'question': {
        if (!stepRef) {
          response = { text: 'All steps are done — if the question is about the finished build, I\'ll answer from the plan context.', suggestions: [] };
          break;
        }
        response = { text: questionText(state, stepRef, message), suggestions: [] };
        break;
      }
      case 'claim_done': {
        const j9 = await runDecision('J9', { state, jevState: buildJevState(state, message, chip) }, deps);
        decisions.push(j9);
        const unmet = j9.detail.results.filter((r) => !r.met || r.certainty < ACCEPT_MIN_CERTAINTY);
        if (j9.detail.allMet) {
          state.status = 'complete';
          log(state, 'system', `Acceptance passed: ${j9.detail.results.length} criteria. Project complete.`);
          response = { text: doneText(state, j9.detail), suggestions: [] };
        } else {
          log(state, 'jev', `J9 acceptance: ${unmet.length} criterion(s) unmet or below certainty ${ACCEPT_MIN_CERTAINTY}.`);
          response = {
            text: notYetText(unmet),
            suggestions: ['Get back to the earliest unmet item and report it once it checks out.'],
          };
        }
        break;
      }
      case 'scope_change': {
        state.proposal = {
          type: 'replan', confidence: intentConf,
          text: `Scope change noted. Re-plan "${state.goal}" with the new scope?`,
        };
        log(state, 'system', 'Scope change detected — replan proposal created.');
        response = {
          text: 'Scope change logged. Confirm the replan in the proposal card, or tell me more about what changed.',
          suggestions: [],
        };
        break;
      }
      case 'blocked': {
        deps.counters.escalations += 1;
        log(state, 'jev', 'Blocked — escalating (mock mode answers from plan context; full mode wakes the LLM).');
        response = {
          text: blockedText(stepRef),
          suggestions: [
            'Tell me what you have on hand and I\'ll score it as a substitute.',
            'If it\'s a knowledge gap, ask me the specific question and I\'ll answer from the plan.',
          ],
        };
        break;
      }
      default:
        response = {
          text: 'Let\'s keep the build moving — a chip (done / failed / substitute / question) or a short sentence is all I need.',
          suggestions: [],
        };
    }
  }

  // 3) Safety incident override — layered on top of whatever the branch said.
  if (j2.detail.safety_concern >= 0.5) {
    log(state, 'system', 'SAFETY: builder reported a safety incident/concern — pause and resolve before continuing.');
    response = {
      text:
        `⚠️ Safety first: stop the step and address what you described before continuing. ` +
        'Tell me it\'s resolved and we pick back up where we left off.\n\n' + response.text,
      safety: true,
      suggestions: response.suggestions,
    };
  }

  project.updatedAt = nowIso();
  return { project, decisions, response };
}

// ── Jev state builder — the ProjectState's "nervous system view" ────────────

function buildJevState(state, message, chip, extra = {}) {
  const stepRef = activeStepRef(state);
  const all = flatSteps(state);
  const idx = stepRef ? stepRef.index : -1;
  const next = all.slice(idx + 1).find((s) => s.status !== 'done') || null;
  return {
    goal: state.goal,
    constraints: state.constraints,
    status: state.status,
    progress: progress(state),
    active_step: stepRef
      ? {
          id: stepRef.step.id,
          title: stepRef.step.title,
          track: stepRef.step.track,
          index: stepRef.index + 1,
          total: stepRef.total,
          instructions: stepRef.step.instructions,
          definition_of_done: stepRef.step.definition_of_done,
          materials: stepRef.step.materials,
          tools: stepRef.step.tools,
          safety: stepRef.step.safety,
          failed: stepRef.step.failed,
        }
      : null,
    next_step: next
      ? { title: next.title, track: next.track, tools: next.tools, definition_of_done: next.definition_of_done }
      : null,
    inventory: state.inventory,
    bom_pending_count: state.bom.filter((b) => b.status === 'pending').length,
    message,
    chip,
    ...extra,
  };
}

async function ensureSafetyGate(deps, state, stepRef, decisions) {
  if (!stepRef || state.safetyGate?.stepId === stepRef.step.id) return state.safetyGate;
  const j6 = await runDecision('J6', { state, stepRef, message: '', jevState: buildJevState(state, '', null) }, deps);
  decisions?.push(j6);
  state.safetyGate = { stepId: stepRef.step.id, flags: j6.detail.flags };
  if (j6.detail.ackRequired) {
    log(state, 'system',
      `Safety gate on "${stepRef.step.title}": ${j6.detail.flags.filter((f) => f.present && f.severity === 'high').map((f) => f.note || f.hazard).join(', ')}`);
  }
  return state.safetyGate;
}

// ── Substitute flow (J4) ─────────────────────────────────────────────────────

function extractNeed(text, stepRef) {
  const dm = /don'?t have|no |missing/i.test(text)
    ? /(?:don'?t have|no |missing)\s+([^.!?,]+)/i.exec(text)
    : null;
  let need = dm ? dm[1].trim() : null;
  if (!need) need = stepRef?.step?.materials?.[0] || 'the required part';
  return { need };
}

async function offerSubstitution(deps, state, stepRef, decisions, prefix, need) {
  const needFinal = need || extractNeed(state.log.at(-1)?.text || '', stepRef).need;
  const items = state.inventory;
  const jevState = buildJevState(state, state.log.at(-1)?.text || '', null, {
    substitution: { need: needFinal, items },
  });
  const j4 = await runDecision('J4', { state, stepRef, substitution: { need: needFinal, items }, jevState }, deps);
  decisions.push(j4);

  if (!items.length) {
    log(state, 'jev', `J4 substitution: nothing in inventory to score (need: "${needFinal}").`);
    return {
      text:
        `For "${needFinal}": add the parts you actually have to your inventory (sidebar → Bill of materials) ` +
        'and I\'ll score each one as a substitute.',
      suggestions: [],
    };
  }

  const best = j4.detail.best;
  if (!best) {
    deps.counters.escalations += 1;
    log(state, 'jev', `J4 substitution: no inventory item scored valid for "${needFinal}" — escalating (mock mode: sourcing advice).`);
    return {
      text:
        `None of the items in your inventory scores as a valid substitute for "${needFinal}". ` +
        'In full mode this goes to the LLM for a design workaround — for now, either source the part or tell me about another item you have.',
      suggestions: [],
    };
  }

  state.proposal = {
    type: 'substitute', need: needFinal, item: best.item,
    compatibility: best.compatibility, confidence: j4.confidence, stepId: stepRef.step.id,
  };
  log(state, 'jev', `J4 substitution: best match "${best.item.name}" for "${needFinal}" (p=${best.probability.toFixed(2)}, compat ${best.compatibility}/2) — proposal pending.`);
  const label = best.compatibility >= 2 ? 'drop-in equivalent' : 'works with changes';
  return {
    text:
      `${prefix || ''}I scored your inventory: "${best.item.name}" substitutes for "${needFinal}" — ${label} ` +
      `(confidence ${Math.round(j4.confidence * 100)}%). Accept the proposal to use it.`,
    suggestions: [],
  };
}

function applyProposal(state) {
  const p = state.proposal;
  if (p.type === 'substitute') {
    const bom = state.bom.find(
      (b) =>
        b.name.toLowerCase().includes(p.need.toLowerCase().slice(0, 12)) ||
        p.need.toLowerCase().includes(b.name.toLowerCase().slice(0, 12)),
    );
    if (bom) bom.status = 'substituted';
    state.counters.substitutions += 1;
    log(state, 'system', `Substitution applied: using "${p.item.name}" in place of "${p.need}".`);
  } else if (p.type === 'replan') {
    log(state, 'system', 'Replan accepted (mock planner keeps the current structure — full mode regenerates with the LLM).');
  }
}

// ── Response text (the human-facing voice of the skeleton) ──────────────────

function safetyLine(state, step) {
  const gate = state.safetyGate?.stepId === step.id ? state.safetyGate.flags : step.safety;
  const high = gate.filter((f) => f.present !== false && f.severity === 'high');
  if (!high.length) return '';
  return `\n⚠️ Safety: ${high.map((f) => f.note || f.hazard).join(' · ')} — acknowledge on the step card before starting.`;
}

function advanceText(doneRef, nextRef, state) {
  return (
    `✓ Step ${doneRef.index + 1}/${doneRef.total} complete — "${doneRef.step.title}".\n` +
    `Next: "${nextRef.step.title}" (${nextRef.step.track === 'sim' ? 'sim track — Velxio emulator' : 'physical'}).` +
    safetyLine(state, nextRef.step)
  );
}

function retryText(stepRef) {
  const s = stepRef.step;
  const hint = s.safety.length
    ? `Usual suspects for this step: ${s.safety.map((f) => f.hazard).join(', ')} — check those first.`
    : 'Check the last instruction line, your tool setup, and the usual suspects (reversed polarity, cold joint, wrong pin).';
  return `Not quite there yet on "${s.title}". ${hint} Take it slow and report back exactly what happens.`;
}

function failureText(stepRef) {
  const s = stepRef.step;
  const safety = s.safety.length ? ` Safety notes for this step: ${s.safety.map((f) => f.note || f.hazard).join('; ')}.` : '';
  return (
    `Logged the failure on "${s.title}" (attempt ${s.failed + 1}).${safety} ` +
    `Try again with the definition of done in mind: ${s.definition_of_done.join('; ')}. ` +
    'If it fails again, tell me what parts you actually have and I\'ll score substitutes.'
  );
}

function questionText(state, stepRef, msg) {
  const s = stepRef.step;
  const m = s.materials.find((x) => msg.toLowerCase().includes(x.split(' ')[0].toLowerCase()));
  const parts = m ? `About "${m}": it's on the bill of materials for this step. ` : '';
  return (
    `${parts}The step is "${s.title}" — ${s.instructions} ` +
    'If that doesn\'t answer it, in full mode your question goes to the LLM planner (the mock planner answers from plan context only).'
  );
}

function blockedText(stepRef) {
  if (!stepRef) return 'No active step — describe what\'s blocking the project as a whole.';
  const s = stepRef.step;
  return (
    `Here's everything the plan knows about "${s.title}": ${s.instructions}\n` +
    `Done when: ${s.definition_of_done.join('; ')}.\n` +
    `Tools: ${s.tools.join(', ') || '—'}. If you're stuck on a part, say what you have instead.`
  );
}

function doneText(state, detail) {
  const met = detail.results.filter((r) => r.met).length;
  return (
    `🏁 Acceptance passed — ${met}/${detail.results.length} criteria ` +
    `(min certainty ${Math.round(detail.confidence * 100)}%). "${state.goal}" is done. Well built.`
  );
}

function notYetText(unmet) {
  return (
    `Not yet — ${unmet.length} acceptance criterion${unmet.length === 1 ? '' : 'a'} still unmet:\n` +
    unmet.map((r) => `• ${r.criterion}`).join('\n') +
    '\nFinish those and claim done again.'
  );
}
