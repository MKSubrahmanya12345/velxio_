import type { Health, GeneratorInfo } from '../types';

// Provider strip: which Jev / store are active, plus the generation-provider
// dropdown. The drop-down lists only *configured* providers (real credentials
// in forge/server/.env) — selecting one switches generation for the next turn.
export function ProviderStrip({
  health,
  offline,
  providers,
  selected,
  onChange,
}: {
  health: Health | null;
  offline: boolean;
  providers: GeneratorInfo[];
  selected: string;
  onChange: (id: string) => void;
}) {
  if (offline) return <span className="fg-prov fg-prov-off">offline</span>;
  const selectedInfo = providers.find(p => p.id === selected);
  return (
    <div className="fg-provs">
      {providers.length > 0 && (
        <label className="fg-prov fg-prov-live fg-prov-select" title={selectedInfo ? `Model: ${selectedInfo.model} — hosts generate with this provider` : 'No model selected'}>
          <select value={selected ?? ''} onChange={e => onChange(e.target.value)} aria-label="Generation model provider">
            <option value="">MODEL</option>
            {providers.map(p => (
              <option key={p.id} value={p.id}>{p.name} · {p.model}</option>
            ))}
          </select>
        </label>
      )}
      <span className="fg-prov fg-prov-live">JEV · {health?.providers.jev || 'none'}</span>
      <span className="fg-prov fg-prov-live">PLANNER · {health?.providers.planner || 'none'}</span>
      <span className="fg-prov fg-prov-live">STORE · {health?.providers.store}</span>
    </div>
  );
}