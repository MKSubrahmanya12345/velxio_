/**
 * AgentTypingOverlay — the "agent is writing" playback for code.
 *
 * Mounted inside the editor pane (.editor-wrapper). While a reveal is
 * active it covers the editor and types the changed files out one by one,
 * then unmounts to reveal the REAL editor with the complete content (the
 * stores were never touched — Monaco always had the full file; this is
 * only the curtain in front of it). Clicking the overlay skips the whole
 * reveal, exactly like the canvas.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useAgentReveal } from './reveal';

export const AgentTypingOverlay: React.FC = () => {
  const active = useAgentReveal((s) => s.active);
  const files = useAgentReveal((s) => s.files);
  const typed = useAgentReveal((s) => s.typed);

  const index = files.findIndex((f) => !typed[f.name]);
  const file = index === -1 ? null : files[index];

  const [chars, setChars] = useState(0);
  const fileRef = useRef<{ name: string } | null>(null);

  useEffect(() => {
    if (!file) return;
    fileRef.current = file;
    setChars(0);
    let raf = 0;
    let count = 0;
    let last = performance.now();
    const perMs = file.content.length / Math.max(1, file.ms);
    const step = (now: number) => {
      if (fileRef.current !== file) return;
      const dt = Math.min(100, now - last);
      last = now;
      count = Math.min(file.content.length, count + perMs * dt);
      setChars(Math.floor(count));
      if (count >= file.content.length) {
        useAgentReveal.getState().markTyped(file.name);
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [file]);

  if (!active || !file) return null;
  const doneCount = index; // files before this one are already typed

  return (
    <div
      className="velxio-typing-overlay"
      onClick={() => useAgentReveal.getState().skip()}
      title="Click to skip"
    >
      <div className="velxio-typing-header">
        <span className="velxio-typing-dot" />
        <span>Agent is writing</span>
        <strong>{file.name}</strong>
        {files.length > 1 && (
          <span>
            {doneCount + 1} of {files.length}
          </span>
        )}
        <span className="velxio-typing-hint">click to skip</span>
      </div>
      <div className="velxio-typing-body">
        {file.content.slice(0, chars)}
        <span className="velxio-typing-caret" />
      </div>
    </div>
  );
};

/**
 * AgentLiveTyping — the SAME curtain, but driven by the model AS it writes.
 *
 * While the run is streaming, the server extracts in-progress write_file
 * content from the tool-call deltas and ships it on every heartbeat; this
 * overlay types it into the editor pane live (content-so-far, rAF catch-up
 * ~0.6s behind the arriving text). It holds no store truth: the workspace is
 * untouched until the checkpoint applies, and the post-result reveal skips
 * files that were already live-typed (see reveal.ts). The header says "live"
 * instead of the skip hint — there is nothing to skip; this IS the run.
 */
import { useAgentLiveType } from './reveal';

const LIVE_CODE_FILE = /\.(ino|py|cpp|c|h)$/;

function LiveTypeBody({ name, content }: { name: string; content: string }) {
  const targetRef = useRef(content);
  targetRef.current = content;
  const fileRef = useRef(name);
  const [chars, setChars] = useState(0);

  useEffect(() => {
    let raf = 0;
    let count = 0;
    let last = performance.now();
    const step = (now: number) => {
      if (fileRef.current !== name) {
        // The model moved on to another file — restart the counter.
        fileRef.current = name;
        count = 0;
      }
      const target = targetRef.current.length;
      const dt = Math.min(100, now - last);
      last = now;
      if (count < target) {
        // Catch up within ~600ms of each arriving batch, but never slower
        // than 40 chars/s so the tail of a fast burst still animates.
        const rate = Math.max(40 / 1000, (target - count) / 600);
        count = Math.min(target, count + rate * dt);
        setChars(Math.floor(count));
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [name]);

  const shown = content.slice(0, chars);
  return (
    <div className="velxio-typing-overlay" title="The agent is writing this file right now">
      <div className="velxio-typing-header">
        <span className="velxio-typing-dot" />
        <span>Agent is writing</span>
        <strong>{name}</strong>
        <span className="velxio-typing-hint">live</span>
      </div>
      <div className="velxio-typing-body">
        {shown}
        <span className="velxio-typing-caret" />
      </div>
    </div>
  );
}

export const AgentLiveTyping: React.FC = () => {
  const active = useAgentLiveType((s) => s.active);
  const files = useAgentLiveType((s) => s.files);
  const order = useAgentLiveType((s) => s.order);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (active) setHidden(false);
  }, [active]);

  if (!active || hidden) return null;

  // Prefer the code file (the editor's subject); fall back to the most
  // recently updated file (diagram.json during layout work).
  const codeName = [...order].reverse().find((n) => LIVE_CODE_FILE.test(n));
  const name = codeName ?? order[order.length - 1];
  if (!name) return null;
  const content = files[name] ?? '';

  return (
    <div onDoubleClick={() => setHidden(true)}>
      <LiveTypeBody name={name} content={content} />
    </div>
  );
};
