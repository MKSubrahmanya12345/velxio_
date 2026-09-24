// /agent — the WireGI build-assistant chat inside Velxio.
//
// This is the speaking interface between the human and the agent: create a
// new chat, prompt, watch it think and use the simulator tools, answer its
// questions, approve with your own eyes. All heavy lifting lives in
// frontend/src/agent-chat/; this file just mounts it as a page.
import { useEffect } from 'react';
import AgentChatApp from '../agent-chat/AgentChatApp';

export function AgentChatPage() {
  // The chat app is a full-height column with its own scrolling; the editor
  // chrome (headers/toolbars) must not squeeze it.
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  return <AgentChatApp />;
}
