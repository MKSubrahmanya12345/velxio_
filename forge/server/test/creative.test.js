import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConversation } from '../src/schema.js';
import { normalizeMemory } from '../src/memory/model.js';
import {
  isYouTubeUrl, extractVideoId, extractCaptionTracks, pickCaptionTrack,
  parseTimedText, parseJson3, segmentsToTranscript, fetchCaptions, extractPageTitle,
} from '../src/creative/youtube.js';
import { htmlToText, assertPublicHttpUrl, fetchPageText } from '../src/creative/sources.js';
import { splitTranscriptAndSummary, transcribeYouTube } from '../src/creative/transcribe.js';
import { candidateNotesFromText, storeIngestedNotes, updateNote, deleteNote, retrieveNotes } from '../src/creative/notes.js';
import { ideaQuestions, scoreIdeas, generateIdeas } from '../src/creative/ideas.js';
import { generateScript, FORMATS } from '../src/creative/script.js';
import { ingestText } from '../src/creative/ingest.js';

// ── fetch stub ──────────────────────────────────────────────────────────────
function stubResponse({ ok = true, status = 200, body = '', contentType = 'text/html', jsonBody = null } = {}) {
  return {
    ok, status,
    headers: { get: name => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
    json: async () => { if (jsonBody === null) throw new Error('no json'); return jsonBody; },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = original; });
}

const openaiEntry = { id: 'key-openrouter', provider: 'openrouter', model: 'test-model', apiKey: 'k', baseUrl: 'https://llm.test' };
const geminiEntry = { id: 'key-gemini', provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'k', baseUrl: 'https://gen.test' };
const fakeRegistry = (entries = [openaiEntry]) => ({ candidates: () => entries, failover: { enabled: false, maxRounds: 1 } });
const acceptJev = async () => ({ answers: {} }); // filled per-test below
const chatJson = obj => stubResponse({ jsonBody: { choices: [{ message: { content: JSON.stringify(obj) } }] }, contentType: 'application/json' });

// ── youtube.js ──────────────────────────────────────────────────────────────
test('youtube url detection and id extraction', () => {
  assert.equal(isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);
  assert.equal(isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ'), true);
  assert.equal(isYouTubeUrl('https://example.com/watch?v=dQw4w9WgXcQ'), false);
  assert.equal(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://youtu.be/dQw4w9WgXcQ?t=10'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://www.youtube.com/live/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('not a url'), '');
});

test('caption track extraction prefers manual english', () => {
  const tracks = [
    { baseUrl: 'https://t.test/auto', languageCode: 'en', kind: 'asr' },
    { baseUrl: 'https://t.test/manual', languageCode: 'en' },
    { baseUrl: 'https://t.test/es', languageCode: 'es' },
  ];
  const html = `<html><script>ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":${JSON.stringify(tracks)}}}};</script></html>`;
  const found = extractCaptionTracks(html);
  assert.equal(found.length, 3);
  assert.equal(pickCaptionTrack(found).baseUrl, 'https://t.test/manual');
  assert.equal(pickCaptionTrack([]), null);
});

test('timed-text and json3 parsing', () => {
  const xml = '<transcript><text start="0.0" dur="2.0">Hello &amp; welcome</text><text start="2.0" dur="1.5">to the <b>show</b></text></transcript>';
  const segs = parseTimedText(xml);
  assert.equal(segs.length, 2);
  assert.equal(segmentsToTranscript(segs), 'Hello & welcome to the show');
  const json3 = JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: 'First line ' }] }, { tStartMs: 1000, segs: [{ utf8: 'second.' }] }] });
  assert.equal(segmentsToTranscript(parseJson3(json3)), 'First line second.');
  assert.deepEqual(parseJson3('not json'), []);
});

test('page title strips youtube suffix', () => {
  assert.equal(extractPageTitle('<title>My Video - YouTube</title>'), 'My Video');
});

test('keyless caption pull follows track url', async () => {
  const tracks = [{ baseUrl: 'https://t.test/track?x=1', languageCode: 'en' }];
  const page = `<title>Vid - YouTube</title><script>"captionTracks":${JSON.stringify(tracks)}</script>`;
  const xml = '<transcript><text start="0" dur="1">caption words here</text></transcript>';
  await withFetch(async url => {
    if (String(url).includes('youtube.com/watch')) return stubResponse({ body: page });
    return stubResponse({ body: xml });
  }, async () => {
    const out = await fetchCaptions('dQw4w9WgXcQ');
    assert.equal(out.transcript, 'caption words here');
    assert.equal(out.title, 'Vid');
  });
});

test('caption pull reports bot wall clearly', async () => {
  await withFetch(async () => stubResponse({ body: "Sign in to confirm you're not a bot" }), async () => {
    await assert.rejects(() => fetchCaptions('dQw4w9WgXcQ'), /bot check/);
  });
});

// ── sources.js ──────────────────────────────────────────────────────────────
test('html to text drops chrome', () => {
  const html = '<html><head><style>.x{}</style><script>alert(1)</script></head><body><nav>home about</nav><article><h1>Title here</h1><p>This is the actual article paragraph with enough words to survive filtering.</p></article><footer>copy</footer></body></html>';
  const text = htmlToText(html);
  assert.match(text, /actual article paragraph/);
  assert.doesNotMatch(text, /alert\(1\)/);
});

test('private urls are rejected', () => {
  assert.throws(() => assertPublicHttpUrl('http://localhost:3000/x'), /Private\/local/);
  assert.throws(() => assertPublicHttpUrl('http://169.254.169.254/'), /Private\/local/);
  assert.throws(() => assertPublicHttpUrl('ftp://example.com/x'), /http\(s\)/);
  assert.ok(assertPublicHttpUrl('https://example.com/article'));
});

test('page fetch extracts article text', async () => {
  const para = 'A long readable article paragraph that comfortably exceeds the minimum length for ingestion purposes. ';
  const html = `<html><head><title>Guide</title></head><body><article><p>${para.repeat(4)}</p></article></body></html>`;
  await withFetch(async () => stubResponse({ body: html, contentType: 'text/html' }), async () => {
    const out = await fetchPageText('https://example.com/guide');
    assert.equal(out.title, 'Guide');
    assert.match(out.text, /readable article/);
  });
});

// ── transcribe.js ───────────────────────────────────────────────────────────
test('transcript/summary split', () => {
  const { transcript, summary } = splitTranscriptAndSummary('hello world\n---SUMMARY---\n- point one');
  assert.equal(transcript, 'hello world');
  assert.equal(summary, '- point one');
  const noMarker = splitTranscriptAndSummary('just text');
  assert.equal(noMarker.transcript, 'just text');
  assert.equal(noMarker.summary, '');
});

test('gemini watch is tried before captions', async () => {
  const seen = [];
  const deps = { cfg: {}, registry: fakeRegistry([geminiEntry]) };
  await withFetch(async url => {
    seen.push(String(url));
    const spoken = 'In this video we measure the ESP32 deep sleep current with a precision meter and compare timer versus touch wakeup. ';
    return stubResponse({ jsonBody: { candidates: [{ content: { parts: [{ text: `${spoken.repeat(3)}---SUMMARY---\n- key point about the video content here` }] } }] }, contentType: 'application/json' });
  }, async () => {
    const out = await transcribeYouTube(deps, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(out.source, 'gemini-watch');
    assert.match(out.transcript, /deep sleep current/);
    assert.match(out.summary, /key point/);
    assert.ok(seen[0].includes(':generateContent'));
    assert.ok(!seen.some(u => u.includes('youtube.com/watch')));
  });
});

test('gemini failure falls back to captions + cleanup', async () => {
  const deps = { cfg: {}, registry: { candidates: () => [geminiEntry, openaiEntry], failover: { enabled: true, maxRounds: 2 } } };
  const tracks = [{ baseUrl: 'https://t.test/track', languageCode: 'en' }];
  const page = `<title>V - YouTube</title>"captionTracks":${JSON.stringify(tracks)}`;
  await withFetch(async url => {
    const u = String(url);
    if (u.includes(':generateContent')) return stubResponse({ ok: false, status: 500, body: 'overloaded' });
    if (u.includes('youtube.com/watch')) return stubResponse({ body: page });
    if (u.includes('t.test/track')) return stubResponse({ body: '<transcript><text start="0" dur="2">raw caption text here</text></transcript>' });
    return chatJson({ transcript: 'Cleaned transcript paragraph.', summary: '- cleaned point' });
  }, async () => {
    const out = await transcribeYouTube(deps, 'https://youtu.be/dQw4w9WgXcQ');
    assert.equal(out.source, 'captions');
    assert.equal(out.transcript, 'Cleaned transcript paragraph.');
    assert.ok(out.attempts.some(a => a.route === 'gemini-watch' && a.error));
  });
});

// ── notes.js ────────────────────────────────────────────────────────────────
const convWith = (notes = []) => {
  const conv = makeConversation({ title: 'Test collection' });
  conv.creative = { collection: true, sources: [] };
  conv.memory = normalizeMemory({ notes, events: [], revision: 0 });
  return conv;
};

test('candidates prefer summary bullets, capped at 8', () => {
  const summary = Array.from({ length: 12 }, (_, i) => `- bullet point number ${i} with enough words to pass the length filter`).join('\n');
  const out = candidateNotesFromText(summary, 'transcript '.repeat(50), 'src');
  assert.equal(out.length, 8);
  assert.equal(out[0].kind, 'fact');
});

test('manual node edit and delete are instant', () => {
  const conv = convWith([{ id: 'note_1', kind: 'fact', text: 'original text here', status: 'pending', domain: 'creative' }]);
  const edited = updateNote(conv, 'note_1', { text: 'edited text here', kind: 'rule' });
  assert.equal(edited.text, 'edited text here');
  assert.equal(edited.status, 'active');
  assert.throws(() => updateNote(conv, 'note_1', { kind: 'nope' }), /Unknown kind/);
  assert.deepEqual(deleteNote(conv, 'note_1'), { deleted: 'note_1' });
  assert.equal(conv.memory.notes.length, 0);
  assert.throws(() => deleteNote(conv, 'note_1'), /not found/);
});

test('retrieval ranks term overlap', () => {
  const conv = convWith([
    { id: 'a', kind: 'fact', text: 'ESP32 deep sleep current draw drops to microamps', status: 'active', domain: 'creative' },
    { id: 'b', kind: 'fact', text: 'sourdough starter hydration ratios for beginners', status: 'active', domain: 'creative' },
    { id: 'c', kind: 'fact', text: 'ESP32 wifi reconnect logic', status: 'rejected', domain: 'creative' },
  ]);
  const hits = retrieveNotes(conv.memory, 'esp32 deep sleep power');
  assert.equal(hits[0].id, 'a');
  assert.ok(!hits.some(h => h.id === 'c'));
});

test('ingest stores notes, fails open without jev', async () => {
  const conv = convWith();
  const deps = { cfg: {}, registry: fakeRegistry(), jev: async () => { throw new Error('typesafe down'); }, counters: { jevCalls: 0 } };
  const { notes, jev } = await storeIngestedNotes(deps, conv, [{ kind: 'fact', domain: 'creative', text: 'learned fact from video', quote: 'video', supersedes: [] }], { id: 'source_1', kind: 'youtube', url: 'https://youtu.be/x', title: 't', summary: 'learned fact from video' });
  assert.equal(jev, 'unavailable');
  assert.equal(notes[0].status, 'active');
  assert.equal(notes[0].sourceId, 'source_1');
});

test('ingest review path accepts supported notes', async () => {
  const conv = convWith();
  const deps = {
    cfg: {}, registry: fakeRegistry(), counters: { jevCalls: 0 },
    jev: async () => ({ answers: {
      kind_0: { type: 'choice', choice: 'fact', confidence: 0.95 },
      domain_0: { type: 'choice', choice: 'creative', confidence: 0.9 },
      support_0: { type: 'noul', noul: 0.95 },
      compatible_0: { type: 'noul', noul: 0.95 },
      conflicts_with_0: { type: 'choice', choice: 'none', confidence: 0.95 },
      change_0: { type: 'noul', noul: 0.99 },
    } }),
  };
  const { notes, jev } = await storeIngestedNotes(deps, conv, [{ kind: 'fact', domain: 'creative', text: 'learned fact from video', quote: 'video', supersedes: [] }], { id: 'source_1', kind: 'youtube', url: 'https://youtu.be/x', title: 't', summary: 'learned fact from video' });
  assert.equal(jev, 'reviewed');
  assert.equal(notes[0].status, 'active');
});

// ── ideas.js ────────────────────────────────────────────────────────────────
test('idea questions and scoring', () => {
  const ideas = [{ title: 'A', pitch: 'p' }, { title: 'B', pitch: 'q' }];
  const notes = [{ id: 'note_1', kind: 'fact', text: 'stored fact' }];
  const q = ideaQuestions(ideas, notes);
  assert.ok(q.support_0 && q.conflicts_with_1);
  const scored = scoreIdeas(ideas, {
    support_0: { type: 'noul', noul: 0.9 }, compatible_0: { type: 'noul', noul: 0.9 },
    conflicts_with_0: { type: 'choice', choice: 'none', confidence: 0.9 },
    support_1: { type: 'noul', noul: 0.9 }, compatible_1: { type: 'noul', noul: 0.1 },
    conflicts_with_1: { type: 'choice', choice: 'note_1', confidence: 0.9 },
  }, notes);
  assert.equal(scored[0].jev.verdict, 'supported');
  assert.equal(scored[1].jev.verdict, 'conflict');
  assert.equal(scored[1].jev.conflictsText, 'stored fact');
});

test('idea generation grounds, scores and ranks', async () => {
  const conv = convWith([
    { id: 'note_1', kind: 'fact', text: 'ESP32 deep sleep current draw drops to microamps with timer wakeup', status: 'active', domain: 'creative' },
  ]);
  const deps = {
    cfg: {}, registry: fakeRegistry(), counters: { jevCalls: 0 },
    jev: async ({ questions }) => {
      const answers = {};
      for (const key of Object.keys(questions)) {
        if (key.startsWith('support_') || key.startsWith('compatible_')) answers[key] = { type: 'noul', noul: 0.9 };
        else answers[key] = { type: 'choice', choice: 'none', confidence: 0.9 };
      }
      return { answers };
    },
  };
  await withFetch(async () => chatJson({ ideas: [
    { title: 'Sleep like a pro', pitch: 'Deep dive into ESP32 deep sleep modes with measured microamp numbers.', hooks: ['Your ESP32 is thirsty'], sourceNoteIds: ['note_1'] },
    { title: 'Wake up tricks', pitch: 'Timer vs touch wakeup for ESP32 deep sleep builds.', hooks: [], sourceNoteIds: ['note_9'] },
  ] }), async () => {
    const out = await generateIdeas(deps, conv, 'esp32 deep sleep video', 5);
    assert.equal(out.ideas.length, 2);
    assert.equal(out.ideas[0].jev.verdict, 'supported');
    assert.deepEqual(out.ideas[1].sourceNoteIds, []);
    assert.equal(out.jev, 'reviewed');
  });
});

test('idea generation needs matching context', async () => {
  const conv = convWith([{ id: 'a', kind: 'fact', text: 'sourdough hydration', status: 'active', domain: 'creative' }]);
  await assert.rejects(() => generateIdeas({ cfg: {}, registry: fakeRegistry(), jev: acceptJev }, conv, 'esp32 deep sleep'), /Nothing in this collection matches/);
});

// ── script.js + ingest.js ───────────────────────────────────────────────────
test('script pack requires real content', async () => {
  const conv = convWith([
    { id: 'note_1', kind: 'fact', text: 'ESP32 deep sleep current draw drops to microamps with timer wakeup', status: 'active', domain: 'creative' },
  ]);
  const deps = { cfg: {}, registry: fakeRegistry() };
  await withFetch(async () => chatJson({ script: 'x'.repeat(500), hooks: ['h'], titles: ['t'], thumbnails: ['th'], sourcesUsed: ['note_1'], needsCheck: [] }), async () => {
    const pack = await generateScript(deps, conv, { idea: 'ESP32 deep sleep video', format: 'video-script' });
    assert.equal(pack.format, 'video-script');
    assert.equal(pack.sources[0].noteId, 'note_1');
    assert.ok(FORMATS.includes('tutorial'));
  });
  await withFetch(async () => chatJson({ script: 'too short' }), async () => {
    await assert.rejects(() => generateScript(deps, conv, { idea: 'ESP32 deep sleep video' }), /unusable script/);
  });
});

test('text ingest distills and stores', async () => {
  const conv = convWith();
  const deps = {
    cfg: {}, registry: fakeRegistry(), counters: { jevCalls: 0 },
    jev: async ({ questions }) => {
      const answers = {};
      for (const key of Object.keys(questions)) {
        if (questions[key].type === 'noul') answers[key] = { type: 'noul', noul: 0.9 };
        else if (key.startsWith('kind_')) answers[key] = { type: 'choice', choice: 'fact', confidence: 0.9 };
        else if (key.startsWith('domain_')) answers[key] = { type: 'choice', choice: 'creative', confidence: 0.9 };
        else if (key.startsWith('conflicts_with_')) answers[key] = { type: 'choice', choice: 'none', confidence: 0.9 };
      }
      return { answers };
    },
  };
  const longText = 'ESP32 deep sleep drops current to microamps. Timer wakeup is the simplest path. ' .repeat(20);
  await withFetch(async () => chatJson({ summary: '- ESP32 deep sleep uses microamps\n- Timer wakeup is simplest for periodic sensing tasks', title: '' }), async () => {
    const out = await ingestText(deps, conv, { title: 'Paste', text: longText });
    assert.equal(out.source.kind, 'text');
    assert.ok(out.notes.length >= 1);
    assert.equal(conv.creative.sources.length, 1);
  });
});
