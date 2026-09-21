// Forge — Jev decision catalog (chat-first + legacy J1-J10).
// Human is a tool: JEV decides when to call human, what to ask, and whether human's report counts.

const r2 = (x) => Math.round(x * 100) / 100;
const choice = (a, id) => a?.[id]?.choice;
const noul = (a, id) => a?.[id]?.noul ?? 0.5;
const score = (a, id) => a?.[id]?.score ?? 0;
const certainty = (p) => Math.max(p, 1 - p);

export const DECISIONS = {
  // ── CHAT: Intent detection (first gate in chat loop) ──────────────────────
  CHAT_INTENT: {
    name: 'Chat intent',
    questions({ message, hasProject }) {
      return {
        chat_intent: {
          type: 'choice',
          instructions: `Classify this chat message: "${message}". Context: ${hasProject ? 'a build plan already exists' : 'no plan yet, fresh conversation'}.`,
          criteria: {
            build_request: 'User wants to build something new (e.g. "I wanna build X", "make me a Y")',
            question: 'User asks a question about the build, plan, parts, or technique',
            status_update: 'User reports progress on a physical step (done, failed, have part, etc)',
            human_tool_result: 'User is responding to a human tool call (completing a requested physical action)',
            claim_done: 'User claims the whole project is finished',
            scope_change: 'User wants to change the goal or plan',
            general: 'General chat, greeting, or off-topic',
          },
        },
        needs_plan: {
          type: 'noul',
          instructions: `Does the message "${message}" require creating a new implementation plan?`,
        },
        frustration: {
          type: 'score',
          instructions: 'How frustrated or stuck is the user?',
          criteria: ['On track', 'Minor friction', 'Stuck, needs help', 'Overwhelmed'],
        },
      };
    },
    verdict(a) {
      const intent = choice(a, 'chat_intent') ?? 'general';
      const intentConf = a?.chat_intent?.confidence ?? 0;
      const needsPlan = noul(a, 'needs_plan');
      const frust = score(a, 'frustration');
      return {
        kind: 'chat_intent',
        summary: `intent=${intent} (conf ${r2(intentConf)}) · needs_plan=${needsPlan >= 0.5} · frustration=${r2(frust)}/3`,
        confidence: intentConf,
        intent,
        intent_confidence: intentConf,
        needs_plan: needsPlan >= 0.5,
        frustration: frust,
      };
    },
  },

  // ── CHAT: Goal extraction confidence ──────────────────────────────────────
  GOAL_PARSE: {
    name: 'Goal parsing',
    questions({ message }) {
      return {
        goal_clear: {
          type: 'noul',
          instructions: `Is the build goal clearly stated in: "${message}"? A clear goal names what to build.`,
        },
        goal_specificity: {
          type: 'score',
          instructions: `How specific is the build goal in "${message}"?`,
          criteria: ['Vague (build something cool)', 'Somewhat specific (build a lamp)', 'Specific (build an MP3 player with ESP32)', 'Very detailed with specs'],
        },
      };
    },
    verdict(a) {
      const clear = noul(a, 'goal_clear');
      const spec = score(a, 'goal_specificity');
      return {
        kind: 'goal_parse',
        summary: `goal_clear=${clear >= 0.5} (p=${r2(clear)}) · specificity=${r2(spec)}/3`,
        confidence: certainty(clear),
        clear: clear >= 0.5,
        specificity: spec,
        certainty: certainty(clear),
      };
    },
  },

  // ── J1 · Feasibility gate (intake, once per project) ─────────────────────
  J1: {
    name: 'Feasibility gate',
    questions({ goal }) {
      return {
        category: {
          type: 'choice',
          instructions: `Which category best fits this build goal: "${goal}"?`,
          criteria: {
            electronics: 'Circuits, boards, soldering, firmware, sensors, power',
            mechanical: 'Frames, cutting, joining, structural parts',
            robotics: 'Moving machines combining electronics and mechanics',
            software: 'Primarily code, no physical build',
            woodwork: 'Wood joinery and furniture',
            craft: 'Textiles, sewing, soft goods',
            food: 'Cooked or baked result',
            general: 'Does not clearly fit the above',
          },
        },
        buildability: {
          type: 'choice',
          instructions: 'Is this build practical for a capable builder with tools and parts access?',
          criteria: {
            yes: 'Practical and well-scoped',
            yes_caveats: 'Buildable but needs design choices, sourcing, or safety care',
            no: 'Not practical, not safe, or effectively impossible to build as stated',
          },
        },
        risky: {
          type: 'noul',
          instructions: 'Does this build involve serious hazards (sharp tools, open flames, mains voltage, chemicals, pressurized parts) that require explicit safety steps?',
        },
        complexity: {
          type: 'score',
          instructions: 'How much total effort does this build represent?',
          criteria: ['Weekend project', 'Multi-day project', 'Multi-week project', 'Major project'],
        },
        budget: {
          type: 'score',
          instructions: 'Realistic parts budget for this build?',
          criteria: ['Under $25', '$25–$100', '$100–$500', '$500+'],
        },
      };
    },
    verdict(a) {
      const cat = choice(a, 'category') ?? 'general';
      const build = choice(a, 'buildability') ?? 'yes_caveats';
      const risky = noul(a, 'risky');
      const cx = score(a, 'complexity');
      const risk_tier = risky >= 0.5 ? 'high' : cx >= 1.5 ? 'medium' : 'low';
      return {
        kind: 'feasibility',
        summary: `category=${cat} · buildability=${build} · risk=${risk_tier} · complexity=${r2(cx)}/3`,
        confidence: a?.buildability?.confidence ?? 0,
        category: cat,
        buildability: build,
        risk_tier,
        complexity: cx,
        budget: score(a, 'budget'),
      };
    },
  },

  // ── J2 · Message triage (hot path — every human message) ─────────────────
  J2: {
    name: 'Message triage',
    questions({ stepRef, message }) {
      const stepDesc = stepRef?.step
        ? `"${stepRef.step.title}" (step ${stepRef.index + 1}/${stepRef.total})`
        : '(none — all steps complete)';
      return {
        intent: {
          type: 'choice',
          instructions: `Classify this builder message about the current step ${stepDesc}: "${message}"`,
          criteria: {
            step_done: 'Reports the current step was completed',
            step_failed: 'Reports the current step failed or the result is bad',
            question: 'Asks a question about the build',
            deviation: 'Reports doing something different than instructed',
            substitute_request: 'States they lack a part and have (or need) a different one',
            scope_change: 'Wants to change the goal or plan',
            claim_done: 'Claims the whole project is finished',
            blocked: 'Cannot continue and needs help',
            off_topic: 'Unrelated to the build',
          },
        },
        safety_concern: {
          type: 'noul',
          instructions: 'Does the message describe a safety incident or concern (burn, spark, shock, smoke, damage, injury)?',
        },
        frustration: {
          type: 'score',
          instructions: 'How frustrated is the builder right now?',
          criteria: ['On track, no friction', 'Minor friction', 'Stuck, needs help', 'Overwhelmed, plan may not fit'],
        },
      };
    },
    verdict(a) {
      const intent = choice(a, 'intent') ?? 'question';
      const intentConf = a?.intent?.confidence ?? 0;
      const safety = noul(a, 'safety_concern');
      const frustration = score(a, 'frustration');
      return {
        kind: 'triage',
        summary: `intent=${intent} (conf ${r2(intentConf)}) · safety_concern=${safety >= 0.5} · frustration=${r2(frustration)}/3`,
        confidence: intentConf,
        intent,
        intent_confidence: intentConf,
        safety_concern: safety,
        frustration,
      };
    },
  },

  // ── HUMAN TOOL: Should we call human? ─────────────────────────────────────
  HUMAN_TOOL: {
    name: 'Human tool decision',
    questions({ stepRef, message, hasPendingHuman }) {
      const stepDesc = stepRef?.step ? `"${stepRef.step.title}" (${stepRef.step.track})` : 'no active step';
      return {
        call_human: {
          type: 'noul',
          instructions: `Given current step ${stepDesc} and message "${message}", should we call the human tool to execute a physical action? Pending human calls: ${hasPendingHuman ? 'yes' : 'no'}.`,
        },
        human_task_complexity: {
          type: 'score',
          instructions: `How complex is the human task for step ${stepDesc}?`,
          criteria: ['Trivial (seconds)', 'Simple (minutes)', 'Involved (hour)', 'Major (hours)'],
        },
        needs_clarification: {
          type: 'noul',
          instructions: `Does the agent need clarification from human before proceeding with "${message}"?`,
        },
      };
    },
    verdict(a) {
      const call = noul(a, 'call_human');
      const complexity = score(a, 'human_task_complexity');
      const clarify = noul(a, 'needs_clarification');
      return {
        kind: 'human_tool',
        summary: `call_human=${call >= 0.5} (p=${r2(call)}) · complexity=${r2(complexity)}/3 · needs_clarify=${clarify >= 0.5}`,
        confidence: certainty(call),
        call_human: call >= 0.5,
        complexity,
        needs_clarification: clarify >= 0.5,
      };
    },
  },

  // ── J3 · Step verification (on "done" reports) ───────────────────────────
  J3: {
    name: 'Step verification',
    questions({ stepRef, message }) {
      const dod = (stepRef?.step?.definition_of_done || ['the step being complete'])
        .map((d, i) => `(${i + 1}) ${d}`)
        .join('; ');
      return {
        verified: {
          type: 'noul',
          instructions: `The step "${stepRef?.step?.title ?? ''}" is done when: ${dod}. Given the builder's report "${message}", was the step completed correctly?`,
        },
        quality: {
          type: 'score',
          instructions: 'Quality of the reported result for this step?',
          criteria: ['Does not meet the definition of done', 'Acceptable, minor flaws', 'Good', 'Excellent'],
        },
      };
    },
    verdict(a) {
      const p = noul(a, 'verified');
      const certaintyP = certainty(p);
      const quality = score(a, 'quality');
      return {
        kind: 'verify',
        summary: `verified=${p >= 0.5} (p=${r2(p)}, certainty ${r2(certaintyP)}) · quality=${r2(quality)}/3`,
        confidence: certaintyP,
        verified: p >= 0.5,
        certainty: certaintyP,
        quality,
      };
    },
  },

  // ── J4 · Substitute matching ──────────────────────────────────────────────
  J4: {
    name: 'Substitute matching',
    questions({ substitution }) {
      const q = {};
      (substitution?.items || []).slice(0, 12).forEach((it, i) => {
        q[`valid_sub_${i}`] = {
          type: 'noul',
          instructions: `Given the missing part "${substitution?.need ?? ''}", is "${it.name}${it.note ? ` (${it.note})` : ''}" a valid substitute?`,
        };
        q[`compat_${i}`] = {
          type: 'score',
          instructions: `How well does "${it.name}" substitute for "${substitution?.need ?? ''}"?`,
          criteria: ['Incompatible', 'Works with changes', 'Drop-in equivalent'],
        };
      });
      return q;
    },
    verdict(a, ctx) {
      const items = (ctx.substitution?.items || []).slice(0, 12);
      let best = null;
      items.forEach((it, i) => {
        const p = noul(a, `valid_sub_${i}`);
        const compat = score(a, `compat_${i}`);
        const cert = certainty(p);
        if (p >= 0.55 && (!best || cert + compat > best.cert + best.compatibility)) {
          best = { item: it, compatibility: compat, probability: p, cert: cert + compat };
        }
      });
      return {
        kind: 'substitution',
        summary: best
          ? `best="${best.item.name}" for "${ctx.substitution?.need}" (p=${r2(best.probability)}, compat ${r2(best.compatibility)}/2)`
          : `no valid substitute found for "${ctx.substitution?.need}"`,
        confidence: best ? certainty(best.probability) : 0,
        best,
      };
    },
  },

  // ── J6 · Safety interlock ─────────────────────────────────────────────────
  J6: {
    name: 'Safety interlock',
    questions({ stepRef }) {
      const q = {};
      (stepRef?.step?.safety || []).slice(0, 6).forEach((s, i) => {
        q[`hazard_${i}`] = {
          type: 'noul',
          instructions: `Before starting the step "${stepRef?.step?.title ?? ''}", must the builder be warned about: ${s.note || s.hazard} (risk class: ${s.hazard})?`,
        };
      });
      return q;
    },
    verdict(a, ctx) {
      const flags = (ctx.stepRef?.step?.safety || []).map((s, i) => {
        const p = noul(a, `hazard_${i}`);
        return { hazard: s.hazard, severity: s.severity, note: s.note, present: p >= 0.5, probability: p };
      });
      const ackRequired = flags.some((f) => f.present && f.severity === 'high');
      return {
        kind: 'safety_gate',
        summary: ackRequired
          ? `ack required: ${flags.filter((f) => f.present && f.severity === 'high').map((f) => f.note || f.hazard).join(', ')}`
          : `no high-severity hazards for this step`,
        confidence: flags.length ? Math.min(...flags.map((f) => certainty(f.probability))) : 1,
        flags,
        ackRequired,
      };
    },
  },

  // ── J8 · Speculative fan-out ──────────────────────────────────────────────
  J8: {
    name: 'Speculative fan-out',
    questions() {
      return {
        next_inventory: {
          type: 'noul',
          instructions: 'Should the builder be prompted to add parts they already have to inventory?',
        },
        next_check: {
          type: 'noul',
          instructions: 'Before next step, does build need a verification checkpoint?',
        },
        next_question: {
          type: 'noul',
          instructions: 'Does builder appear to have an unanswered question?',
        },
      };
    },
    verdict(a) {
      const suggestions = [
        noul(a, 'next_inventory') >= 0.55 ? 'Add the parts you already have to your inventory — it powers substitute matching.' : null,
        noul(a, 'next_check') >= 0.55 ? 'Run a quick checkpoint check before moving on.' : null,
        noul(a, 'next_question') >= 0.55 ? 'Ask me anything about this step.' : null,
      ].filter(Boolean);
      return {
        kind: 'fanout',
        summary: `${suggestions.length} suggestion(s) from 3 probes`,
        confidence: 1,
        suggestions,
      };
    },
  },

  // ── J9 · Completion acceptance ────────────────────────────────────────────
  J9: {
    name: 'Completion acceptance',
    questions({ state }) {
      const q = {};
      (state?.acceptance || []).slice(0, 8).forEach((c, i) => {
        q[`accept_${i}`] = {
          type: 'noul',
          instructions: `Does finished project satisfy: "${c}"?`,
        };
      });
      return q;
    },
    verdict(a, ctx) {
      const criteria = (ctx.state?.acceptance || []).slice(0, 8);
      const results = criteria.map((c, i) => {
        const p = noul(a, `accept_${i}`);
        return { criterion: c, met: p >= 0.5, certainty: certainty(p) };
      });
      const allMet = results.length > 0 && results.every((r) => r.met && r.certainty >= 0.8);
      const metCount = results.filter((r) => r.met).length;
      return {
        kind: 'acceptance',
        summary: `acceptance ${metCount}/${results.length} criteria met (all require certainty ≥ 0.8)`,
        confidence: results.length ? Math.min(...results.map((r) => r.certainty)) : 0,
        results,
        allMet,
      };
    },
  },

  // ── J10 · Plan difficulty match ───────────────────────────────────────────
  J10: {
    name: 'Plan difficulty match',
    questions({ message }) {
      return {
        difficulty: {
          type: 'score',
          instructions: `Builder message: "${message}". How well does current plan difficulty match skill?`,
          criteria: ['Right level', 'Slightly hard', 'Too hard', 'Over my head'],
        },
      };
    },
    verdict(a) {
      const level = score(a, 'difficulty');
      return {
        kind: 'difficulty',
        summary: `difficulty=${r2(level)}/3`,
        confidence: a?.difficulty?.confidence ?? 0,
        level,
      };
    },
  },
};

// Run one decision: build questions → one batched Jev call → verdict.
export async function runDecision(id, ctx, deps) {
  const d = DECISIONS[id];
  if (!d) throw new Error(`unknown decision: ${id}`);
  const questions = d.questions(ctx);
  const res = await deps.jev({ state: ctx.jevState ?? {}, questions });
  const v = d.verdict(res.answers, ctx);
  if (deps.counters) deps.counters.jevCalls += 1;
  if (deps.conversationCounters) deps.conversationCounters.jevCalls += 1;
  return { id, name: d.name, kind: v.kind, summary: v.summary, confidence: v.confidence, detail: v };
}
