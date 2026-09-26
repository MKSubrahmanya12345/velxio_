import { generateJSON } from './llm.js';
import { makeProject, makePart, newId } from '../models/project.js';
import { researchPart } from './research.js';
import { reconcileProject } from './reconcile.js';
import { runSimPhase } from './velxio.js';
import { pickProfile } from './profiles.js';
import { describeError, errorSummary } from './debug.js';

const PLAN_SYSTEM = `You are WireGI's hardware architect. Turn the user's request into the smallest complete build plan that can be verified.
Return JSON ONLY:
{
  "classification": string,
  "domains": [string],
  "parts": [{"name":string,"domain":string,"idea":string,"researchRequired":boolean}]
}
Rules:
- Parts are meaningful engineering work units, not wires, screws or procedures.
- Prefer 1-6 parts. Do not split a trivial request into artificial parts.
- Set researchRequired=false only when the part is a standard, well-known item whose exact facts can be established by the simulator/tooling or are already obvious from the request.
- Set researchRequired=true whenever exact electrical, mechanical, compatibility, version, rating, or component facts are needed.
- Never invent specifications. A plan is intent, not evidence.
- Include firmware only when it is genuinely required.
- Do not invent requirements.`;

function now() { return new Date().toISOString(); }

export function createFastBuildAgent({ cfg, registry, store, indexer }) {
  const save = async (project) => {
    project.updatedAt = now();
    await store.save(project);
  };

  const emit = (fn, type, stage, message, extra = {}) => fn?.({ type, stage, message, ts: now(), ...extra });

  async function plan(project, emitFn, prefer) {
    const result = await generateJSON({
      registry,
      system: PLAN_SYSTEM,
      user: JSON.stringify({ goal: project.goal, constraints: project.constraints }),
      temperature: 0.1,
      emit: emitFn,
      prefer,
      operation: 'fast-build-plan',
    });
    if (!Array.isArray(result?.parts) || !result.parts.length) {
      throw new Error('The architect returned no build parts.');
    }

    const profile = pickProfile(result.classification, result.domains, project.goal);
    project.profileId = profile.id;
    project.profileLabel = profile.label;
    project.state.idea.classification = result.classification;
    project.state.idea.domains = result.domains || [];
    project.state.idea.profile = { id: profile.id, label: profile.label, ladder: profile.ladder };
    project.state.parts = result.parts.slice(0, 6).map((p) => {
      const part = makePart({ name: p.name, domain: p.domain, idea: { summary: p.idea, researchRequired: p.researchRequired !== false } });
      part.meta = { researchRequired: p.researchRequired !== false };
      return part;
    });
    project.state.idea.parts = project.state.parts.map((p) => ({ id: p.id, name: p.name, domain: p.domain, idea: p.idea }));
    project.state.idea.revisions.push({ at: now(), kind: 'created', note: project.goal, revision: 1 });
    project.status = 'researching';
    await save(project);
    emit(emitFn, 'project', 'planned', `Fast build plan: ${project.state.parts.length} part${project.state.parts.length === 1 ? '' : 's'}.`, {
      projectId: project.id,
      parts: project.state.parts.map((p) => ({ id: p.id, name: p.name, domain: p.domain })),
    });
  }

  async function researchOne(project, part, emitFn, prefer) {
    part.status = 'researching';
    part.attempts = (part.attempts || 0) + 1;
    part.startedAt = now();
    try {
      const result = await researchPart({ part, project, registry, indexer, emit: emitFn, prefer });
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
      part.evidence = [...(part.evidence || []), { rung: 'research', at: part.updatedAt, detail: result.web?.count ? `${result.web.engine} search + synthesis` : 'research synthesis' }];
      return { ok: true, part };
    } catch (err) {
      const d = describeError(err);
      part.status = 'failed';
      part.error = d.message;
      part.errorDetail = d;
      return { ok: false, part, error: d };
    }
  }

  async function runProject(goal, constraints = {}, { emit: emitFn = () => {}, prefer } = {}) {
    const project = makeProject({ goal, constraints });
    project.state.runLog = [];
    project.status = 'init';
    await store.create(project);
    const run = { id: newId('run'), kind: 'fast-build', startedAt: now(), status: 'running', goal };
    project.state.runs.push(run);
    project.currentRunId = run.id;

    try {
      emit(emitFn, 'run', 'start', `Build started: ${goal}`, { runId: run.id });
      await plan(project, emitFn, prefer);

      const researchParts = project.state.parts.filter((p) => p.meta?.researchRequired !== false);
      const knownParts = project.state.parts.filter((p) => p.meta?.researchRequired === false);

      if (knownParts.length) {
        emit(emitFn, 'agent', 'evidence', `${knownParts.length} standard part${knownParts.length === 1 ? '' : 's'} left for simulator/tool verification instead of LLM research.`);
      }

      // Independent research is concurrent. This preserves evidence quality while
      // removing the old one-part-at-a-time latency wall.
      const results = await Promise.all(researchParts.map((part) => researchOne(project, part, emitFn, prefer)));
      project.state.current.parts = project.state.parts
        .filter((p) => p.current?.data)
        .map((p) => ({ id: p.id, name: p.name, domain: p.domain, data: p.current.data }));
      project.state.researchLog.push(...results.filter((r) => r.ok).map((r) => ({ part: r.part.name, ts: now() })));
      await save(project);

      const failed = results.filter((r) => !r.ok);
      if (failed.length) {
        emit(emitFn, 'agent', 'research', `${failed.length} research item${failed.length === 1 ? '' : 's'} failed; continuing with verified data where available.`);
      }

      // Reconciliation is useful only when there are multiple researched parts.
      // A one-part build does not need an extra LLM call.
      if (project.state.parts.filter((p) => p.current?.data).length > 1) {
        try {
          await reconcileProject({ project, emit: emitFn, registry, contextChars: cfg?.throughput?.reconcileContextChars });
          await save(project);
        } catch (err) {
          emit(emitFn, 'reconcile', 'failed', `Integration check failed: ${errorSummary(err)}`, { error: describeError(err) });
        }
      }

      // Simulation remains the evidence gate. It is not removed; it is simply
      // reached without the old 24-turn controller repeatedly asking an LLM what
      // to do next.
      if (project.state.parts.some((p) => p.current?.data)) {
        try {
          const sim = await runSimPhase({ project, registry, cfg, emit: emitFn, prefer });
          if (sim) project.state.sim = sim;
          await save(project);
        } catch (err) {
          emit(emitFn, 'sim', 'failed', `Simulation failed: ${errorSummary(err)}`, { error: describeError(err) });
        }
      }

      const missing = project.state.parts.filter((p) => !p.current?.data && p.meta?.researchRequired !== false && p.status !== 'failed');
      const failedParts = project.state.parts.filter((p) => p.status === 'failed');
      const simBad = project.state.sim && ['failed', 'partial'].includes(project.state.sim.status);
      project.status = missing.length || failedParts.length || simBad ? 'partial' : 'complete';
      project.state.chat.push({ role: 'agent', content: summary(project), ts: now() });
      run.status = project.status;
      run.endedAt = now();
      await save(project);
      emit(emitFn, 'run', 'end', `Build ${project.status}.`, { runId: run.id });
      return project;
    } catch (err) {
      const d = describeError(err);
      project.status = 'failed';
      run.status = 'failed';
      run.endedAt = now();
      run.error = d.message;
      project.state.errors.push({ at: now(), runId: run.id, where: 'fast-build', ...d });
      await save(project);
      emit(emitFn, 'error', 'run', `Build failed: ${d.message}`, { error: d, fatal: true });
      throw err;
    }
  }

  return { runProject };
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
