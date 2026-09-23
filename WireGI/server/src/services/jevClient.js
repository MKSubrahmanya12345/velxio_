// Jev decision client. Primary: Forge's real TypeSafe Jev provider.
// Fallback: if no TYPESAFE_API_KEY is configured — OR the live call fails,
// times out, or returns nothing usable — the LLM acts as a typed decision
// model, so a slow/broken decision never blocks a build (we route it to the
// LLM and use that data instead).
import { createJevProvider } from '../../../../forge/server/src/providers/jev.js';
import { generateJSON } from './llm.js';

// A live System One call should answer in 70–500ms. If it hasn't answered in a
// few seconds it is not coming; route the decision to the LLM instead.
const LIVE_TIMEOUT_MS =
  Number(process.env.WIREGI_JEV_TIMEOUT_MS) > 0 ? Number(process.env.WIREGI_JEV_TIMEOUT_MS) : 8000;

// Typed-decision prompt used whenever the live System One model is unavailable.
// The answer shapes mirror Jev's own exactly, so downstream readers never need
// to care which one answered.
const SYS_LLM_DECISION = `You are a typed decision model (System One). Given STATE and TYPED QUESTIONS, return JSON only:
{ "answers": { "<id>": <answer object> } }
Answer shapes:
  choice -> { "type":"choice", "choice": "<one of the criteria keys>", "confidence": 0..1 }
  score  -> { "type":"score", "score": <0-based index into the criteria list>, "confidence": 0..1 }
  noul   -> { "type":"noul", "noul": 0..1, "confidence": 0..1 }   (probability, 1 = certainly yes)
No prose. Be decisive.`;

async function raceTimeout(promise, ms) {
  let t;
  const guard = new Promise((resolve) => {
    t = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } catch {
    return undefined; // signal "threw"
  } finally {
    clearTimeout(t);
  }
}

export function createJev(cfg) {
  let live = null;
  try {
    live = createJevProvider(cfg);
  } catch {
    live = null;
  }

  function renderQuestions(questions) {
    return Object.entries(questions)
      .map(([id, q]) => {
        let opts = '';
        if (q.type === 'choice' && q.criteria) {
          const keys = Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria);
          const meaning = Array.isArray(q.criteria)
            ? ''
            : `\n  meaning: ${keys.map((k) => `${k} = ${String(q.criteria[k]).slice(0, 140)}`).join(' | ')}`;
          opts = `\n  choose exactly one key from: ${JSON.stringify(keys)}${meaning}`;
        } else if (q.type === 'score' && Array.isArray(q.criteria)) {
          opts = `\n  score is the 0-based index into: ${JSON.stringify(q.criteria)}`;
        }
        return `- id: ${id}\n  type: ${q.type}\n  question: ${q.instructions}${opts}`;
      })
      .join('\n');
  }

  async function decideViaLLM({ state, questions }, registry, why) {
    const user = `STATE:\n${JSON.stringify(state, null, 2)}\n\nQUESTIONS:\n${renderQuestions(questions)}`;
    const out = await generateJSON({ registry, system: SYS_LLM_DECISION, user, temperature: 0 });
    return {
      source: 'llm-fallback',
      answers: out.answers || {},
      model: 'llm-fallback',
      note: why,
    };
  }

  return {
    available: Boolean(live),

    // questions: built with services/jevQuestions.js
    //   choice -> { type, instructions, criteria: {key: desc} }
    //   score  -> { type, instructions, criteria: [labels] }
    //   noul   -> { type, instructions }
    async decide({ state, questions }, { registry } = {}) {
      if (live) {
        const res = await raceTimeout(live({ state, questions }), LIVE_TIMEOUT_MS);

        if (res === undefined) {
          // Live call threw (bad schema, auth, provider error) → LLM.
          return decideViaLLM({ state, questions }, registry, 'live Jev call failed');
        }
        if (res === null) {
          // Live call is too slow — do not keep the build waiting. → LLM.
          return decideViaLLM(
            { state, questions },
            registry,
            `live Jev did not answer within ${LIVE_TIMEOUT_MS}ms`,
          );
        }

        const answers = res?.answers || res;
        if (answers && typeof answers === 'object' && Object.keys(answers).length > 0) {
          return { source: 'jev', answers, model: res?.model, provider: res?.provider };
        }
        // Answered, but with nothing usable → LLM.
        return decideViaLLM({ state, questions }, registry, 'live Jev returned no usable answers');
      }

      return decideViaLLM({ state, questions }, registry, 'no TYPESAFE_API_KEY configured');
    },
  };
}
