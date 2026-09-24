// Bounded concurrency + optional rate limiting for provider calls (Gap B).
// Zero dependencies, matching Forge's zero-dep style.
//
// Why this exists: firing every part's research at once hammers a single
// provider key and turns a build into a 429 storm. Preventing that is cheaper
// than cleaning it up — a promise pool (semaphore) plus an optional token
// bucket throttles the load before it leaves the process.
//
// Knobs (env-overridable, read once at import):
//   WIREGI_CONCURRENCY   max in-flight provider calls   (default 8)
//   WIREGI_RPM           requests/minute ceiling, 0=off (default 0)
//
// The semaphore slot is acquired ONCE per part and held across that part's
// retries, so backoff sleeps never free up extra concurrency.

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

// 8, not 4. Parts are researched in parallel and each one is a ~25s round
// trip, so on a twelve-part build the old default meant three serial waves
// (≈75s) where one wave would do. Eight still stays well clear of a 429 storm
// on any mainstream key; raise it further with WIREGI_CONCURRENCY if your
// provider's rate limits allow.
export const CONCURRENCY = Math.max(1, envInt('WIREGI_CONCURRENCY', 8));
export const RPM = Math.max(0, envInt('WIREGI_RPM', 0));

// A counting semaphore. acquire() resolves when a slot is free; release()
// hands the slot to the next waiter (FIFO).
export function createSemaphore(limit = 1) {
  let active = 0;
  const waiting = [];

  function pump() {
    while (active < limit && waiting.length) {
      active += 1;
      waiting.shift()();
    }
  }

  function acquire() {
    return new Promise((resolve) => {
      waiting.push(resolve);
      pump();
    });
  }

  function release() {
    active = Math.max(0, active - 1);
    pump();
  }

  async function run(fn) {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return {
    acquire,
    release,
    run,
    get active() {
      return active;
    },
    get waiting() {
      return waiting.length;
    },
  };
}

// Token bucket. Refills at tokensPerSecond, bursts up to maxTokens.
export function createTokenBucket({ tokensPerSecond, maxTokens = 1 }) {
  let tokens = maxTokens;
  let last = Date.now();
  const queue = [];
  let timer = null;

  function pump() {
    const now = Date.now();
    tokens = Math.min(maxTokens, tokens + ((now - last) / 1000) * tokensPerSecond);
    last = now;
    while (queue.length && tokens >= 1) {
      tokens -= 1;
      queue.shift()();
    }
    if (queue.length) {
      const deficit = Math.max(0, 1 - tokens);
      const ms = Math.max(10, Math.ceil((deficit / tokensPerSecond) * 1000));
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          pump();
        }, ms);
      }
    }
  }

  return {
    acquire() {
      return new Promise((resolve) => {
        queue.push(resolve);
        pump();
      });
    },
    get queued() {
      return queue.length;
    },
  };
}

export const providerLimiter = createSemaphore(CONCURRENCY);
export const rateLimiter =
  RPM > 0
    ? createTokenBucket({ tokensPerSecond: RPM / 60, maxTokens: Math.max(1, Math.ceil(RPM / 60)) })
    : null;

// Run one provider-bound unit of work inside the concurrency cap (and the rate
// ceiling, when configured). Retries stay inside `fn`, so the slot is held
// across a part rather than re-acquired per attempt.
export async function withProviderSlot(fn) {
  return providerLimiter.run(async () => {
    if (rateLimiter) await rateLimiter.acquire();
    return fn();
  });
}

// Worker-pool map: at most `limit` items in flight, results in input order.
// Like Promise.all, this rejects if `fn` rejects — callers that need per-item
// isolation (see agent.js runPart) must catch inside `fn`.
export async function mapWithConcurrency(items, limit, fn) {
  const list = [...items];
  const results = new Array(list.length);
  const width = Math.max(1, Math.min(limit, list.length || 1));
  let cursor = 0;

  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= list.length) return;
      results[i] = await fn(list[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}
