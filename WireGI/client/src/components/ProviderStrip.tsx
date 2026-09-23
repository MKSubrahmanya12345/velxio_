import { useEffect, useState } from 'react';
import { health } from '../api';

export default function ProviderStrip() {
  const [info, setInfo] = useState<any>(null);
  useEffect(() => {
    health().then(setInfo).catch(() => {});
  }, []);
  if (!info) return <span className="status-pill">…</span>;
  return (
    <span className="status-pill">
      JEV: {info.jev} · Providers: {info.providers}
    </span>
  );
}
