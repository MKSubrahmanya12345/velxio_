export default function ConfidenceMeter({ value, label }: { value: number; label?: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div>
      {label && (
        <div className="kv">
          <b>{label}</b>
        </div>
      )}
      <div className="meter">
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
