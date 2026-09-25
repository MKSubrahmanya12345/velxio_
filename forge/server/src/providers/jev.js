// Forge — Jev provider factory.
//
// Contract: ask({ state, questions }) → { answers, model, provider, usage }
//
// `state` is sent as structured JSON when the caller passed an object. The
// System One API accepts a string, object, or array. Stringifying an object
// first throws away the paths questions are supposed to point at.

export function createJevProvider(cfg) {
  if (cfg.jev.provider === 'typesafe' && cfg.jev.apiKey) return typesafeJev(cfg);
  throw new Error(
    'JEV: no live provider configured. Set TYPESAFE_API_KEY in forge/server/.env (JEV_PROVIDER=typesafe). ' +
    'Mocks were removed — JEV only runs against the real TypeSafe API.'
  );
}

function typesafeJev(cfg) {
  return async function typesafe({ state, questions }) {
    const body = {
      state: state === undefined || state === null ? '' : state,
      model: cfg.jev.model,
      questions,
    };
    const res = await fetch(`${cfg.jev.baseUrl}/v1/systemone`, {
      method: 'POST',
      signal: AbortSignal.timeout(60000),
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
