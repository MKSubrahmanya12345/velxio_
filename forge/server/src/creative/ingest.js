// Velxio Create — ingest orchestration.
//
// One URL (or pasted text) → extracted text → summarized → stored as
// JEV-governed notes + a source record on the collection. Long transcripts
// are summarized through the normal failover loop so notes stay atomic even
// when the video is hours long.

import { nowIso } from '../schema.js';
import { id } from '../memory/model.js';
import { createJsonModel } from '../providers/jsonModel.js';
import { isYouTubeUrl } from './youtube.js';
import { transcribeYouTube } from './transcribe.js';
import { assertPublicHttpUrl, fetchPageText } from './sources.js';
import { candidateNotesFromText, storeIngestedNotes } from './notes.js';
import { creativeError } from './youtube.js';

const SUMMARIZE_PROMPT = `Distill ingested content into learnable notes. Return JSON only: {"summary":"8-12 bullet lines (each a self-contained fact, claim, number, or structural observation)","title":"a short descriptive title when the source title is missing or useless, else empty string"}.

Rules: bullets must be atomic and self-contained; preserve concrete details (names, numbers, steps, quotes); never invent content; skip ads/sponsor reads Intros/outros.`;

async function summarizeSource(deps, { kind, title, text }, emit) {
  const model = createJsonModel(deps.cfg, { registry: deps.registry, operation: 'creative_ingest', emit });
  const raw = await model(SUMMARIZE_PROMPT, { kind, title, text: text.slice(0, 60000) });
  const bullets = String(raw?.summary || '').trim();
  const fixedTitle = String(raw?.title || '').trim();
  if (!bullets) throw creativeError('The model returned an empty summary. Try again.', 'bad_summary');
  return { summary: bullets.slice(0, 12000), title: fixedTitle.slice(0, 200) };
}

export async function ingestUrl(deps, conversation, url, emit = () => {}) {
  const clean = String(url || '').trim();
  if (!clean) throw creativeError('A URL is required.', 'bad_url', 400);
  let kind;
  let title = '';
  let transcript = '';
  let summary = '';
  let source = '';
  const attempts = [];
  if (isYouTubeUrl(clean)) {
    kind = 'youtube';
    const events = [];
    const done = await transcribeYouTube(deps, clean, e => { events.push(e); emit(e); });
    transcript = done.transcript;
    title = done.title;
    source = done.source;
    attempts.push(...done.attempts);
    // Gemini-watch already returns a summary; captions get one here.
    if (done.summary && done.summary.replace(/\s/g, '').length > 100) {
      summary = done.summary.slice(0, 12000);
    }
  } else {
    kind = 'page';
    const safe = assertPublicHttpUrl(clean);
    const page = await fetchPageText(safe);
    transcript = page.text;
    title = page.title;
    source = 'fetch';
  }
  if (!summary) {
    const distilled = await summarizeSource(deps, { kind, title, text: transcript }, emit);
    summary = distilled.summary;
    if ((!title || title === clean) && distilled.title) title = distilled.title;
  }
  return persistSource(deps, conversation, { kind, url: clean, title: title || clean, transcript, summary, source, attempts });
}

export async function ingestText(deps, conversation, { title, text }, emit = () => {}) {
  const clean = String(text || '').trim();
  if (clean.replace(/\s/g, '').length < 200) {
    throw creativeError('Pasted text is too short to learn from (need ~200 characters).', 'short_text', 400);
  }
  const distilled = await summarizeSource(deps, { kind: 'text', title: title || '', text: clean }, emit);
  return persistSource(deps, conversation, {
    kind: 'text',
    url: '',
    title: (title || distilled.title || 'Pasted text').slice(0, 200),
    transcript: clean.slice(0, 100000),
    summary: distilled.summary,
    source: 'paste',
    attempts: [],
  });
}

async function persistSource(deps, conversation, { kind, url, title, transcript, summary, source, attempts }) {
  const record = {
    id: id('source'),
    kind,
    url,
    title,
    source,
    attempts,
    fetchedAt: nowIso(),
    chars: transcript.length,
    summary,
    transcript: transcript.slice(0, 100000),
  };
  const candidates = candidateNotesFromText(summary, transcript, title);
  if (!candidates.length) throw creativeError('Nothing learnable could be distilled from this source.', 'empty_source');
  const { notes, jev } = await storeIngestedNotes(deps, conversation, candidates, {
    id: record.id,
    kind,
    url,
    title,
    summary,
    transcript,
  });
  conversation.creative.sources.push(record);
  conversation.updatedAt = nowIso();
  return {
    source: { ...record, transcript: undefined },
    transcriptChars: record.transcript.length,
    notes,
    jev,
  };
}
