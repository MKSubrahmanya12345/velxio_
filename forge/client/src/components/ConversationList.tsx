import { useMemo, useState } from 'react';
import type { Conversation } from '../types';
import { progressOf } from '../state';

export function ConversationList({ conversations, currentId, loading, onSelect, onDelete }: {
  conversations: Conversation[];
  currentId: string | null;
  loading?: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => conversations
    .filter(c => c.title.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)), [conversations, query]);

  return (
    <>
      <div className="fg-history-search">
        <label className="fg-human-label" htmlFor="search-builds">Your builds <span>{conversations.length}</span></label>
        <input id="search-builds" type="search" className="fg-input" placeholder="Search builds…" value={query} onChange={e => setQuery(e.target.value)} />
      </div>
      <div className="fg-conv-list" aria-label="Conversations" aria-busy={loading}>
        {loading && !conversations.length ? <p className="fg-history-empty" role="status">Loading your builds…</p> : !visible.length ? (
          <div className="fg-history-empty">
            <strong>{query.trim() ? 'No matching builds' : 'A fresh workbench'}</strong>
            <p>{query.trim() ? 'Try a different search.' : 'Start a build above. Your plans and progress will live here.'}</p>
          </div>
        ) : visible.map(c => {
          const progress = progressOf(c.projectState);
          return (
            <div key={c.id} className={currentId === c.id ? 'fg-conv-item fg-conv-active' : 'fg-conv-item'}>
              <button className="fg-conv-btn" aria-current={currentId === c.id ? 'page' : undefined} onClick={() => onSelect(c.id)}>
                <div className="fg-conv-title">{c.title || 'Untitled build'}</div>
                <div className="fg-conv-meta">
                  <span>{new Date(c.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                  <span>·</span>
                  <span>{c.projectState?.status === 'complete' ? 'Complete' : progress.total ? `${progress.completed}/${progress.total} steps` : 'Planning'}</span>
                </div>
              </button>
              <button className="fg-conv-del" onClick={() => onDelete(c.id)} aria-label={`Delete ${c.title || 'untitled build'}`} title="Delete build">×</button>
            </div>
          );
        })}
      </div>
    </>
  );
}
