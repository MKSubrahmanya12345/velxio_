// Velxio Create — YouTube transcription.
//
// Order (per product decision): Gemini watches the video natively first —
// the URL goes to generateContent as a file_data part, so no video bytes
// pass through Forge and YouTube's datacenter bot-wall never applies. Every
// configured Gemini key is tried in registry order. Only when all Gemini
// attempts fail do we fall back to the keyless caption pull (youtube.js),
// cleaned up through the normal all-provider failover loop.

import { providerDefinition, baseFor } from '../providers/catalog.js';
import { callProviderEntry, runWithFailover } from '../providers/failover.js';
import { creativeError, extractVideoId, fetchCaptions } from './youtube.js';

export const TRANSCRIPT_PROMPT =
  'Transcribe this video. Return the full spoken transcript as plain text (no timestamps, no speaker labels unless the video needs them), ' +
  'followed by a divider line "---SUMMARY---", followed by 5-10 bullet lines capturing the key points, claims, numbers and structure. ' +
  'Transcribe faithfully; do not invent content for parts you cannot hear.';

function geminiEntries(registry) {
  return (registry?.candidates?.() || []).filter(e => {
    try {
      return providerDefinition(e.provider)?.kind === 'gemini';
    } catch {
      return false;
    }
  });
}

function geminiWatchRequest(entry, youtubeUrl, timeoutMs) {
  const model = String(entry.model || '').trim() || providerDefinition(entry.provider).defaultModel;
  const base = baseFor(entry);
  return {
    url: `${base}/models/${encodeURIComponent(model)}:generateContent`,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': entry.apiKey },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { text: TRANSCRIPT_PROMPT },
          { file_data: { file_uri: youtubeUrl } },
        ],
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 32768 },
    }),
    timeoutMs,
  };
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) throw new Error('no candidates in Gemini response');
  const text = parts.map(p => (p && typeof p.text === 'string' ? p.text : '')).join('').trim();
  if (!text) throw new Error('Gemini returned an empty transcript');
  return text;
}

export function splitTranscriptAndSummary(text) {
  const marker = '---SUMMARY---';
  const idx = String(text || '').indexOf(marker);
  if (idx === -1) return { transcript: String(text || '').trim(), summary: '' };
  return {
    transcript: String(text).slice(0, idx).trim(),
    summary: String(text).slice(idx + marker.length).trim(),
  };
}

async function watchViaGemini(entry, youtubeUrl, { fetchImpl, timeoutMs }) {
  const request = geminiWatchRequest(entry, youtubeUrl, timeoutMs);
  let res;
  try {
    res = await (fetchImpl || fetch)(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(request.timeoutMs),
    });
  } catch (error) {
    throw new Error(`request failed (${error.message || error})`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '').then(t => t.slice(0, 200).replace(/\s+/g, ' '));
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return extractGeminiText(await res.json().catch(() => { throw new Error('non-JSON response'); }));
}

// Transcribe one YouTube URL. Returns { transcript, summary, title, source,
// attempts[] }. `emit` receives provider-switch progress events.
export async function transcribeYouTube(deps, youtubeUrl, emit = () => {}, { fetchImpl, timeoutMs = 120000 } = {}) {
  const videoId = extractVideoId(youtubeUrl);
  if (!videoId) throw creativeError('That is not a recognizable YouTube URL.', 'bad_url', 400);
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const attempts = [];
  const geminiKeys = geminiEntries(deps.registry);

  for (const entry of geminiKeys) {
    attempts.push({ provider: entry.provider, keyId: entry.id, route: 'gemini-watch' });
    try {
      const raw = await watchViaGemini(entry, watchUrl, { fetchImpl, timeoutMs });
      const { transcript, summary } = splitTranscriptAndSummary(raw);
      if (transcript.replace(/\s/g, '').length < 100) throw new Error('transcript too short — the video may be music-only or blocked');
      emit({ type: 'success', provider: entry.provider, keyId: entry.id, route: 'gemini-watch' });
      return { transcript, summary, title: watchUrl, source: 'gemini-watch', attempts, keyId: entry.id };
    } catch (error) {
      attempts[attempts.length - 1].error = String(error.message || error).slice(0, 200);
      emit({ type: 'error', provider: entry.provider, keyId: entry.id, route: 'gemini-watch', error: String(error.message || error).slice(0, 200) });
    }
  }

  // Gemini exhausted (or no Gemini key): keyless captions + a failover cleanup.
  emit({ type: 'round', message: geminiKeys.length ? 'Gemini keys exhausted — pulling public captions' : 'No Gemini key — pulling public captions' });
  const captions = await fetchCaptions(videoId, { fetchImpl });
  attempts.push({ provider: 'youtube-captions', route: 'captions', segments: captions.segments });
  let summary = '';
  try {
    const cleaned = await runWithFailover({
      registry: deps.registry,
      operation: 'transcript_cleanup',
      work: async entry => {
        const out = await callProviderEntry(entry, {
          system: 'Clean a raw video caption dump. Return JSON only: {"transcript":"cleaned full transcript as flowing paragraphs","summary":"5-10 bullet lines of key points, claims, numbers"}. Fix punctuation and casing; never invent content.',
          user: captions.transcript.slice(0, 60000),
          maxTokens: 16384,
          temperature: 0.1,
          fetchImpl,
        });
        return JSON.parse(String(out).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
      },
    });
    if (cleaned?.result?.transcript) {
      return {
        transcript: String(cleaned.result.transcript),
        summary: String(cleaned.result.summary || ''),
        title: captions.title || watchUrl,
        source: 'captions',
        attempts,
        keyId: cleaned.entry?.id || null,
      };
    }
  } catch (error) {
    attempts.push({ provider: 'failover-cleanup', route: 'captions', error: String(error.message || error).slice(0, 200) });
    summary = '';
  }
  // Cleanup failed but captions are real content — return them raw rather
  // than failing the ingest.
  return { transcript: captions.transcript, summary, title: captions.title || watchUrl, source: 'captions-raw', attempts, keyId: null };
}
