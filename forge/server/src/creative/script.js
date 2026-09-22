// Velxio Create — full creator pack generation.
//
// One failover-backed JSON call expands a validated idea into the complete
// pack: script + alternate hooks + titles + thumbnail concepts + the sources
// it drew on. Formats mirror the Velxio-side presets (video-script default).

import { createJsonModel } from '../providers/jsonModel.js';
import { retrieveNotes, logCreativeEvent } from './notes.js';
import { creativeError } from './youtube.js';

export const FORMATS = ['video-script', 'blog-post', 'tutorial', 'social-captions', 'product-copy'];

const FORMAT_BRIEF = {
  'video-script': 'a spoken video script: 3-second hook, short speakable beats with [B-ROLL]/[ON SCREEN] cues, call to action',
  'blog-post': 'a structured blog post: headline, payoff intro, scannable sections, one practical example, 3 takeaways',
  tutorial: 'a hands-on tutorial: parts list, numbered steps with success checks and one common mistake each',
  'social-captions': 'a 3-variant social pack: punchy X post (<280 chars), visual Instagram caption with hashtags, professional LinkedIn post',
  'product-copy': 'crisp product copy: one-line pitch, 3 benefit bullets, short README/launch paragraph',
};

export const SCRIPT_PROMPT = `You are a senior content writer for a maker/creator channel. Expand the chosen idea into a complete creator pack, reusing concrete facts/numbers/names from the supplied collection notes.

Return JSON only: {"script":"the full piece in lightweight markdown","hooks":["3 alternate opening hooks"],"titles":["5 title options, ranked"],"thumbnails":["3 thumbnail concepts described in one line each"],"sourcesUsed":["note ids actually reused"],"needsCheck":["any claim that needs verifying, or empty array"]}

Rules: never invent facts the notes do not support; every concrete claim must trace to a supplied note id; flag uncertain claims in needsCheck instead of stating them.`;

function normalizePack(raw, noteIds) {
  const ids = new Set(noteIds);
  const str = v => String(v || '').trim();
  const strList = (v, max) => (Array.isArray(v) ? v.map(str).filter(Boolean).slice(0, max) : []);
  const pack = {
    script: str(raw?.script).slice(0, 24000),
    hooks: strList(raw?.hooks, 5),
    titles: strList(raw?.titles, 8),
    thumbnails: strList(raw?.thumbnails, 5),
    sourcesUsed: (Array.isArray(raw?.sourcesUsed) ? raw.sourcesUsed.map(String).filter(id => ids.has(id)) : []).slice(0, 10),
    needsCheck: strList(raw?.needsCheck, 10),
  };
  if (!pack.script || pack.script.length < 200) {
    throw creativeError('The model returned an unusable script. Try again or pick another idea.', 'bad_script');
  }
  return pack;
}

export async function generateScript(deps, conversation, { idea, prompt = '', format = 'video-script' } = {}, emit = () => {}) {
  const fmt = FORMATS.includes(format) ? format : 'video-script';
  const ideaText = typeof idea === 'string' ? idea.trim() : `${idea?.title || ''}\n${idea?.pitch || ''}`.trim();
  if (!ideaText) throw creativeError('An idea (title + pitch, or text) is required.', 'bad_idea', 400);
  if (ideaText.length > 3000) throw creativeError('Idea text must be under 3000 characters.', 'bad_idea', 400);
  const memory = conversation.memory;
  const context = retrieveNotes(memory, `${ideaText} ${prompt}`, 12);
  if (!context.length) throw creativeError('Nothing in this collection matches this idea. Ingest related links first.', 'no_context', 400);
  const model = createJsonModel(deps.cfg, { registry: deps.registry, operation: 'creative_script', emit });
  const raw = await model(`${SCRIPT_PROMPT}\n\nFormat: ${FORMAT_BRIEF[fmt]}.`, {
    idea: ideaText.slice(0, 3000),
    request: String(prompt || '').slice(0, 2000),
    format: fmt,
    notes: context.map(({ _score, ...note }) => note),
  });
  const pack = normalizePack(raw, context.map(n => n.id));
  const byId = new Map(context.map(n => [n.id, n]));
  pack.sources = pack.sourcesUsed.map(id => {
    const note = byId.get(id);
    return note ? { noteId: id, kind: note.kind, text: note.text, sourceId: note.sourceId || null } : { noteId: id };
  });
  logCreativeEvent(memory, 'script', 'complete', `Full pack generated (${fmt}) for: ${ideaText.slice(0, 80)}`, { format: fmt });
  return { ...pack, format: fmt, idea: ideaText.slice(0, 300) };
}
