// Velxio Create — YouTube helpers (dependency-free).
//
// Two transcription routes:
//   1. Gemini-native (transcribe.js): the model watches the video server-side
//      via a file_data part. Primary route — no bytes through Forge.
//   2. Keyless caption pull (this file): extract the captionTracks from the
//      watch page and download the timed-text track. Fallback when no Gemini
//      key answers. Best-effort: YouTube changes markup and bot-walls
//      datacenter IPs, so every failure carries a clear message.

const WATCH_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be']);

export function isYouTubeUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return WATCH_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function extractVideoId(raw) {
  try {
    const url = new URL(String(raw || '').trim());
    const host = url.hostname.toLowerCase();
    if (host === 'youtu.be' || host === 'www.youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0] || '';
      return /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : '';
    }
    if (WATCH_HOSTS.has(host)) {
      const v = url.searchParams.get('v') || '';
      if (/^[A-Za-z0-9_-]{6,20}$/.test(v)) return v;
      const shorts = url.pathname.match(/^\/(shorts|live|embed)\/([A-Za-z0-9_-]{6,20})/);
      if (shorts) return shorts[2];
    }
  } catch {
    /* fall through */
  }
  return '';
}

// Pull the player response's caption track list out of the watch-page HTML.
// youtube-transcript-api uses the same anchor ("captionTracks":[...]).
export function extractCaptionTracks(html) {
  const text = String(html || '');
  const anchor = text.indexOf('"captionTracks"');
  if (anchor === -1) return [];
  const start = text.indexOf('[', anchor);
  if (start === -1) return [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length && i < start + 200000; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        try {
          const tracks = JSON.parse(text.slice(start, i + 1));
          return Array.isArray(tracks) ? tracks : [];
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

export function pickCaptionTrack(tracks) {
  const list = (Array.isArray(tracks) ? tracks : []).filter(t => t && typeof t.baseUrl === 'string');
  if (!list.length) return null;
  // Prefer manual (non-ASR) English, then any manual, then any English, then first.
  const score = t => {
    const code = String(t.languageCode || '').toLowerCase();
    const auto = /auto|asr/i.test(String(t.kind || '') + String(t.name || ''));
    return (code.startsWith('en') ? 2 : 0) + (!auto ? 1 : 0);
  };
  return [...list].sort((a, b) => score(b) - score(a))[0];
}

// Parse <text start="1.2" dur="3.4">Hello &amp; welcome</text> timed-text XML.
export function parseTimedText(xml) {
  const text = String(xml || '');
  const segments = [];
  const re = /<text[^>]*start="([\d.]+)"[^>]*dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = re.exec(text)) !== null && segments.length < 20000) {
    segments.push({
      start: Number(match[1]),
      dur: Number(match[2]),
      text: decodeEntities(match[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()),
    });
  }
  return segments.filter(s => s.text);
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export function segmentsToTranscript(segments) {
  return (segments || []).map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();
}

export function extractPageTitle(html) {
  const match = String(html || '').match(/<title>([\s\S]*?)<\/title>/i);
  if (!match) return '';
  return decodeEntities(match[1]).replace(/\s*-\s*YouTube\s*$/i, '').trim().slice(0, 200);
}

// Keyless caption pull for one video id. Throws creativeError on failure.
export async function fetchCaptions(videoId, { fetchImpl, timeoutMs = 20000 } = {}) {
  const fetchFn = fetchImpl || fetch;
  const doFetch = async url => {
    const res = await fetchFn(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  };
  let page;
  try {
    page = await doFetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`);
  } catch (error) {
    throw creativeError(`YouTube blocked the caption pull (${error.message || error}). Gemini-native transcription needs a Gemini key in Providers.`, 'youtube_blocked');
  }
  if (/Sign in to confirm you['’]re not a bot/i.test(page)) {
    throw creativeError('YouTube showed a bot check instead of captions. Gemini-native transcription needs a Gemini key in Providers.', 'youtube_blocked');
  }
  const track = pickCaptionTrack(extractCaptionTracks(page));
  if (!track) {
    throw creativeError('This video exposes no caption tracks (captions may be disabled). Gemini-native transcription needs a Gemini key in Providers.', 'no_captions');
  }
  const trackUrl = track.baseUrl.includes('&fmt=') ? track.baseUrl : `${track.baseUrl}&fmt=json3`;
  let timed;
  try {
    timed = await doFetch(trackUrl);
  } catch (error) {
    throw creativeError(`The caption track download failed (${error.message || error}).`, 'caption_download_failed');
  }
  const segments = timed.trim().startsWith('{') ? parseJson3(timed) : parseTimedText(timed);
  const transcript = segmentsToTranscript(segments);
  if (!transcript) throw creativeError('The caption track was empty.', 'empty_captions');
  return { transcript, title: extractPageTitle(page), language: track.languageCode || 'unknown', segments: segments.length };
}

// fmt=json3 shape: {"events":[{"tStartMs":..,"segs":[{"utf8":".."}]}]}
export function parseJson3(json) {
  try {
    const data = JSON.parse(String(json));
    const events = Array.isArray(data.events) ? data.events : [];
    return events
      .map(e => ({
        start: (Number(e.tStartMs) || 0) / 1000,
        dur: (Number(e.dDurationMs) || 0) / 1000,
        text: (Array.isArray(e.segs) ? e.segs.map(s => s.utf8 || '').join('') : '').replace(/\s+/g, ' ').trim(),
      }))
      .filter(s => s.text);
  } catch {
    return [];
  }
}

export function creativeError(message, code = 'creative_error', status = 502) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}
