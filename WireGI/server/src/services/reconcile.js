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

export async function reconcileProject({ project, emit = () => {}, registry, jev, prefer }) {
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

  // ── 2. One LLM pass over the compact bundle. ─────────────────────────────
  const bundle = parts.map((p) => ({
    name: p.name,
    domain: p.domain,
    idea: p.idea?.summary,
    gathered: (p.current?.gathered || []).slice(0, 10),
    data: p.current?.data,
    flaggedByResearch: (p.current?.understand?.conflicts || []).slice(0, 4),
    openQuestions: (p.openQuestions || []).slice(0, 4),
  }));

  const user = `PROJECT GOAL: ${project.goal}
CONSTRAINTS: ${JSON.stringify(project.constraints || {})}

PARTS AS RESEARCHED (${bundle.length}):
${JSON.stringify(bundle, null, 2)}`;

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
