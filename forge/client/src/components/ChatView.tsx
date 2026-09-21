import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Conversation, ChatMessage, HumanToolCall } from '../types';

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user';
  const isTool = msg.role === 'tool';
  return (
    <div className={isUser ? 'fg-msg fg-msg-user' : isTool ? 'fg-msg fg-msg-tool' : 'fg-msg fg-msg-assistant'}>
      <div className="fg-msg-head">
        <span className="fg-msg-avatar">{isUser ? 'You' : isTool ? '🔧' : '⚒ Forge'}</span>
        <span className="fg-msg-time">{new Date(msg.at).toLocaleTimeString()}</span>
      </div>
      <div className="fg-msg-content">
        {/* Render markdown-ish: keep pre-wrap, but bold headers */}
        <div className="fg-md" style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
      </div>
      {msg.decisions && msg.decisions.length > 0 && (
        <div className="fg-msg-decisions">
          {msg.decisions.map((d, i) => (
            <span key={i} className="fg-decision" title={d.summary}>
              <span className="fg-dec-id">{d.id}</span>
              <span className={d.confidence >= 0.85 ? 'fg-dec-high' : d.confidence >= 0.6 ? 'fg-dec-med' : 'fg-dec-low'}>{d.summary}</span>
            </span>
          ))}
        </div>
      )}
      {msg.toolCalls && msg.toolCalls.length > 0 && (
        <div className="fg-msg-tools">
          {msg.toolCalls.map(tc => (
            <HumanToolCard key={tc.id} tool={tc} />
          ))}
        </div>
      )}
    </div>
  );
}

function HumanToolCard({ tool }: { tool: HumanToolCall }) {
  const a = tool.arguments;
  return (
    <div className={tool.status === 'requires_action' ? 'fg-human-card fg-human-pending' : 'fg-human-card fg-human-done'}>
      <div className="fg-human-head">
        <span className="fg-human-icon">🔧</span>
        <span className="fg-human-title">human tool · {a.task}</span>
        <span className={`fg-human-status fg-human-${tool.status}`}>{tool.status}</span>
      </div>
      <div className="fg-human-body">
        <div className="fg-human-section">
          <div className="fg-human-label">Instructions</div>
          <div className="fg-human-text">{a.instructions}</div>
        </div>
        <div className="fg-human-grid">
          <div>
            <div className="fg-human-label">Materials</div>
            <div className="fg-human-chips">
              {a.materials?.length ? a.materials.map((m, i) => <span key={i} className="fg-tool-chip">{m}</span>) : <span className="fg-muted">—</span>}
            </div>
          </div>
          <div>
            <div className="fg-human-label">Tools</div>
            <div className="fg-human-chips">
              {a.tools?.length ? a.tools.map((t, i) => <span key={i} className="fg-tool-chip">{t}</span>) : <span className="fg-muted">—</span>}
            </div>
          </div>
        </div>
        {a.safety?.length > 0 && (
          <div className="fg-human-section">
            <div className="fg-human-label">Safety</div>
            <div className="fg-safety fg-safety-warn">
              {a.safety.map((s, i) => (
                <div key={i} className="fg-safety-item">⚠️ {s.note || s.hazard} ({s.severity})</div>
              ))}
            </div>
          </div>
        )}
        <div className="fg-human-section">
          <div className="fg-human-label">Done when</div>
          <ul className="fg-dod">
            {a.definition_of_done?.map((d, i) => <li key={i}>{d}</li>)}
          </ul>
        </div>
        {a.reason && <div className="fg-human-reason">Reason: {a.reason}{a.attempt ? ` · attempt ${a.attempt}` : ''}</div>}
        {tool.result && (
          <div className="fg-human-result">
            <div className="fg-human-label">Your result</div>
            <div>{tool.result}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export function ChatView({
  conversation,
  onUpdate,
  onBack,
}: {
  conversation: Conversation;
  onUpdate: (c: Conversation) => void;
  onBack: () => void;
}) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [conversation.messages.length]);

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError('');
    setInput('');
    try {
      const r = await api.message(conversation.id, { text: text.trim() });
      onUpdate(r.conversation);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const pendingTool = conversation.pendingHumanTools?.find(t => t.status === 'requires_action');

  return (
    <div className="fg-chat">
      <div className="fg-chat-head">
        <button className="fg-back" onClick={onBack}>← all chats</button>
        <div className="fg-chat-title">
          <strong>{conversation.title}</strong>
          <span className="fg-muted">{conversation.counters?.jevCalls || 0} JEV calls · {conversation.counters?.humanCalls || 0} human calls · {conversation.projectState ? `${conversation.projectState.phases.length} phases` : 'no plan yet'}</span>
        </div>
        {conversation.projectState && (
          <div className="fg-chat-progress">
            <span>{conversation.projectState.counters?.stepsCompleted || 0}/{conversation.projectState.phases?.flatMap(p => p.steps).length || 0} steps</span>
          </div>
        )}
      </div>

      <div className="fg-chat-messages">
        {conversation.messages.length === 0 && (
          <div className="fg-msg fg-msg-system">
            <div className="fg-msg-content">
              <div>👋 New chat started. Say what you wanna build.</div>
              <div className="fg-muted" style={{ marginTop: 8 }}>Example: “I wanna build an MP3 player with ESP32 and a speaker” — I’ll run JEV feasibility, then planner, then call you as human tool for each physical step.</div>
            </div>
          </div>
        )}
        {conversation.messages.map(m => (
          <MessageBubble key={m.id} msg={m} />
        ))}
        <div ref={endRef} />
      </div>

      {pendingTool && (
        <div className="fg-pending-banner">
          🔧 Human tool pending: <strong>{pendingTool.arguments.task}</strong> — execute and report back below. JEV will verify.
        </div>
      )}

      <div className="fg-composer-area">
        <div className="fg-composer">
          <textarea
            className="fg-input fg-textarea fg-textarea-chat"
            rows={2}
            placeholder={pendingTool ? `Report back on "${pendingTool.arguments.task}" — e.g. "done, ${pendingTool.arguments.definition_of_done[0]}" or "it failed, ..." ` : 'Say what you wanna build, or report back on human tool task...'}
            value={input}
            disabled={busy}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(input);
            }}
          />
          <div className="fg-composer-actions">
            <button className="fg-btn fg-btn-secondary" disabled={busy} onClick={() => send('I have a question about the current step')}>? Question</button>
            <button className="fg-btn fg-btn-secondary" disabled={busy} onClick={() => send('done, it looks good and meets definition of done')}>✅ Done</button>
            <button className="fg-btn fg-btn-secondary" disabled={busy} onClick={() => send('it failed, not working as expected')}>✗ Failed</button>
            <button className="fg-btn fg-btn-primary" disabled={busy || !input.trim()} onClick={() => send(input)}>{busy ? '…' : 'Send'}</button>
          </div>
        </div>
        <div className="fg-composer-hints">
          <span><kbd>⌘+Enter</kbd> to send</span>
          <span>·</span>
          <span>JEV decides intent, feasibility, verification in between</span>
          <span>·</span>
          <span>Human as tool: I call, you execute</span>
        </div>
        {error && <div className="fg-banner fg-banner-error" style={{ marginTop: 8 }}>{error}</div>}
      </div>

      {conversation.projectState && (
        <details className="fg-plan-details">
          <summary>View current plan: {conversation.projectState.goal} — {conversation.projectState.phases.length} phases</summary>
          <div className="fg-plan-grid">
            {conversation.projectState.phases.map(phase => (
              <div key={phase.id} className="fg-plan-phase">
                <div className="fg-plan-phase-title">{phase.name}</div>
                {phase.steps.map(s => (
                  <div key={s.id} className={s.status === 'done' ? 'fg-plan-step fg-plan-done' : s.id === conversation.projectState?.current.stepId ? 'fg-plan-step fg-plan-current' : 'fg-plan-step'}>
                    <span className="fg-plan-step-track">{s.track}</span>
                    <span>{s.title}</span>
                    {s.status === 'done' && <span className="fg-plan-check">✓</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
