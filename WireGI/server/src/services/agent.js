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
import { generateJSON, generate } from './llm.js';
import { makeProject, makePart } from '../models/project.js';
import { researchPart } from './research.js';
import { triagePart, decomposePlan, affectedParts, isSufficient } from './gate.js';
import { choice, noul, answerValue, noulTrue } from './jevQuestions.js';
import { pickProfile, getProfile, isSafetyCritical } from './profiles.js';
import { reconcileProject } from './reconcile.js';
import { mapWithConcurrency, withProviderSlot, CONCURRENCY } from './queue.js';
import { withRetry } from './retry.js';

const SYS_DECOMPOSE = `You decompose a build request into the concrete PARTS needed to actually make it.
Return JSON ONLY: { "classification": string, "domains": [string], "parts": [ { "name": string, "domain": string, "idea": string } ] }.
Cover hardware, firmware/software, tools, and verification. For a drone include: frame, motors, ESC (electronic speed controller), flight controller, propellers, receiver/radio, video system, battery, firmware.`;



export function createAgent({ cfg, registry, jev, store, indexer }) {
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
  async function safeDecide(emit, project, label, { state, questions }, fallback = {}) {
    try {
      const res = await jev.decide({ state, questions }, { registry });
      logDecision(project, label, res);
      emit({ type: 'decision', label, answers: res.answers, source: res.source });
      return res;
    } catch (err) {
      const res = { source: 'unavailable', answers: fallback, note: err?.message || String(err) };
      logDecision(project, label, res);
      emit({
        type: 'decision',
        label,
        answers: fallback,
        source: 'unavailable',
      });
      emit({
        type: 'research',
        stage: 'gate',
        part: '(decision)',
        message: `${label} unavailable — continuing with safe defaults (${err?.message || 'error'})`,
      });
      return res;
    }
  }

  function applyResearch(part, project, result) {
    part.status = result.humanCheckpoint ? 'awaiting_human' : 'data_ready';
    part.current = { gathered: result.gathered, understand: result.understand, data: result.data };
    part.research = result.research;
    part.humanCheckpoint = result.humanCheckpoint;
    part.checklist = result.data?.checklist || [];
    part.openQuestions = result.understand?.openQuestions || [];
    part.error = null;
    part.updatedAt = new Date().toISOString();

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
    };
    if (existing) Object.assign(existing, entry);
    else project.state.current.parts.push(entry);
    project.state.researchLog.push({ part: part.name, web: result.web, ts: part.updatedAt });
  }

  // One part's research pass (Jev gate + research pipeline). May throw; the
  // caller (runPart) owns retries and failure isolation.
  async function researchOne(part, project, emit) {
    const profile = getProfile(project.profileId);

    // Jev gate (Gap 1): decide the cheapest safe research path. Fails safe to LLM.
    // Guards are profile-defined, so "safety-critical" means the right thing per domain.
    const triage = await triagePart({ part, project, indexer, jev, registry, profile });
    emit({
      type: 'research',
      stage: 'gate',
      partId: part.id,
      part: part.name,
      message: `Gate (${triage.usedJev ? 'Jev' : 'LLM-fallback'}): ${triage.action} — ${triage.reason}`,
    });

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
        };
        applyResearch(part, project, result);
        emit({
          type: 'part',
          stage: 'done',
          partId: part.id,
          part: part.name,
          data: result.data,
          humanCheckpoint: result.humanCheckpoint,
          note: 'reused from ' + src.name,
        });
        return result;
      }
      // fall through to a full pass if no source was found
    }

    // skip → offload trivial part to the human (0 LLM call).
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
        humanCheckpoint: true,
        web: { engine: 'skip', count: 0 },
      };
      applyResearch(part, project, result);
      emit({
        type: 'part',
        stage: 'done',
        partId: part.id,
        part: part.name,
        data: result.data,
        humanCheckpoint: true,
        note: 'skipped (trivial) — needs your input',
      });
      return result;
    }

    // light → cheaper model; full → full model.
    const prefer = triage.action === 'light' ? triage.prefer : undefined;
    const result = await researchPart({ part, project, registry, emit, indexer, prefer });
    applyResearch(part, project, result);

    // T4 sufficiency → push to human instead of an auto-repair LLM call.
    if (!(await isSufficient({ part, project, jev, registry }))) {
      part.humanCheckpoint = true;
      if (part.status === 'data_ready') part.status = 'awaiting_human';
      part.openQuestions = [
        ...(part.openQuestions || []),
        'Jev flagged gathered data as insufficient — please verify/refine.',
      ];
    }
    emit({
      type: 'part',
      stage: 'done',
      partId: part.id,
      part: part.name,
      data: result.data,
      humanCheckpoint: part.humanCheckpoint,
    });
    return result;
  }

  // Gap B: one part, fully isolated. Never throws. Retries transient provider
  // failures with backoff, checkpoints progress, and leaves a terminal status.
  async function runPart(part, project, emit) {
    part.status = 'researching';
    part.attempts = (part.attempts || 0) + 1;
    part.error = null;
    emit({ type: 'part', stage: 'start', partId: part.id, part: part.name });

    try {
      await withRetry(() => researchOne(part, project, emit), {
        onRetry: ({ attempt, retries, waitMs, error }) => {
          emit({
            type: 'retry',
            partId: part.id,
            part: part.name,
            attempt,
            retries,
            waitMs,
            message: `Retry ${attempt}/${retries} for ${part.name} in ${waitMs}ms — ${error?.message || error}`,
          });
        },
      });
      if (part.status === 'researching') part.status = 'data_ready';
      part.error = null;
      part.updatedAt = new Date().toISOString();
      await safeCheckpoint(project);
      return true;
    } catch (err) {
      part.status = 'failed';
      part.error = err?.message || String(err);
      part.updatedAt = new Date().toISOString();
      project.state.researchLog.push({
        part: part.name,
        web: { engine: 'failed', count: 0 },
        ts: part.updatedAt,
        error: part.error,
      });
      emit({
        type: 'part',
        stage: 'failed',
        partId: part.id,
        part: part.name,
        error: part.error,
        note: 'part failed — siblings continue; resume to retry',
      });
      await safeCheckpoint(project);
      return false;
    }
  }

  function buildSummary(project) {
    const profile = getProfile(project.profileId);
    const lines = [
      `# ${project.goal}`,
      '',
      `Status: **${project.status}**`,
      `Classification: ${project.state.idea.classification || '?'} · Domains: ${(project.state.idea.domains || []).join(', ')}`,
      `Profile: **${profile.label}** · verification ladder: ${profile.ladder.join(' → ')}`,
      '',
      '## Parts',
      '',
    ];
    for (const p of project.state.parts) {
      lines.push(
        `- **${p.name}** (${p.domain}) — ${p.status}${p.humanCheckpoint ? ' · ⚠ needs your eyes' : ''}${
          p.error ? ` · ✖ ${p.error}` : ''
        }`,
      );
      if (p.current?.data?.bomRow) lines.push(`    - BOM: ${p.current.data.bomRow}`);
      if (p.current?.data?.wiring) lines.push(`    - Wiring: ${p.current.data.wiring}`);
      if ((p.checklist || []).length) lines.push(`    - Checklist: ${p.checklist.join('; ')}`);
      if ((p.openQuestions || []).length) lines.push(`    - Open: ${p.openQuestions.join('; ')}`);
    }
    const failed = project.state.parts.filter((p) => p.status === 'failed');
    if (failed.length) {
      lines.push('', `## Needs a resume`, '', `Failed parts: ${failed.map((p) => p.name).join(', ')}`);
    }

    // Integration: did the parts agree with each other?
    for (const r of project.state.reconciliations || []) {
      if (r.skipped) continue;
      if (r.failed) {
        lines.push('', `## Integration`, '', `Failed: ${r.reason}`);
        continue;
      }
      lines.push('', `## Integration`, '', `${r.coherent ? '✅ coherent' : '⚠ conflicts found'} — ${r.summary || ''}`);
      for (const c of r.conflicts || []) {
        lines.push(`  - [${c.severity}] ${(c.parts || []).join(' ↔ ')}: ${c.issue}`);
        if (c.resolution) lines.push(`      → ${c.resolution}`);
      }
    }
    return lines.join('\n');
  }

  // D4/D5/D6 gate + status resolution + summary + durable save. Shared by
  // runProject, continueProject and resumeProject.
  async function finalize(project, emit, { summarise = true } = {}) {
    const parts = project.state.parts;
    const failed = parts.filter((p) => p.status === 'failed');
    const pending = parts.filter((p) => p.status === 'pending' || p.status === 'researching');
    const unverifiedHumanGates = parts.filter((p) => p.humanCheckpoint && !p.verified);

    let dCheck = null;
    try {
      dCheck = await jev.decide(
        {
          state: {
            operation: 'verify',
            goal: project.goal,
            parts: project.state.current.parts.map((p) => ({
              name: p.name,
              hasData: !!p.data,
              humanCheckpoint: p.humanCheckpoint,
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
      emit({ type: 'decision', label: 'D4-D6 verify', answers: dCheck.answers, source: dCheck.source });
    } catch (err) {
      // The verify gate must never sink a finished build — fall back to computed status.
      emit({
        type: 'research',
        stage: 'gate',
        part: '(verify)',
        message: 'D4-D6 gate unavailable — using computed status (' + (err?.message || 'error') + ')',
      });
    }

    // The ladder's top rung is human, and the decision model gets to insist on
    // it: if Jev says a human MUST look, the project cannot be "complete".
    const decisionWantsHuman = noulTrue(dCheck?.answers?.needsHuman);
    const blockingConflicts = (project.state.reconciliations || []).some(
      (r) => !r.skipped && (r.conflicts || []).some((c) => c.severity === 'blocking'),
    );

    let status;
    if (failed.length || pending.length) status = 'partial';
    else if (unverifiedHumanGates.length || decisionWantsHuman || blockingConflicts)
      status = 'awaiting_human';
    else status = noulTrue(dCheck?.answers?.done) ? 'complete' : 'awaiting_human';
    project.status = status;

    if (summarise) {
      project.state.chat.push({ role: 'agent', content: buildSummary(project), ts: new Date().toISOString() });
    }
    await safeCheckpoint(project);
    emit({ type: 'done', projectId: project.id, status: project.status, summary: buildSummary(project) });
    return project;
  }

  // Cross-part integration. Never fatal: if it fails, the parts are still
  // useful and the failure is recorded rather than thrown.
  async function safeReconcile(project, emit) {
    try {
      const entry = await reconcileProject({ project, emit, registry, jev });
      await safeCheckpoint(project);
      return entry;
    } catch (err) {
      emit({
        type: 'reconcile',
        stage: 'failed',
        reason: err?.message || String(err),
      });
      project.state.reconciliations = [
        ...(project.state.reconciliations || []),
        { at: new Date().toISOString(), failed: true, reason: err?.message || String(err) },
      ];
      await safeCheckpoint(project);
      return null;
    }
  }

  // Bounded, isolated, checkpointed research pass over a set of parts.
  async function researchBatch(parts, project, emit, note) {
    if (!parts.length) return { ok: 0, failed: 0, total: 0 };
    emit({ type: 'batch', stage: 'start', total: parts.length, concurrency: CONCURRENCY, note });
    const outcomes = await mapWithConcurrency(parts, CONCURRENCY, (p) =>
      withProviderSlot(() => runPart(p, project, emit)),
    );
    const ok = outcomes.filter(Boolean).length;
    const failedCount = outcomes.filter((o) => !o).length;
    emit({ type: 'batch', stage: 'done', ok, failed: failedCount, total: parts.length, note });
    return { ok, failed: failedCount, total: parts.length };
  }

  async function runProject(goal, constraints, { emit = () => {}, prefer } = {}) {
    const project = makeProject({ goal, constraints });

    // D1 — Jev classifies the build and its domains.
    // choice criteria MUST be a dict { key: description }; a bare array is
    // rejected by the API with a 422. Builders live in services/jevQuestions.js.
    const d1 = await safeDecide(emit, project, 'D1 classify', {
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

    // D2/D3 — Jev steers breadth + risk bias; the LLM still writes the parts.
    const plan = await decomposePlan({ goal, constraints, jev, registry });
    emit({
      type: 'decision',
      label: 'D2/D3 decompose-plan',
      answers: plan.usedJev ? { breadth: plan.breadthHint, risk: plan.riskBias } : {},
      source: plan.usedJev ? 'jev' : 'llm-fallback',
    });
    // Domain profile: chosen from Jev's classification + the goal text. It
    // decides the research schema, the guards and the verification ladder —
    // i.e. it is what lets one engine build a drone OR an app.
    const preProfile = pickProfile(answerValue(d1.answers?.classification), [], goal);
    emit({ type: 'project', stage: 'profile', profileId: preProfile.id, label: preProfile.label });

    const decomp = await generateJSON({
      registry,
      system:
        SYS_DECOMPOSE +
        `\nDomain guidance (${preProfile.label}): ${preProfile.decompose}` +
        (plan.breadthHint ? ` Aim for about ${plan.breadthHint} parts.` : '') +
        plan.riskBias,
      user: `GOAL: ${goal}\nCONSTRAINTS: ${JSON.stringify(constraints)}`,
      temperature: 0.3,
      emit,
      prefer,
    });

    // Now that the LLM has read the goal, re-pick with its classification too.
    const profile = pickProfile(
      decomp.classification || answerValue(d1.answers?.classification),
      decomp.domains,
      goal,
    );

    const parts = (decomp.parts || []).map((p) =>
      makePart({ name: p.name, domain: p.domain, idea: { summary: p.idea } }),
    );
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
    await store.create(project);
    emit({
      type: 'project',
      stage: 'decomposed',
      projectId: project.id,
      profileId: profile.id,
      profileLabel: profile.label,
      ladder: profile.ladder,
      parts: parts.map((p) => ({ id: p.id, name: p.name, domain: p.domain })),
    });

    // Bounded concurrency, per-part isolation, per-part checkpoint.
    await researchBatch(parts, project, emit, 'initial');

    // Reassembly: make the independently-researched parts agree.
    await safeReconcile(project, emit);
    return finalize(project, emit);
  }

  async function continueProject(projectId, text, { emit = () => {}, prefer } = {}) {
    const project = await store.get(projectId);
    if (!project) throw Object.assign(new Error('project not found'), { status: 404 });
    project.state.chat.push({ role: 'user', content: text, ts: new Date().toISOString() });
    emit({ type: 'chat', role: 'user', content: text });

    const partNames = project.state.parts.map((p) => p.name);
    const dMsg = await safeDecide(
      emit,
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

    if (intent === 'approve') {
      const targets =
        target && target !== 'none' && target !== 'all'
          ? project.state.parts.filter((p) => p.name.toLowerCase().includes(String(target).toLowerCase()))
          : project.state.parts;
      for (const p of targets) {
        if (p.current?.data) {
          p.verified = true;
          p.status = 'verified';
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
        content: `Marked ${targets.filter((p) => p.verified).length} part(s) as verified.`,
        ts: new Date().toISOString(),
      });
    } else if (intent === 'add_constraint' || intent === 'revise_part') {
      const extracted = await generateJSON({
        registry,
        system:
          'Extract updated constraints from the user message. Return JSON: { "constraints": { <key>: <value> } }. Only include keys the user actually changed or added.',
        user: `GOAL: ${project.goal}\nCURRENT CONSTRAINTS: ${JSON.stringify(project.constraints)}\nUSER MESSAGE: ${text}`,
        emit,
        prefer,
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
      await safeCheckpoint(project);
      await researchBatch(targets, project, emit, 'constraint-change');

      // Constraints changed → specs may no longer agree. Re-integrate.
      await safeReconcile(project, emit);

      project.state.chat.push({
        role: 'agent',
        content: `Updated constraints (IDEA revision ${project.state.idea.revisions.length}) and re-ran research for ${targets.length} part(s).`,
        ts: new Date().toISOString(),
      });
    } else {
      const reply = await generate({
        registry,
        system:
          'You are WireGI, an agentic build assistant. Answer the user using the project state. Be concise. Ask clarifying questions if needed.',
        user: `GOAL: ${project.goal}\nCONSTRAINTS: ${JSON.stringify(project.constraints)}\nPARTS:\n${project.state.parts
          .map((p) => `- ${p.name} (${p.status}): ${p.current?.data?.bomRow || ''}`)
          .join('\n')}\nUSER: ${text}`,
        emit,
        prefer,
      });
      project.state.chat.push({ role: 'agent', content: reply, ts: new Date().toISOString() });
    }

    return finalize(project, emit, { summarise: false });
  }

  // Gap B: resume a stalled/partial run. Stale 'researching' parts (server died
  // mid-flight) and 'failed' parts are re-run; everything else is left alone.
  async function resumeProject(projectId, { emit = () => {} } = {}) {
    const project = await store.get(projectId);
    if (!project) throw Object.assign(new Error('project not found'), { status: 404 });

    const resumable = project.state.parts.filter(
      (p) =>
        p.status === 'failed' ||
        p.status === 'pending' ||
        p.status === 'researching' ||
        !p.current?.data,
    );

    if (!resumable.length) {
      emit({
        type: 'batch',
        stage: 'done',
        ok: 0,
        failed: 0,
        total: 0,
        note: 'nothing to resume — every part has data',
      });
      return project;
    }

    for (const p of resumable) {
      p.status = 'pending';
      p.error = null;
    }
    project.status = 'researching';
    project.state.chat.push({
      role: 'agent',
      content: `Resuming ${resumable.length} part(s): ${resumable.map((p) => p.name).join(', ')}.`,
      ts: new Date().toISOString(),
    });
    await safeCheckpoint(project);

    await researchBatch(resumable, project, emit, 'resume');
    await safeReconcile(project, emit);
    return finalize(project, emit);
  }

  return { runProject, continueProject, resumeProject, buildSummary };
}
