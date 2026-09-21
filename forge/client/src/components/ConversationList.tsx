import type { Conversation } from '../types';

export function ConversationList({
  conversations,
  currentId,
  onSelect,
  onDelete,
}: {
  conversations: Conversation[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (!conversations.length) {
    return <div className="fg-muted" style={{ padding: 16 }}>No conversations yet. Start one →</div>;
  }
  return (
    <div className="fg-conv-list">
      {conversations.map(c => (
        <div key={c.id} className={currentId === c.id ? 'fg-conv-item fg-conv-active' : 'fg-conv-item'}>
          <button className="fg-conv-btn" onClick={() => onSelect(c.id)}>
            <div className="fg-conv-title">{c.title || 'Untitled build'}</div>
            <div className="fg-conv-meta">
              <span>{new Date(c.updatedAt).toLocaleDateString()}</span>
              <span>·</span>
              <span>{c.counters?.jevCalls || 0} JEV calls</span>
              {c.projectState && <span>· {c.projectState.phases?.length || 0} phases</span>}
            </div>
          </button>
          <button className="fg-conv-del" onClick={() => onDelete(c.id)} title="Delete">×</button>
        </div>
      ))}
    </div>
  );
}
