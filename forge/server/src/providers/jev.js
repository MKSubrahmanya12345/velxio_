// Forge — Jev provider factory.
//
// Contract: ask({ state, questions }) → { answers: { [id]: { type, …fields } }, model, provider, usage }
//
// `state` is serialized to JSON before the call (the TypeSafe API takes
// unstructured program state as a string).

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
      state: typeof state === 'string' ? state : JSON.stringify(state),
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