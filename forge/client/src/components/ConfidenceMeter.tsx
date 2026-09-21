// Visualizes the confidence a Jev decision came back with — the whole point
// of calibrated decisions is that this number is meaningful.
export function ConfidenceMeter({ value, label }: { value: number; label?: string }) {
  const pct = Math.round(value * 100);
  const tier = value >= 0.85 ? 'high' : value >= 0.6 ? 'med' : 'low';
  return (
    <div className="fg-conf" title="Jev confidence for the latest decision of this kind">
      <div className="fg-conf-bar">
        <div className={`fg-conf-fill fg-conf-${tier}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="fg-conf-label">
        {label ? `${label} ` : ''}{pct}%
      </span>
    </div>
  );
}
