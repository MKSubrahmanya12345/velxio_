import { useMemo, useState } from 'react';
import type { ProjectSummary } from './types';
import Avatar from './Avatar';

/** Long-form clock for the thread; short for the list. */
export function timeOf(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const withinWeek = now.getTime() - d.getTime() < 7 * 86400000;
  if (withinWeek) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export function previewOf(p: ProjectSummary): string {
  if (p.needsYou > 0) return `Needs your eyes · ${p.needsYou} part${p.needsYou === 1 ? '' : 's'}`;
  if (p.lastMessageRole && p.lastMessageAt) return p.lastMessagePreview || '—';
  return 'No messages yet';
}

export default function ChatsList({
  projects,
  onOpen,
  onNewChat,
}: {
  projects: ProjectSummary[];
  onOpen: (id: string) => void;
  onNewChat: () => void;
}) {
  const [q, setQ] = useState('');
  const needsYouTotal = useMemo(
    () => projects.reduce((n, p) => n + (p.needsYou || 0), 0),
    [projects],
  );

  const filtered = useMemo(() => {
    if (!q.trim()) return projects;
    const needle = q.trim().toLowerCase();
    return projects.filter((p) => p.goal.toLowerCase().includes(needle));
  }, [projects, q]);

  return (
    <div className="chats">
      <header className="wa-header">
        <div className="wa-header-title">
          <h1>Builds</h1>
          <span className="wa-header-sub">
            {needsYouTotal > 0 ? `${needsYouTotal} part${needsYouTotal === 1 ? '' : 's'} need you` : 'agentic build assistant'}
          </span>
        </div>
        <button className="new-chat-btn" onClick={onNewChat} title="Create a new chat">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
          <span>New chat</span>
        </button>
      </header>

      <div className="chats-search">
        <SearchIcon />
        <input type="text" placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="chats-list">
        {filtered.length === 0 && (
          <div className="empty">
            {projects.length === 0 ? (
              <>
                <p className="empty-title">No builds yet</p>
                <p className="empty-sub">
                  Create a new chat, describe what you want to build — the agent researches it,
                  builds it in the simulator and tells you what to do.
                </p>
                <button className="ck-btn ck-btn--primary" onClick={onNewChat}>
                  + Create a new chat
                </button>
              </>
            ) : (
              <>
                <p className="empty-title">No chats match “{q}”</p>
                <p className="empty-sub">Try a different search.</p>
              </>
            )}
          </div>
        )}
        {filtered.map((p) => (
          <button key={p.id} className="chat-row" onClick={() => onOpen(p.id)}>
            <Avatar name={p.goal} status={p.status} />
            <div className="chat-row-body">
              <div className="chat-row-title">{p.goal}</div>
              <div className={`chat-row-preview${p.needsYou > 0 ? ' preview--need' : ''}`}>
                {previewOf(p)}
              </div>
            </div>
            <div className="chat-row-side">
              <span className="chat-row-time">{timeOf(p.lastMessageAt || p.updatedAt)}</span>
              {p.needsYou > 0 && <span className="need-pill">{p.needsYou}</span>}
            </div>
          </button>
        ))}
      </div>

      {projects.length > 0 && (
        <div className="chats-foot">
          <span className={`status-chip ${projects.some((p) => p.status === 'researching') ? 'status-chip--live' : ''}`}>
            {projects.some((p) => p.status === 'researching')
              ? 'a build is running'
              : `${projects.length} chat${projects.length === 1 ? '' : 's'}`}
          </span>
        </div>
      )}
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}
