// Reconciliation — the reassembly pass.
//
// Parts are researched independently and in parallel. That is fast, and it is
// exactly how a build ends up globally wrong while every individual part is
// locally right: battery capacity ↔ motor KV ↔ ESC current ↔ prop size is a
// COUPLED system, and nine isolated research calls cannot see a coupling.
//
// So after the batch, one cross-part consistency pass runs:
//   1. a cheap Jev gate decides whether these parts are even coupled
//      (independent parts skip the expensive call entirely)
//   2. one LLM pass hunts contradictions across parts and proposes patches
//   3. patches are applied IN CODE to the parts that own the field
//   4. blocking conflicts escalate to the human
//
// This is the literal answer to "the fragmentation of a single project into
// parts": the parts must agree, or the project is a pile of correct answers.
import { getProfile, ladderText } from './profiles.js';
import { generateJSON } from './llm.js';
import { noul, noulTrue } from './jevQuestions.js';
import { withProviderSlot } from './queue.js';
import { withTimeout } from './gate.js';

const COUPLING_TIMEOUT_MS = 6000;
const DEFAULT_RECONCILE_CONTEXT_CHARS = 18000;

const clip = (value, limit) => {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
};

function compactValue(value, limit) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return clip(value, limit);
  }
  try {
    return clip(JSON.stringify(value), limit);
  } catch {
    return '[unserialisable]';
  }
}

function compactData(data, valueLimit) {
  if (!data || typeof data !== 'object') return compactValue(data, valueLimit);
  const entries = Object.entries(data);
  const priority = ['bomRow', 'wiring', 'config', 'deps', 'interfaces', 'settings', 'checklist'];
  const orderedKeys = [
    ...priority.filter((key) => Object.prototype.hasOwnProperty.call(data, key)),
    ...entries.map(([key]) => key).filter((key) => !priority.includes(key)),
  ];
  return Object.fromEntries(
    orderedKeys
      .slice(0, 8)
      .map((key) => [clip(key, 80), compactValue(data[key], valueLimit)]),
  );
}

function compactPart(part, mode) {
  const idea = typeof part.idea === 'string' ? part.idea : part.idea?.summary || part.idea;
  return {
    name: clip(part.name, 180),
    domain: clip(part.domain, 80),
    ...(mode.idea ? { idea: compactValue(idea, mode.idea) } : {}),
    gathered: (part.current?.gathered || [])
      .slice(0, mode.gathered)
      .map((g) => ({
        field: clip(g?.field, 100),
        value: compactValue(g?.value, mode.gatheredValue),
        source: clip(g?.source, 180),
      })),
    data: compactData(part.current?.data || part.data, mode.data),
    flaggedByResearch: (part.current?.understand?.conflicts || [])
      .slice(0, mode.questions)
      .map((q) => clip(q, mode.question)),
    openQuestions: (part.openQuestions || []).slice(0, mode.questions).map((q) => clip(q, mode.question)),
  };
}

/**
 * Build a bounded integration bundle.
 *
 * A six-part run can easily produce more input than Groq's context/ITPM limit
 * when every gathered field and multiline config is repeated verbatim. The
 * reconciler needs the cross-part numbers, not every prose sentence, so compact
 * each field before serialising and tighten it in stages. The returned text is
 * always valid JSON unless an unusually huge part name exhausts the final hard
 * cap (in which case the model still gets a clearly marked prefix).
 */
export function compactReconcileBundle(parts, maxChars = DEFAULT_RECONCILE_CONTEXT_CHARS) {
  const max = Math.max(500, Number(maxChars) || DEFAULT_RECONCILE_CONTEXT_CHARS);
  const modes = [
    { idea: 360, gathered: 6, gatheredValue: 260, data: 700, questions: 4, question: 260 },
    { idea: 220, gathered: 4, gatheredValue: 180, data: 460, questions: 3, question: 220 },
    { idea: 120, gathered: 3, gatheredValue: 120, data: 280, questions: 2, question: 160 },
    { idea: 0, gathered: 2, gatheredValue: 90, data: 180, questions: 1, question: 120 },
  ];

  let text = '';
  let bundle = [];
  for (const mode of modes) {
    bundle = parts.map((part) => compactPart(part, mode));
    text = JSON.stringify(bundle);
    if (text.length <= max) {
      return { text, bundle, chars: text.length, approxTokens: Math.ceil(text.length / 4), truncated: mode !== modes[0] };
    }
  }

  // This last pass is mostly defensive. Keep every part represented rather
  // than slicing the JSON halfway through a part and hiding later conflicts.
  const perPart = Math.max(60, Math.floor(max / Math.max(1, parts.length * 3)));
  bundle = parts.map((part) =>
    compactPart(part, { idea: 0, gathered: 1, gatheredValue: perPart, data: perPart, questions: 1, question: perPart }),
  );
  text = JSON.stringify(bundle);
  if (text.length > max) text = `${text.slice(0, Math.max(0, max - 24))}…[bundle clipped]`;
  return { text, bundle, chars: text.length, approxTokens: Math.ceil(text.length / 4), truncated: true };
}

const SYS_RECONCILE = (profile) => `You are the integration lead on a build project. Parts were researched independently and in parallel; your job is to find where they CONTRADICT each other and make the project coherent.

Domain: ${profile.label} — ${profile.summary}
How this domain is verified: ${profile.verification}
Verification ladder available: ${ladderText(profile)}

Rules:
- Only report REAL contradictions between specific parts, where a number, rating, size, interface or assumption in one part makes another part wrong, under-rated, incompatible, or unbuildable.
- Coupled quantities are the usual suspects: power/current draw vs supply rating, voltage vs component rating, sizes vs mounting, torque/load vs material, interfaces/protocols, versions/APIs.
- Do NOT invent requirements, do not restate what is already consistent, and do not report vague "double-check this" items.
- Each conflict MUST carry a concrete resolution, expressed as patches to the specific field of the specific part that must change. The "part" value must exactly match a part name you were given.
- "blocking" = the build will not work or is unsafe as specified. "warning" = it works but is suboptimal or risky.

Return JSON ONLY:
{
  "coherent": boolean,
  "summary": "one paragraph: do these parts form a buildable whole? name the strongest coupling you checked",
  "conflicts": [
    {
      "severity": "blocking" | "warning",
      "parts": ["<exact part name>", "<exact part name>"],
      "issue": "what specifically contradicts, with the numbers",
      "resolution": "what must change and why",
      "patches": [ { "part": "<exact part name>", "field": "bomRow|wiring|config", "value": "the corrected value" } ]
    }
  ]
}
Return an empty conflicts array if the parts are genuinely consistent. Do not manufacture conflicts to seem useful.`;

function nowIso() {
  return new Date().toISOString();
}

function findPart(parts, name) {
  const needle = String(name || '').trim().toLowerCase();
  if (!needle) return null;
  return (
    parts.find((p) => String(p.name).toLowerCase() === needle) ||
    parts.find((p) => String(p.name).toLowerCase().includes(needle)) ||
    parts.find((p) => needle.includes(String(p.name).toLowerCase())) ||
    null
  );
}

// Apply a patch to the field the part actually owns. Never invents a field.
function applyPatch(project, parts, patch) {
  const target = findPart(parts, patch?.part);
  if (!target || !target.current?.data) return false;
  const field = String(patch.field || '');
  if (!field || !(field in target.current.data)) return false;

  target.current.data[field] = patch.value;
  target.updatedAt = nowIso();
  target.evidence = [
    ...(target.evidence || []),
    { rung: 'reconcile', at: target.updatedAt, detail: String(patch.value).slice(0, 240) },
  ];

  // Keep the project's CURRENT mirror in sync so the UI sees the patch.
  const mirror = (project.state.current.parts || []).find((p) => p.id === target.id);
  if (mirror) mirror.data = target.current.data;
  return true;
}

export async function reconcileProject({ project, emit = () => {}, registry, jev, prefer, contextChars }) {
  const startedAt = Date.now();
  const profile = getProfile(project.profileId);
  const parts = (project.state.parts || []).filter((p) => p.current?.data && p.status !== 'failed');

  // Nothing to integrate — a single part has nothing to contradict.
  if (parts.length < 2) {
    emit({
      type: 'reconcile',
      stage: 'skipped',
      reason: `only ${parts.length} researched part(s) — nothing to integrate`,
    });
    return { skipped: true, reason: 'fewer than 2 researched parts' };
  }

  emit({ type: 'reconcile', stage: 'start', total: parts.length, profile: profile.id });

  // ── 1. Cheap coupling gate. Independent parts skip the expensive pass. ────
  // Fail-safe: on timeout, error, or no Jev, coupled stays true and we reconcile.
  let coupled = true;
  let gateSource = 'default';
  if (jev?.available) {
    const res = await withTimeout(
      jev.decide(
        {
          state: {
            operation: 'reconcile_gate',
            goal: project.goal,
            profile: profile.id,
            parts: parts.map((p) => ({ name: p.name, domain: p.domain })),
          },
          questions: {
            coupled: noul(
              'Do any of these parts share coupled specifications — power/current, voltage, size/mounting, interfaces, load/torque, or versions — such that their specs must agree with each other? Answer low only if the parts are genuinely independent.',
            ),
          },
        },
        { registry },
      ),
      COUPLING_TIMEOUT_MS,
    );
    if (res?.answers) {
      coupled = noulTrue(res.answers.coupled);
      gateSource = res.source || 'jev';
    }
    if (!coupled) {
      emit({
        type: 'reconcile',
        stage: 'skipped',
        reason: `decision (${gateSource}) reports the parts are independent — no integration pass needed`,
      });
      project.state.reconciliations = [
        ...(project.state.reconciliations || []),
        { at: nowIso(), skipped: true, coupled: false, source: gateSource },
      ];
      return { skipped: true, reason: 'parts judged independent' };
    }
  }

  // ── 2. One LLM pass over a bounded bundle. ───────────────────────────────
  // The old pretty-printed bundle sent every multiline config and every
  // gathered source verbatim. On a six-part run that exceeded Groq's 7k input
  // token budget (HTTP 413) before the model could even start. Keep the goal,
  // names and cross-part values, but put a hard character budget around the
  // user message.
  const maxContextChars = Math.max(
    4000,
    Number(contextChars) || Number(process.env.WIREGI_RECONCILE_CONTEXT_CHARS) || DEFAULT_RECONCILE_CONTEXT_CHARS,
  );
  const headerBudget = Math.max(400, Math.floor(maxContextChars * 0.3));
  const constraints = clip(JSON.stringify(project.constraints || {}), Math.min(1800, Math.floor(headerBudget * 0.45)));
  const prefix = `PROJECT GOAL: ${clip(project.goal, Math.min(1800, Math.floor(headerBudget * 0.45)))}\nCONSTRAINTS: ${constraints}\n\nPARTS AS RESEARCHED (${parts.length}):\n`;
  const bundleBudget = Math.max(500, maxContextChars - prefix.length);
  const compacted = compactReconcileBundle(parts, bundleBudget);
  const user = `${prefix}${compacted.text}`;
  emit({
    type: 'reconcile',
    stage: 'context',
    chars: user.length,
    approxTokens: Math.ceil(user.length / 4),
    budgetChars: maxContextChars,
    truncated: compacted.truncated,
    message: `Integration context compacted to ${user.length} chars (~${Math.ceil(user.length / 4)} input tokens)${
      compacted.truncated ? ' — tight budget' : ''
    }`,
  });

  const out = await withProviderSlot(() =>
    generateJSON({
      registry,
      system: SYS_RECONCILE(profile),
      user,
      temperature: 0.15,
      maxTokens: 4096,
      emit,
      prefer,
      operation: 'reconcile',
    }),
  );

  // ── 3. Apply patches in code; never trust the model to edit state. ───────
  const conflicts = Array.isArray(out.conflicts) ? out.conflicts : [];
  let applied = 0;
  const report = [];

  for (const c of conflicts) {
    const touched = [];
    for (const patch of c.patches || []) {
      if (applyPatch(project, parts, patch)) {
        applied += 1;
        touched.push(`${patch.part}.${patch.field}`);
      }
    }

    // Blocking → the human must decide; warning → recorded as an open question.
    if (c.severity === 'blocking') {
      for (const name of c.parts || []) {
        const p = findPart(parts, name);
        if (!p) continue;
        p.humanCheckpoint = true;
        if (p.status === 'data_ready') p.status = 'awaiting_human';
        p.openQuestions = [
          ...(p.openQuestions || []),
          `Integration conflict: ${c.issue} → ${c.resolution}`,
        ];
      }
    } else {
      for (const name of c.parts || []) {
        const p = findPart(parts, name);
        if (!p) continue;
        p.openQuestions = [...(p.openQuestions || []), `Integration note: ${c.issue}`];
      }
    }

    const record = {
      severity: c.severity || 'warning',
      parts: c.parts || [],
      issue: c.issue,
      resolution: c.resolution,
      patchesApplied: touched,
    };
    report.push(record);
    emit({ type: 'reconcile', stage: 'conflict', conflict: record, applied });
  }

  // ── 4. Record the pass. ──────────────────────────────────────────────────
  const entry = {
    at: nowIso(),
    coupled: true,
    source: gateSource,
    coherent: out.coherent !== false && !report.some((r) => r.severity === 'blocking'),
    summary: out.summary || '',
    conflicts: report,
    patchesApplied: applied,
  };
  project.state.reconciliations = [...(project.state.reconciliations || []), entry];

  emit({
    type: 'reconcile',
    stage: 'done',
    coherent: entry.coherent,
    conflicts: report.length,
    blocking: report.filter((r) => r.severity === 'blocking').length,
    patchesApplied: applied,
    summary: entry.summary,
    ms: Date.now() - startedAt,
  });

  return entry;
}
