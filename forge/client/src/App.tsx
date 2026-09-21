import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { Health, Project } from './types';
import { ProviderStrip } from './components/ProviderStrip';
import { NewProjectForm } from './components/NewProjectForm';
import { ProjectList } from './components/ProjectList';
import { BenchView } from './components/BenchView';
import { HowItWorks } from './components/HowItWorks';

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [current, setCurrent] = useState<Project | null>(null);
  const [offline, setOffline] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setProjects(await api.list());
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setOffline(true));
    refresh();
  }, [refresh]);

  return (
    <div className="fg-shell">
      <header className="fg-header">
        <div className="fg-header-inner">
          <button className="fg-logo" onClick={() => { setCurrent(null); refresh(); }}>
            Velxio <span>Forge</span>
          </button>
          <ProviderStrip health={health} offline={offline} />
        </div>
      </header>

      <main className="fg-main">
        {offline && !current && (
          <div className="fg-banner fg-banner-warn">
            Server unreachable — start the API (<code>cd forge/server &amp;&amp; npm install &amp;&amp; npm run dev</code>) and reload. See forge/README.md.
          </div>
        )}
        {current ? (
          <BenchView
            project={current}
            onProject={(p) => { setCurrent(p); refresh(); }}
            onBack={() => { setCurrent(null); refresh(); }}
          />
        ) : (
          <div className="fg-home">
            <div className="fg-hero">
              <h1>
                What are we <em>building</em>?
              </h1>
              <p className="fg-sub">
                Give Forge a goal. It runs the feasibility gate, synthesizes the plan,
                simulates what can be simulated, then works the build with you — one step at a time.
              </p>
            </div>
            <HowItWorks />
            <NewProjectForm onCreated={created} />
            <ProjectList projects={projects} onOpen={(p) => setCurrent(p)} />
          </div>
        )}
      </main>
    </div>
  );

  function created(p: Project) {
    setCurrent(p);
    refresh();
  }
}
