// Forge — deterministic offline Jev (mock provider).
//
// Returns EXACTLY the same response shape as the real TypeSafe API (see
// docs.typesafe.ai quickstart): answers keyed by question id, each with
// `type` plus the fields for that type:
//   choice → { choice, confidence, probabilities }
//   score  → { score, confidence, legend, probabilities }
//   noul   → { noul }            (no separate confidence in the real API)
//
// Pattern-based and seeded on the input text, so the same message always
// yields the same answers. This lets the whole loop run — including the
// confidence-gating paths — with zero network and zero keys.

const r2 = (x) => Math.round(x * 10000) / 10000;

function hash01(s) {
  let h = 2166136261;
  s = String(s ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

const band = (seed, lo = 0.62, hi = 0.93) => lo + hash01(seed) * (hi - lo);

function choiceAnswer(options, winner, conf) {
  const rest = (1 - conf) / Math.max(1, options.length - 1);
  const probabilities = {};
  for (const o of options) probabilities[o] = r2(o === winner ? conf : rest);
  return { type: 'choice', choice: winner, confidence: r2(conf), probabilities };
}

function choiceAnswerSeeded(options, winner, seed) {
  return choiceAnswer(options, winner, band(seed));
}

function scoreAnswer(levels, pos, seed) {
  const p = levels.map((_, i) => Math.exp(-((i - pos) ** 2) / 0.6));
  const sum = p.reduce((x, y) => x + y, 0) || 1;
  const probabilities = {};
  const legend = {};
  levels.forEach((lvl, i) => {
    legend[String(i)] = lvl;
    probabilities[String(i)] = r2(p[i] / sum);
  });
  const maxP = Math.max(...p) / sum;
  return {
    type: 'score',
    score: r2(pos),
    confidence: r2(0.5 + 0.45 * maxP),
    legend,
    probabilities,
  };
}

const noulAnswer = (p) => ({ type: 'noul', noul: r2(Math.min(1, Math.max(0, p))) });

// ── Patterns ─────────────────────────────────────────────────────────────────

const RE = {
  weapon: /\b(gun|rifle|pistol|firearm|bomb|grenade|explosive)\b/i,
  fail: /doesn'?t work|not working|failed|broke|broken|cold joint|no(thing)? (happen|work)|sparks?|smoke|burned|burnt|short(ed)?|error|reads \d/i,
  donePos: /looks (good|solid|fine|great|perfect)|shiny|secure|clean|identified|all parts|checks? (out|good)|ready|perfect|done\b|meets the definition/i,
  safety: /smoke|burn(t|ing)?\b|spark|shock|hot\b|warm\b|smell|melting|leak|injur|cut (my|me)/i,
  stuck: /\bstuck\b|can'?t (continue|figure|proceed)|overwhelmed|give (it )?up|no clue/i,
  have: /\bi (have|got|own)\b|\binstead of\b|\bno \w+ available\b/i,
  question: /\?|\b(what|how|why|where|when|which|can you|should i|does)\b/i,
  claim: /i (think )?(it'?s|this|the (project|build|whole thing) )(is )?(done|complete|finished)|all (done|finished)|i finished everything/i,
};

const STOP = new Set(['a', 'an', 'the', 'of', 'for', 'with', 'and', 'but', 'on', 'in', 'to', 'my', 'i', 'have', 'got', 'is', 'it', 'not', 'no']);
const tokens = (s) =>
  String(s).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t));
const overlap = (a, b) => {
  const sb = new Set(tokens(b));
  return tokens(a).filter((t) => sb.has(t));
};

const CAT_WORDS = {
  electronics: ['led', 'circuit', 'arduino', 'esp32', 'mp3', 'audio', 'player', 'speaker', 'battery', 'solder', 'sensor', 'chip', 'pcb', 'diode', 'resistor', 'firmware', 'radio', 'lamp'],
  robotics: ['robot', 'drone', 'servo', 'arm', 'walker'],
  mechanical: ['frame', 'weld', 'bracket', 'chassis', 'metal', 'cnc', 'helmet'],
  woodwork: ['wood', 'table', 'shelf', 'joinery', 'furniture'],
  craft: ['sew', 'knit', 'crochet', 'quilt', 'textile'],
  food: ['bake', 'cook', 'recipe', 'bread', 'cake', 'pasta'],
  software: ['app', 'website', 'api', 'game', 'script', 'saas'],
};

const PART_GROUPS = [
  ['resistor', 'potentiometer', 'pot'],
  ['capacitor', 'cap', 'condenser'],
  ['diode'],
  ['led'],
  ['speaker', 'buzzer'],
  ['battery', 'lipo', 'li-ion', '18650'],
  ['switch', 'button'],
  ['motor', 'servo'],
  ['wire', 'cable', 'harness'],
  ['mcu', 'microcontroller', 'esp32', 'atmega', 'rp2040'],
];
function sameGroup(a, b) {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  return PART_GROUPS.some((g) => g.some((w) => ta.has(w)) && g.some((w) => tb.has(w)));
}

// ── Mock answerer ────────────────────────────────────────────────────────────

function mockCategory(goal) {
  const g = String(goal).toLowerCase();
  let winner = 'general';
  let best = 0;
  for (const [cat, words] of Object.entries(CAT_WORDS)) {
    const hits = words.filter((w) => g.includes(w)).length;
    if (hits > best) { best = hits; winner = cat; }
  }
  const options = ['electronics', 'mechanical', 'robotics', 'software', 'woodwork', 'craft', 'food', 'general'];
  return choiceAnswerSeeded(options, winner, 'cat:' + goal);
}

function mockBuildability(goal) {
  const g = String(goal).toLowerCase();
  if (RE.weapon.test(g)) return choiceAnswer(['yes', 'yes_caveats', 'no'], 'no', 0.9);
  if (/iron man|ironman|drone|robot|helmet|car|plane/.test(g)) {
    return choiceAnswerSeeded(['yes', 'yes_caveats', 'no'], 'yes_caveats', 'build:' + goal);
  }
  return choiceAnswerSeeded(['yes', 'yes_caveats', 'no'], 'yes', 'build:' + goal);
}

function mockRisky(goal) {
  const g = String(goal).toLowerCase();
  return noulAnswer(/solder|cut|weld|knife|blade|chemical|acid|voltage|battery|laser|flame|pressure/.test(g) ? 0.8 : 0.2);
}

function mockComplexity(goal) {
  const g = String(goal).toLowerCase();
  const pos = /helmet|robot|car|drone|house|engine/.test(g) ? 2.6 : /lamp|card|candle|clock/.test(g) ? 0.4 : 1.3;
  return scoreAnswer(['Weekend project', 'Multi-day project', 'Multi-week project', 'Major project'], pos, 'cx:' + goal);
}

function mockBudget(goal) {
  const g = String(goal).toLowerCase();
  const pos = /helmet|robot|car|drone/.test(g) ? 2.6 : /lamp/.test(g) ? 0.6 : 1.3;
  return scoreAnswer(['Under $25', '$25–$100', '$100–$500', '$500+'], pos, 'bud:' + goal);
}

const CHIP_INTENT = {
  done: 'step_done',
  failed: 'step_failed',
  substitute: 'substitute_request',
  question: 'question',
  claim_done: 'claim_done',
};

function mockIntent(ctx, msg) {
  const options = ['step_done', 'step_failed', 'question', 'deviation', 'substitute_request', 'scope_change', 'claim_done', 'blocked', 'off_topic'];
  if (ctx.chip && CHIP_INTENT[ctx.chip]) {
    return choiceAnswer(options, CHIP_INTENT[ctx.chip], band('chip:' + msg, 0.8, 0.95));
  }
  let winner = 'question';
  if (RE.claim.test(msg)) winner = 'claim_done';
  else if (RE.fail.test(msg)) winner = 'step_failed';
  else if (RE.have.test(msg)) winner = 'substitute_request';
  else if (RE.stuck.test(msg)) winner = 'blocked';
  else if (RE.question.test(msg) && !RE.donePos.test(msg)) winner = 'question';
  else if (RE.donePos.test(msg)) winner = 'step_done';
  return choiceAnswerSeeded(options, winner, 'intent:' + msg);
}

function mockSafetyConcern(msg) {
  return noulAnswer(RE.safety.test(msg) ? 0.85 : 0.12);
}

function mockFrustration(msg) {
  const pos = RE.stuck.test(msg) ? 2.6 : /ugh|annoying|frustrat/i.test(msg) ? 1.6 : 0.4;
  return scoreAnswer(['On track, no friction', 'Minor friction', 'Stuck, needs help', 'Overwhelmed, plan may not fit'], pos, 'frus:' + msg);
}

function mockVerified(msg) {
  if (RE.fail.test(msg)) return noulAnswer(0.18);
  if (RE.donePos.test(msg)) return noulAnswer(band('ver:' + msg, 0.78, 0.95));
  return noulAnswer(0.55);
}

function mockQuality(msg) {
  const pos = /excellent|perfect|beautiful/i.test(msg) ? 2.6
    : /good|solid|fine|checks? out/i.test(msg) ? 1.6
    : /\b(ok|acceptable)\b/i.test(msg) ? 0.9
    : RE.fail.test(msg) ? 0.3
    : 1.1;
  return scoreAnswer(['Does not meet the definition of done', 'Acceptable, minor flaws', 'Good', 'Excellent'], pos, 'qual:' + msg);
}

function mockHazard(id, step) {
  const i = Number(id.split('_')[1] || 0);
  const s = (step?.safety || [])[i];
  if (!s) return noulAnswer(0.15);
  return noulAnswer(s.severity === 'high' ? 0.9 : 0.75);
}

function mockSubstitute(id, ctx) {
  const i = Number(id.split(/_(\d+)$/)[1] || 0);
  const sub = ctx.substitution || {};
  const item = (sub.items || [])[i];
  const need = sub.need || '';
  if (!item) return noulAnswer(0.2);
  const name = `${item.name} ${item.note || ''}`;
  const ov = overlap(name, need);
  if (id.startsWith('valid_sub')) {
    return noulAnswer(ov.length ? band('vsub:' + item.name + need, 0.72, 0.9) : 0.2);
  }
  const pos = ov.length ? (sameGroup(name, need) ? 2.4 : 1.3) : 0.3;
  return scoreAnswer(['Incompatible', 'Works with changes', 'Drop-in equivalent'], pos, 'compat:' + item.name + need);
}

function mockAccept(id, ctx) {
  const i = Number(id.slice('accept_'.length) || 0);
  const prog = ctx.progress || { completed: 0, total: 1 };
  const total = Math.max(1, prog.total);
  if (prog.completed >= total) return noulAnswer(0.9 + hash01('acc' + i + total) * 0.08);
  return noulAnswer(0.15 + 0.55 * (prog.completed / total));
}

function mockDifficulty(ctx, msg) {
  const pos = RE.stuck.test(msg) || (ctx.active_step?.failed || 0) >= 2 ? 2.7
    : RE.fail.test(msg) ? 1.6
    : 0.4;
  return scoreAnswer(['Right level', 'Slightly hard', 'Too hard', 'Over my head'], pos, 'diff:' + msg);
}

function mockNextInventory(ctx) {
  const pending = ctx.bom_pending_count || 0;
  const inv = ctx.inventory?.length || 0;
  return noulAnswer(pending > 0 && inv === 0 ? 0.72 : 0.2);
}

function mockNextCheck(ctx) {
  const ns = ctx.next_step;
  if (!ns) return noulAnswer(0.25);
  const blob = `${ns.title} ${ns.definition_of_done.join(' ')} ${ns.tools.join(' ')}`;
  return noulAnswer(/multimeter|measure|within \d|test/i.test(blob) ? 0.7 : 0.25);
}

function mockNextQuestion(msg) {
  return noulAnswer(/\?/.test(msg) ? 0.8 : 0.2);
}

function mockAnswer(id, q, ctx, msg) {
  switch (id) {
    case 'category': return mockCategory(ctx.goal);
    case 'buildability': return mockBuildability(ctx.goal);
    case 'risky': return mockRisky(ctx.goal);
    case 'complexity': return mockComplexity(ctx.goal);
    case 'budget': return mockBudget(ctx.goal);
    case 'intent': return mockIntent(ctx, msg);
    case 'safety_concern': return mockSafetyConcern(msg);
    case 'frustration': return mockFrustration(msg);
    case 'verified': return mockVerified(msg);
    case 'quality': return mockQuality(msg);
    case 'difficulty': return mockDifficulty(ctx, msg);
    case 'next_inventory': return mockNextInventory(ctx);
    case 'next_check': return mockNextCheck(ctx);
    case 'next_question': return mockNextQuestion(msg);
    default:
      break;
  }
  if (id.startsWith('hazard_')) return mockHazard(id, ctx.active_step);
  if (id.startsWith('valid_sub') || id.startsWith('compat')) return mockSubstitute(id, ctx);
  if (id.startsWith('accept_')) return mockAccept(id, ctx);
  // Fallback for unknown question ids — keeps the contract honest.
  if (q.type === 'choice') {
    const opts = Object.keys(q.criteria || {});
    return opts.length ? choiceAnswerSeeded(opts, opts[0], id + msg) : noulAnswer(0.5);
  }
  if (q.type === 'score') {
    const levels = Array.isArray(q.criteria) ? q.criteria : ['ok'];
    return scoreAnswer(levels, 0, id + msg);
  }
  return noulAnswer(0.5);
}

export function createJevMock() {
  return async function jevMock({ state, questions }) {
    const ctx = typeof state === 'string' ? JSON.parse(state || '{}') : state || {};
    const msg = String(ctx.message || '');
    const answers = {};
    for (const [id, q] of Object.entries(questions || {})) {
      answers[id] = mockAnswer(id, q, ctx, msg);
    }
    return {
      model: 'jev-mock-1.0',
      provider: 'mock',
      answers,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  };
}
