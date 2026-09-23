// Retry with capped exponential backoff + full jitter (Gap B).
//
// Retries only transient failures: 429, 408, 5xx, timeouts and network errors.
// Fails fast on auth/client errors (401/403/404/400/422, missing keys, "no
// provider") so a bad credential never burns the retry budget.
//
// Forge's runWithFailover already switches between providers on failure, but
// it does so with no delay. This layer adds the wait that actually lets a rate
// limit recover.
//
// Knobs (env-overridable):
//   WIREGI_RETRIES        extra attempts after the first (default 4)
//   WIREGI_RETRY_BASE_MS  base delay for the first backoff   (default 500)
//   WIREGI_RETRY_MAX_MS   delay ceiling                      (default 30000)

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

const DEFAULTS = {
  retries: Math.max(0, envInt('WIREGI_RETRIES', 4)),
  baseMs: Math.max(50, envInt('WIREGI_RETRY_BASE_MS', 500)),
  maxMs: Math.max(100, envInt('WIREGI_RETRY_MAX_MS', 30000)),
};

const FATAL_MSG =
  /invalid api key|unauthorized|forbidden|authentication|no provider|no candidates|not configured|missing api key|invalid model|bad request/i;
const RETRYABLE_MSG =
  /rate limit|too many requests|timed? ?out|etimedout|econnreset|econnrefused|socket hang up|fetch failed|network|aborted|temporarily unavailable|overloaded|at capacity|service unavailable/i;

// Pull an HTTP-ish status out of whatever the provider layer threw.
export function statusOf(err) {
  if (!err) return null;
  const direct = Number(err.status ?? err.statusCode);
  if (Number.isFinite(direct) && direct >= 100 && direct < 600) return direct;
  const m = String(err.message || err).match(/\b([45]\d\d)\b/);
  return m ? Number(m[1]) : null;
}

// Honour a Retry-After header when the provider sent one (seconds or date).
export function retryAfterMs(err) {
  const raw =
    err?.retryAfter ??
    err?.headers?.get?.('retry-after') ??
    err?.response?.headers?.get?.('retry-after') ??
    null;
  if (raw == null) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(String(raw));
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

export function isRetryable(err) {
  if (!err) return false;
  const s = statusOf(err);
  if (s === 400 || s === 401 || s === 403 || s === 404 || s === 422) return false;
  if (s === 408 || s === 429) return true;
  if (s != null && s >= 500 && s <= 599) return true;
  const msg = String(err.message || err);
  if (FATAL_MSG.test(msg)) return false;
  return RETRYABLE_MSG.test(msg);
}

// Capped exponential backoff with full jitter (avoids a thundering herd when
// several parts fail at once).
export function backoffMs(attempt, { baseMs = DEFAULTS.baseMs, maxMs = DEFAULTS.maxMs } = {}) {
  const capped = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(Math.random() * capped);
}

// withRetry(fn, { onRetry }) -> resolves with fn's value, or throws the last
// error once retries are exhausted or the error is non-retryable.
export async function withRetry(fn, opts = {}) {
  const retries = opts.retries ?? DEFAULTS.retries;
  const baseMs = opts.baseMs ?? DEFAULTS.baseMs;
  const maxMs = opts.maxMs ?? DEFAULTS.maxMs;
  const onRetry = opts.onRetry;

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !isRetryable(err)) throw err;
      const hinted = retryAfterMs(err) ?? 0;
      const wait = Math.min(maxMs, Math.max(hinted, backoffMs(attempt, { baseMs, maxMs })));
      try {
        onRetry?.({ attempt: attempt + 1, retries, waitMs: wait, error: err });
      } catch {
        /* an emit failure must never break the retry loop */
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
