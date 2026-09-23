// Generic LLM generation through Forge's failover loop (reuses Forge providers).
import { runWithFailover, callProviderEntry } from '../../../forge/server/src/providers/failover.js';

// Plain text generation. `registry` is Forge's ProviderRegistry.
export async function generate({
  registry, system, user, temperature = 0.2, maxTokens = 4096, emit, prefer, operation = 'generate',
}) {
  const { result } = await runWithFailover({
    registry,
    emit,
    prefer,
    operation,
    work: (entry) => callProviderEntry(entry, { system, user, temperature, maxTokens }),
  });
  return String(result);
}

// Generate and coerce to JSON (tolerates code fences and surrounding prose).
export async function generateJSON(opts) {
  const text = await generate(opts);
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    /* fall through to brace extraction */
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return JSON.parse(cleaned.slice(start, end + 1));
  }
  throw new Error('LLM did not return valid JSON: ' + text.slice(0, 200));
}
