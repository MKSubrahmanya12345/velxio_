import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { progressOf } from '../state';
import { api } from '../api';
import { MemoryPanel } from './MemoryPanel';
import type { MemoryEvent, MemoryNote, Conversation, ChatMessage, HumanToolCall } from '../types';

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
        <div className={`fg-md${isUser ? ' fg-md-plain' : ''}`}>
          {isUser ? msg.content : <Markdown skipHtml>{msg.content}</Markdown>}
        </div>
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
        <span className="fg-human-title">{a.task}</span>
        <span className={`fg-human-status fg-human-${tool.status}`}>{{ requires_action: 'Your next step', completed: 'Completed', failed: 'Needs attention' }[tool.status]}</span>
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
  provider,
}: {
  conversation: Conversation;
  onUpdate: (c: Conversation) => void;
  onBack: () => void;
  provider?: string;
}) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [events, setEvents] = useState<MemoryEvent[]>([]);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(false);
  const nearBottom = useRef(true);
  const progress = progressOf(conversation.projectState);

  useEffect(() => {
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (nearBottom.current || busy) endRef.current?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'end' });
  }, [conversation.messages.length, busy]);

  const send = async (text: string) => {
    if (!text.trim() || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError('');
    setEvents([]);
    try {
      const r = await api.message(conversation.id, { text: text.trim(), provider: provider || undefined }, event => setEvents(list => [...list, event]));
      setInput('');
      onUpdate(r.conversation);
      setEvents([]);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  // Quick actions prepare a report; only the user can supply evidence of completion.
  const prepareReport = (prefix: string) => {
    setInput(value => value.trim() ? value : prefix);
    inputRef.current?.focus();
  };

  const changeNote = (note: MemoryNote) => {
    if (input.trim() && !window.confirm('Replace your current draft with a note-change request?')) return;
    const target = note.status === 'pending' && note.supersedes.length ? note.supersedes[0] : note.id;
    setInput(`Replace note ${target}: `);
    setMemoryOpen(false);
    inputRef.current?.focus();
  };

  const pendingTool = conversation.pendingHumanTools?.find(t => t.status === 'requires_action');
  const pendingQuestions = conversation.memory?.notes.filter(n => n.kind === 'question' && (n.status === 'pending' || n.status === 'proposed')) || [];
  const showDecision = pendingQuestions.length > 0;

  return (
    <div className="fg-chat-workspace">
    <div className="fg-chat">
      <div className="fg-chat-head">
        <button className="fg-back" onClick={onBack}>← new build</button>
        <div className="fg-chat-title">
          <strong>{conversation.title}</strong>
          <span className="fg-muted">{conversation.counters?.jevCalls || 0} JEV calls · {conversation.counters?.humanCalls || 0} human calls · {conversation.projectState ? `${conversation.projectState.phases.length} phases` : `${conversation.memory?.notes.filter(n => n.status === 'active').length || 0} active notes`}</span>
        </div>
        <button className="fg-btn fg-btn-secondary fg-memory-toggle" aria-expanded={memoryOpen} onClick={() => setMemoryOpen(v => !v)}>Project memory</button>
        {conversation.projectState && (
          <div className="fg-chat-progress">
            <span>{progress.completed}/{progress.total} steps · {Math.round(progress.pct * 100)}%</span>
            <progress aria-label="Build progress" value={progress.completed} max={progress.total || 1} />
          </div>
        )}
      </div>

      <div className="fg-chat-messages" onScroll={e => {
        const el = e.currentTarget;
        nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      }}>
        {conversation.messages.length === 0 && (
          <div className="fg-msg fg-msg-system">
            <div className="fg-msg-content">
              <div>👋 New chat started. Say what you wanna build.</div>
              <div className="fg-muted" style={{ marginTop: 8 }}>Example: “I wanna build an MP3 player with ESP32 and a speaker.” JEV records the decision. This chat does not write the firmware.</div>
            </div>
          </div>
        )}
        {conversation.messages.map(m => (
          <MessageBubble key={m.id} msg={m} />
        ))}
        {busy && <div className="fg-working" role="status" aria-label="Message processing"><span className="fg-working-dot" />Forge is reviewing your message…</div>}
        <div ref={endRef} />
      </div>

      {pendingTool && (
        <div className="fg-pending-banner">
          🔧 Up next: <strong>{pendingTool.arguments.task}</strong> — follow the checks above, then share your observations.
        </div>
      )}

      {showDecision && !pendingTool && (
        <div className="fg-pending-banner" style={{background:'rgba(63,185,80,0.12)', borderColor:'#3fb950'}}>
          Open questions in project memory{pendingQuestions.length ? ` — ${pendingQuestions.length}` : ''}. Answer below if you want them recorded.
          <div style={{marginTop:8, display:'flex', gap:8}}>
            <button className="fg-btn fg-btn-secondary" disabled={busy} onClick={() => inputRef.current?.focus()}>Answer</button>
          </div>
          {pendingQuestions.length>0 && (
            <ul style={{margin:'8px 0 0 18px', fontSize:13}}>
              {pendingQuestions.slice(0,4).map(q => <li key={q.id}>{q.text}</li>)}
            </ul>
          )}
        </div>
      )}

      <div className="fg-composer-area">
        <div className="fg-composer">
          <textarea
            ref={inputRef}
            aria-label="Message Forge"
            aria-describedby="composer-hint"
            className="fg-input fg-textarea fg-textarea-chat"
            rows={2}
            placeholder={pendingTool ? 'What did you observe? Include checks, measurements, or anything that went wrong…' : 'Ask a question or describe what you want to build…'}
            value={input}
            disabled={busy}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(input); }
            }}
          />
          <div className="fg-composer-actions">
            <button className="fg-btn fg-btn-secondary" disabled={busy} onClick={() => prepareReport('My question is: ')}>Ask a question</button>
            {pendingTool && <>
              <button className="fg-btn fg-btn-secondary" disabled={busy} onClick={() => prepareReport('I completed the step. Here is what I checked: ')}>Report progress</button>
              <button className="fg-btn fg-btn-secondary" disabled={busy} onClick={() => prepareReport('The step failed. Here is what happened: ')}>Report a problem</button>
            </>}

            <button className="fg-btn fg-btn-primary" disabled={busy || !input.trim()} onClick={() => send(input)}>{busy ? 'Reviewing…' : 'Send →'}</button>
          </div>
        </div>
        <div className="fg-composer-hints" id="composer-hint">
          <span><kbd>Ctrl / ⌘ + Enter</kbd> to send · Include real observations so Forge can check your progress.</span>
        </div>
        {error && <div className="fg-banner fg-banner-error" role="alert" style={{ marginTop: 8 }}>{error} Your draft is still here. If the connection dropped, reopen this build to check whether the message arrived before sending again.</div>}
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
    <div className={`fg-memory-wrap${memoryOpen ? ' is-open' : ''}`}>
      <button className="fg-memory-close fg-btn fg-btn-secondary" onClick={() => setMemoryOpen(false)}>Close memory ×</button>
      <MemoryPanel memory={conversation.memory} events={events} busy={busy} error={error} onChange={changeNote} />
    </div>
    </div>
  );
}
