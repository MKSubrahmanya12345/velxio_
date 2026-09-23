import type { ReactNode } from 'react';

export default function StepCard({
  title,
  children,
  active,
}: {
  title: string;
  children?: ReactNode;
  active?: boolean;
}) {
  return (
    <div className="part-card" style={{ borderColor: active ? 'var(--accent)' : 'var(--border)' }}>
      <div className="part-head" style={{ cursor: 'default' }}>
        <span className="name">{title}</span>
        {active && <span className="badge data_ready">active</span>}
      </div>
      <div className="part-body">{children}</div>
    </div>
  );
}
