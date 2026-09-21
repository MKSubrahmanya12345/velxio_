import type { Health } from '../types';

// Live provider badges: which Jev / planner / store are active. Mock badges
// are amber-ish so nobody mistakes an offline run for a TypeSafe-backed one.
export function ProviderStrip({ health, offline }: { health: Health | null; offline: boolean }) {
  if (offline) return <span className="fg-prov fg-prov-off">offline</span>;
  if (!health) return null;
  const items: [string, string][] = [
    ['JEV', health.providers.jev],
    ['PLANNER', health.providers.planner],
    ['STORE', health.providers.store],
  ];
  return (
    <div className="fg-provs">
      {items.map(([k, v]) => (
        <span key={k} className={v === 'mock' ? 'fg-prov fg-prov-mock' : 'fg-prov fg-prov-live'}>
          {k} · {v}
        </span>
      ))}
    </div>
  );
}
