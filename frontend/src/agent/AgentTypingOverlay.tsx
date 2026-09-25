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
