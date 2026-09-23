// The WireGI agent: prompt -> Jev decisions -> parallel research per part ->
// merge into durable IDEA/CURRENT/VERIFIED state -> streamed communication.
import { generateJSON, generate } from './llm.js';
import { makeProject, makePart } from '../models/project.js';
import { researchPart } from './research.js';
import { triagePart, decomposePlan, affectedParts, isSufficient, SAFETY_CRITICAL } from './gate.js';

const SYS_DECOMPOSE = `You decompose a build request into the concrete PARTS needed to actually make it.
Return JSON ONLY: { "classification": string, "domains": [string], "parts": [ { "name": string, "domain": string, "idea": string } ] }.
Cover hardware, firmware/software, tools, and verification. For a drone include: frame, motors, ESC (electronic speed controller), flight controller, propellers, receiver/radio, video system, battery, firmware.`;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function answerValue(a) {
  if (a == null) return null;
  if (typeof a !== 'object') return a;
  if ('value' in a) return a.value;
  if ('probability' in a) return a.probability;
  if ('score' in a) return a.score;
  if ('choice' in a) return a.choice;
  return a;
}
function answerConfidence(a) {
  return a && typeof a === 'object' ? num(a.confidence ?? a.probability ?? a.score) : null;
}
function noulTrue(a) {
  const v = answerValue(a);
  if (typeof v === 'boolean') return v;
  const n = num(v);
  return n != null ? n >= 0.5 : false;
}

export function createAgent({ cfg, registry, jev, store, indexer }) {
  function logDecision(project, label, res) {
    project.state.decisions.push({
      label,
      at: new Date().toISOString(),
      source: res?.source,
      model: res?.model,
      answers: res?.answers ?? res,
    });
  }

  function applyResearch(part, project, result) {
    part.status = result.humanCheckpoint ? 'awaiting_human' : 'data_ready';
    part.current = { gathered: result.gathered, understand: result.understand, data: result.data };
    part.research = result.research;
    part.humanCheckpoint = result.humanCheckpoint;
    part.checklist = result.data?.checklist || [];
    part.openQuestions = result.understand?.openQuestions || [];
    part.updatedAt = new Date().toISOString();
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

  async function researchOne(part, project, emit) {
    emit({ type: 'part', stage: 'start', partId: part.id, part: part.name });

    // Jev gate (Gap 1): decide the cheapest safe research path. Fails safe to LLM.
    const triage = await triagePart({ part, project, indexer, jev, registry });
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

  function buildSummary(project) {
    const lines = [
      `# ${project.goal}`,
      '',
      `Status: **${project.status}**`,
      `Classification: ${project.state.idea.classification || '?'} · Domains: ${(project.state.idea.domains || []).join(', ')}`,
      '',
      '## Parts',
      '',
    ];
    for (const p of project.state.parts) {
      lines.push(`- **${p.name}** (${p.domain}) — ${p.status}${p.humanCheckpoint ? ' · ⚠ needs your eyes' : ''}`);
      if (p.current?.data?.bomRow) lines.push(`    - BOM: ${p.current.data.bomRow}`);
      if (p.current?.data?.wiring) lines.push(`    - Wiring: ${p.current.data.wiring}`);
      if ((p.checklist || []).length) lines.push(`    - Checklist: ${p.checklist.join('; ')}`);
      if ((p.openQuestions || []).length) lines.push(`    - Open: ${p.openQuestions.join('; ')}`);
    }
    return lines.join('\n');
  }

  async function runProject(goal, constraints, { emit = () => {}, prefer } = {}) {
    const project = makeProject({ goal, constraints });

    // D1 — Jev classifies the build and its domains.
    const d1 = await jev.decide(
      {
        state: { operation: 'classify', goal, constraints },
        questions: {
          classification: {
            type: 'choice',
            instructions: 'What kind of build is this?',
            criteria: ['electronics', 'mechanical', 'embedded/MCU', 'software', 'robotics', 'mixed'],
          },
          domains: {
            type: 'choice',
            instructions: 'Which domains does it span? (pick primary)',
            criteria: ['hardware', 'firmware', 'web', 'mechanical', 'robotics', 'mixed'],
          },
        },
      },
      { registry },
    );
    logDecision(project, 'D1 classify', d1);
    emit({ type: 'decision', label: 'D1 classify', answers: d1.answers, source: d1.source });

    // D2/D3 — Jev steers breadth + risk bias; the LLM still writes the parts.
    const plan = await decomposePlan({ goal, constraints, jev, registry });
    emit({
      type: 'decision',
      label: 'D2/D3 decompose-plan',
      answers: plan.usedJev ? { breadth: plan.breadthHint, risk: plan.riskBias } : {},
      source: plan.usedJev ? 'jev' : 'llm-fallback',
    });
    const decomp = await generateJSON({
      registry,
      system: SYS_DECOMPOSE + (plan.breadthHint ? ` Aim for about ${plan.breadthHint} parts.` : '') + plan.riskBias,
      user: `GOAL: ${goal}\nCONSTRAINTS: ${JSON.stringify(constraints)}`,
      temperature: 0.3,
      emit,
      prefer,
    });
    const parts = (decomp.parts || []).map((p) =>
      makePart({ name: p.name, domain: p.domain, idea: { summary: p.idea } }),
    );
    project.state.parts = parts;
    project.state.idea = {
      goal,
      constraints,
      classification: decomp.classification,
      domains: decomp.domains,
      parts: parts.map((p) => ({ name: p.name, domain: p.domain })),
    };
    project.state.current.parts = [];
    await store.create(project);
    emit({
      type: 'project',
      stage: 'decomposed',
      projectId: project.id,
      parts: parts.map((p) => ({ id: p.id, name: p.name, domain: p.domain })),
    });

    // Parallel research -> gather -> understand -> data for each part.
    await Promise.all(parts.map((p) => researchOne(p, project, emit)));
    await store.save(project);

    // D4/D5/D6 — completion gate, human-eyes gate, stop condition.
    const dCheck = await jev.decide(
      {
        state: {
          operation: 'verify',
          goal,
          parts: project.state.current.parts.map((p) => ({
            name: p.name,
            hasData: !!p.data,
            humanCheckpoint: p.humanCheckpoint,
          })),
        },
        questions: {
          complete: {
            type: 'noul',
            instructions: "Is every part's gathered data complete and conflict-free enough to start building?",
          },
          needsHuman: {
            type: 'noul',
            instructions: 'Does any part REQUIRE human eyes (soldering/eyeball confirmation) before it is verified?',
          },
          done: {
            type: 'noul',
            instructions: 'Is CURRENT state effectively equal to IDEA state for all verified parts? This is the stop condition.',
          },
        },
      },
      { registry },
    );
    logDecision(project, 'D4-D6 verify', dCheck);
    emit({ type: 'decision', label: 'D4-D6 verify', answers: dCheck.answers, source: dCheck.source });

    project.status = project.state.current.parts.some((p) => p.humanCheckpoint) ? 'awaiting_human' : 'complete';
    if (noulTrue(dCheck.answers?.done)) project.status = 'complete';
    project.state.chat.push({ role: 'agent', content: buildSummary(project), ts: new Date().toISOString() });
    await store.save(project);
    emit({ type: 'done', projectId: project.id, status: project.status, summary: buildSummary(project) });
    return project;
  }

  async function continueProject(projectId, text, { emit = () => {}, prefer } = {}) {
    const project = await store.get(projectId);
    if (!project) throw Object.assign(new Error('project not found'), { status: 404 });
    project.state.chat.push({ role: 'user', content: text, ts: new Date().toISOString() });
    emit({ type: 'chat', role: 'user', content: text });

    const partNames = project.state.parts.map((p) => p.name);
    const dMsg = await jev.decide(
      {
        state: {
          operation: 'message',
          goal: project.goal,
          text,
          parts: project.state.parts.map((p) => ({ name: p.name, status: p.status })),
        },
        questions: {
          intent: {
            type: 'choice',
            instructions: 'What is the user doing with this message?',
            criteria: ['approve', 'add_constraint', 'revise_part', 'ask', 'other'],
          },
          target: {
            type: 'choice',
            instructions: 'Which part is the message about (if any)?',
            criteria: ['all', 'none', ...partNames],
          },
        },
      },
      { registry },
    );
    logDecision(project, 'message', dMsg);
    emit({ type: 'decision', label: 'message', answers: dMsg.answers, source: dMsg.source });

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
          if (!project.state.verified.parts.find((x) => x.id === p.id)) {
            project.state.verified.parts.push({ id: p.id, name: p.name });
          }
        }
      }
      project.status = project.state.parts.every((p) => p.verified) ? 'complete' : 'awaiting_human';
      project.state.chat.push({
        role: 'agent',
        content: `Marked ${targets.filter((p) => p.verified).length} part(s) as verified. Status: ${project.status}.`,
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
      // T5 — only re-research parts the change actually touches (+ always safety-critical).
      const affected = await affectedParts({ project, text, jev, registry });
      const safetyIds = project.state.parts
        .filter((p) => SAFETY_CRITICAL.test(p.name) || SAFETY_CRITICAL.test(p.domain || ''))
        .map((p) => p.id);
      const ids = [...new Set([...affected, ...safetyIds])];
      for (const p of project.state.parts) if (ids.includes(p.id)) await researchOne(p, project, emit);
      project.status = project.state.current.parts.some((p) => p.humanCheckpoint) ? 'awaiting_human' : 'complete';
      project.state.chat.push({
        role: 'agent',
        content: 'Updated constraints and re-ran research for all parts. Status: ' + project.status + '.',
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

    await store.save(project);
    emit({ type: 'done', projectId: project.id, status: project.status, summary: buildSummary(project) });
    return project;
  }

  return { runProject, continueProject, buildSummary };
}
