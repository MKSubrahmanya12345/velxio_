// Wire-format builders for TypeSafe Jev questions.
//
// The API is strict about the shape of `criteria`, and getting it wrong fails
// the whole call with a 422 (Pydantic). Verified against Forge's working calls
// and the API's own validation errors:
//
//   choice -> criteria MUST be a dict  { optionKey: description }
//             (a bare array is rejected: "Input should be a valid dictionary")
//   score  -> criteria is an ARRAY of rubric labels; the answer is the INDEX
//   noul   -> no criteria at all; the answer is a probability 0..1
//
// Answer shapes returned by the model (a[id]):
//   { type:'choice', choice:'<key>', confidence:0..1 }
//   { type:'noul',   noul:0..1,      confidence:0..1 }
//   { type:'score',  score:<index>,  confidence:0..1 }
//
// Always build questions with these helpers rather than hand-writing objects.

// Accepts either a dict ({ key: description }) or an array of option keys /
// { key, desc } objects, and always emits the dict form the API requires.
export function choice(instructions, options) {
  const criteria = Array.isArray(options)
    ? Object.fromEntries(
        options.map((o) =>
          typeof o === 'string'
            ? [o, o]
            : [o.key, o.desc ?? o.description ?? o.key],
        ),
      )
    : options;
  return { type: 'choice', instructions, criteria };
}

// score criteria is an array of labels, ordered lowest -> highest.
export function score(instructions, labels) {
  return labels && labels.length
    ? { type: 'score', instructions, criteria: labels }
    : { type: 'score', instructions };
}

export function noul(instructions) {
  return { type: 'noul', instructions };
}

// ---- answer readers (tolerant of both live Jev and the LLM fallback) --------

export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function answerOf(answers, id) {
  return answers?.[id] ?? null;
}

// The chosen key / probability / index, whichever the question type returned.
export function answerValue(a) {
  if (a == null) return null;
  if (typeof a !== 'object') return a;
  if ('choice' in a) return a.choice;
  if ('noul' in a) return a.noul;
  if ('score' in a) return a.score;
  if ('value' in a) return a.value; // LLM-fallback shape
  if ('probability' in a) return a.probability;
  return a;
}

// Certainty of an answer. For noul the stored number is a probability, so
// certainty is distance from the 0.5 boundary (Forge uses the same rule).
export function answerCertainty(a) {
  if (a && typeof a === 'object') {
    const c = num(a.confidence);
    if (c != null) return c;
    const p = num(a.noul ?? a.probability);
    if (p != null) return Math.max(p, 1 - p);
    return null;
  }
  return null;
}

export function noulTrue(a) {
  const v = answerValue(a);
  if (typeof v === 'boolean') return v;
  const n = num(v);
  return n != null ? n >= 0.5 : false;
}
