import type { Health } from '../types';

/** Compact live-plumbing readout: Jev mode, provider keys, web search. */
export default function ProviderStrip({ health }: { health: Health | null }) {
  if (!health) return <span className="pill subtle">connecting…</span>;
  const llmOk = health.providers > 0;
  return (
    <span className="pills">
      <span className={`pill ${health.jev === 'typesafe' ? 'good' : 'subtle'}`} title="Typed decision layer">
        JEV {health.jev === 'typesafe' ? 'live' : 'llm-fallback'}
      </span>
      <span
        className={`pill ${llmOk ? 'good' : 'bad'}`}
        title={
          llmOk
            ? `Active: ${health.activeProvider || '?'}`
            : 'No provider key configured — runs will fail at the first LLM call. Fix it in the Debug tab.'
        }
      >
        {llmOk ? `${health.providers} key${health.providers === 1 ? '' : 's'}` : 'no LLM key'}
      </span>
      <span className={`pill ${health.webSearch ? 'good' : 'subtle'}`} title="Web search for research">
        web {health.webSearch || 'off'}
      </span>
    </span>
  );
}
