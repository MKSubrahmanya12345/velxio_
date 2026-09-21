import type { Health } from '../types';

// Live provider badges: which JEV / generation model / store are active, plus
// the failover policy. Names always come from what is really configured —
// 'unconfigured' is rendered as a warning, never as a provider name.
export function ProviderStrip({ health, offline, onOpenProviders }: { health: Health | null; offline: boolean; onOpenProviders?: () => void }) {
  if (offline) return <span className="fg-prov fg-prov-off">offline</span>;
  if (!health) return null;

  const active = health.activeProvider;
  const generator = active ? `${active.provider}${active.note ? ` · ${active.note}` : ''}` : health.providers.planner;
  const failover = health.failover;
  const tone = (value: string) => (value === 'mock' ? 'fg-prov-mock' : value === 'unconfigured' || !value ? 'fg-prov-warn' : 'fg-prov-live');

  const items: [string, string][] = [
    ['JEV', health.providers.jev],
    ['MODEL', generator],
    ['STORE', health.providers.store],
  ];

  return (
    <div className="fg-provs">
      {items.map(([k, v]) => (
        <span key={k} className={`fg-prov ${tone(v)}`}>
          {k} · {v}
        </span>
      ))}
      {failover && (
        <span
          className={`fg-prov ${failover.enabled && failover.configured ? 'fg-prov-failover' : 'fg-prov-warn'}`}
          title={failover.enabled
            ? `On any error Forge switches key/provider and loops — ${failover.maxRounds} rounds across ${failover.keys} enabled key(s), then stops.`
            : failover.configured
              ? 'Auto-switch is off — only the selected key is used.'
              : 'No providers configured.'}
        >
          FAILOVER · {failover.enabled ? `${failover.maxRounds} rounds · ${failover.keys} keys` : 'off'}
        </span>
      )}
      {onOpenProviders && (
        <button className="fg-prov fg-prov-link" onClick={onOpenProviders} title="Add keys, notes, and switching policy">
          Manage keys
        </button>
      )}
    </div>
  );
}
