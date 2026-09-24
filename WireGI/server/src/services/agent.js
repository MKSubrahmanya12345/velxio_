// The WireGI agent: prompt -> Jev decisions -> parallel research per part ->
// merge into durable IDEA/CURRENT/VERIFIED state -> streamed communication.
//
// Gap B (concurrency + resilience) lives here:
//   * bounded concurrency   — mapWithConcurrency + withProviderSlot (queue.js)
//   * per-part retry        — withRetry with backoff + jitter (retry.js)
//   * failure isolation     — runPart never throws; a failed part is marked and
//                             its siblings keep going
//   * per-part checkpoints  — serialized store.save after every part, so a
//                             crash mid-run leaves resumable progress
//   * resumable runs        — resumeProject() re-runs pending/researching/failed
//
// Debuggability (this is the layer that answers "what is it doing, and why did
// that fail?"):
//   * every run has a runId, a durable event log (project.state.runLog) and a
//     record in project.state.runs with wall-clock timings
//   * every part carries tier, provider, latency, attempts, started/finished
//   * failures are recorded as full records (name, message, where, stack,
//     provider attempts) in project.state.errors AND in the stream — never as
//     an empty message
//   * the project is persisted BEFORE the first LLM call, so a run that dies in
//     decomposition is still inspectable afterwards
import { generateJSON, generate } from './llm.js';
import { makeProject, makePart, newId } from '../models/project.js';
import { researchPart } from './research.js';
import { triagePart, decomposePlan, affectedParts, isSufficient } from './gate.js';
import { choice, noul, answerValue, noulTrue } from './jevQuestions.js';
import { pickProfile, getProfile, isSafetyCritical } from './profiles.js';
import { reconcileProject } from './reconcile.js';
import { runSimPhase } from './velxio.js';
import { mapWithConcurrency, withProviderSlot, CONCURRENCY } from './queue.js';
import { withRetry } from './retry.js';
import { createTracer, describeError, errorSummary, withContext } from './debug.js';

const SYS_DECOMPOSE = `You decompose a build request into the concrete PARTS needed to actually make it.
Return JSON ONLY: { "classification": string, "domains": [string], "parts": [ { "name": string, "domain": string, "idea": string } ] }.
Cover hardware, firmware/software, tools, and verification. For a drone include: frame, motors, ESC (electronic speed controller), flight controller, propellers, receiver/radio, video system, battery, firmware.`;

const MAX_ERRORS = 50;

export function createAgent({ cfg, registry, jev, store, indexer }) {
  const debugCfg = cfg?.debug || {};
  const runLogLimit = debugCfg.runLogLimit || 2000;

  // store.save() writes a single tmp file, so two concurrent saves would race.
  // Every checkpoint goes through this chain (last one wins, order preserved).
  let saveChain = Promise.resolve();
  function checkpoint(project) {
    saveChain = saveChain.then(
      () => store.save(project),
      () => store.save(project), // a failed save must not stall the chain
    );
    return saveChain;
  }
  // A checkpoint is best-effort: losing one write must never kill a build.
  const safeCheckpoint = (project) => checkpoint(project).catch(() => {});

  // ── run lifecycle ──────────────────────────────────────────────────────────
  function beginRun(project, kind, emit, detail = {}) {
    const runId = newId('run');
    project.state.runs = project.state.runs || [];
    const tracer = createTracer({
      emit,
      project,
      runId,
      limit: runLogLimit,
      debug: Boolean(debugCfg.enabled),
    });
    const run = {
      id: runId,
      kind,
      startedAt: new Date().toISOString(),
      status: 'running',
      goal: project.goal,
      ...detail,
    };
    project.state.runs.push(run);
    project.currentRunId = runId;
    tracer.emit({
      type: 'run',
      stage: 'start',
      kind,
      goal: project.goal,
      message: `Run started — ${kind}${detail.note ? ` (${detail.note})` : ''}`,
    });

    return {
      runId,
      run,
      tracer,
      finish(status, extra = {}) {
        const ms = Date.now() - tracer.startedAt;
        run.status = status;
        run.endedAt = new Date().toISOString();
        run.ms = ms;
        run.events = tracer.seq;
        Object.assign(run, extra);
        tracer.emit({
          type: 'run',
          stage: 'end',
          status,
          ms,
          message: `Run ${status} in ${(ms / 1000).toFixed(1)}s · ${tracer.seq} events`,
        });
        return run;
      },
    };
  }

  function recordError(project, runId, where, err, extra = {}) {
    const described = describeError(err);
    const record = { at: new Date().toISOString(), runId, where, ...described, ...extra };
    project.state.errors = [...(project.state.errors || []), record].slice(-MAX_ERRORS);
    return record;
  }

  function logDecision(project, label, res) {
    project.state.decisions.push({
      label,
      at: new Date().toISOString(),
      source: res?.source,
      model: res?.model,
      note: res?.note,
      answers: res?.answers ?? res,
    });
  }

  // Ask Jev, but never let a decision take the build down. jevClient already
  // degrades live-Jev → LLM fallback; if even that fails (or it is slow,
  // malformed, or unavailable) we log it and continue with a safe default, per
  // the rule: a bad decision routes to the LLM, it never blocks the build.
  async function safeDecide(tracer, project, label, { state, questions }, fallback = {}) {
    const done = tracer.phase(`decision:${label}`, {});
    try {
      const res = await jev.decide({ state, questions }, { registry });
      const ms = done({ source: res?.source });
      logDecision(project, label, res);
      tracer.emit({
        type: 'decision',
        label,
        answers: res.answers,
        source: res.source,
        model: res.model,
        note: res.note,
        ms,
        message: `Decision ${label} → ${res.source}${res.note ? ` (${res.note})` : ''}`,
      });
      return res;
    } catch (err) {
      const described = describeError(err);
      done({ source: 'unavailable', error: described.message });
      const res = { source: 'unavailable', answers: fallback, note: described.message };
      logDecision(project, label, res);
      recordError(project, tracer.runId, `decision:${label}`, err, { recovered: true });
      tracer.emit({
        type: 'decision',
        label,
        answers: fallback,
        source: 'unavailable',
        error: described,
        level: 'warn',
        message: `Decision ${label} unavailable — continuing with safe defaults (${described.message})`,
      });
      return res;
    }
  }

  function applyResearch(part, project, result) {
    part.status = result.humanCheckpoint ? 'awaiting_human' : 'data_ready';
    part.current = { gathered: result.gathered, understand: result.understand, data: result.data };
    part.research = result.research;
    part.humanCheckpoint = result.humanCheckpoint;
    // A fresh research pass clears "needs your answer" — the sufficiency check
    // below re-raises it if the new data is still not enough.
    part.needsInput = false;
    part.checklist = result.data?.checklist || [];
    part.openQuestions = result.understand?.openQuestions || [];
    part.error = null;
    part.errorDetail = null;
    part.meta = result.meta || part.meta || null; // who answered + how long
    part.updatedAt = new Date().toISOString();
    part.finishedAt = part.updatedAt;

    // Verification-ladder evidence: record WHICH rung produced this and how.
    const web = result.web || { engine: 'none', count: 0 };
    part.evidence = [
      ...(part.evidence || []),
      {
        rung: 'research',
        at: part.updatedAt,
        detail:
          web.engine === 'index'
            ? `reused indexed findings${web.reusedFrom ? ` (${web.reusedFrom})` : ''}`
            : web.engine === 'skip'
              ? 'offloaded to human by triage gate'
              : web.count
                ? `${web.engine} × ${web.count} sources + model synthesis`
                : 'model knowledge (no web-search key)',
      },
    ];
    const existing = project.state.current.parts.find((p) => p.id === part.id);
    const entry = {
      id: part.id,
      name: part.name,
      domain: part.domain,
      data: result.data,
      humanCheckpoint: result.humanCheckpoint,
      web: result.web,
      meta: part.meta,
    };
    if (existing) Object.assign(existing, entry);
    else project.state.current.parts.push(entry);
    project.state.researchLog.push({ part: part.name, web: result.web, ts: part.updatedAt, meta: part.meta });
  }

  // One part's research pass (Jev gate + research pipeline). May throw; the
  // caller (runPart) owns retries and failure isolation.
  async function researchOne(part, tracer, project) {
    const profile = getProfile(project.profileId);

    // Jev gate (Gap 1): decide the cheapest safe research path. Fails safe to LLM.
    // Guards are profile-defined, so "safety-critical" means the right thing per domain.
    const gateDone = tracer.phase('triage', { partId: part.id, part: part.name });
    const triage = await triagePart({ part, project, indexer, jev, registry, profile });
    gateDone({ action: triage.action });
    part.tier = triage.action;
    part.triageReason = triage.reason;
    tracer.emit({
      type: 'research',
      stage: 'gate',
      partId: part.id,
      part: part.name,
      action: triage.action,
      tier: triage.action,
      reason: triage.reason,
      note: triage.reason,
      usedJev: triage.usedJev,
      confidence: triage.confidence,
      prefer: triage.prefer,
      message: `Gate (${triage.usedJev ? 'Jev' : 'LLM-fallback'}): ${triage.action} — ${triage.reason}`,
    });

    const researched = tracer.phase('research', { partId: part.id, part: part.name });

    // dup → copy a sibling's data (0 LLM call).
    if (triage.action === 'dup') {
      const src = project.state.parts.find(
        (p) => p.id !== part.id && p.current?.data && (!triage.source || p.name === triage.source),
      );
      if (src) {
        const result = {
          research: src.research || [],
          gathered: src.gathered || [],
          understand: src.current?.understand || { validation: [], openQuestions: [], conflicts: [] },
          data: src.data,
          humanCheckpoint: Boolean(src.humanCheckpoint),
          web: { engine: 'reuse', count: 0 },
          meta: { provider: '(reused)', model: src.meta?.model, latencyMs: 0, attempts: 0 },
        };
        applyResearch(part, project, result);
        // applyResearch cleared it — inherit the sibling's flag, whatever it was.
        part.needsInput = Boolean(src.needsInput);
        if (part.needsInput) part.status = 'awaiting_human';
        const ms = researched({ reusedFrom: src.name });
        tracer.emit({
          type: 'part',
          stage: 'done',
          partId: part.id,
          part: part.name,
          data: result.data,
          humanCheckpoint: result.humanCheckpoint,
          ms,
          note: 'reused from ' + src.name,
          message: `${part.name} done (reused from ${src.name}) in ${ms}ms`,
        });
        return result;
      }
      // fall through to a full pass if no source was found
      tracer.debug(`${part.name}: gate said duplicate but no sibling with data — running a full pass`);
    }

    // skip → offload trivial part to the human (0 LLM call). This needs the
    // human's INPUT, never their approval — so it is needsInput, not a checkpoint.
    if (triage.action === 'skip') {
      const result = {
        research: [],
        gathered: [],
        understand: {
          validation: [],
          openQuestions: ['Part marked trivial by gate — please provide specifics.'],
          conflicts: [],
        },
        data: { bomRow: '— provide —', wiring: '— provide —', config: '— provide —', checklist: ['Define this part'] },
        humanCheckpoint: false,
        web: { engine: 'skip', count: 0 },
        meta: { provider: '(skipped by gate)', latencyMs: 0, attempts: 0 },
      };
      applyResearch(part, project, result);
      part.needsInput = true;
      part.status = 'awaiting_human';
      const ms = researched({ skipped: true });
      tracer.emit({
        type: 'part',
        stage: 'done',
        partId: part.id,
        part: part.name,
        data: result.data,
        humanCheckpoint: false,
        needsInput: true,
        ms,
        note: 'skipped (trivial) — needs your input',
        message: `${part.name} skipped by the gate — needs your input`,
      });
      return result;
    }

    // light → cheaper model; full → full model.
    const prefer = triage.action === 'light' ? triage.prefer : undefined;
    const result = await researchPart({
      part,
      project,
      registry,
      emit: tracer.emit,
      indexer,
      prefer,
    });
    applyResearch(part, project, result);
    const ms = researched({ provider: result.meta?.provider, model: result.meta?.model });

    // T4 sufficiency. Insufficient data is the AGENT'S problem, not the
    // human's — so the first move is a targeted self-repair pass with the gaps
    // spelled out, not an escalation. Only if the data is STILL insufficient
    // afterwards does the human hear about it, and then as questions to
    // ANSWER (needsInput), never as something to APPROVE: offering approval on
    // data the agent itself just doubted would forge the evidence ladder.
    const sufDone = tracer.phase('sufficiency', { partId: part.id, part: part.name });
    if (!(await isSufficient({ part, project, jev, registry }))) {
      const gaps = (part.openQuestions || []).filter(Boolean);
      tracer.emit({
        type: 'log',
        level: 'info',
        partId: part.id,
        part: part.name,
        message: `${part.name}: data insufficient — the agent re-researches its own gaps before bothering you`,
      });
      try {
        const repair = await researchPart({
          part,
          project,
          registry,
          emit: tracer.emit,
          indexer,
          prefer,
          guidance: `A PREVIOUS RESEARCH PASS ON THIS PART WAS JUDGED INSUFFICIENT.${
            gaps.length ? `\nUnresolved questions from that pass:\n${gaps.map((q) => `- ${q}`).join('\n')}` : ''
          }\nResolve every gap yourself now: pick concrete, sensible values and commit to them. Do NOT list these as open questions again, do NOT defer to the human, and set "humanCheckpoint" false unless the build is truly blocked on a preference, a bench fact, or a safety sign-off only the builder can provide.`,
        });
        applyResearch(part, project, repair);
      } catch (err) {
        // A failed repair pass must not kill the part — the sufficiency
        // re-check below decides what happens next.
        tracer.emit({
          type: 'log',
          level: 'warn',
          partId: part.id,
          part: part.name,
          message: `${part.name}: self-repair pass failed (${errorSummary(err)})`,
          error: describeError(err),
        });
      }
    }
    if (!(await isSufficient({ part, project, jev, registry }))) {
      part.needsInput = true;
      part.humanCheckpoint = false; // never approvable while the agent doubts its own data
      if (part.status === 'data_ready') part.status = 'awaiting_human';
      part.openQuestions = [
        ...(part.openQuestions || []),
        'The agent could not fully resolve this part on its own — answer the questions above and it will fold your answers in.',
      ];
      sufDone({ sufficient: false });
    } else {
      sufDone({ sufficient: true });
    }
    tracer.emit({
      type: 'part',
      stage: 'done',
      partId: part.id,
      part: part.name,
      data: result.data,
      humanCheckpoint: part.humanCheckpoint,
      needsInput: part.needsInput,
      ms,
      provider: result.meta?.provider,
      model: result.meta?.model,
      attempts: part.attempts,
      message: `${part.name} researched via ${result.meta?.provider || '?'}/${result.meta?.model || '?'} in ${ms}ms${
        part.humanCheckpoint ? ' — needs your eyes' : part.needsInput ? ' — needs your answer' : ''
      }`,
    });
    return result;
  }

  // Gap B: one part, fully isolated. Never throws. Retries transient provider
  // failures with backoff, checkpoints progress, and leaves a terminal status.
  async function runPart(part, project, run) {
    const tracer = run.tracer.child({ partId: part.id, part: part.name });
    part.status = 'researching';
    part.attempts = (part.attempts || 0) + 1;
    part.error = null;
    part.errorDetail = null;
    part.startedAt = new Date().toISOString();
    tracer.emit({
      type: 'part',
      stage: 'start',
      attempt: part.attempts,
      tier: part.tier,
      message: `${part.name} → research (attempt ${part.attempts})`,
    });

    try {
      await withRetry(() => researchOne(part, tracer, project), {
        onRetry: ({ attempt, retries, waitMs, error }) => {
          tracer.emit({
            type: 'retry',
            attempt,
            retries,
            waitMs,
            error: describeError(error),
            message: `Retry ${attempt}/${retries} for ${part.name} in ${waitMs}ms — ${errorSummary(error)}`,
          });
        },
      });
      if (part.status === 'researching') part.status = 'data_ready';
      part.error = null;
      part.updatedAt = new Date().toISOString();
      await safeCheckpoint(project);
      return true;
    } catch (err) {
      const described = describeError(err);
      part.status = 'failed';
      part.error = described.message; // short string, kept for compatibility
      part.errorDetail = described; // full record: name/where/stack/attempts
      part.updatedAt = new Date().toISOString();
      part.finishedAt = part.updatedAt;
      recordError(project, run.runId, `part:${part.name}`, err, { partId: part.id });
      project.state.researchLog.push({
        part: part.name,
        web: { engine: 'failed', count: 0 },
        ts: part.updatedAt,
        error: described.message,
      });
      tracer.emit({
        type: 'part',
        stage: 'failed',
        error: described,
        ms: Date.now() - new Date(part.startedAt).getTime(),
        note: 'part failed — siblings continue; resume to retry',
        message: `${part.name} failed — ${described.message}`,
      });
      await safeCheckpoint(project);
      return false;
    }
  }

  function buildSummary(project) {
    const profile = getProfile(project.profileId);
    const statusLabel =
      { init: 'not started', researching: 'working', awaiting_human: 'needs your eyes', partial: 'partial', complete: 'complete', failed: 'failed' }[
        project.status
      ] || project.status;
    const lines = [
      `# ${project.goal}`,
      '',
      `**${statusLabel}** · ${project.state.idea.classification || '? classification'} · ${(project.state.idea.domains || []).join(', ')}`,
      `Profile: **${profile.label}** · ladder: ${profile.ladder.join(' → ')}`,
      '',
      '## Parts',
      '',
    ];
    const statusOf = (p) => {
      if (p.verified) return '✓ verified';
      if (p.needsInput) return '❓ needs your answer';
      if (p.humanCheckpoint) return '⚠ needs your eyes';
      if (p.status === 'failed') return '✖ failed';
      return p.status === 'data_ready' ? 'researched' : p.status;
    };
    for (const p of project.state.parts) {
      lines.push(`- **${p.name}** · \`${p.domain}\` · ${statusOf(p)}`);
      const d = p.current?.data || p.data;
      if (d?.bomRow) lines.push(`  - **BOM** — ${d.bomRow}`);
      if (d?.wiring) lines.push(`  - **Wiring** — ${d.wiring}`);
      if ((p.checklist || []).length) {
        lines.push('  - **Checklist**');
        for (const c of p.checklist) lines.push(`    - ${c}`);
      }
      if ((p.openQuestions || []).length) {
        lines.push('  - **Questions**');
        for (const q of p.openQuestions) lines.push(`    - ${q}`);
      }
      if ((p.humanInput || []).length) {
        lines.push(`  - **You said** — ${p.humanInput[p.humanInput.length - 1].text}`);
      }
    }
    const failed = project.state.parts.filter((p) => p.status === 'failed');
    if (failed.length) {
      lines.push('', '## Needs a resume', '');
      for (const p of failed) {
        lines.push(`- **${p.name}** — ${p.error || 'unknown error'}`);
      }
    }

    // The simulation rung: what the agent actually BUILT and verified.
    const sim = project.state.sim;
    if (sim && sim.status && sim.status !== 'skipped') {
      lines.push('', `## Simulator (Velxio) — ${sim.status}`, '');
      if (sim.summary) lines.push(`- ${sim.summary}`);
      for (const c of sim.checks || []) lines.push(`- ✓ ${c}`);
      lines.push(
        `- ${sim.rounds || 0} rounds · ${(sim.toolLog || []).length} tool calls${
          sim.verified?.length ? ` · verified: ${sim.verified.join(', ')}` : ''
        }`,
      );
      if (sim.instructions) {
        lines.push('', '**What to do next**', '', sim.instructions);
      }
    }

    // Integration: did the parts agree with each other?
    for (const r of project.state.reconciliations || []) {
      if (r.skipped) continue;
      if (r.failed) {
        lines.push('', '## Integration', '', `Failed: ${r.reason}`);
        continue;
      }
      const conflicts = r.conflicts || [];
      const blocking = conflicts.filter((c) => c.severity === 'blocking').length;
      lines.push('', '## Integration', '');
      if (r.coherent && !conflicts.length) {
        lines.push(`✅ **coherent** — ${r.summary || 'the parts agree.'}`);
      } else {
        lines.push(
          `⚠ **${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} found**${
            blocking ? ` (${blocking} blocking)` : ''
          } — ${r.summary || ''}`,
        );
      }
      for (const c of conflicts) {
        const who = (c.parts || []).join(' ↔ ');
        lines.push(`- ${c.severity === 'blocking' ? '🛑 **blocking**' : '❗ **warning**'} · ${who}`);
        lines.push(`  - ${c.issue}`);
        if (c.resolution) lines.push(`  - → ${c.resolution}`);
      }
    }
    const errors = project.state.errors || [];
    if (errors.length) {
      lines.push('', '## Errors during the run', '');
      for (const e of errors.slice(-5)) {
        lines.push(`- \`${e.where || '?'}\` — **${e.name || 'Error'}**: ${e.message}`);
      }
      lines.push('', '_Full trace: right-hand panel → Flow._');
    }
    return lines.join('\n');
  }

  // D4/D5/D6 gate + status resolution + summary + durable save. Shared by
  // runProject, continueProject and resumeProject.
  async function finalize(project, tracer, { summarise = true } = {}) {
    const parts = project.state.parts;
    const failed = parts.filter((p) => p.status === 'failed');
    const pending = parts.filter((p) => p.status === 'pending' || p.status === 'researching');
    const unverifiedHumanGates = parts.filter((p) => p.humanCheckpoint && !p.verified);
    // Parts the agent could not resolve on its own: they block "complete" too,
    // but they wait for ANSWERS, not approvals.
    const unanswered = parts.filter((p) => p.needsInput && !p.verified);

    let dCheck = null;
    const verifyDone = tracer.phase('verify');
    try {
      dCheck = await jev.decide(
        {
          state: {
            operation: 'verify',
            goal: project.goal,
            parts: project.state.parts.map((p) => ({
              name: p.name,
              hasData: !!p.current?.data,
              humanCheckpoint: p.humanCheckpoint,
              needsInput: p.needsInput,
            })),
            failed: failed.map((p) => p.name),
          },
          questions: {
            complete: noul(
              "Is every part's gathered data complete and conflict-free enough to start building?",
            ),
            needsHuman: noul(
              'Does any part REQUIRE human eyes (soldering/eyeball confirmation) before it is verified?',
            ),
            done: noul(
              'Is CURRENT state effectively equal to IDEA state for all verified parts? This is the stop condition.',
            ),
          },
        },
        { registry },
      );
      logDecision(project, 'D4-D6 verify', dCheck);
      verifyDone({ source: dCheck.source });
      tracer.emit({
        type: 'decision',
        label: 'D4-D6 verify',
        answers: dCheck.answers,
        source: dCheck.source,
        message: `Decision D4-D6 verify → ${dCheck.source}`,
      });
    } catch (err) {
      // The verify gate must never sink a finished build — fall back to computed status.
      verifyDone({ source: 'unavailable' });
      recordError(project, tracer.runId, 'verify', err, { recovered: true });
      tracer.emit({
        type: 'log',
        level: 'warn',
        message: `D4-D6 gate unavailable — using computed status (${errorSummary(err)})`,
        error: describeError(err),
      });
    }

    // The ladder's top rung is human, and the decision model gets to insist on
    // it: if Jev says a human MUST look, the project cannot be "complete".
    const decisionWantsHuman = noulTrue(dCheck?.answers?.needsHuman);
    const blockingConflicts = (project.state.reconciliations || []).some(
      (r) => !r.skipped && (r.conflicts || []).some((c) => c.severity === 'blocking'),
    );

    let status;
    if (!parts.length) status = 'failed';
    else if (failed.length && failed.length === parts.length) status = 'failed';
    else if (failed.length || pending.length) status = 'partial';
    else if (unverifiedHumanGates.length || unanswered.length || decisionWantsHuman || blockingConflicts)
      status = 'awaiting_human';
    // No decision available (no Jev, no LLM key, provider down): the human is
    // the top rung anyway — if they have verified everything, the project is
    // complete. This is what lets approvals work with zero providers.
    else if (!dCheck) status = 'complete';
    else status = noulTrue(dCheck.answers?.done) ? 'complete' : 'awaiting_human';
    project.status = status;

    if (summarise) {
      project.state.chat.push({ role: 'agent', content: buildSummary(project), ts: new Date().toISOString() });
    }
    await safeCheckpoint(project);
    const counts = {
      total: parts.length,
      done: parts.filter((p) => p.status === 'data_ready' || p.status === 'awaiting_human' || p.status === 'verified').length,
      failed: failed.length,
      needsHuman: parts.filter((p) => p.humanCheckpoint && !p.verified).length,
      needsInput: unanswered.length,
    };
    tracer.emit({
      type: 'done',
      projectId: project.id,
      status: project.status,
      summary: buildSummary(project),
      counts,
      message: `Done — ${project.status} (${counts.done}/${counts.total} parts${
        counts.failed ? `, ${counts.failed} failed` : ''
      })`,
    });
    return project;
  }

  // Cross-part integration. Never fatal: if it fails, the parts are still
  // useful and the failure is recorded rather than thrown.
  async function safeReconcile(project, tracer) {
    const done = tracer.phase('reconcile');
    try {
      const entry = await reconcileProject({ project, emit: tracer.emit, registry, jev });
      done({ coherent: entry?.coherent, conflicts: entry?.conflicts?.length || 0 });
      await safeCheckpoint(project);
      return entry;
    } catch (err) {
      done({ failed: true });
      const described = describeError(err);
      recordError(project, tracer.runId, 'reconcile', err);
      tracer.emit({
        type: 'reconcile',
        stage: 'failed',
        reason: described.message,
        error: described,
        message: `Integration failed — ${described.message}`,
      });
      project.state.reconciliations = [
        ...(project.state.reconciliations || []),
        { at: new Date().toISOString(), failed: true, reason: described.message },
      ];
      await safeCheckpoint(project);
      return null;
    }
  }

  // Bounded, isolated, checkpointed research pass over a set of parts.
  async function researchBatch(parts, project, note, tracer) {
    if (!parts.length) return { ok: 0, failed: 0, total: 0 };
    const startedAt = Date.now();
    tracer.emit({
      type: 'batch',
      stage: 'start',
      total: parts.length,
      concurrency: CONCURRENCY,
      note,
      message: `Batch ${note}: ${parts.length} part(s), up to ${CONCURRENCY} at a time`,
    });
    const outcomes = await mapWithConcurrency(parts, CONCURRENCY, (p) =>
      withProviderSlot(() => runPart(p, project, runFromTracer(tracer))),
    );
    const ok = outcomes.filter(Boolean).length;
    const failedCount = outcomes.filter((o) => !o).length;
    tracer.emit({
      type: 'batch',
      stage: 'done',
      ok,
      failed: failedCount,
      total: parts.length,
      note,
      ms: Date.now() - startedAt,
      message: `Batch ${note} done: ${ok} ok, ${failedCount} failed of ${parts.length} in ${Date.now() - startedAt}ms`,
    });
    return { ok, failed: failedCount, total: parts.length };
  }

  // runPart needs the run (for runId + a part-scoped child tracer); the batch
  // only has the tracer, so wrap it back into the shape runPart expects.
  function runFromTracer(tracer) {
    return { runId: tracer.runId, tracer };
  }

  // ── The simulation rung ─────────────────────────────────────────────────
  //
  // runSimPhase() (services/velxio.js) gives the agent hands: it turns the
  // researched parts into a real artifact inside the Velxio simulator —
  // circuit, firmware, validation, compile, simulate, physics — and reports
  // what passed. This applies its record to the project: durable state, a
  // chat message that tells the human what to do next, and per-part evidence
  // on the verification ladder (research → SIM → human-eyes).
  function applySim(project, sim, tracer) {
    if (!sim) return;
    project.state.sim = { ...sim, toolLog: (sim.toolLog || []).slice(-60) };

    const title =
      sim.status === 'simulated'
        ? '🧪 **Built and verified in the simulator**'
        : sim.status === 'partial'
          ? '🧪 **Partially verified in the simulator**'
          : sim.status === 'skipped'
            ? '🧪 Simulator rung skipped'
            : '🧪 **Simulator rung could not finish**';

    const meta = [
      `${sim.rounds || 0} design round${(sim.rounds || 0) === 1 ? '' : 's'}`,
      (sim.toolLog || []).length
        ? `${sim.toolLog.filter((t) => t.ok).length}/${sim.toolLog.length} tool calls ok`
        : 'no tool calls',
      sim.verified?.length ? `verified: ${sim.verified.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join(' · ');

    if (sim.status === 'skipped') {
      project.state.chat.push({
        role: 'agent',
        content: `${title} — ${sim.reason || 'the simulator was not available'}. The research stands on its own; the design loop will run when Velxio is reachable.`,
        ts: new Date().toISOString(),
      });
      return;
    }

    project.state.chat.push({
      role: 'agent',
      content: `${title} (${meta})\n\n${sim.summary || ''}\n\n${
        sim.instructions || 'No instructions were produced — ask for them.'
      }`,
      ts: new Date().toISOString(),
    });

    // Ladder evidence: the sim rung now backs every part that fed the artifact.
    if (sim.status !== 'skipped') {
      const detail = `Velxio simulator: ${sim.verified?.length ? sim.verified.join(', ') : 'attempted'} · ${(sim.toolLog || []).length} tool calls`;
      for (const p of project.state.parts) {
        if (!p.current?.data && !p.data) continue;
        p.evidence = [
          ...(p.evidence || []),
          { rung: 'simulation', at: sim.at || new Date().toISOString(), by: 'velxio', detail },
        ];
      }
    }
    tracer.emit({
      type: 'sim',
      stage: 'applied',
      status: sim.status,
      message: `Simulation rung applied to the project (${sim.status})`,
    });
  }

  async function runProject(goal, constraints, { emit = () => {}, prefer } = {}) {
    const project = makeProject({ goal, constraints });
    project.state.runLog = [];
    const run = beginRun(project, 'build', emit, { goal, constraints });
    const tracer = run.tracer;

    // Persist immediately: a run that dies in decomposition (no keys, invalid
    // JSON, provider outage) must still be inspectable afterwards.
    project.status = 'init';
    await store.create(project);

    try {
      // D1 — Jev classifies the build and its domains.
      // choice criteria MUST be a dict { key: description }; a bare array is
      // rejected by the API with a 422. Builders live in services/jevQuestions.js.
      const classifyDone = tracer.phase('classify');
      const d1 = await safeDecide(tracer, project, 'D1 classify', {
        state: { operation: 'classify', goal, constraints },
        questions: {
          classification: choice('What kind of build is this?', {
            electronics: 'Primarily an electronics/wiring build',
            mechanical: 'Primarily a mechanical/fabrication build',
            'embedded/MCU': 'Centred on a microcontroller or firmware',
            software: 'Primarily software, little or no physical build',
            robotics: 'A robot combining mechanics, electronics and control',
            mixed: 'Substantially spans several of the above',
          }),
          domains: choice('Which domains does it span? (pick primary)', {
            hardware: 'Physical parts, wiring and assembly',
            firmware: 'Code that runs on the device',
            web: 'Web or app software',
            mechanical: 'Frames, enclosures, moving parts',
            robotics: 'Sensing, actuation and control loops',
            mixed: 'No single dominant domain',
          }),
        },
      });
      classifyDone({ source: d1.source });

      // D2/D3 — Jev steers breadth + risk bias; the LLM still writes the parts.
      const planDone = tracer.phase('decompose-plan');
      const plan = await decomposePlan({ goal, constraints, jev, registry });
      planDone({ source: plan.usedJev ? 'jev' : 'llm-fallback' });
      tracer.emit({
        type: 'decision',
        label: 'D2/D3 decompose-plan',
        answers: plan.usedJev ? { breadth: plan.breadthHint, risk: plan.riskBias } : {},
        source: plan.usedJev ? 'jev' : 'llm-fallback',
        message: `Decision D2/D3 decompose-plan → ${plan.usedJev ? `jev (≈${plan.breadthHint} parts)` : 'llm-fallback'}`,
      });
      // Domain profile: chosen from Jev's classification + the goal text. It
      // decides the research schema, the guards and the verification ladder —
      // i.e. it is what lets one engine build a drone OR an app.
      const preProfile = pickProfile(answerValue(d1.answers?.classification), [], goal);
      tracer.emit({
        type: 'project',
        stage: 'profile',
        profileId: preProfile.id,
        profileLabel: preProfile.label,
        label: preProfile.label,
        parts: [],
        message: `Domain profile selected: ${preProfile.label} (ladder: ${preProfile.ladder.join(' → ')})`,
      });

      const decompDone = tracer.phase('decompose');
      const decomp = await generateJSON({
        registry,
        system:
          SYS_DECOMPOSE +
          `\nDomain guidance (${preProfile.label}): ${preProfile.decompose}` +
          // A hard limit, not a target. "Aim for about 8" is read as a vibe by
          // every model, which is how a plan for ~8 parts came back as 12 — and
          // then got researched, one LLM pass each.
          (plan.breadthHint
            ? ` Return AT MOST ${plan.breadthHint} parts. Group related items instead of listing every sub-component or step — this is a hard ceiling, not a target, and returning more than ${plan.breadthHint} is a wrong answer. Do NOT include tools, assembly steps or verification procedures as parts.`
            : '') +
          plan.riskBias,
        user: `GOAL: ${goal}\nCONSTRAINTS: ${JSON.stringify(constraints)}`,
        temperature: 0.3,
        emit: tracer.emit,
        prefer,
        operation: 'decompose',
      });

      if (!decomp || !Array.isArray(decomp.parts) || decomp.parts.length === 0) {
        throw new Error(
          `Decomposition produced no parts (classification=${JSON.stringify(decomp?.classification ?? null)}, ` +
            `parts=${JSON.stringify(decomp?.parts ?? null)}). The model reply was structurally valid JSON but had no "parts" array.`,
        );
      }

      // Now that the LLM has read the goal, re-pick with its classification too.
      const profile = pickProfile(
        decomp.classification || answerValue(d1.answers?.classification),
        decomp.domains,
        goal,
      );

      const parts = decomp.parts.map((p) =>
        makePart({ name: p.name, domain: p.domain, idea: { summary: p.idea } }),
      );

      // The plan is a ceiling; say so when the model walks past it rather than
      // quietly researching the overage. Keeping the extra parts is the safer
      // failure — dropping them could lose something real — but the trace has
      // to show that the plan was not honoured.
      if (plan.usedJev && plan.breadthHint && parts.length > plan.breadthHint) {
        tracer.emit({
          type: 'log',
          level: 'warn',
          message: `Decomposition returned ${parts.length} parts against a plan of ${plan.breadthHint} — researching them all. Each extra part is one more research pass; tighten SYS_DECOMPOSE if this keeps happening.`,
          planned: plan.breadthHint,
          actual: parts.length,
        });
      }
      project.profileId = profile.id;
      project.profileLabel = profile.label;
      project.state.parts = parts;
      project.state.idea = {
        goal,
        constraints,
        classification: decomp.classification,
        domains: decomp.domains,
        profile: { id: profile.id, label: profile.label, ladder: profile.ladder },
        parts: parts.map((p) => ({ name: p.name, domain: p.domain })),
        revisions: [
          { at: new Date().toISOString(), kind: 'created', note: `Initial IDEA from: ${goal}`, revision: 1 },
        ],
      };
      project.state.current.parts = [];
      project.status = 'researching';
      await safeCheckpoint(project);
      const decompMs = decompDone({ parts: parts.length });
      tracer.emit({
        type: 'project',
        stage: 'decomposed',
        projectId: project.id,
        profileId: profile.id,
        profileLabel: profile.label,
        ladder: profile.ladder,
        classification: decomp.classification,
        domains: decomp.domains,
        ms: decompMs,
        parts: parts.map((p) => ({ id: p.id, name: p.name, domain: p.domain })),
        message: `Decomposed into ${parts.length} parts in ${decompMs}ms (${profile.label})`,
      });

      // Bounded concurrency, per-part isolation, per-part checkpoint.
      await researchBatch(parts, project, 'initial', tracer);

      // Reassembly: make the independently-researched parts agree.
      await safeReconcile(project, tracer);

      // The simulation rung: research said WHAT — now the agent BUILDS it in
      // the Velxio simulator (circuit + firmware, validated, compiled,
      // simulated) and writes the human's next steps. Skips itself when the
      // Velxio backend is not reachable — research stands on its own.
      const sim = await runSimPhase({ project, registry, cfg, emit: tracer.emit, prefer });
      applySim(project, sim, tracer);

      const finished = await finalize(project, tracer);
      run.finish(project.status, { counts: { parts: parts.length } });
      await safeCheckpoint(project);
      return finished;
    } catch (err) {
      const described = describeError(err);
      recordError(project, run.runId, 'runProject', err);
      project.status = 'failed';
      project.state.chat.push({
        role: 'agent',
        content: `⚠ The run failed before it could finish.\n\n**${described.name}**: ${described.message}${
          described.where ? `\n\n_where: ${described.where}_` : ''
        }\n\nOpen the **Flow** panel on the right for every step leading to this, and **Debug** for the environment (keys, providers, ports).`,
        ts: new Date().toISOString(),
      });
      tracer.emit({
        type: 'error',
        stage: 'run',
        where: 'runProject',
        fatal: true,
        error: described,
        message: `Run failed — ${described.name}: ${described.message}`,
      });
      run.finish('failed', { error: described.message });
      await safeCheckpoint(project);
      throw withContext(err, { where: 'runProject', runId: run.runId });
    }
  }

  async function continueProject(projectId, text, { emit = () => {}, prefer } = {}) {
    const project = await store.get(projectId);
    if (!project) throw Object.assign(new Error('project not found'), { status: 404 });
    const run = beginRun(project, 'message', emit, { note: text.slice(0, 120) });
    const tracer = run.tracer;
    project.status = project.status === 'init' ? 'init' : 'researching';

    try {
      project.state.chat.push({ role: 'user', content: text, ts: new Date().toISOString() });
      tracer.emit({ type: 'chat', role: 'user', content: text, message: `You: ${text.slice(0, 120)}` });

      const partNames = project.state.parts.map((p) => p.name);
      const dMsg = await safeDecide(
        tracer,
        project,
        'message',
        {
          state: {
            operation: 'message',
            goal: project.goal,
            text,
            parts: project.state.parts.map((p) => ({ name: p.name, status: p.status })),
          },
          questions: {
            intent: choice('What is the user doing with this message?', {
              approve: 'Approving/confirming finished work',
              add_constraint: 'Adding or changing a build constraint (budget, size, power, parts)',
              revise_part: 'Asking for a specific part to be redone or re-researched',
              simulate: 'Asking the agent to build/simulate/verify the design in the simulator',
              ask: 'Asking a question about the build',
              other: 'Anything else',
            }),
            target: choice('Which part is the message about (if any)?', ['all', 'none', ...partNames]),
          },
        },
        {
          // Safe default when no decision can be made: treat it as a question.
          intent: { type: 'choice', choice: 'ask', confidence: 0 },
          target: { type: 'choice', choice: 'none', confidence: 0 },
        },
      );

      const intent = answerValue(dMsg.answers?.intent);
      const target = answerValue(dMsg.answers?.target);
      tracer.emit({
        type: 'log',
        level: 'debug',
        message: `Message intent=${intent} target=${target}`,
        data: { intent, target },
      });

      if (intent === 'approve') {
        const targets =
          target && target !== 'none' && target !== 'all'
            ? project.state.parts.filter((p) => p.name.toLowerCase().includes(String(target).toLowerCase()))
            : project.state.parts;
        let verifiedCount = 0;
        for (const p of targets) {
          if (p.current?.data) {
            p.verified = true;
            p.status = 'verified';
            verifiedCount += 1;
            // The human rung, recorded with who/why — this is what makes
            // VERIFIED auditable weeks later.
            p.evidence = [
              ...(p.evidence || []),
              {
                rung: 'human-eyes',
                at: new Date().toISOString(),
                by: 'user',
                detail: text.slice(0, 200),
              },
            ];
            if (!project.state.verified.parts.find((x) => x.id === p.id)) {
              project.state.verified.parts.push({ id: p.id, name: p.name, at: new Date().toISOString() });
            }
          }
        }
        project.state.chat.push({
          role: 'agent',
          content: `Marked ${verifiedCount} part(s) as verified by you.`,
          ts: new Date().toISOString(),
        });
      } else if (intent === 'add_constraint' || intent === 'revise_part') {
        const extracted = await generateJSON({
          registry,
          system:
            'Extract updated constraints from the user message. Return JSON: { "constraints": { <key>: <value> } }. Only include keys the user actually changed or added.',
          user: `GOAL: ${project.goal}\nCURRENT CONSTRAINTS: ${JSON.stringify(project.constraints)}\nUSER MESSAGE: ${text}`,
          emit: tracer.emit,
          prefer,
          operation: 'extract-constraints',
        });
        project.constraints = { ...project.constraints, ...(extracted.constraints || {}) };

        // Keep IDEA as the LIVING document: the constraint change is recorded as a
        // revision, so CURRENT can be compared against the request as it evolved —
        // not against a frozen first draft.
        const profile = getProfile(project.profileId);
        project.state.idea.constraints = { ...project.constraints };
        project.state.idea.revisions = [
          ...(project.state.idea.revisions || []),
          {
            at: new Date().toISOString(),
            kind: 'constraint-change',
            note: text.slice(0, 300),
            constraints: { ...project.constraints },
            revision: (project.state.idea.revisions?.length || 0) + 1,
          },
        ];

        // T5 — only re-research parts the change actually touches (+ always the
        // domain's safety-critical parts).
        const affected = await affectedParts({ project, text, jev, registry });
        const safetyIds = project.state.parts
          .filter((p) => isSafetyCritical(p.name, p.domain || '', profile))
          .map((p) => p.id);
        const ids = [...new Set([...affected, ...safetyIds])];
        const targets = project.state.parts.filter((p) => ids.includes(p.id));
        project.status = 'researching';
        tracer.emit({
          type: 'log',
          level: 'info',
          message: `Constraint change → re-researching ${targets.length} part(s): ${targets
            .map((p) => p.name)
            .join(', ')}`,
        });
        await safeCheckpoint(project);
        await researchBatch(targets, project, 'constraint-change', tracer);

        // Constraints changed → specs may no longer agree. Re-integrate.
        await safeReconcile(project, tracer);

        // The artifact is now stale too: parts changed under it. Re-run the
        // design loop so the simulator rung matches the new CURRENT state.
        if (project.state.sim) {
          const sim = await runSimPhase({ project, registry, cfg, emit: tracer.emit, prefer });
          applySim(project, sim, tracer);
        }

        project.state.chat.push({
          role: 'agent',
          content: `Updated constraints (IDEA revision ${project.state.idea.revisions.length}) and re-ran research for ${targets.length} part(s).`,
          ts: new Date().toISOString(),
        });
      } else if (intent === 'simulate') {
        // "Build it / simulate it / does it work?" — the design loop, on demand.
        const sim = await runSimPhase({ project, registry, cfg, emit: tracer.emit, prefer });
        if (!sim) {
          project.state.chat.push({
            role: 'agent',
            content:
              "I couldn't reach the Velxio simulator (is the Velxio backend running on port 8000?). Research is intact — ask again once it's up.",
            ts: new Date().toISOString(),
          });
        } else {
          applySim(project, sim, tracer);
        }
      } else {
        const reply = await generate({
          registry,
          system:
            'You are WireGI, an agentic build assistant. Answer the user using the project state. Be concise. Ask clarifying questions if needed.',
          user: `GOAL: ${project.goal}\nCONSTRAINTS: ${JSON.stringify(project.constraints)}\nPARTS:\n${project.state.parts
            .map((p) => `- ${p.name} (${p.status}): ${p.current?.data?.bomRow || ''}`)
            .join('\n')}\nUSER: ${text}`,
          emit: tracer.emit,
          prefer,
          operation: 'chat-reply',
        });
        project.state.chat.push({ role: 'agent', content: reply, ts: new Date().toISOString() });
      }

      const finished = await finalize(project, tracer, { summarise: false });
      run.finish(project.status);
      return finished;
    } catch (err) {
      recordError(project, run.runId, 'continueProject', err);
      const described = describeError(err);
      project.state.chat.push({
        role: 'agent',
        content: `⚠ Could not handle that message: **${described.name}** — ${described.message}`,
        ts: new Date().toISOString(),
      });
      tracer.emit({
        type: 'error',
        stage: 'message',
        where: 'continueProject',
        fatal: true,
        error: described,
        message: `Message run failed — ${described.name}: ${described.message}`,
      });
      run.finish('failed', { error: described.message });
      await safeCheckpoint(project);
      throw withContext(err, { where: 'continueProject', runId: run.runId });
    }
  }

  // ── the human checkpoint, driven from the chat ────────────────────────────
  //
  // `awaiting_human` used to be a dead end: the project said "needs you" and the
  // only way out was a free-text message whose intent had to be guessed by an
  // LLM. That is both slow and broken when no provider is reachable.
  //
  // This path is DETERMINISTIC — no Jev, no LLM, no tokens:
  //   approve  → mark the part(s) verified with a human-eyes evidence record
  //   provide  → store the human's answer on the part (feeds the next research)
  //   rerun    → re-run research for that one part with the human's input
  //   reject   → same as rerun, but recorded as a rejection
  async function respondHuman(projectId, { partId = null, decision = 'provide', text = '' } = {}, { emit = () => {} } = {}) {
    const project = await store.get(projectId);
    if (!project) throw Object.assign(new Error('project not found'), { status: 404 });
    const note = String(text || '').trim();
    const run = beginRun(project, 'human', emit, {
      note: `${decision}${partId ? ` · ${partId}` : ' · all'}`,
    });
    const tracer = run.tracer;

    try {
      const withData = project.state.parts.filter((p) => p.current?.data);
      const waiting = project.state.parts.filter((p) => (p.humanCheckpoint || p.needsInput) && !p.verified);

      let targets;
      if (partId) {
        targets = project.state.parts.filter((p) => p.id === partId);
        if (!targets.length) throw Object.assign(new Error(`no part with id ${partId}`), { status: 404 });
      } else if (decision === 'approve') {
        // "approve all" = everything researched — EXCEPT parts the agent itself
        // still doubts (needsInput). Those cannot be approved into VERIFIED.
        targets = withData.filter((p) => !p.verified && !p.needsInput);
      } else {
        targets = waiting.length ? waiting : withData;
      }

      const approved = [];
      const answered = [];
      const requeued = [];
      const notApprovable = [];

      for (const part of targets) {
        if (decision === 'approve') {
          if (!part.current?.data) continue;
          // The logical guard: approval is a human-eyes rung on the evidence
          // ladder, and a rung cannot certify data the agent flagged as
          // insufficient. Answer the questions instead.
          if (part.needsInput) {
            notApprovable.push(part.name);
            tracer.emit({
              type: 'human',
              stage: 'approve-blocked',
              level: 'warn',
              partId: part.id,
              part: part.name,
              message: `${part.name}: not approvable yet — the agent still has open questions on it`,
            });
            continue;
          }
          part.verified = true;
          part.status = 'verified';
          part.updatedAt = new Date().toISOString();
          part.evidence = [
            ...(part.evidence || []),
            {
              rung: 'human-eyes',
              at: part.updatedAt,
              by: 'user',
              detail: note || 'approved from the chat',
            },
          ];
          if (!project.state.verified.parts.find((x) => x.id === part.id)) {
            project.state.verified.parts.push({ id: part.id, name: part.name, at: part.updatedAt });
          }
          approved.push(part.name);
          tracer.emit({
            type: 'human',
            stage: 'approve',
            partId: part.id,
            part: part.name,
            note,
            message: `${part.name}: approved by you (human-eyes)`,
          });
        } else {
          if (note) {
            part.humanInput = [
              ...(part.humanInput || []),
              { at: new Date().toISOString(), text: note, decision },
            ];
            part.evidence = [
              ...(part.evidence || []),
              {
                rung: 'human-eyes',
                at: new Date().toISOString(),
                by: 'user',
                detail: `${decision === 'reject' ? 'rejected' : 'input'}: ${note}`,
              },
            ];
          }
          part.updatedAt = new Date().toISOString();
          answered.push(part.name);
          tracer.emit({
            type: 'human',
            stage: decision,
            partId: part.id,
            part: part.name,
            text: note,
            message: `${part.name}: ${decision === 'reject' ? 'rejected' : 'your input recorded'}${note ? ` — ${note}` : ''}`,
          });
          // Re-run the part when asked to — and ALSO when the human answers a
          // needsInput part: an answer that is not folded into a new research
          // pass is not really accepted, just stored.
          if (decision !== 'provide' || (part.needsInput && note)) requeued.push(part);
        }
      }

      // The conversation records what the human did, in their own words.
      if (note || approved.length || answered.length) {
        project.state.chat.push({
          role: 'user',
          content:
            decision === 'approve'
              ? `approve ${targets.length === 1 ? targets[0].name : `all (${approved.length})`}${note ? ` — ${note}` : ''}`
              : `${decision} ${targets.map((p) => p.name).join(', ')}: ${note || '(no note)'}`,
          ts: new Date().toISOString(),
        });
      }

      // Answering open questions is only useful if the part is researched again
      // with that input — so a rerun re-uses this one part's pipeline.
      if (requeued.length) {
        for (const p of requeued) {
          p.status = 'pending';
          p.error = null;
          p.errorDetail = null;
        }
        project.status = 'researching';
        await safeCheckpoint(project);
        await researchBatch(requeued, project, 'human-followup', tracer);
        await safeReconcile(project, tracer);
      }

      if (approved.length) {
        project.state.chat.push({
          role: 'agent',
          content: `✅ Marked **${approved.length}** part(s) verified by you: ${approved.join(', ')}.`,
          ts: new Date().toISOString(),
        });
      }
      if (notApprovable.length) {
        project.state.chat.push({
          role: 'agent',
          content: `⚠ Not approved: **${notApprovable.join(', ')}** — the agent still has open questions on ${
            notApprovable.length === 1 ? 'it' : 'them'
          }, and it won't ask you to verify data it doubts itself. Answer the questions (or re-research) instead.`,
          ts: new Date().toISOString(),
        });
      }
      if (answered.length && !requeued.length) {
        project.state.chat.push({
          role: 'agent',
          content: `Noted for ${answered.join(', ')}. Say “re-research ${answered[0]}” (or use ↻ in the checkpoint card) to fold it in.`,
          ts: new Date().toISOString(),
        });
      }

      await safeCheckpoint(project);
      const finished = await finalize(project, tracer, { summarise: false });
      run.finish(project.status, { approved: approved.length, answered: answered.length });
      return finished;
    } catch (err) {
      const described = describeError(err);
      recordError(project, run.runId, 'respondHuman', err);
      tracer.emit({
        type: 'error',
        stage: 'human',
        where: 'respondHuman',
        fatal: true,
        error: described,
        message: `Could not record your ${decision}: ${described.name}: ${described.message}`,
      });
      run.finish('failed', { error: described.message });
      await safeCheckpoint(project);
      throw withContext(err, { where: 'respondHuman', runId: run.runId });
    }
  }

  // Gap B: resume a stalled/partial run. Stale 'researching' parts (server died
  // mid-flight) and 'failed' parts are re-run; everything else is left alone.
  async function resumeProject(projectId, { emit = () => {} } = {}) {
    const project = await store.get(projectId);
    if (!project) throw Object.assign(new Error('project not found'), { status: 404 });
    const run = beginRun(project, 'resume', emit, {});

    try {
      const resumable = project.state.parts.filter(
        (p) =>
          p.status === 'failed' ||
          p.status === 'pending' ||
          p.status === 'researching' ||
          !p.current?.data,
      );

      if (!resumable.length) {
        run.tracer.emit({
          type: 'batch',
          stage: 'done',
          ok: 0,
          failed: 0,
          total: 0,
          note: 'nothing to resume — every part has data',
          message: 'Nothing to resume — every part has data',
        });
        run.finish(project.status);
        return project;
      }

      for (const p of resumable) {
        p.status = 'pending';
        p.error = null;
        p.errorDetail = null;
      }
      project.status = 'researching';
      project.state.chat.push({
        role: 'agent',
        content: `Resuming ${resumable.length} part(s): ${resumable.map((p) => p.name).join(', ')}.`,
        ts: new Date().toISOString(),
      });
      await safeCheckpoint(project);

      await researchBatch(resumable, project, 'resume', run.tracer);
      await safeReconcile(project, run.tracer);
      const finished = await finalize(project, run.tracer);
      run.finish(project.status);
      return finished;
    } catch (err) {
      const described = describeError(err);
      recordError(project, run.runId, 'resumeProject', err);
      run.tracer.emit({
        type: 'error',
        stage: 'resume',
        where: 'resumeProject',
        fatal: true,
        error: described,
        message: `Resume failed — ${described.name}: ${described.message}`,
      });
      run.finish('failed', { error: described.message });
      await safeCheckpoint(project);
      throw withContext(err, { where: 'resumeProject', runId: run.runId });
    }
  }

  return { runProject, continueProject, resumeProject, respondHuman, buildSummary };
}
