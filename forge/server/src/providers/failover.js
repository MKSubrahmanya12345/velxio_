// Forge — provider failover.
//
// Every generation call goes through runWithFailover(). It walks the registry's
// candidate order (selected key first, then that provider's other keys, then
// every other enabled provider/key) and, on ANY error — HTTP status, timeout,
// network failure, malformed response — switches to the next credential and
// tries again.
//
// The loop has exactly one stop condition: the round budget. One round is a
// complete pass over all enabled providers and keys; after `maxRounds` rounds
// (10 by default) the runner gives up and reports every attempt it made. Nothing
// else interrupts it — no "provider is down, stop" heuristic, no per-key retry
// cap. Credentials rejected outright (401/403/404) can optionally be left out of
// later rounds; that is off-by-default behaviour controlled from the UI, and the
// loop itself still runs to its budget for everything else.

import { buildRequest, extractText, isPermanentStatus, providerDefinition, resolveProviderId } from './catalog.js';

export const DEFAULT_MAX_ROUNDS = 10;

export function keyLabel(entry) {
  const def = providerDefinition(entry.provider);
  const note = entry.note ? ` “${entry.note}”` : '';
  return `${def.short}${note} · ${entry.model}`;
}

// A provider call failure that keeps its HTTP status (when there was one) so the
// runner can tell a rejected credential from a rate limit or an outage.
export function providerError(message, { status = null, provider = '', keyId = '', permanent = false, cause = null } = {}) {
  const error = new Error(message);
  error.status = status;
  error.provider = provider;
  error.keyId = keyId;
  error.permanent = permanent;
  if (cause) error.cause = cause;
  return error;
}

export function noProvidersError(registry) {
  const error = new Error(
    'No generation providers are configured. Open the Providers page and add at least one key ' +
    '(Gemini, OpenRouter, AWS Bedrock, or Ollama), or set LLM_API_KEY / AWS credentials in forge/server/.env. ' +
    'No project changes were saved.'
  );
  error.status = 503;
  error.noProviders = true;
  if (registry) error.file = registry.file;
  return error;
}

// Plans and structured replies arrive as JSON, sometimes code-fenced. Parsing
// inside the attempt means a model that answers with prose counts as a failed
// attempt, so the loop moves to the next provider/key instead of returning junk.
export function parsePlanText(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!cleaned) throw new Error('The provider returned an empty response.');
  return JSON.parse(cleaned);
}

// One real HTTP call to one credential. Returns generated text only.
export async function callProviderEntry(entry, { system, user, temperature = 0.2, maxTokens = 8192, timeoutMs, fetchImpl } = {}) {
  const request = buildRequest(entry, { system, user, temperature, maxTokens });
  const limit = timeoutMs ?? request.timeoutMs;
  let res;
  try {
    res = await (fetchImpl || fetch)(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(limit),
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw providerError(
      timedOut ? `${keyLabel(entry)} timed out after ${Math.round(limit / 1000)}s.` : `${keyLabel(entry)} could not be reached: ${error?.message || error}`,
      { status: null, provider: entry.provider, keyId: entry.id, cause: error }
    );
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300).replace(/\s+/g, ' ').trim();
    throw providerError(
      `${keyLabel(entry)} returned HTTP ${res.status}${detail ? `: ${detail}` : '.'}`,
      { status: res.status, provider: entry.provider, keyId: entry.id, permanent: isPermanentStatus(res.status) }
    );
  }

  let data;
  try {
    data = await res.json();
  } catch (error) {
    throw providerError(`${keyLabel(entry)} returned a non-JSON response.`, { status: null, provider: entry.provider, keyId: entry.id, cause: error });
  }
  try {
    return extractText(entry, data);
  } catch (error) {
    throw providerError(`${keyLabel(entry)}: ${error.message}`, { status: null, provider: entry.provider, keyId: entry.id, cause: error });
  }
}

// Connectivity/credential check for exactly one key. No failover, short timeout,
// and the reply is truncated — this is a probe, not a generation.
export async function testProviderEntry(entry, { timeoutMs = 20000, fetchImpl } = {}) {
  const started = Date.now();
  try {
    const text = await callProviderEntry(entry, {
      system: 'You are a connectivity probe. Reply with JSON only: {"ok":true}',
      user: '{"probe":true}',
      maxTokens: 64,
      temperature: 0,
      timeoutMs,
      fetchImpl,
    });
    return { ok: true, keyId: entry.id, provider: entry.provider, model: entry.model, latencyMs: Date.now() - started, reply: String(text).slice(0, 400) };
  } catch (error) {
    return { ok: false, keyId: entry.id, provider: entry.provider, model: entry.model, latencyMs: Date.now() - started, status: error.status ?? null, error: error.message };
  }
}

/**
 * Run `work(entry, info)` against every enabled credential until one succeeds.
 *
 * @param {object}   opts
 * @param {object}   opts.registry   provider registry (candidate order + stats)
 * @param {Function} opts.work       async (entry, info) => result
 * @param {string}  [opts.operation] label used in logs/events
 * @param {Function}[opts.emit]      progress callback for streamed turns/UI
 * @param {string}  [opts.prefer]    start the loop at this key id or provider id
 * @returns {Promise<{result:*, used:object, entry:object, attempts:Array, rounds:number, switched:boolean}>}
 */
export async function runWithFailover({ registry, work, operation = 'generate', emit = () => {}, fetchImpl, prefer } = {}) {
  if (typeof work !== 'function') throw new Error('runWithFailover needs a work function.');
  const settings = registry?.failover || { enabled: true, maxRounds: DEFAULT_MAX_ROUNDS, retryRejected: false };
  const enabled = registry?.candidates?.() || [];
  if (!enabled.length) throw noProvidersError(registry);

  // With auto-switch off only the selected credential is used — one attempt.
  // A requested provider/key is a starting point, never a pin: the rest of the
  // loop stays behind it, so the same failure handling applies to every entry.
  const order = preferredOrder(settings.enabled === false ? enabled.slice(0, 1) : enabled, prefer);
  const maxRounds = settings.enabled === false ? 1 : Math.max(1, Number(settings.maxRounds) || DEFAULT_MAX_ROUNDS);
  const skipped = new Set();
  const attempts = [];
  let attempt = 0;
  let rounds = 0;

  for (let round = 1; round <= maxRounds; round++) {
    rounds = round;
    for (const entry of order) {
      if (skipped.has(entry.id)) continue;
      attempt += 1;
      const started = Date.now();
      const info = {
        round,
        attempt,
        maxRounds,
        candidates: order.length,
        keyId: entry.id,
        provider: entry.provider,
        providerLabel: providerDefinition(entry.provider).label,
        note: entry.note,
        model: entry.model,
        label: keyLabel(entry),
        operation,
      };
      emit({ type: 'attempt', ...info });
      try {
        const result = await work(entry, info);
        const latencyMs = Date.now() - started;
        await registry.recordSuccess?.(entry.id, { latencyMs, operation });
        emit({ type: 'success', ...info, latencyMs, switched: attempt > 1 });
        return { result, used: info, entry, attempts, rounds: round, switched: attempt > 1, latencyMs };
      } catch (error) {
        const status = error?.status ?? null;
        const message = error?.message || String(error);
        // Rejected credentials are only dropped from later rounds when the user
        // asked for it; the loop keeps running for every other key.
        const permanent = Boolean(error?.permanent) && settings.retryRejected !== true;
        if (permanent) skipped.add(entry.id);
        const latencyMs = Date.now() - started;
        await registry.recordFailure?.(entry.id, { status, message, permanent, round, attempt, operation });
        attempts.push({ ...info, status, message, permanent, latencyMs, at: new Date().toISOString() });
        emit({ type: 'error', ...info, status, message, permanent, latencyMs });
      }
    }
    if (order.every(entry => skipped.has(entry.id))) break;
    if (round < maxRounds) {
      emit({
        type: 'round',
        round: round + 1,
        maxRounds,
        candidates: order.filter(entry => !skipped.has(entry.id)).length,
        message: `Round ${round} of ${maxRounds} failed on every provider — looping all keys and providers again.`,
      });
    }
  }

  throw exhaustedError({ attempts, rounds, maxRounds, skipped, order, operation });
}

// Put the requested key (or every key of the requested provider) first, then
// keep the ordinary order: selected key → same provider → the rest.
export function preferredOrder(entries, prefer) {
  const want = String(prefer || '').trim();
  if (!want) return entries;
  const wanted = resolveProviderId(want);
  const matches = entry =>
    entry.id === want ||
    String(entry.provider).toLowerCase() === want.toLowerCase() ||
    (wanted ? resolveProviderId(entry.provider) === wanted : false);
  const head = entries.filter(matches);
  if (!head.length) return entries;
  return [...head, ...entries.filter(entry => !matches(entry))];
}

// The final failure names every credential tried and why it failed: "the model
// is down" is not actionable, the actual per-key reasons are.
export function exhaustedError({ attempts, rounds, maxRounds, skipped, order, operation }) {
  const perKey = new Map();
  for (const a of attempts) {
    const list = perKey.get(a.keyId) || [];
    list.push(a);
    perKey.set(a.keyId, list);
  }
  const lines = [...perKey.entries()].map(([, list]) => {
    const last = list[list.length - 1];
    // Attempt messages already name the credential; don't say it twice.
    const detail = last.message.startsWith(last.label) ? last.message : `${last.label}: ${last.message}`;
    return `  · ${detail}${list.length > 1 ? ` (${list.length} attempts)` : ''}`;
  });
  const rejected = [...skipped].length;
  const message = [
    `Every configured provider failed after ${attempts.length} attempt${attempts.length === 1 ? '' : 's'} across ${rounds} of ${maxRounds} round${maxRounds === 1 ? '' : 's'}.`,
    rejected ? `${rejected} credential${rejected === 1 ? '' : 's'} were rejected outright and skipped in later rounds.` : '',
    lines.length ? `Attempts:\n${lines.join('\n')}` : '',
    `Add another key on the Providers page, or fix one of these. No ${operation} output was produced and no project changes were saved.`,
  ].filter(Boolean).join('\n');
  const error = new Error(message);
  error.status = 502;
  error.allProvidersFailed = true;
  error.attempts = attempts;
  error.rounds = rounds;
  error.maxRounds = maxRounds;
  error.tried = order.map(entry => entry.id);
  return error;
}
