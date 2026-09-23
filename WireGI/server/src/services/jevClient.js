// Jev decision client. Primary: Forge's real TypeSafe Jev provider.
// Fallback: if no TYPESAFE_API_KEY is configured, the LLM acts as a typed
// decision model so the flow still runs (decisions "work properly" either way).
import { createJevProvider } from '../../../../forge/server/src/providers/jev.js';
import { generateJSON } from './llm.js';

export function createJev(cfg) {
  let live = null;
  try {
    live = createJevProvider(cfg);
  } catch {
    live = null;
  }

  return {
    available: Boolean(live),

    // questions: { id: { type:'choice'|'score'|'noul', instructions, criteria? } }
    async decide({ state, questions }, { registry } = {}) {
      if (live) {
        const res = await live({ state, questions });
        return { source: 'jev', answers: res.answers || res, model: res.model, provider: res.provider };
      }

      const qText = Object.entries(questions)
        .map(([id, q]) => {
          const crit = q.criteria ? `\n  options: ${JSON.stringify(q.criteria)}` : '';
          return `- id: ${id}\n  type: ${q.type}\n  question: ${q.instructions}${crit}`;
        })
        .join('\n');

      const sys = `You are a typed decision model (System One). Given STATE and TYPED QUESTIONS, return JSON only:
{ "answers": { "<id>": <answer object> } }
Answer shapes:
  choice -> { "type":"choice", "value": <one of criteria or null>, "confidence": 0..1 }
  score  -> { "type":"score", "value": <number>, "confidence": 0..1 }
  noul   -> { "type":"noul", "value": <true|false>, "probability": 0..1, "confidence": 0..1 }
No prose. Be decisive.`;
      const user = `STATE:\n${JSON.stringify(state, null, 2)}\n\nQUESTIONS:\n${qText}`;
      const out = await generateJSON({ registry, system: sys, user, temperature: 0 });
      return { source: 'llm-fallback', answers: out.answers || {}, model: 'llm-fallback' };
    },
  };
}
