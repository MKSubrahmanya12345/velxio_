import { useEffect, useState } from 'react';
import ChatsList from './components/ChatsList';
import Thread from './components/Thread';
import { health, listProjects } from './lib/api';
import type { ProjectSummary } from './lib/types';

type Route = { view: 'chats' } | { view: 'thread'; id: string };

function routeOf(hash: string): Route {
  const m = hash.match(/^#\/p\/([^/]+)/);
  if (m) return { view: 'thread', id: decodeURIComponent(m[1]) };
  return { view: 'chats' };
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => routeOf(window.location.hash));
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [server, setServer] = useState<'ok' | 'down'>('ok');

  useEffect(() => {
    const onHash = () => setRoute(routeOf(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const list = await listProjects();
        if (!alive) return;
        setProjects(list);
        setServer('ok');
      } catch {
        if (!alive) return;
        setServer('down');
        try {
          const h = await health();
          if (alive && h.ok) setServer('ok');
        } catch {
          /* stays down */
        }
      }
    };
    void tick();
    const id = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="app">
      {server === 'down' && (
        <div className="conn-banner">
          <span className="conn-dot" /> can't reach the WireGI server (localhost:4322) — retrying…
        </div>
      )}
      {route.view === 'chats' && (
        <ChatsList
          projects={projects}
          onOpen={(id) => {
            window.location.hash = `#/p/${encodeURIComponent(id)}`;
          }}
        />
      )}
      {route.view === 'thread' && (
        <Thread
          projectId={route.id}
          onBack={() => {
            window.location.hash = '#/';
          }}
        />
      )}
    </div>
  );
}