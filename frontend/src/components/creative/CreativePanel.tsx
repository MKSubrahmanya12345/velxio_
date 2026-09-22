import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  Check,
  ChevronRight,
  Circle,
  Copy,
  Film,
  FlaskConical,
  Link2,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import {
  creativeApi,
  describeVerdict,
  type CollectionDetail,
  type CollectionSummary,
  type IdeasResult,
  type ScriptPack,
} from '../../creative/api';
import './CreativePanel.css';

type View = 'learn' | 'create';

function useCopy(): [string | null, (text: string, key: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const copy = useCallback((text: string, key: string) => {
    const done = () => {
      setCopied(key);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(null), 1600);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => {});
    } else {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand('copy');
        done();
      } catch {
        /* clipboard unavailable */
      }
      document.body.removeChild(area);
    }
  }, []);
  return [copied, copy];
}

export function CreativePanel() {
  const [view, setView] = useState<View>('learn');
  const [live, setLive] = useState<boolean | null>(null);
  const [statusError, setStatusError] = useState('');
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [activeId, setActiveId] = useState('');
  const [detail, setDetail] = useState<CollectionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copied, copy] = useCopy();

  // Learn state
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [ingestMode, setIngestMode] = useState<'url' | 'text'>('url');
  const [ingestUrl, setIngestUrl] = useState('');
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [ingesting, setIngesting] = useState(false);
  const [ingestNote, setIngestNote] = useState('');
  const [noteQuery, setNoteQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  // Create state
  const [prompt, setPrompt] = useState('');
  const [format, setFormat] = useState('video-script');
  const [ideasResult, setIdeasResult] = useState<IdeasResult | null>(null);
  const [ideasBusy, setIdeasBusy] = useState(false);
  const [pack, setPack] = useState<ScriptPack | null>(null);
  const [packBusy, setPackBusy] = useState<string | null>(null);

  const refreshDetail = useCallback(async (id: string) => {
    const d = await creativeApi.collectionDetail(id);
    setDetail(d);
    setCollections((prev) =>
      prev.map((c) =>
        c.id === id
          ? { ...c, noteCount: d.noteCount, pendingCount: d.pendingCount, sourceCount: d.sourceCount, sources: d.sources }
          : c,
      ),
    );
  }, []);

  const boot = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const s = await creativeApi.status();
      setLive(s.live);
      if (!s.live) {
        setStatusError(
          s.enabled
            ? 'Forge is not reachable. Start it with `npm start` in forge/server (or enable FORGE_AUTOSTART) and retry.'
            : 'Forge is disabled. Set FORGE_ENABLED=true in backend/.env and restart the API.',
        );
        return;
      }
      const list = await creativeApi.listCollections();
      setCollections(list.collections);
      if (list.collections.length && !activeId) {
        setActiveId(list.collections[0].id);
      } else if (activeId) {
        await refreshDetail(activeId);
      }
    } catch (e) {
      setLive(false);
      setStatusError(e instanceof Error ? e.message : 'Could not reach the creative backend.');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    if (!activeId || !live) return;
    setError('');
    refreshDetail(activeId).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : 'Could not load the collection.'),
    );
  }, [activeId, live, refreshDetail]);

  async function createCollection() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setError('');
    try {
      const c = await creativeApi.createCollection(name);
      setCollections((prev) => [c, ...prev]);
      setActiveId(c.id);
      setNewName('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the collection.');
    } finally {
      setCreating(false);
    }
  }

  async function runIngest() {
    if (!activeId || ingesting) return;
    setIngesting(true);
    setIngestNote('');
    setError('');
    try {
      const result =
        ingestMode === 'url'
          ? await creativeApi.ingest(activeId, { url: ingestUrl.trim() })
          : await creativeApi.ingest(activeId, { text: pasteText, title: pasteTitle.trim() });
      setIngestNote(
        `Learned ${result.notes.length} node${result.notes.length === 1 ? '' : 's'} from ${result.source.title || 'source'} (${result.transcriptChars.toLocaleString()} chars${result.jev === 'reviewed' ? ', JEV-reviewed' : ', stored directly'}).`,
      );
      setIngestUrl('');
      setPasteText('');
      setPasteTitle('');
      await refreshDetail(activeId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ingest failed.');
    } finally {
      setIngesting(false);
    }
  }

  async function saveEdit(noteId: string) {
    if (!activeId || !editText.trim()) return;
    setError('');
    try {
      await creativeApi.patchNote(activeId, noteId, { text: editText.trim() });
      setEditingId(null);
      await refreshDetail(activeId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the node.');
    }
  }

  async function removeNote(noteId: string) {
    if (!activeId) return;
    setError('');
    try {
      await creativeApi.deleteNote(activeId, noteId);
      await refreshDetail(activeId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the node.');
    }
  }

  async function runIdeas() {
    if (!activeId || !prompt.trim() || ideasBusy) return;
    setIdeasBusy(true);
    setError('');
    setPack(null);
    try {
      const result = await creativeApi.ideas(activeId, { prompt: prompt.trim(), count: 5 });
      setIdeasResult(result);
      await refreshDetail(activeId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Idea generation failed.');
    } finally {
      setIdeasBusy(false);
    }
  }

  async function runScript(ideaTitle: string, ideaPitch: string) {
    if (!activeId || packBusy) return;
    setPackBusy(ideaTitle);
    setError('');
    try {
      const result = await creativeApi.script(activeId, {
        idea: `${ideaTitle}\n${ideaPitch}`,
        prompt: prompt.trim(),
        format,
      });
      setPack(result);
      await refreshDetail(activeId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Script generation failed.');
    } finally {
      setPackBusy(null);
    }
  }

  const filteredNotes = (detail?.notes ?? []).filter(
    (n) =>
      !noteQuery.trim() ||
      n.text.toLowerCase().includes(noteQuery.trim().toLowerCase()) ||
      n.kind.includes(noteQuery.trim().toLowerCase()),
  );

  if (loading) {
    return (
      <div className="creative-panel creative-center">
        <LoaderCircle size={18} className="creative-spin" /> Connecting to Forge…
      </div>
    );
  }

  if (live === false) {
    return (
      <div className="creative-panel creative-center">
        <div className="creative-offline">
          <AlertCircle size={20} />
          <p>{statusError || 'Forge is unreachable.'}</p>
          <button className="creative-secondary" onClick={() => void boot()}>
            <RefreshCw size={13} /> Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="creative-panel">
      <div className="creative-viewtabs" role="tablist" aria-label="Create views">
        <button
          role="tab"
          aria-selected={view === 'learn'}
          className={view === 'learn' ? 'active' : ''}
          onClick={() => setView('learn')}
        >
          <BookOpen size={13} /> LEARN
        </button>
        <button
          role="tab"
          aria-selected={view === 'create'}
          className={view === 'create' ? 'active' : ''}
          onClick={() => setView('create')}
        >
          <Sparkles size={13} /> CREATE
        </button>
        <span className="creative-live" title="Forge connection">
          <Circle size={7} fill="currentColor" className={live ? 'connected' : ''} />
          {live ? 'Forge' : 'Offline'}
        </span>
      </div>

      {error && (
        <div className="creative-error">
          <AlertCircle size={14} />
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError('')}>
            <X size={13} />
          </button>
        </div>
      )}

      <div className="creative-scroll">
        {view === 'learn' ? (
          <>
            <div className="creative-row">
              <select
                aria-label="Collection"
                value={activeId}
                onChange={(e) => setActiveId(e.target.value)}
              >
                {collections.length === 0 && <option value="">No collections yet</option>}
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.noteCount} nodes · {c.sourceCount} sources
                  </option>
                ))}
              </select>
            </div>
            <div className="creative-row">
              <input
                placeholder="New collection name…"
                value={newName}
                maxLength={80}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createCollection();
                }}
              />
              <button
                className="creative-secondary"
                disabled={!newName.trim() || creating}
                onClick={() => void createCollection()}
                title="Create collection"
              >
                {creating ? <LoaderCircle size={13} className="creative-spin" /> : <Plus size={13} />}
              </button>
            </div>

            {activeId && (
              <>
                <div className="creative-section">
                  <span className="creative-section-title">
                    <Link2 size={12} /> INGEST — LINK → TEXT → LEARN
                  </span>
                  <div className="creative-modetabs">
                    <button
                      className={ingestMode === 'url' ? 'active' : ''}
                      onClick={() => setIngestMode('url')}
                    >
                      <Film size={12} /> YouTube / article link
                    </button>
                    <button
                      className={ingestMode === 'text' ? 'active' : ''}
                      onClick={() => setIngestMode('text')}
                    >
                      Paste text
                    </button>
                  </div>
                  {ingestMode === 'url' ? (
                    <div className="creative-row">
                      <input
                        placeholder="Paste a YouTube or article URL…"
                        value={ingestUrl}
                        onChange={(e) => setIngestUrl(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void runIngest();
                        }}
                      />
                      <button
                        className="creative-primary"
                        disabled={!ingestUrl.trim() || ingesting}
                        onClick={() => void runIngest()}
                      >
                        {ingesting ? (
                          <LoaderCircle size={13} className="creative-spin" />
                        ) : (
                          'Learn'
                        )}
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="creative-row">
                        <input
                          placeholder="Title (optional)…"
                          value={pasteTitle}
                          maxLength={200}
                          onChange={(e) => setPasteTitle(e.target.value)}
                        />
                      </div>
                      <textarea
                        className="creative-textarea"
                        placeholder="Paste the content to learn (transcript, article text, notes)…"
                        value={pasteText}
                        onChange={(e) => setPasteText(e.target.value)}
                      />
                      <div className="creative-row creative-end">
                        <button
                          className="creative-primary"
                          disabled={pasteText.trim().length < 200 || ingesting}
                          onClick={() => void runIngest()}
                        >
                          {ingesting ? (
                            <LoaderCircle size={13} className="creative-spin" />
                          ) : (
                            'Learn this text'
                          )}
                        </button>
                      </div>
                    </>
                  )}
                  {ingesting && (
                    <p className="creative-muted">
                      <LoaderCircle size={12} className="creative-spin" /> Pulling transcript →
                      distilling nodes → JEV review. Big videos take a minute or two.
                    </p>
                  )}
                  {ingestNote && <p className="creative-note">{ingestNote}</p>}
                </div>

                <div className="creative-section">
                  <span className="creative-section-title">
                    NODES · {detail?.noteCount ?? 0} ACTIVE
                    {(detail?.pendingCount ?? 0) > 0 && ` · ${detail?.pendingCount} PENDING`}
                  </span>
                  <div className="creative-row">
                    <input
                      placeholder="Filter nodes…"
                      value={noteQuery}
                      onChange={(e) => setNoteQuery(e.target.value)}
                    />
                  </div>
                  <div className="creative-nodes">
                    {filteredNotes.length === 0 && (
                      <p className="creative-muted">
                        {detail?.notes.length
                          ? 'No nodes match this filter.'
                          : 'Nothing learned yet — ingest a link above.'}
                      </p>
                    )}
                    {filteredNotes.map((n) => (
                      <article key={n.id} className={`creative-node ${n.status}`}>
                        {editingId === n.id ? (
                          <>
                            <textarea
                              className="creative-textarea creative-edit"
                              value={editText}
                              onChange={(e) => setEditText(e.target.value)}
                            />
                            <div className="creative-node-actions">
                              <button
                                className="creative-primary"
                                disabled={!editText.trim()}
                                onClick={() => void saveEdit(n.id)}
                              >
                                <Check size={12} /> Save
                              </button>
                              <button
                                className="creative-secondary"
                                onClick={() => setEditingId(null)}
                              >
                                Cancel
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            <p>
                              <em className="creative-kind">[{n.kind}]</em> {n.text}
                            </p>
                            <div className="creative-node-actions">
                              {n.status !== 'active' && (
                                <span className="creative-chip muted">{n.status}</span>
                              )}
                              <button
                                title="Edit node"
                                aria-label="Edit node"
                                onClick={() => {
                                  setEditingId(n.id);
                                  setEditText(n.text);
                                }}
                              >
                                <Pencil size={12} />
                              </button>
                              <button
                                title="Delete node"
                                aria-label="Delete node"
                                onClick={() => void removeNote(n.id)}
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          </>
                        )}
                      </article>
                    ))}
                  </div>
                </div>

                {(detail?.sourcePreviews.length ?? 0) > 0 && (
                  <div className="creative-section">
                    <span className="creative-section-title">
                      SOURCES · {detail?.sourcePreviews.length}
                    </span>
                    {detail!.sourcePreviews.map((s) => (
                      <details key={s.id} className="creative-source">
                        <summary>
                          <Film size={12} /> {s.title || s.url}
                          <span className="creative-chip muted">{s.kind}</span>
                        </summary>
                        <p className="creative-muted">{s.summary}</p>
                      </details>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <div className="creative-row">
              <select
                aria-label="Collection"
                value={activeId}
                onChange={(e) => {
                  setActiveId(e.target.value);
                  setIdeasResult(null);
                  setPack(null);
                }}
              >
                {collections.length === 0 && <option value="">No collections yet</option>}
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.noteCount} nodes
                  </option>
                ))}
              </select>
            </div>
            <div className="creative-row">
              <select aria-label="Format" value={format} onChange={(e) => setFormat(e.target.value)}>
                <option value="video-script">Video script</option>
                <option value="blog-post">Blog post</option>
                <option value="tutorial">Tutorial</option>
                <option value="social-captions">Social pack</option>
                <option value="product-copy">Product copy</option>
              </select>
            </div>
            <textarea
              className="creative-textarea"
              placeholder="What should I create? e.g. “Give me video ideas like my ESP32 deep-sleep pieces, aimed at beginners”…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <div className="creative-row creative-end">
              <button
                className="creative-primary"
                disabled={!activeId || !prompt.trim() || ideasBusy}
                onClick={() => void runIdeas()}
              >
                {ideasBusy ? (
                  <>
                    <LoaderCircle size={13} className="creative-spin" /> Generating…
                  </>
                ) : (
                  <>
                    <FlaskConical size={13} /> Generate ideas
                  </>
                )}
              </button>
            </div>
            {ideasBusy && (
              <p className="creative-muted">
                Retrieving nodes → proposing ideas → JEV cross-compare…
              </p>
            )}
            {ideasResult && (
              <div className="creative-section">
                <span className="creative-section-title">
                  IDEAS · RANKED{ideasResult.jev === 'reviewed' ? ' · JEV-SCORED' : ' · JEV UNAVAILABLE'}
                </span>
                {ideasResult.ideas.map((idea) => {
                  const v = describeVerdict(idea.jev);
                  const busy = packBusy === idea.title;
                  return (
                    <article key={idea.title} className="creative-idea">
                      <strong>{idea.title}</strong>
                      <p>{idea.pitch}</p>
                      <div className="creative-node-actions">
                        <span className={`creative-chip ${v.tone}`} title={idea.jev.conflictsText ?? undefined}>
                          {v.label}
                          {idea.jev.support !== null && ` ${(idea.jev.support * 100).toFixed(0)}%`}
                        </span>
                        {idea.sourceNoteIds.length > 0 && (
                          <span className="creative-muted">{idea.sourceNoteIds.length} nodes</span>
                        )}
                      </div>
                      {idea.jev.conflictsText && (
                        <p className="creative-conflict">Conflicts: “{idea.jev.conflictsText}”</p>
                      )}
                      <button
                        className="creative-secondary"
                        disabled={packBusy !== null}
                        onClick={() => void runScript(idea.title, idea.pitch)}
                      >
                        {busy ? (
                          <LoaderCircle size={12} className="creative-spin" />
                        ) : (
                          <ChevronRight size={12} />
                        )}
                        Make full pack
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
            {pack && (
              <div className="creative-section">
                <span className="creative-section-title">
                  FULL PACK · {pack.idea.slice(0, 60)}
                </span>
                <div className="creative-pack">
                  <ReactMarkdown>{pack.script}</ReactMarkdown>
                </div>
                <PackList
                  title="Hooks"
                  items={pack.hooks}
                  idKey="hooks"
                  copied={copied}
                  onCopy={copy}
                />
                <PackList
                  title="Titles"
                  items={pack.titles}
                  idKey="titles"
                  copied={copied}
                  onCopy={copy}
                />
                <PackList
                  title="Thumbnails"
                  items={pack.thumbnails}
                  idKey="thumbs"
                  copied={copied}
                  onCopy={copy}
                />
                {pack.needsCheck.length > 0 && (
                  <PackList
                    title="Verify before publishing"
                    items={pack.needsCheck}
                    idKey="check"
                    copied={copied}
                    onCopy={copy}
                  />
                )}
                {pack.sources.length > 0 && (
                  <details className="creative-source">
                    <summary>Sources used · {pack.sources.length}</summary>
                    {pack.sources.map((s) => (
                      <p key={s.noteId} className="creative-muted">
                        [{s.kind ?? 'note'}] {s.text ?? s.noteId}
                      </p>
                    ))}
                  </details>
                )}
                <div className="creative-row creative-end">
                  <button
                    className="creative-secondary"
                    onClick={() =>
                      copy(
                        `${pack.script}\n\n## Hooks\n${pack.hooks.map((h) => `- ${h}`).join('\n')}\n\n## Titles\n${pack.titles.map((t) => `- ${t}`).join('\n')}\n\n## Thumbnails\n${pack.thumbnails.map((t) => `- ${t}`).join('\n')}`,
                        'pack',
                      )
                    }
                  >
                    {copied === 'pack' ? <Check size={12} /> : <Copy size={12} />} Copy pack
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function PackList({
  title,
  items,
  idKey,
  copied,
  onCopy,
}: {
  title: string;
  items: string[];
  idKey: string;
  copied: string | null;
  onCopy: (text: string, key: string) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="creative-packlist">
      <span className="creative-section-title">{title.toUpperCase()}</span>
      <ul>
        {items.map((item, i) => (
          <li key={i}>
            <span>{item}</span>
            <button
              title={`Copy ${title.toLowerCase()} ${i + 1}`}
              aria-label={`Copy ${title.toLowerCase()} ${i + 1}`}
              onClick={() => onCopy(item, `${idKey}-${i}`)}
            >
              {copied === `${idKey}-${i}` ? <Check size={12} /> : <Copy size={12} />}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
