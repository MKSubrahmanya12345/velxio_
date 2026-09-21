// Forge — Jev provider factory.
//
// Two implementations with the identical contract:
//   ask({ state, questions }) → { answers: { [id]: { type, …fields } }, model, provider, usage }
//
// `state` is serialized to JSON before the real call (the TypeSafe API takes
// unstructured program state as a string); the mock accepts either shape.

import { createJevMock } from './jevMock.js';

export function createJevProvider(cfg) {
  if (cfg.jev.provider === 'typesafe' && cfg.jev.apiKey) return typesafeJev(cfg);
  return createJevMock();
}

function typesafeJev(cfg) {
  return async function typesafe({ state, questions }) {
    const body = {
      state: typeof state === 'string' ? state : JSON.stringify(state),
      model: cfg.jev.model,
      questions,
    };
    const res = await fetch(`${cfg.jev.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.jev.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`TypeSafe API ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return { ...data, provider: 'typesafe' };
  };
}
