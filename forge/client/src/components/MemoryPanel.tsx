import { useEffect, useState } from 'react';
import type { MemoryEvent, MemoryNote, ProjectMemory } from '../types';

const labels = { goal: 'Goal', rule: 'User rule', fact: 'Fact', preference: 'Preference', assumption: 'AI inference', suggestion: 'AI suggestion', question: 'Open question' };
const domains: Record<string, string> = { production: 'Real-world production', fiction: 'Story world', creative: 'Creative direction', meta: 'Collaboration process', unknown: 'Scope not established' };
const checkLabels: Record<string, string> = { pass: 'respected by response', conflict: 'contradiction found', uncertain: 'uncertain — not a confirmed conflict', unknown: 'no usable JEV value' };
const stages = [ ['gate', 'Gate'], ['extract', 'Form'], ['review', 'JEV'], ['context', 'Context'], ['generate', 'Draft'], ['check', 'Check'] ] as const;

const modeLabels: Record<string, string> = { answer: 'answer', clarify_first: 'ask first', rule_change: 'rule change', out_of_scope: 'out of scope' };

export function MemoryPanel({ memory, events = [], busy = false, error = '', onChange, onOpenGlobalRules }: {
  onOpenGlobalRules?: () => void;
  memory?: ProjectMemory;
  events?: MemoryEvent[];
  busy?: boolean;
  error?: string;
  onChange?: (note: MemoryNote) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [replayStep, setReplayStep] = useState<number | null>(null);
  const recorded = memory?.events || [];
  const source = events.length ? events : recorded;
  const turnId = source[source.length - 1]?.turnId;
  const recordedTurn = source.filter(e => e.turnId === turnId);
  const replaying = replayStep !== null && !busy;
  const trace = replaying ? recordedTurn.slice(0, replayStep + 1) : recordedTurn;
  useEffect(() => { setReplayStep(null); }, [busy, turnId]);
  useEffect(() => {
    if (replayStep === null || busy) return;
    const timer = window.setTimeout(() => setReplayStep(step => step !== null && step < recordedTurn.length - 1 ? step + 1 : null), 650);
    return () => window.clearTimeout(timer);
  }, [replayStep, busy, recordedTurn.length]);
  const last = trace[trace.length - 1];
  const snapshot = !error && busy ? [...trace].reverse().find(e => e.stage === 'context')?.notes : undefined;
  const candidates = busy && !snapshot && !error ? trace.find(e => e.proposals)?.proposals || [] : [];
  const notes = snapshot || memory?.notes || [];
  const activeRules = notes.filter(n => n.status === 'active' && n.kind === 'rule');
  const priority = (n: MemoryNote) => n.status === 'pending' ? 0 : n.status === 'active' && n.kind === 'rule' ? 1 : n.status === 'active' ? 2 : n.status === 'proposed' ? 3 : 4;
  const visible = (showAll ? [...notes] : notes.filter(n => !['superseded', 'rejected'].includes(n.status))).sort((a, b) => priority(a) - priority(b));
  const checks = [...trace].reverse().find(e => e.checks)?.checks || [];
  const checking = (busy || replaying) && last?.stage === 'check' && last.status === 'running';
  const liveIds = new Set(trace.find(e => e.stage === 'review' && e.status === 'complete')?.noteIds || []);
  const mock = last?.providers.jev === 'mock';
  const directive = [...trace].reverse().find(e => e.stage === 'gate' && e.directive)?.directive;
  const globalApplied = directive?.applicableRules.filter(r => r.source === 'global') || [];

  return (
    <aside className="fg-memory" aria-label="Project memory">
      <div className="fg-memory-heading">
        <div><span className="fg-memory-eyebrow">THE PROJECT REMEMBERS</span><h2>Project memory <span>{activeRules.length} {activeRules.length === 1 ? 'rule' : 'rules'}</span></h2></div>
        <span className={`fg-memory-beacon${busy || replaying ? ' is-live' : ''}`} aria-hidden="true" />
      </div>
      <p className="fg-memory-intro">Your rules persist. AI ideas stay tentative. JEV checks what changes—and what comes next.</p>
      {last && <div className="fg-memory-providers">
        <span>{last.providers.generator === 'mock' ? 'Demo generator' : `LLM · ${last.providers.generator}`}</span>
        <span>{mock ? 'Demo JEV · heuristics' : 'Live JEV'}</span>
      </div>}
      <div className="fg-memory-flow" aria-label="Memory processing stages">
        {stages.map(([stage, title]) => {
          const state = [...trace].reverse().find(e => e.stage === stage);
          return <div key={stage} className={`fg-memory-node ${state ? `is-${state.status}` : ''}`}><span>{state?.status === 'complete' ? '✓' : state?.status === 'blocked' ? '!' : '·'}</span><small>{title}</small></div>;
        })}
      </div>
      <div className={`fg-memory-status${error ? ' has-error' : ''}`} role="status" aria-label="Memory processing" aria-live="polite">
        {error ? 'Turn interrupted · working changes were not confirmed' : replaying ? `Replay · ${last?.label || 'Recorded events'}` : busy ? last?.label || 'Starting the memory loop…' : last ? 'Last turn · recorded decision trail' : 'Memory will form as you describe your project.'}
      </div>
      {!busy && recordedTurn.length > 0 && <button className="fg-memory-replay" onClick={() => setReplayStep(replaying ? null : 0)}>{replaying ? 'Stop replay ■' : 'Replay recorded turn ↻'}</button>}
      {directive && <section className="fg-memory-gate" aria-label="Pre-turn gate">
        <header><span>JEV pre-turn gate</span><small>mode · {modeLabels[directive.mode] || directive.mode}</small></header>
        {directive.applicableRules.length > 0
          ? <ul>{directive.applicableRules.map(r => <li key={r.id}><em className={`src-${r.source}`}>{r.source}</em><span>{r.text}{r.unresolved && <small> · no JEV value, kept in force</small>}</span></li>)}</ul>
          : <p>No rules applied to this message.</p>}
        {onOpenGlobalRules && <p>{globalApplied.length ? `${globalApplied.length} global rule${globalApplied.length === 1 ? '' : 's'} applied. ` : ''}<button onClick={onOpenGlobalRules}>Manage global rules →</button></p>}
      </section>}
      {!directive && onOpenGlobalRules && <p className="fg-memory-caveat" style={{ margin: '0 0 14px' }}>Global rules apply to every chat. <button className="fg-link-btn" onClick={onOpenGlobalRules}>Manage global rules →</button></p>}
      {busy && <p className="fg-memory-caveat">Working copy · saved only when this turn finishes.</p>}
      <div className="fg-memory-notes">
        {!notes.length && !candidates.length && <div className="fg-memory-empty"><span>＋</span><strong>Start with what matters.</strong><p>“Only one person.” “No paid tools.” “This must work offline.” Rules emerge from your words—not a fixed form.</p></div>}
        {candidates.map(n => <article key={n.id} className="fg-memory-note is-forming"><header><span>{labels[n.kind]}</span><small>Proposed · awaiting JEV</small></header><p>{n.text}</p></article>)}
        {visible.map(note => {
          const check = checks.find(c => c.noteId === note.id);
          return <article key={`${note.id}-${note.status}`} className={`fg-memory-note note-${note.kind} status-${note.status}${liveIds.has(note.id) ? ' is-new' : ''}${checking && last.noteIds?.includes(note.id) ? ' is-checking' : ''}`}>
            <header><span>{labels[note.kind]}</span><small>{note.status === 'active' && note.kind === 'rule' ? 'Binding' : note.status}</small></header>
            <p>{note.text}</p>
            {check && <div className={`fg-memory-check check-${check.verdict}`}><span>{check.verdict === 'pass' ? '✓' : '!'}</span>{mock ? 'Demo check' : 'JEV check'} · {checkLabels[check.verdict] || check.verdict}</div>}
            <details className="fg-memory-source"><summary>Why is this here?</summary>
              <p>{note.reason}</p>
              {note.quote ? <blockquote>“{note.quote}”</blockquote> : <p>AI-generated, not a statement from you.</p>}
              {note.domain && note.domain !== 'unknown' && <p>Scope: {domains[note.domain] || note.domain}</p>}
              {note.review && <small>Review: label {note.review.classification ?? `uncertain (${note.review.labelLean ?? 'no lean'})`} · support {note.review.support ?? '—'} · compatibility {note.review.compatible ?? '—'}{note.review.conflictsWith ? ` · conflicts with ${note.review.conflictsWith}` : ''}</small>}
              {note.supersedes.length > 0 && <p>{note.status === 'active' ? 'Replaces' : 'Proposes replacing'}: {note.supersedes.join(', ')}</p>}
              {note.supersededBy && <p>Replaced by: {note.supersededBy}</p>}
              {note.sourceMessageId && <small>Source: {note.sourceMessageId}</small>}
            </details>
            {onChange && ['active', 'pending', 'proposed'].includes(note.status) && <button className="fg-memory-edit" disabled={busy} onClick={() => onChange(note)}>Change this note ↗</button>}
          </article>;
        })}
      </div>
      {notes.some(n => ['rejected', 'superseded'].includes(n.status)) && <button className="fg-memory-history" onClick={() => setShowAll(v => !v)}>{showAll ? 'Hide retired notes' : 'Show retired / rejected notes'}</button>}
      {trace.length > 0 && <details className="fg-memory-trace"><summary>Decision trail <span>{trace.length} events</span></summary><ol>
        {trace.map(e => <li key={e.id} className={`trace-${e.status}`}><span className="fg-trace-dot" /><div><strong>{e.label}</strong><small>{new Date(e.at).toLocaleTimeString()} · {e.stage}</small>
          {e.checks?.map(c => <p key={c.noteId}>{c.verdict === 'pass' ? '✓' : '!'} {c.text} <span>({checkLabels[c.verdict] || c.verdict}{c.value !== null && c.value !== undefined ? ` · ${c.value}` : ''})</span></p>)}
          {e.blocking?.map((b, i) => <p key={i} className="fg-trace-block">held by: {b.type}{b.text ? ` — ${b.text}` : ''}{b.detail ? ` — ${b.detail}` : ''}</p>)}
          {e.raw != null && <details className="fg-memory-raw"><summary>Raw JEV response</summary><pre>{JSON.stringify(e.raw, null, 2)}</pre></details>}
        </div></li>)}
      </ol></details>}
      <p className="fg-memory-caveat">{mock ? 'Demo scores are scripted examples, not semantic verification. Connect JEV and an LLM for open-ended reasoning.' : 'JEV evaluates consistency, not real-world truth. A passed check is not proof that a physical result works.'}</p>
    </aside>
  );
}
