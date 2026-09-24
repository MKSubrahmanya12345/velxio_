import { useEffect, useState } from 'react';
import ChatsList from './ChatsList';
import NewChat from './NewChat';
import Thread from './Thread';
import TasksScreen from './TasksScreen';
import { health, listProjects } from './api';
import type { ProjectSummary } from './types';

// The WireGI chat experience inside Velxio — the same UI the WireGI mobile
// app has (chat list, thread with checkpoint cards, tasks), plus the flow the
// mobile app never had: create a new chat right here, prompt, and watch the
// agent think → use tools → tell you what to do.
//
// Routing is hash-based inside the page (#/new, #/tasks, #/p/<id>) so it
// composes with the app's BrowserRouter without touching its routes.

type Route = { view: 'chats' } | { view: 'new' } | { view: 'tasks' } | { view: 'thread'; id: string };

function routeOf(hash: string): Route {
  if (hash.startsWith('#/new')) return { view: 'new' };
  if (hash.startsWith('#/tasks')) return { view: 'tasks' };
  const m = hash.match(/^#\/p\/([^/]+)/);
  if (m) return { view: 'thread', id: decodeURIComponent(m[1]) };
  return { view: 'chats' };
}

export default function AgentChatApp() {
  const [route, setRoute] = useState<Route>(() => routeOf(window.location.hash));
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [server, setServer] = useState<'ok' | 'down'>('ok');
  const [openTasks, setOpenTasks] = useState(0);

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

  const openThread = (id: string) => {
    window.location.hash = `#/p/${encodeURIComponent(id)}`;
  };

  return (
    <div className="agc">
      <div className="app">
      {server === 'down' && (
        <div className="conn-banner">
          <span className="conn-dot" /> can't reach the agent server (WireGI on
          localhost:4322) — start it with `npm run dev` inside WireGI/server, then this
          reconnects automatically.
        </div>
      )}
      {route.view === 'chats' && (
        <ChatsList
          projects={projects}
          onOpen={openThread}
          onNewChat={() => {
            window.location.hash = '#/new';
          }}
        />
      )}
      {route.view === 'new' && (
        <NewChat
          onCancel={() => {
            window.location.hash = '#/';
          }}
          onCreated={(p) => openThread(p.id)}
        />
      )}
      {route.view === 'tasks' && (
        <TasksScreen projects={projects} onOpenThread={openThread} onCountChange={setOpenTasks} />
      )}
      {route.view === 'thread' && (
        <Thread
          projectId={route.id}
          onBack={() => {
            window.location.hash = '#/';
          }}
        />
      )}

      {route.view !== 'thread' && (
        <nav className="tabbar">
          <button
            className={`tab${route.view === 'chats' || route.view === 'new' ? ' active' : ''}`}
            onClick={() => {
              window.location.hash = '#/';
            }}
          >
            <span className="tab-ico">
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.4 8.9 8.9 0 0 1-3.1-.6L3 21l1.7-6.1a8.2 8.2 0 0 1-.7-3.4A8.4 8.4 0 0 1 12.5 3h.5a8.4 8.4 0 0 1 8 8v.5z" />
              </svg>
            </span>
            <span className="tab-label">Chats</span>
          </button>
          <button
            className={`tab${route.view === 'tasks' ? ' active' : ''}`}
            onClick={() => {
              window.location.hash = '#/tasks';
            }}
          >
            <span className="tab-ico">
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 6h13M8 12h13M8 18h13" />
                <path d="M3 6h.01M3 12h.01M3 18h.01" />
              </svg>
            </span>
            <span className="tab-label">Tasks</span>
            {openTasks > 0 && <span className="tab-badge">{openTasks}</span>}
          </button>
        </nav>
      )}
      </div>
    </div>
  );
}
