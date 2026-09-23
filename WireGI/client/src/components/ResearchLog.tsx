export default function ResearchLog({
  log,
}: {
  log: Array<{ part: string; web: { engine: string; count: number }; ts: string }>;
}) {
  return (
    <div className="panel">
      <h3>Research log</h3>
      {log.length === 0 ? (
        <div style={{ color: 'var(--muted)' }}>none yet</div>
      ) : (
        <ul className="tight">
          {log.map((r, i) => (
            <li key={i}>
              {r.part} — <code>{r.web.engine}</code> ({r.web.count})
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
