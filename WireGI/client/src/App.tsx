import { useCallback, useEffect, useState } from 'react';
import HomePage from './pages/HomePage';
import ProjectPage from './pages/ProjectPage';
import { health as healthApi } from './api';
import { useProject } from './lib/useProject';
import type { Health } from './types';

// Hash routing: #/p/<projectId> — a reload keeps you on the same project.
const readHash = () => {
  const m = window.location.hash.match(/^#\/p\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
};

export default function App() {
  const [projectId, setProjectId] = useState<string | null>(readHash());
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    const onHash = () => setProjectId(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const poll = () => healthApi().then(setHealth).catch(() => setHealth(null));
    poll();
    const id = setInterval(poll, 20000);
    return () => clearInterval(id);
  }, []);

  const open = useCallback((id: string) => {
    window.location.hash = `#/p/${id}`;
    setProjectId(id);
  }, []);

  const goHome = useCallback(() => {
    window.location.hash = '';
    setProjectId(null);
  }, []);

  // Landing page → create the project, then navigate to it while it streams.
  const starter = useProject(null);
  const start = useCallback(
    async (goal: string) => {
      const p = await starter.startBuild(goal);
      if (p?.id) open(p.id);
    },
    [open, starter],
  );

  if (!projectId) {
    return <HomePage onOpen={open} health={health} onStart={start} busy={starter.busy} flow={starter.flow} />;
  }
  return <ProjectPage projectId={projectId} health={health} onHome={goHome} />;
}
