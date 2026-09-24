import { useRef, useState } from 'react';
import type { FlowEntry, Project } from './types';
import { createProject } from './api';

const SUGGESTIONS = [
  'A drone I can build and fly this weekend, budget $150',
  'ESP32 bluetooth mouse for my PC',
  'RC car with obstacle avoidance',
  'Arduino weather station with a display',
];

/**
 * The "create a new chat" flow: prompt → the agent runs (classify, decompose,
 * research, reconcile, build in the simulator) with live progress → the
 * thread opens. The first prompt IS the project goal.
 */
export default function NewChat({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (p: Project) => void;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<FlowEntry[]>([]);
  const [err, setErr] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const start = (text: string) => {
    const goal = text.trim();
    if (!goal || busy) return;
    setBusy(true);
    setErr('');
    setActivity([]);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    createProject(
      goal,
      (ev) => setActivity((l) => [...l.slice(-6), ev]),
      ctrl.signal,
    )
      .then((p) => {
        if (abortRef.current === ctrl) onCreated(p);
      })
      .catch((e) => {
        if (abortRef.current !== ctrl) return;
        setBusy(false);
        setErr(String((e as { message?: string })?.message || e));
      });
  };

  const cancel = () => {
    abortRef.current?.abort();
    setBusy(false);
    setActivity([]);
  };

  return (
    <div className="chats new-chat">
      <header className="wa-header">
        <button className="icon-btn" onClick={busy ? cancel : onCancel} aria-label="Back">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="wa-header-title">
          <h1>New chat</h1>
          <span className="wa-header-sub">describe what you want to build</span>
        </div>
        <div className="spacer" />
      </header>

      <div className="new-chat-body">
        {!busy ? (
          <>
            <textarea
              className="new-chat-prompt"
              rows={4}
              autoFocus
              placeholder="What do you want to build? e.g. “a drone under $150 that I can assemble with parts I order today”"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  start(draft);
                }
              }}
            />
            <div className="quick-chips new-chat-chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => setDraft(s)}>
                  {s}
                </button>
              ))}
            </div>
            {err && (
              <div className="bubble bubble--them bubble--err">
                <b>Couldn't start the build:</b> {err}
              </div>
            )}
            <button
              className="ck-btn ck-btn--primary new-chat-go"
              onClick={() => start(draft)}
              disabled={!draft.trim()}
            >
              Start the build →
            </button>
            <p className="muted small">
              The agent researches the parts, builds the circuit + firmware in the simulator,
              verifies it compiles and runs, then tells you exactly what to do.
            </p>
          </>
        ) : (
          <div className="new-chat-running">
            <div className="bubble bubble--them bubble--working">
              <span className="spinner" /> The agent is working on it…
              <ul className="activity">
                {activity.map((ev, i) => (
                  <li key={i}>
                    <span className="activity-dot" /> {ev.message || ev.type}
                  </li>
                ))}
              </ul>
            </div>
            <button className="ck-btn" onClick={cancel}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
