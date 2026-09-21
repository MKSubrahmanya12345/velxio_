// Forge — chat-first pipeline with human as a tool.
// Flow for "I wanna build X":
// 1. CHAT_INTENT via JEV -> is it build_request?
// 2. GOAL_PARSE via JEV -> is goal clear?
// 3. J1 feasibility gate via JEV
// 4. planner -> implementation plan
// 5. J6 safety + HUMAN_TOOL decision via JEV -> call human tool for first step
//
// Human as tool: assistant can emit toolCalls[{name: 'human', arguments: {task, instructions...}}]
// UI renders them as actionable cards. User's next message is treated as tool result.

import {
  activeStepRef, normalizeConstraints, sanitizePlan, progress, log,
  nowIso, makeMessage, makeHumanToolCall, flatSteps, completeHumanToolCall
} from './schema.js';
import { runDecision } from './decisions/catalog.js';
import { markStepComplete, advanceStep, skillOutcome, needsAck } from './stateMachine.js';

const INTENT_THRESHOLD = 0.55;
const VERIFY_THRESHOLD = 0.6;

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildJevState(state, message, extra = {}) {
  const stepRef = activeStepRef(state);
  const all = flatSteps(state);
  const idx = stepRef ? stepRef.index : -1;
  const next = all.slice(idx + 1).find((s) => s.status !== 'done') || null;
  return {
    goal: state?.goal || extra.goal || message,
    constraints: state?.constraints || {},
    status: state?.status || 'active',
    progress: state ? progress(state) : { completed: 0, total: 0, pct: 0 },
    active_step: stepRef ? {
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
    } : null,
    next_step: next ? { title: next.title, track: next.track, tools: next.tools, definition_of_done: next.definition_of_done } : null,
    inventory: state?.inventory || [],
    bom_pending_count: state ? state.bom.filter((b) => b.status === 'pending').length : 0,
    message,
    hasProject: !!state,
    hasPendingHuman: extra.hasPendingHuman || false,
    ...extra,
  };
}

async function ensureSafetyGate(deps, state, stepRef, decisions) {
  if (!stepRef) return null;
  const j6 = await runDecision('J6', { state, stepRef, message: '', jevState: buildJevState(state, '', { active_step: stepRef.step }) }, deps);
  decisions?.push(j6);
  return { stepId: stepRef.step.id, flags: j6.detail.flags, ackRequired: j6.detail.ackRequired };
}

// ── Chat synthesis: goal -> feasibility -> plan ───────────────────────────────

export async function synthesizeChatProject(deps, conversation, goalText, constraints = {}) {
  const decisions = [];
  const goal = String(goalText || '').trim();
  const normConstraints = normalizeConstraints(constraints);

  // GOAL_PARSE
  const goalParse = await runDecision('GOAL_PARSE', { message: goal, jevState: { message: goal, goal } }, deps);
  decisions.push(goalParse);

  // J1 feasibility
  const j1 = await runDecision('J1', { goal, constraints: normConstraints, jevState: { goal, constraints: normConstraints } }, deps);
  decisions.push(j1);

  const feasibility = {
    category: j1.detail.category,
    buildability: j1.detail.buildability,
    risk_tier: j1.detail.risk_tier,
    complexity: j1.detail.complexity,
  };

  if (feasibility.buildability === 'no') {
    const msg = makeMessage('assistant',
      `I can't take this build on as stated — feasibility gate flagged it as not buildable (risk tier ${feasibility.risk_tier}). If you re-scope — a non-functional replica, or a safer variant — I'll plan that one.`,
      { decisions, meta: { feasibility } }
    );
    conversation.messages.push(msg);
    conversation.title = goal.slice(0, 60);
    conversation.updatedAt = nowIso();
    conversation.counters.jevCalls += decisions.length;
    return { conversation, response: msg, decisions, projectState: null };
  }

  // Planner
  const rawPlan = await deps.planner(goal, normConstraints, feasibility);
  const plan = sanitizePlan(rawPlan, goal);

  // Build projectState
  const projectState = {
    goal,
    constraints: normConstraints,
    feasibility,
    status: 'active',
    phases: plan.phases,
    current: { phaseId: plan.phases[0].id, stepId: plan.phases[0].steps[0].id },
    inventory: [],
    bom: plan.bom,
    acceptance: plan.acceptance,
    log: [],
    skill: {},
    safetyAcks: {},
    safetyGate: null,
    counters: { messages: 0, jevCalls: 0, escalations: 0, stepsCompleted: 0, substitutions: 0 },
    confidence: { J1: j1.confidence },
    proposal: null,
  };

  log(projectState, 'jev', `J1 feasibility: ${j1.summary}`);
  log(projectState, 'plan', `Plan synthesized: ${projectState.phases.length} phases · ${flatSteps(projectState).length} steps · ${projectState.bom.length} parts`);

  const stepRef = activeStepRef(projectState);
  const safetyGate = await ensureSafetyGate(deps, projectState, stepRef, decisions);
  projectState.safetyGate = safetyGate;

  // HUMAN_TOOL decision for first step
  const humanDec = await runDecision('HUMAN_TOOL', {
    stepRef,
    message: goal,
    hasPendingHuman: false,
    jevState: buildJevState(projectState, goal, { hasPendingHuman: false, active_step: stepRef?.step })
  }, deps);
  decisions.push(humanDec);

  let humanTool = null;
  if (humanDec.detail.call_human && stepRef) {
    humanTool = makeHumanToolCall(stepRef, { reason: 'First step of implementation plan' });
    conversation.pendingHumanTools = [humanTool];
    projectState.counters.humanCalls = (projectState.counters.humanCalls || 0) + 1;
  }

  const est = projectState.bom.reduce((s, b) => s + b.cost_usd, 0);
  const phaseList = projectState.phases.map((p, i) => `${i + 1}. **${p.name}** — ${p.steps.length} steps`).join('\n');

  const planText =
`### Implementation plan ready for: "${goal}"

**Category:** ${feasibility.category} · **Risk:** ${feasibility.risk_tier} · **Complexity:** ${feasibility.complexity.toFixed(1)}/3 · **Est. cost:** $${est.toFixed(0)}
**${projectState.phases.length} phases, ${flatSteps(projectState).length} steps, ${projectState.bom.length} parts**

#### Phases
${phaseList}

#### Bill of Materials (top)
${projectState.bom.slice(0, 8).map(b => `- ${b.name} x${b.qty} ($${b.cost_usd})`).join('\n')}${projectState.bom.length > 8 ? `\n- ... and ${projectState.bom.length - 8} more` : ''}

#### Acceptance Criteria
${projectState.acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n')}

#### Next Step → Human Tool
${stepRef ? `**${stepRef.step.title}** (${stepRef.step.track === 'sim' ? 'SIM · Velxio' : 'PHYSICAL · human tool'})\n> ${stepRef.step.instructions}\n\n**Done when:** ${stepRef.step.definition_of_done.join('; ')}` : 'No steps'}

${safetyGate?.ackRequired ? `\n⚠️ **Safety:** ${safetyGate.flags.filter(f => f.present && f.severity === 'high').map(f => f.note || f.hazard).join(' · ')} — acknowledge before proceeding.` : ''}

---
I'm treating you as a tool — when I need physical work, I'll call \`human\` with exact instructions. Report back with what happened and I'll verify via JEV and advance.
`;

  const assistantMsg = makeMessage('assistant', planText, {
    decisions,
    toolCalls: humanTool ? [humanTool] : [],
    plan: projectState,
    meta: { feasibility, humanCalled: !!humanTool }
  });

  conversation.messages.push(assistantMsg);
  conversation.projectState = projectState;
  conversation.title = goal.slice(0, 60);
  conversation.updatedAt = nowIso();
  conversation.counters.plans += 1;
  conversation.counters.jevCalls += decisions.length;
  if (humanTool) conversation.counters.humanCalls += 1;

  return { conversation, response: assistantMsg, decisions, projectState };
}

// ── Chat message handler (main loop) ─────────────────────────────────────────

export async function handleChatMessage(deps, conversation, input) {
  const text = String(input?.text || '').trim();
  const chip = input?.chip || null;
  const message = text || (chip ? String(chip) : '');
  const decisions = [];

  if (!message) {
    const errMsg = makeMessage('assistant', 'Send a message — e.g. "I wanna build an MP3 player" or report back on the current human tool task.', { decisions });
    return { conversation, response: errMsg, decisions };
  }

  // Add user message
  const userMsg = makeMessage('user', message, { meta: { chip } });
  conversation.messages.push(userMsg);
  conversation.counters.messages += 1;

  const hasProject = !!conversation.projectState;
  const hasPendingHuman = (conversation.pendingHumanTools || []).some(t => t.status === 'requires_action');

  // CHAT_INTENT via JEV
  const chatIntent = await runDecision('CHAT_INTENT', {
    message,
    hasProject,
    jevState: buildJevState(conversation.projectState, message, { hasProject, hasPendingHuman })
  }, deps);
  decisions.push(chatIntent);

  const intent = chatIntent.detail.intent;
  const intentConf = chatIntent.detail.intent_confidence;

  // Low confidence → clarify
  if (intentConf < INTENT_THRESHOLD) {
    const clarifyMsg = makeMessage('assistant',
      `I'm only ${Math.round(intentConf * 100)}% sure what that meant (JEV triage low confidence). Could you rephrase? If you want to build something, say "I wanna build X" with what X is.`,
      { decisions }
    );
    conversation.messages.push(clarifyMsg);
    conversation.updatedAt = nowIso();
    return { conversation, response: clarifyMsg, decisions };
  }

  // ── Build request path ───────────────────────────────────────────────────
  if (intent === 'build_request' || chatIntent.detail.needs_plan) {
    // If already has project, treat as scope change unless user explicitly wants new
    if (hasProject && !/new|different|instead|change|other/i.test(message)) {
      // Maybe they want to add to existing? For simplicity, if message is clearly new build, create new plan
      // Check if goal is different
      const isNewGoal = message.length > 20 && !conversation.projectState.goal.toLowerCase().includes(message.toLowerCase().slice(0, 15));
      if (isNewGoal) {
        // New plan overrides
        const result = await synthesizeChatProject(deps, conversation, message, {});
        // Merge decisions
        result.decisions = [...decisions, ...result.decisions];
        result.response.decisions = result.decisions;
        return result;
      }
    }
    if (!hasProject) {
      const result = await synthesizeChatProject(deps, conversation, message, {});
      result.decisions = [...decisions, ...result.decisions];
      result.response.decisions = result.decisions;
      return result;
    }
    // Has project but wants new build
    const result = await synthesizeChatProject(deps, conversation, message, {});
    result.decisions = [...decisions, ...result.decisions];
    result.response.decisions = result.decisions;
    return result;
  }

  // If no project yet and intent is not build_request → guide to build request
  if (!hasProject) {
    const guideMsg = makeMessage('assistant',
      `I don't have a build plan yet. Tell me what you wanna build — e.g. "I wanna build an MP3 player" or "Build me an LED desk lamp" — and I'll run feasibility via JEV, then give you the full implementation plan with human tool calls.\n\n**Human as tool:** Once planning is done, I'll call you as \`human\` for each physical step, with exact instructions and definition-of-done. You report back, I verify via JEV, and we advance.`,
      { decisions }
    );
    conversation.messages.push(guideMsg);
    conversation.updatedAt = nowIso();
    return { conversation, response: guideMsg, decisions };
  }

  // ── Has project from here ─────────────────────────────────────────────────
  const state = conversation.projectState;
  const stepRef = activeStepRef(state);

  // Safety incident check via J2
  const j2 = await runDecision('J2', {
    stepRef,
    message,
    chip,
    jevState: buildJevState(state, message, { chip, hasPendingHuman })
  }, deps);
  decisions.push(j2);

  if (j2.detail.safety_concern >= 0.5) {
    log(state, 'system', 'SAFETY: builder reported safety concern');
    const safetyMsg = makeMessage('assistant',
      `⚠️ **Safety first:** Stop the step and address what you described before continuing. Tell me it's resolved and we pick back up.\n\nCurrent step: "${stepRef?.step.title || 'N/A'}"`,
      { decisions }
    );
    conversation.messages.push(safetyMsg);
    conversation.updatedAt = nowIso();
    return { conversation, response: safetyMsg, decisions };
  }

  // Handle by triage intent
  let responseText = '';
  let toolCalls = [];
  let shouldAdvance = false;

  switch (j2.detail.intent) {
    case 'step_done':
    case 'human_tool_result':
    case 'status_update': {
      // If pending human tool, complete it
      if (hasPendingHuman && conversation.pendingHumanTools.length) {
        const pending = conversation.pendingHumanTools.find(t => t.status === 'requires_action');
        if (pending) {
          // Verify via J3
          const j3 = await runDecision('J3', {
            stepRef,
            message,
            jevState: buildJevState(state, message, { chip })
          }, deps);
          decisions.push(j3);

          if (!j3.detail.verified) {
            stepRef.step.failed += 1;
            skillOutcome(state, stepRef.step, false);
            completeHumanToolCall(pending, message, false);
            responseText = `JEV verification: **not verified** (certainty ${Math.round(j3.detail.certainty * 100)}%). Step "${stepRef.step.title}" needs retry (fail ${stepRef.step.failed}).\n\n**Hint:** ${stepRef.step.safety.length ? `Check safety: ${stepRef.step.safety.map(s => s.hazard).join(', ')}` : 'Check DOD: ' + stepRef.step.definition_of_done.join('; ')}\n\nI'll call human tool again for retry.`;
            // Re-call human
            const retryTool = makeHumanToolCall(stepRef, { reason: 'Retry after verification failed', attempt: stepRef.step.failed });
            toolCalls = [retryTool];
            conversation.pendingHumanTools = [retryTool];
          } else if (j3.detail.certainty < VERIFY_THRESHOLD) {
            responseText = `I'm only ${Math.round(j3.detail.certainty * 100)}% sure that's actually done (JEV certainty low). Quick re-check: ${stepRef.step.definition_of_done[0]}\n\nConfirm with more detail?`;
          } else {
            // Success
            completeHumanToolCall(pending, message, true);
            markStepComplete(state, stepRef.step);
            skillOutcome(state, stepRef.step, true);
            state.counters.stepsCompleted += 1;
            const doneRef = stepRef;
            const next = advanceStep(state);
            if (next) {
              const nextRef = activeStepRef(state);
              const safetyGate = await ensureSafetyGate(deps, state, nextRef, decisions);
              state.safetyGate = safetyGate;
              // Decide if next step needs human tool
              const humanDec = await runDecision('HUMAN_TOOL', {
                stepRef: nextRef,
                message,
                hasPendingHuman: false,
                jevState: buildJevState(state, message, { active_step: nextRef.step })
              }, deps);
              decisions.push(humanDec);

              let nextHumanTool = null;
              if (humanDec.detail.call_human) {
                nextHumanTool = makeHumanToolCall(nextRef, { reason: 'Next step in plan' });
                conversation.pendingHumanTools = [nextHumanTool];
                toolCalls = [nextHumanTool];
                conversation.counters.humanCalls += 1;
              }

              responseText = `✅ **Step ${doneRef.index + 1}/${doneRef.total} verified** — "${doneRef.step.title}" (JEV quality ${j3.detail.quality.toFixed(1)}/3, certainty ${Math.round(j3.detail.certainty * 100)}%)\n\n**Next:** "${nextRef.step.title}" (${nextRef.step.track === 'sim' ? 'SIM · Velxio' : 'PHYSICAL · human tool required'})\n> ${nextRef.step.instructions}\n\n**Done when:** ${nextRef.step.definition_of_done.join('; ')}\n${safetyGate?.ackRequired ? `\n⚠️ Safety ack required: ${safetyGate.flags.filter(f => f.present && f.severity === 'high').map(f => f.note || f.hazard).join(' · ')}` : ''}`;

              if (nextHumanTool) {
                responseText += `\n\n🔧 **Human tool called** — see card below. Execute and report back.`;
              }
            } else {
              conversation.pendingHumanTools = [];
              responseText = `🎉 **That was the last step!** All ${doneRef.total} steps done. Say "I think it's done" and I'll run acceptance via JEV (J9).`;
            }
          }
        } else {
          responseText = `No pending human tool, but noted: "${message}". Current step: "${stepRef?.step.title || 'none'}".`;
        }
      } else {
        // No pending human, but user reports done → verify current step
        if (!stepRef) {
          responseText = `No active step — all done. Claim done to run acceptance check (J9).`;
        } else {
          const j3 = await runDecision('J3', { stepRef, message, jevState: buildJevState(state, message) }, deps);
          decisions.push(j3);
          if (j3.detail.verified && j3.detail.certainty >= VERIFY_THRESHOLD) {
            markStepComplete(state, stepRef.step);
            const next = advanceStep(state);
            if (next) {
              const nextRef = activeStepRef(state);
              const nextTool = makeHumanToolCall(nextRef);
              conversation.pendingHumanTools = [nextTool];
              toolCalls = [nextTool];
              responseText = `✅ Verified "${stepRef.step.title}". Next: "${nextRef.step.title}" — human tool called.`;
            } else {
              responseText = `All steps complete. Claim done for acceptance.`;
            }
          } else {
            responseText = `Not yet verified for "${stepRef.step.title}" — ${j3.detail.certainty < VERIFY_THRESHOLD ? 'low certainty, need more detail' : 'does not meet DOD'}.`;
          }
        }
      }
      break;
    }
    case 'step_failed': {
      if (!stepRef) {
        responseText = `No active step to fail.`;
        break;
      }
      stepRef.step.failed += 1;
      skillOutcome(state, stepRef.step, false);
      const j10 = await runDecision('J10', { message, jevState: buildJevState(state, message) }, deps);
      decisions.push(j10);
      const retryTool = makeHumanToolCall(stepRef, { reason: `Retry after failure ${stepRef.step.failed}`, attempt: stepRef.step.failed });
      toolCalls = [retryTool];
      conversation.pendingHumanTools = [retryTool];
      responseText = `Logged failure on "${stepRef.step.title}" (attempt ${stepRef.step.failed}). JEV difficulty: ${j10.detail.level.toFixed(1)}/3\n\n**Try:** ${stepRef.step.definition_of_done.join('; ')}\n\n🔧 Human tool re-called for retry.`;
      break;
    }
    case 'question': {
      // Answer from plan context
      const s = stepRef?.step;
      responseText = s
        ? `**Q:** ${message}\n\n**About current step "${s.title}":** ${s.instructions}\n\n**Materials:** ${s.materials.join(', ') || '—'}\n**Tools:** ${s.tools.join(', ') || '—'}\n**Done when:** ${s.definition_of_done.join('; ')}\n\n*If this doesn't answer, ask more specifically — in full mode this goes to LLM planner.*`
        : `**Q:** ${message}\n\nNo active step — question is about project "${state.goal}".\n\nPhases: ${state.phases.map(p => p.name).join(' → ')}\nBOM: ${state.bom.length} parts\nAcceptance: ${state.acceptance.join('; ')}`;
      break;
    }
    case 'claim_done': {
      const j9 = await runDecision('J9', { state, jevState: buildJevState(state, message) }, deps);
      decisions.push(j9);
      const unmet = j9.detail.results.filter(r => !r.met || r.certainty < 0.8);
      if (j9.detail.allMet) {
        state.status = 'complete';
        responseText = `🏁 **Acceptance passed** — ${j9.detail.results.length} criteria (min certainty ${Math.round(j9.confidence * 100)}%). "${state.goal}" is done. Well built.`;
      } else {
        responseText = `Not yet — ${unmet.length} criterion unmet:\n${unmet.map(r => `• ${r.criterion} (certainty ${Math.round(r.certainty * 100)}%)`).join('\n')}\n\nFinish those and claim done again.`;
      }
      break;
    }
    case 'scope_change': {
      responseText = `Scope change noted: "${message}". Want me to re-plan "${state.goal}" with new scope? Say "Replan: <new goal>" and I'll run feasibility + planner again via JEV.`;
      break;
    }
    case 'blocked': {
      responseText = `You're blocked on "${stepRef?.step.title || 'project'}". Here's plan context:\n\n${stepRef ? `**Instructions:** ${stepRef.step.instructions}\n**DOD:** ${stepRef.step.definition_of_done.join('; ')}\n**Tools:** ${stepRef.step.tools.join(', ')}` : `Goal: ${state.goal}\nPhases: ${state.phases.map(p => p.name).join(', ')}`}\n\nTell me what you have on hand and I'll score substitutes via J4, or ask specific question.`;
      // Offer human tool again
      if (stepRef) {
        const tool = makeHumanToolCall(stepRef, { reason: 'Unblock attempt' });
        toolCalls = [tool];
        conversation.pendingHumanTools = [tool];
      }
      break;
    }
    default: {
      responseText = `Got it: "${message}". Current step: "${stepRef?.step.title || 'none'}" (${stepRef?.total ? `${progress(state).completed}/${progress(state).total}` : 'no plan'}).\n\nIf you're working on a human tool task, report what happened. If you wanna build something new, say "I wanna build X".`;
    }
  }

  const assistantMsg = makeMessage('assistant', responseText, { decisions, toolCalls, meta: { intent, stepId: stepRef?.step.id } });
  conversation.messages.push(assistantMsg);
  conversation.updatedAt = nowIso();
  conversation.counters.jevCalls += decisions.length;

  return { conversation, response: assistantMsg, decisions };
}

// ── Legacy compatibility: keep old synthesizeProject/handleMessage wrappers ───

export async function synthesizeProject(deps, input) {
  // For old /api/projects route — create a conversation then extract state
  const conv = deps._tempConv || { messages: [], pendingHumanTools: [], counters: { messages: 0, jevCalls: 0, humanCalls: 0, plans: 0 }, projectState: null, title: input.goal, id: 'tmp', createdAt: nowIso(), updatedAt: nowIso() };
  const result = await synthesizeChatProject(deps, conv, input.goal, input.constraints);
  return { state: result.projectState, decisions: result.decisions, response: { text: result.response.content, suggestions: [] } };
}

export async function handleMessage(deps, project, input) {
  // Convert old project to conversation
  const conv = {
    id: project.id,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    title: project.state.goal,
    messages: [],
    projectState: project.state,
    pendingHumanTools: [],
    counters: { messages: project.state.counters?.messages || 0, jevCalls: 0, humanCalls: 0, plans: 1 },
  };
  // If pending human tool from old state, reconstruct
  const stepRef = activeStepRef(project.state);
  if (stepRef) {
    conv.pendingHumanTools = [makeHumanToolCall(stepRef)];
  }
  const result = await handleChatMessage(deps, conv, input);
  const updatedProject = {
    id: conv.id,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    state: result.conversation.projectState,
  };
  return { project: updatedProject, response: { text: result.response.content, suggestions: [] }, decisions: result.decisions };
}
