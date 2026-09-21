import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { Conversation, Health } from './types';
import { ProviderStrip } from './components/ProviderStrip';
import { ChatView } from './components/ChatView';
import { ConversationList } from './components/ConversationList';

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [current, setCurrent] = useState<Conversation | null>(null);
  const [offline, setOffline] = useState(false);
  const [initialGoal, setInitialGoal] = useState('');

  const refresh = useCallback(async () => {
    try {
      const list = await api.list();
      setConversations(list);
      setOffline(false);
      // Update current if it exists
      if (current) {
        const updated = list.find(c => c.id === current.id);
        if (updated) setCurrent(updated);
      }
    } catch {
      setOffline(true);
    }
  }, [current?.id]);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setOffline(true));
    refresh();
  }, []);

  const handleNewChat = async (goal: string) => {
    if (!goal.trim()) return;
    try {
      const r = await api.create(goal.trim());
      setCurrent(r.conversation);
      refresh();
    } catch (e) {
      console.error(e);
      alert(String((e as Error).message));
    }
  };

  const handleSelect = async (id: string) => {
    try {
      const conv = await api.get(id);
      setCurrent(conv);
    } catch (e) {
      console.error(e);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this conversation?')) return;
    await api.remove(id);
    if (current?.id === id) setCurrent(null);
    refresh();
  };

  return (
    <div className="fg-shell">
      <header className="fg-header">
        <div className="fg-header-inner">
          <button className="fg-logo" onClick={() => { setCurrent(null); setInitialGoal(''); refresh(); }}>
            Velxio <span>Forge</span> <em className="fg-logo-sub">chat · human as tool</em>
          </button>
          <ProviderStrip health={health} offline={offline} />
        </div>
      </header>

      <main className="fg-main-chat">
        {offline && (
          <div className="fg-banner fg-banner-warn" style={{ margin: 16 }}>
            Server unreachable — start API (<code>cd forge/server && npm install && npm run dev</code>)
          </div>
        )}

        <div className="fg-chat-layout">
          <aside className="fg-chat-sidebar">
            <div className="fg-sidebar-head">
              <button className="fg-btn fg-btn-primary fg-btn-block" onClick={() => { setCurrent(null); setInitialGoal(''); }}>
                + New build chat
              </button>
              <div className="fg-sidebar-hint">
                JEV in between every turn. Human is a tool the agent calls.
              </div>
            </div>
            <ConversationList conversations={conversations} currentId={current?.id || null} onSelect={handleSelect} onDelete={handleDelete} />
            <div className="fg-sidebar-foot">
              <div className="fg-jargon">
                <div><strong>Flow:</strong> you → JEV intent → feasibility → planner → human tool</div>
                <div className="fg-muted">Try: “I wanna build an MP3 player”</div>
              </div>
            </div>
          </aside>

          <section className="fg-chat-main">
            {current ? (
              <ChatView conversation={current} onUpdate={(c) => { setCurrent(c); refresh(); }} onBack={() => setCurrent(null)} />
            ) : (
              <div className="fg-empty">
                <div className="fg-hero-chat">
                  <h1>What do you <em>wanna build</em>?</h1>
                  <p className="fg-sub">Chat interface. Human is a tool. I plan, JEV decides, you execute.</p>

                  <div className="fg-example-grid">
                    {[
                      'I wanna build an MP3 player with ESP32',
                      'Build me an LED desk lamp that runs on 5V',
                      'I wanna build an iron man helmet with LED matrix',
                      'Build a line-following robot',
                    ].map(ex => (
                      <button key={ex} className="fg-example-card" onClick={() => setInitialGoal(ex)}>
                        <span className="fg-example-icon">⚒</span>
                        <span>{ex}</span>
                      </button>
                    ))}
                  </div>

                  <div className="fg-composer fg-composer-hero">
                    <textarea
                      className="fg-input fg-textarea"
                      rows={2}
                      placeholder='e.g. "I wanna build an MP3 player" — I will run JEV feasibility, then give implementation plan'
                      value={initialGoal}
                      onChange={e => setInitialGoal(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { handleNewChat(initialGoal); } }}
                    />
                    <button className="fg-btn fg-btn-primary" disabled={!initialGoal.trim()} onClick={() => handleNewChat(initialGoal)}>
                      Plan it →
                    </button>
                  </div>

                  <div className="fg-how">
                    <div className="fg-hip">
                      <div className="fg-hip-card">
                        <div className="fg-hip-num">01 · JEV</div>
                        <div className="fg-hip-title">Intent & Feasibility</div>
                        <div className="fg-hip-desc">Every message goes through JEV: chat intent (build_request?), goal clarity, feasibility gate (category, risk, complexity). Low confidence → clarify.</div>
                      </div>
                      <div className="fg-hip-card">
                        <div className="fg-hip-num">02 · PLANNER</div>
                        <div className="fg-hip-title">Implementation Plan</div>
                        <div className="fg-hip-desc">If feasible, planner synthesizes phases → steps → BOM → acceptance. Plan is rendered in chat with cost & safety.</div>
                      </div>
                      <div className="fg-hip-card">
                        <div className="fg-hip-num">03 · HUMAN TOOL</div>
                        <div className="fg-hip-title">Human as a Tool</div>
                        <div className="fg-hip-desc">Agent calls <code>human</code> tool for each physical step. You execute, report back, JEV verifies, we advance. Like an agent loop where human is the actuator.</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
