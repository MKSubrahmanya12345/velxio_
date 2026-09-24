// Generic LLM generation through Forge's failover loop (reuses Forge providers).
//
// Two jobs beyond calling the model:
//
//   1. TRANSLATE provider events. Forge's failover emits `attempt`/`success`/
//      `error`/`round` for every single credential it tries. A failed attempt is
//      NOT a failed run — this bridge re-labels them `provider.*` so a 429 from
//      one key can never be rendered as "ERROR undefined" by the UI, while still
//      appearing in the flow log with its status, latency and message.
//
//   2. KEEP THE METADATA. Which key/model actually answered, how many attempts
//      it took and how long it took used to be thrown away; now it comes back
//      with the text and is recorded per part.
import '../env.js'; // WireGI's .env wins over Forge's — must run first
import { runWithFailover, callProviderEntry } from '../../../../forge/server/src/providers/failover.js';
import { errorSummary, trimText } from './debug.js';

/** Re-label Forge's provider events into the WireGI trace taxonomy. */
export function bridgeProviderEvents(emit) {
  if (!emit) return () => {};
  return (ev) => {
    const base = {
      provider: ev.provider,
      providerLabel: ev.providerLabel,
      model: ev.model,
      keyId: ev.keyId,
      label: ev.label,
      operation: ev.operation,
      attempt: ev.attempt,
      candidates: ev.candidates,
      round: ev.round,
      maxRounds: ev.maxRounds,
    };
    switch (ev.type) {
      case 'attempt':
        return emit({
          ...base,
          type: 'provider',
          stage: 'attempt',
          message: `→ ${ev.label} — attempt ${ev.attempt}/${ev.candidates}, round ${ev.round}/${ev.maxRounds}`,
        });
      case 'success':
        return emit({
          ...base,
          type: 'provider',
          stage: 'ok',
          latencyMs: ev.latencyMs,
          switched: ev.switched,
          message: `✔ ${ev.label} answered in ${ev.latencyMs}ms${ev.switched ? ' (after failover)' : ''}`,
        });
      case 'error':
        return emit({
          ...base,
          type: 'provider',
          stage: 'fail',
          status: ev.status ?? null,
          permanent: ev.permanent,
          latencyMs: ev.latencyMs,
          providerMessage: ev.message,
          message: `✖ ${ev.label}${ev.status ? ` HTTP ${ev.status}` : ''} — ${trimText(String(ev.message || 'failed'), 300)}`,
        });
      case 'round':
        return emit({
          ...base,
          type: 'provider',
          stage: 'round',
          message: ev.message,
        });
      default:
        return emit(ev);
    }
  };
}

/**
 * Plain text generation + the metadata of the call that produced it.
 * @returns {Promise<{text:string, used:object, attempts:array, rounds:number}>}
 */
export async function generateWithMeta({
  registry,
  system,
  user,
  temperature = 0.2,
  maxTokens = 4096,
  emit,
  prefer,
  operation = 'generate',
}) {
  const started = Date.now();
  const bridged = bridgeProviderEvents(emit);
  const res = await runWithFailover({
    registry,
    emit: bridged,
    prefer,
    operation,
    work: (entry) => callProviderEntry(entry, { system, user, temperature, maxTokens }),
  });
  return {
    text: String(res.result ?? ''),
    used: {
      provider: res.used?.provider,
      providerLabel: res.used?.providerLabel,
      model: res.used?.model,
      keyId: res.used?.keyId,
      latencyMs: res.latencyMs ?? Date.now() - started,
      switched: Boolean(res.switched),
      rounds: res.rounds,
      attempts: res.attempts?.length || 0,
      operation,
    },
    attempts: res.attempts || [],
    rounds: res.rounds,
  };
}

/** Plain text generation. `registry` is Forge's ProviderRegistry. */
export async function generate(opts) {
  const { text } = await generateWithMeta(opts);
  return text;
}

// Generate and coerce to JSON (tolerates code fences and surrounding prose).
export async function generateJSON(opts) {
  const meta = await generateWithMeta(opts);
  const text = meta.text;
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const emit = opts?.emit;
  try {
    return JSON.parse(cleaned);
  } catch {
    /* fall through to brace extraction */
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      /* fall through to the rich error below */
    }
  }
  // This used to throw a bare Error with a 200-char slice. Now the whole call
  // is reconstructible from the trace: which key, which model, what it said.
  const error = new Error(
    `${meta.used?.provider || 'provider'}/${meta.used?.model || '?'} answered with invalid JSON (${cleaned.length} chars). ` +
      `First 300: ${trimText(cleaned, 300)}`,
  );
  error.name = 'InvalidJSONError';
  error.provider = meta.used?.provider;
  error.where = opts?.operation || 'generateJSON';
  error.attempts = meta.attempts;
  error.raw = cleaned;
  emit?.({
    type: 'log',
    level: 'warn',
    message: `Model returned invalid JSON — ${errorSummary(error)}`,
    text: trimText(cleaned, 1200),
    provider: meta.used?.provider,
    model: meta.used?.model,
  });
  throw error;
}
