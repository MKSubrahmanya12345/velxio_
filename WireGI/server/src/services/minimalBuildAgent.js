import { generateJSON } from './llm.js';
import { makeProject, makePart, newId } from '../models/project.js';
import { createSpecializedWorkers } from './specializedWorkers.js';
import { reconcileProject } from './reconcile.js';
import { runSimPhase } from './velxio.js';
import { pickProfile } from './profiles.js';
import { describeError } from './debug.js';

const MAX_PARTS = 3;
const now = () => new Date().toISOString();

const PLAN_SYSTEM = `You are WireGI's hardware architect. Produce the smallest complete build plan for the user's request.
Return JSON ONLY:
{"classification":string,"domains":[string],"parts":[{"name":string,"domain":string,"idea":string,"researchRequired":boolean}],"simulationRequired":boolean}
Rules:
- Use at most 3 meaningful engineering work units.
- Combine tightly coupled hardware/firmware/software work instead of splitting it artificially.
- Never invent requirements or specifications.
- researchRequired is only a hint; evidence still comes from tools/research.
- simulationRequired=true only when simulation materially validates the requested behavior.`;

export function createMinimalBuildAgent({ cfg, registry, store, indexer }) {
  const save = async (project) => { project.updatedAt = now(); await store.save(project); };
  const emit = (fn, type, stage, message, extra = {}) => fn?.({ type, stage, message, ts: now(), ...extra });
  const workers = createSpecializedWorkers({ registry, indexer });

  async function plan(project, emitFn, prefer) {
    const p = await generateJSON({
      registry,
      system: PLAN_SYSTEM,
      user: JSON.stringify({ goal: project.goal, constraints: project.constraints }),
      temperature: 0.1,
      emit: emitFn,
      prefer,
      operation: 'minimal-build-plan',
    });
    if (!Array.isArray(p?.parts) || !p.parts.length) throw new Error('The architect returned no build parts.');
    const profile = pickProfile(p.classification, p.domains, project.goal);
    project.profileId = profile.id;
    project.profileLabel = profile.label;
    project.state.idea.classification = p.classification;
    project.state.idea.domains = p.domains || [];
    project.state.idea.profile = { id: profile.id, label: profile.label, ladder: profile.ladder };
    project.state.parts = p.parts.slice(0, MAX_PARTS).map((x) => {
      const part = makePart({ name: x.name, domain: x.domain, idea: { summary: x.idea, researchRequired: x.researchRequired !== false } });
      part.meta = { researchRequired: x.researchRequired !== false };
      return part;
    });
    project.state.idea.parts = project.state.parts.map((x) => ({ id: x.id, name: x.name, domain: x.domain, idea: x.idea }));
    project.state.idea.revisions.push({ at: now(), kind: 'created', note: project.goal, revision: 1 });
    project.state.simulationRequired = p.simulationRequired === true;
    project.state.workers = {};
    project.status = 'researching';
    await save(project);
    emit(emitFn, 'project', 'planned', `Minimal plan: ${project.state.parts.length} shared work units.`, {
      projectId: project.id,
      parts: project.state.parts.map((x) => ({ id: x.id, name: x.name, domain: x.domain })),
    });
  }

  async function runProject(goal, constraints = {}, { emit: emitFn = () => {}, prefer } = {}) {
    const project = makeProject({ goal, constraints });
    project.state.runLog = [];
    project.state.checkpoint = null;
    project.state.workers = {};
    project.status = 'init';
    await store.create(project);
    const run = { id: newId('run'), kind: 'shared-parallel-build', startedAt: now(), status: 'running', goal };
    project.state.runs.push(run);
    project.currentRunId = run.id;

    try {
      emit(emitFn, 'run', 'start', `Build started: ${goal}`, { runId: run.id });

      project.state.checkpoint = { runId: run.id, stage: 'planning', status: 'running', updatedAt: now() };
      await save(project);
      emit(emitFn, 'stage', 'planning', 'Planning the smallest complete build…', { runId: run.id });
      await plan(project, emitFn, prefer);

      project.state.checkpoint = { runId: run.id, stage: 'workers', status: 'running', updatedAt: now() };
      await save(project);
      emit(emitFn, 'stage', 'workers', 'Starting hardware and coding workers in parallel…', {
        runId: run.id,
        workers: ['hardware', 'coding'],
      });
      await workers.run({ project, emit: emitFn, prefer });
      await save(project);

      const usable = project.state.parts.filter((p) => p.current?.data);
      if (usable.length > 1) {
        emit(emitFn, 'stage', 'reconcile', 'Integrating the shared hardware and software state…', { runId: run.id });
        project.state.checkpoint = { runId: run.id, stage: 'reconcile', status: 'running', updatedAt: now() };
        await save(project);
        await reconcileProject({ project, emit: emitFn, registry, contextChars: cfg?.throughput?.reconcileContextChars });
        await save(project);
      }

      if (project.state.simulationRequired && usable.length) {
        emit(emitFn, 'stage', 'simulation', 'Running targeted verification on the integrated project…', { runId: run.id });
        project.state.checkpoint = { runId: run.id, stage: 'simulation', status: 'running', updatedAt: now() };
        await save(project);
        project.state.sim = await runSimPhase({ project, registry, cfg, emit: emitFn, prefer });
        await save(project);
      }

      const failed = project.state.parts.filter((p) => p.status === 'failed').length;
      project.status = failed ? 'partial' : 'complete';
      project.state.checkpoint = { runId: run.id, stage: 'complete', status: 'complete', updatedAt: now() };
      project.state.chat.push({ role: 'agent', content: summary(project), ts: now() });
      run.status = project.status;
      run.endedAt = now();
      await save(project);
      emit(emitFn, 'run', 'end', `Build ${project.status}.`, {
        runId: run.id,
        workers: project.state.workers,
      });
      return project;
    } catch (err) {
      const d = describeError(err);
      project.status = 'failed';
      run.status = 'failed';
      run.endedAt = now();
      run.error = d.message;
      project.state.errors.push({ at: now(), runId: run.id, where: 'shared-parallel-build', ...d });
      await save(project);
      emit(emitFn, 'error', 'run', `Build failed: ${d.message}`, {
        error: d,
        fatal: true,
        checkpoint: project.state.checkpoint,
        workers: project.state.workers,
      });
      throw err;
    }
  }

  return { runProject };
}

function summary(project) {
  const lines = [`# ${project.goal}`, '', `Status: **${project.status}**`, ''];
  const workers = project.state.workers || {};
  if (workers.hardware || workers.coding) {
    lines.push(`Workers: hardware=${workers.hardware?.status || 'idle'}, coding=${workers.coding?.status || 'idle'}`, '');
  }
  for (const p of project.state.parts) {
    const mark = p.status === 'failed' ? '✖' : p.verified ? '✓' : p.current?.data ? '•' : '?';
    lines.push(`- ${mark} **${p.name}** (${p.domain})`);
    if (p.current?.data?.bomRow) lines.push(`  - BOM: ${p.current.data.bomRow}`);
    if (p.current?.data?.wiring) lines.push(`  - Wiring: ${p.current.data.wiring}`);
  }
  if (project.state.sim?.summary) lines.push('', `Simulation: ${project.state.sim.summary}`);
  return lines.join('\n');
}
