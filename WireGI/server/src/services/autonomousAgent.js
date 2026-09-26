import { generateJSON, generate } from './llm.js';
import { makeProject, makePart, newId } from '../models/project.js';
import { researchPart } from './research.js';
import { reconcileProject } from './reconcile.js';
import { runSimPhase } from './velxio.js';
import { getProfile, pickProfile } from './profiles.js';
import { describeError, errorSummary } from './debug.js';

const MAX_TURNS = 24;
const DECOMPOSE_SYSTEM = `You are the hardware project architect.
Turn a user's hardware request into a compact, buildable project plan.
Return JSON ONLY:
{
  "classification": string,
  "domains": [string],
  "parts": [{"name":string,"domain":string,"idea":string}]
}
Rules:
- Parts are meaningful engineering work units, not every screw, wire, tool or procedure.
- Include firmware/software only when the requested device needs it.
- Prefer 4-10 parts.
- Do not invent requirements.
- Make every part concrete enough for another agent to research and build.`;

const DECIDE_SYSTEM = `You are the control brain of a hardware engineering agent.
You receive the current durable project state after the previous action.
Choose ONE next action that moves the project toward a verified build.
Return JSON ONLY:
{
  "action":"research"|"simulate"|"reconcile"|"revise"|"finish"|"ask_human",
  "partId":string|null,
  "reason":string,
  "instruction":string
}
Rules:
- Prefer acting over asking.
- Research only one part at a time when its data is missing, stale or contradicted.
- Use simulation when the current design is concrete enough to test.
- Reconcile when multiple parts have data and their interfaces may conflict.
- Revise when evidence shows the current design needs a change; instruction must describe the change.
- Ask the human only for a preference, physical fact, irreversible choice, or safety sign-off that cannot be resolved from available evidence.
- Finish only when the design is coherent and there is no obvious unverified work remaining.
- Do not choose the same successful action repeatedly without a state change.`;

function now() { return new Date().toISOString(); }

export function createAutonomousAgent({ cfg, registry, store, indexer, fallbackAgent }) {
  const save = async (project) => {
    project.updatedAt = now();
    try { await store.save(project); } catch { /* execution must not die on a telemetry save */ }
  };

  const emitEvent = (emit, type, stage, message, extra = {}) =>
    emit?.({ type, stage, message, ts: now(), ...extra });

  function stateForDecision(project) {
    return {
      goal: project.goal,
      constraints: project.constraints,
      status: project.status,
      profile: { id: project.profileId, label: project.profileLabel },
      parts: project.state.parts.map((p) => ({
        id: p.id,
        name: p.name,
        domain: p.domain,
        status: p.status,
        hasData: Boolean(p.current?.data),
        data: p.current?.data || null,
        openQuestions: p.openQuestions || [],
        evidence: (p.evidence || []).map((e) => ({ rung: e.rung, detail: e.detail })),
        error: p.error,
      })),
      integration: (project.state.reconciliations || []).slice(-2),
      simulation: project.state.sim ? {
        status: project.state.sim.status,
        summary: project.state.sim.summary,
        verified: project.state.sim.verified,
      } : null,
    };
  }

  async function decide(project, emit, prefer) {
    const result = await generateJSON({
      registry,
      system: DECIDE_SYSTEM,
      user: JSON.stringify(stateForDecision(project)),
      temperature: 0,
      emit,
      prefer,
      operation: 'autonomous-next-action',
    });
    const allowed = new Set(['research', 'simulate', 'reconcile', 'revise', 'finish', 'ask_human']);
    return allowed.has(result?.action) ? result : { action: 'research', partId: null, reason: 'No valid action was returned.', instruction: '' };
  }

  async function decompose(project, emit, prefer) {
    const plan = await generateJSON({
      registry,
      system: DECOMPOSE_SYSTEM,
      user: JSON.stringify({ goal: project.goal, constraints: project.constraints }),
      temperature: 0.2,
      emit,
      prefer,
      operation: 'autonomous-decompose',
    });
    if (!Array.isArray(plan?.parts) || !plan.parts.length) throw new Error('The architect returned no hardware parts.');
    const profile = pickProfile(plan.classification, plan.domains, project.goal);
    project.profileId = profile.id;
    project.profileLabel = profile.label;
    project.state.idea.classification = plan.classification;
    project.state.idea.domains = plan.domains || [];
    project.state.idea.profile = { id: profile.id, label: profile.label, ladder: profile.ladder };
    project.state.parts = plan.parts.slice(0, 12).map((p) => makePart({ name: p.name, domain: p.domain, idea: { summary: p.idea } }));
    project.state.idea.parts = project.state.parts.map((p) => ({ id: p.id, name: p.name, domain: p.domain, idea: p.idea }));
    project.state.idea.revisions.push({ at: now(), kind: 'created', note: project.goal, revision: 1 });
    project.status = 'researching';
    await save(project);
    emitEvent(emit, 'project', 'planned', `Project planned as ${project.state.parts.length} engineering parts.`, {
      projectId: project.id,
      profileId: profile.id,
      parts: project.state.parts.map((p) => ({ id: p.id, name: p.name, domain: p.domain })),
    });
  }

  async function research(project, part, emit, prefer, instruction = '') {
    part.status = 'researching';
    part.attempts = (part.attempts || 0) + 1;
    part.startedAt = now();
    const result = await researchPart({
      part,
      project,
      registry,
      indexer,
      emit,
      prefer,
      guidance: instruction || undefined,
    });
    part.current = { gathered: result.gathered, understand: result.understand, data: result.data };
    part.data = result.data;
    part.gathered = result.gathered || [];
    part.research = result.research || [];
    part.openQuestions = result.understand?.openQuestions || [];
    part.humanCheckpoint = Boolean(result.humanCheckpoint);
    part.status = part.humanCheckpoint ? 'awaiting_human' : 'data_ready';
    part.updatedAt = now();
    part.finishedAt = part.updatedAt;
    part.error = null;
    part.errorDetail = null;
    part.evidence = [...(part.evidence || []), {
      rung: 'research', at: part.updatedAt,
      detail: result.web?.count ? `${result.web.engine} search + synthesis` : 'research synthesis',
    }];
    project.state.current.parts = project.state.parts.filter((p) => p.current?.data).map((p) => ({ id: p.id, name: p.name, domain: p.domain, data: p.current.data }));
    project.state.researchLog.push({ part: part.name, ts: part.updatedAt, web: result.web || null, meta: result.meta || null });
    await save(project);
  }

  async function reconcile(project, emit) {
    const entry = await reconcileProject({ project, emit, registry, contextChars: cfg?.throughput?.reconcileContextChars });
    await save(project);
    return entry;
  }

  async function simulate(project, emit, prefer) {
    const result = await runSimPhase({ project, registry, cfg, emit, prefer });
    if (result) {
      project.state.sim = result;
      if (result.status !== 'skipped') {
        for (const p of project.state.parts) {
          if (!p.current?.data) continue;
          p.evidence = [...(p.evidence || []), { rung: 'simulation', at: now(), by: 'velxio', detail: result.summary || result.status }];
        }
      }
    }
    await save(project);
    return result;
  }

  async function revise(project, instruction, emit, prefer) {
    const patch = await generateJSON({
      registry,
      system: `You are revising a hardware design. Return JSON ONLY: {"goal":string,"constraints":object,"partUpdates":[{"partId":string,"instruction":string}]}.
Change only what is required by the instruction. Do not invent user preferences.`,
      user: JSON.stringify({ goal: project.goal, constraints: project.constraints, parts: project.state.parts.map((p) => ({ id: p.id, name: p.name, idea: p.idea, data: p.current?.data })), instruction }),
      temperature: 0.1,
      emit,
      prefer,
      operation: 'autonomous-revise',
    });
    if (patch.goal) project.goal = patch.goal;
    project.constraints = { ...project.constraints, ...(patch.constraints || {}) };
    project.state.idea.goal = project.goal;
    project.state.idea.constraints = project.constraints;
    project.state.idea.revisions.push({ at: now(), kind: 'agent-revision', note: instruction, revision: project.state.idea.revisions.length + 1 });
    for (const update of patch.partUpdates || []) {
      const part = project.state.parts.find((p) => p.id === update.partId);
      if (!part) continue;
      part.idea = { ...part.idea, revision: update.instruction };
      part.status = 'pending';
      part.current = null;
      part.verified = false;
      part.evidence = [];
      part.openQuestions = [];
    }
    project.state.sim = null;
    await save(project);
  }

  function chooseResearchPart(project, requestedId) {
    if (requestedId) {
      const exact = project.state.parts.find((p) => p.id === requestedId);
      if (exact) return exact;
    }
    return project.state.parts.find((p) => !p.current?.data && p.status !== 'failed') ||
      project.state.parts.find((p) => p.status === 'failed') || null;
  }

  async function runProject(goal, constraints = {}, { emit = () => {}, prefer } = {}) {
    const project = makeProject({ goal, constraints });
    project.state.runLog = [];
    project.status = 'init';
    await store.create(project);
    const run = { id: newId('run'), kind: 'autonomous-build', startedAt: now(), status: 'running', goal };
    project.state.runs.push(run);
    project.currentRunId = run.id;
    try {
      emitEvent(emit, 'run', 'start', `Autonomous build started: ${goal}`, { runId: run.id });
      await decompose(project, emit, prefer);

      let lastAction = '';
      let repeated = 0;
      for (let turn = 0; turn < MAX_TURNS; turn += 1) {
        const decision = await decide(project, emit, prefer);
        const actionKey = `${decision.action}:${decision.partId || ''}:${decision.instruction || ''}`;
        repeated = actionKey === lastAction ? repeated + 1 : 0;
        lastAction = actionKey;
        emitEvent(emit, 'agent', 'decision', `${decision.action}: ${decision.reason || 'moving the design forward'}`, decision);
        if (repeated >= 2) {
          emitEvent(emit, 'agent', 'guard', 'The controller repeated an action without progress; forcing a fresh research decision.');
          const fallback = chooseResearchPart(project, null);
          if (fallback) {
            await research(project, fallback, emit, prefer, 'Re-evaluate this part from the current project state and resolve any stale or missing assumptions.');
            continue;
          }
        }

        if (decision.action === 'research') {
          const part = chooseResearchPart(project, decision.partId);
          if (!part) continue;
          try { await research(project, part, emit, prefer, decision.instruction); }
          catch (err) {
            const d = describeError(err);
            part.status = 'failed'; part.error = d.message; part.errorDetail = d;
            await save(project);
            emitEvent(emit, 'part', 'failed', `${part.name} failed: ${d.message}`, { error: d, partId: part.id });
          }
        } else if (decision.action === 'reconcile') {
          try { await reconcile(project, emit); }
          catch (err) { emitEvent(emit, 'reconcile', 'failed', `Integration failed: ${errorSummary(err)}`, { error: describeError(err) }); }
        } else if (decision.action === 'simulate') {
          try { await simulate(project, emit, prefer); }
          catch (err) { emitEvent(emit, 'sim', 'failed', `Simulation failed: ${errorSummary(err)}`, { error: describeError(err) }); }
        } else if (decision.action === 'revise') {
          await revise(project, decision.instruction || decision.reason || 'Revise the design based on the current evidence.', emit, prefer);
        } else if (decision.action === 'ask_human') {
          project.status = 'awaiting_human';
          project.state.chat.push({ role: 'agent', content: decision.instruction || decision.reason || 'I need one decision from you before continuing.', ts: now() });
          await save(project);
          break;
        } else if (decision.action === 'finish') {
          break;
        }
      }

      const missing = project.state.parts.filter((p) => !p.current?.data && p.status !== 'verified');
      const conflicts = (project.state.reconciliations || []).some((r) => (r.conflicts || []).some((c) => c.severity === 'blocking'));
      const simNeedsWork = project.state.sim && ['failed', 'partial'].includes(project.state.sim.status);
      if (project.status !== 'awaiting_human') project.status = missing.length || conflicts || simNeedsWork ? 'partial' : 'complete';
      project.state.chat.push({ role: 'agent', content: summary(project), ts: now() });
      run.status = project.status; run.endedAt = now();
      emitEvent(emit, 'run', 'end', `Autonomous build ${project.status}.`, { runId: run.id });
      await save(project);
      return project;
    } catch (err) {
      const d = describeError(err);
      project.status = 'failed';
      run.status = 'failed'; run.endedAt = now(); run.error = d.message;
      project.state.errors.push({ at: now(), runId: run.id, where: 'autonomous-build', ...d });
      await save(project);
      emitEvent(emit, 'error', 'run', `Build failed: ${d.message}`, { error: d, fatal: true });
      throw err;
    }
  }

  async function message(projectId, text, { emit = () => {}, prefer } = {}) {
    if (!fallbackAgent) throw new Error('fallback agent unavailable');
    return fallbackAgent.continueProject(projectId, text, { emit, prefer });
  }

  return { runProject, message };
}

function summary(project) {
  const lines = [`# ${project.goal}`, '', `Status: **${project.status}**`, ''];
  for (const p of project.state.parts) {
    const mark = p.status === 'failed' ? '✖' : p.verified ? '✓' : p.current?.data ? '•' : '?';
    lines.push(`- ${mark} **${p.name}** (${p.domain})`);
    if (p.current?.data?.bomRow) lines.push(`  - BOM: ${p.current.data.bomRow}`);
    if (p.current?.data?.wiring) lines.push(`  - Wiring: ${p.current.data.wiring}`);
  }
  if (project.state.sim?.summary) lines.push('', `Simulation: ${project.state.sim.summary}`);
  return lines.join('\n');
}
