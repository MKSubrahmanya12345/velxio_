import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { MemoryPanel } from './components/MemoryPanel';
import type { MemoryEvent, Conversation, Health, GeneratorInfo, ProvidersState } from './types';
import { ProviderStrip } from './components/ProviderStrip';
import { ProvidersView } from './components/ProvidersView';
import { ChatView } from './components/ChatView';
import { ConversationList } from './components/ConversationList';

const PROVIDER_KEY = 'forge.generator';

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [providers, setProviders] = useState<GeneratorInfo[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string>(() => {
    try { return localStorage.getItem(PROVIDER_KEY) || ''; } catch { return ''; }
  });
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [current, setCurrent] = useState<Conversation | null>(null);
  const [offline, setOffline] = useState(false);
  const [initialGoal, setInitialGoal] = useState('');

  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [creationEvents, setCreationEvents] = useState<MemoryEvent[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // 'chat' is the workspace; 'providers' is the key/failover management page;
  // 'rules' is the cross-project global rule set behind the pre-turn gate.
  const [view, setView] = useState<'chat' | 'providers' | 'rules'>('chat');
  const activeId = useRef<string | null>(null);
  const navigation = useRef(0);
  const refreshVersion = useRef(0);
  const createInFlight = useRef(false);
  const deletedIds = useRef(new Set<string>());

  // A history refresh must never replace an open conversation with an older snapshot.
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    setLoading(true);
    try {
      // The key list is best-effort: without it the header simply offers the
      // registry's own selection instead of a per-chat preference.
      const info = await api.providers?.get?.().catch(() => null) ?? null;
      const [list, status] = await Promise.all([api.list(), api.health()]);
      if (version !== refreshVersion.current) return;
      setConversations(list);
      setHealth(status);
      const state = (info as ProvidersState | null) || null;
      const options = (state?.keys || []).map(k => ({
        id: k.id,
        name: `${k.providerLabel}${k.note ? ` · ${k.note}` : ''}`,
        model: k.model,
        type: k.provider,
      }));
      setProviders(options);
      // Drop a remembered choice that no longer exists (key deleted, server
      // reset) instead of sending a provider the server would reject.
      setSelectedProvider(cur => (cur && options.some(o => o.id === cur) ? cur : ''));
      setOffline(false);
    } catch {
      if (version === refreshVersion.current) setOffline(true);
    } finally {
      if (version === refreshVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSidebarOpen(false);
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [sidebarOpen]);

  const updateConversation = (conversation: Conversation) => {
    if (deletedIds.current.has(conversation.id)) return;
    ++refreshVersion.current;
    setLoading(false);
    setConversations(list => [conversation, ...list.filter(c => c.id !== conversation.id)]);
    if (activeId.current === conversation.id) {
      // A send may finish while this same build is being reopened. Its result is
      // newer than the pending GET snapshot, so invalidate that navigation too.
      ++navigation.current;
      setLoadingId(null);
      setCurrent(conversation);
    }
  };

  const newChat = () => {
    ++navigation.current;
    activeId.current = null;
    setCurrent(null);
    setLoadingId(null);
    setInitialGoal('');
    setError('');
    setSidebarOpen(false);
  };

  const handleProviderChange = (id: string) => {
    setSelectedProvider(id);
    try { localStorage.setItem(PROVIDER_KEY, id); } catch { /* private mode */ }
  };

  const handleNewChat = async (goal: string) => {
    if (!goal.trim() || createInFlight.current) return;
    createInFlight.current = true;
    setCreating(true);
    setCreationEvents([]);
    setError('');
    const version = ++navigation.current;
    try {
      const r = await api.create(goal.trim(), undefined, event => {
        if (version === navigation.current) setCreationEvents(list => [...list, event]);
      }, selectedProvider || undefined);
      if (version === navigation.current) {
        activeId.current = r.conversation.id;
        setCurrent(r.conversation);
        setInitialGoal('');
      }
      updateConversation(r.conversation);
    } catch (e) {
      if (version === navigation.current) setError((e as Error).message);
    } finally {
      createInFlight.current = false;
      setCreating(false);
    }
  };

  const handleSelect = async (id: string) => {
    const version = ++navigation.current;
    activeId.current = id;
    setCurrent(null);
    setLoadingId(id);
    setError('');
    setSidebarOpen(false);
    try {
      const conv = await api.get(id);
      if (version === navigation.current) setCurrent(conv);
    } catch (e) {
      if (version === navigation.current) {
        activeId.current = null;
        setError((e as Error).message);
      }
    } finally {
      if (version === navigation.current) setLoadingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this conversation? This cannot be undone.')) return;
    try {
      await api.remove(id);
      deletedIds.current.add(id);
      ++refreshVersion.current;
      setLoading(false);
      setConversations(list => list.filter(c => c.id !== id));
      if (activeId.current === id) newChat();
    } catch (e) {
      setError(`Could not delete conversation: ${(e as Error).message}`);
    }
  };

  return (
    <div className="fg-shell">
      <header className="fg-header">
        <div className="fg-header-inner">
          <button className="fg-logo" onClick={newChat}>
            Velxio <span>Forge</span>
            {(health?.providers.jev === 'mock' || health?.providers.planner === 'mock') && <small className="fg-mobile-demo" title="Demo: simulated decision or planning provider">Demo</small>}
            <em className="fg-logo-sub">your build workspace</em>
          </button>
          <div className="fg-header-actions">
            <button className="fg-btn fg-btn-secondary fg-history-toggle" aria-expanded={sidebarOpen} aria-controls="build-history" onClick={() => setSidebarOpen(v => !v)}>Build history</button>
            <button
              className={`fg-btn ${view === 'providers' ? 'fg-btn-primary' : 'fg-btn-secondary'}`}
              aria-current={view === 'providers' ? 'page' : undefined}
              onClick={() => setView(v => (v === 'providers' ? 'chat' : 'providers'))}
            >
              Providers
            </button>
            <ProviderStrip
              health={health}
              offline={offline}
              providers={providers}
              selected={selectedProvider}
              onChange={handleProviderChange}
              onOpenProviders={() => setView('providers')}
            />
          </div>
        </div>
      </header>

      {view === 'providers' ? (
        <main className="fg-main-chat">
          <ProvidersView onBack={() => setView('chat')} onChanged={() => void refresh()} />
        </main>
      ) : view === 'rules' ? (
        <main className="fg-main-chat">
          <GlobalRulesPanel onBack={() => setView('chat')} />
        </main>
      ) : (
      <main className="fg-main-chat">
        {offline && (
          <div className="fg-banner fg-banner-warn" style={{ margin: 16 }}>
            Could not connect to Forge. Check the API server and try again.
            <button className="fg-btn fg-btn-secondary" onClick={refresh} disabled={loading}>{loading ? 'Connecting…' : 'Reconnect'}</button>
          </div>
        )}

        {error && <div className="fg-banner fg-banner-error fg-app-error" role="alert">{error}<button className="fg-back" aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
        <div className="fg-chat-layout">
          <aside id="build-history" className={`fg-chat-sidebar${sidebarOpen ? ' fg-mobile-open' : ''}`} aria-label="Build history">
            <div className="fg-sidebar-head">
              <button className="fg-btn fg-btn-primary fg-btn-block" onClick={newChat}>
                + New build chat
              </button>
              <div className="fg-sidebar-hint">
                Your ideas, plans, and progress. All in one place.
              </div>
            </div>
            <ConversationList loading={loading} conversations={conversations} currentId={loadingId || current?.id || null} onSelect={handleSelect} onDelete={handleDelete} />
            <div className="fg-sidebar-foot">
              <div className="fg-jargon">
                <div><strong>From idea to working build.</strong></div>
                <div className="fg-muted">Plan it. Build it. Check each step.</div>
              </div>
            </div>
          </aside>

          <section className="fg-chat-main">
            {loadingId ? (
              <div className="fg-empty" role="status">Opening your build…</div>
            ) : current ? (
              <ChatView key={current.id} conversation={current} onUpdate={updateConversation} onBack={newChat} provider={selectedProvider} />
            ) : (
              <div className="fg-empty">
                <div className="fg-hero-chat">
                  <div className="fg-eyebrow">YOUR IDEA. YOUR RULES. A SHARED MEMORY.</div>
                  <h1>What will you <em>build next</em>?</h1>
                  <p className="fg-sub">Tell Forge what you want to create—and what matters. Your rules become project memory. JEV uses them to guide what comes next.</p>

                  <div className="fg-example-grid">
                    {[
                      'I want to make a horror film. Only me, no other actors or crew.',
                      'Build a study app. It must work offline. No paid tools.',
                      'Help me organize a community event. My budget is $200.',
                      'I wanna build an MP3 player with ESP32',
                    ].map(ex => (
                      <button key={ex} className="fg-example-card" disabled={creating} onClick={() => setInitialGoal(ex)}>
                        <span className="fg-example-icon">⚒</span>
                        <span>{ex}</span>
                      </button>
                    ))}
                  </div>

                  <div className="fg-composer fg-composer-hero">
                    <textarea
                      className="fg-input fg-textarea"
                      rows={3}
                      aria-label="Describe your build"
                      disabled={creating}
                      placeholder="Describe your idea. Include parts you have, your budget, or what you want to learn…"
                      value={initialGoal}
                      onChange={e => setInitialGoal(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void handleNewChat(initialGoal); } }}
                    />
                    <button className="fg-btn fg-btn-primary" disabled={creating || !initialGoal.trim()} onClick={() => handleNewChat(initialGoal)}>
                      {creating ? 'Starting your project…' : 'Start project →'}
                    </button>
                  </div>

                  <p className="fg-hero-note" role="status">{creating ? 'Forming project notes, evaluating them with JEV, and checking the response.' : 'Start with an example, or make it your own. Ctrl / ⌘ + Enter to plan.'}</p>

                  {creating && <div className="fg-memory-intake"><MemoryPanel events={creationEvents} busy /></div>}

                  <div className="fg-how">
                    <div className="fg-hip">
                      <div className="fg-hip-card">
                        <div className="fg-hip-num">01 · UNDERSTAND</div>
                        <div className="fg-hip-title">Memory that forms</div>
                        <div className="fg-hip-desc">The LLM extracts goals, rules, facts, and possibilities from your words. No fixed domain or project form.</div>
                      </div>
                      <div className="fg-hip-card">
                        <div className="fg-hip-num">02 · DECIDE</div>
                        <div className="fg-hip-title">JEV at the gate</div>
                        <div className="fg-hip-desc">JEV evaluates which notes are grounded, what conflicts, and whether you authorized a change.</div>
                      </div>
                      <div className="fg-hip-card">
                        <div className="fg-hip-num">03 · CONTINUE</div>
                        <div className="fg-hip-title">Generation with memory</div>
                        <div className="fg-hip-desc">The same LLM uses that memory. JEV checks the draft, sending conflicts back for revision before you see it.</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      </main>
      )}
    </div>
  );
}
       