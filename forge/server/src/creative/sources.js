// Velxio Create — web page / text source ingestion (dependency-free).
//
// Articles, docs and blog posts: fetch the page, strip chrome, keep the
// readable text. YouTube is handled by youtube.js + transcribe.js.

import { creativeError } from './youtube.js';

export const MAX_PAGE_BYTES = 1500000;
export const MAX_SOURCE_CHARS = 100000;

const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254.169.254']);

export function assertPublicHttpUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw creativeError('That is not a valid URL.', 'bad_url', 400);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw creativeError('Only http(s) URLs can be ingested.', 'bad_url', 400);
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    throw creativeError('Private/local URLs cannot be ingested.', 'blocked_url', 400);
  }
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    throw creativeError('Private/local URLs cannot be ingested.', 'blocked_url', 400);
  }
  return url.toString();
}

// Crude but dependency-free readability: drop scripts/styles/nav/footers,
// then keep paragraph-ish text.
export function htmlToText(html) {
  let text = String(html || '');
  text = text.replace(/<(script|style|noscript|template|svg|canvas)[\s\S]*?<\/\1>/gi, ' ');
  text = text.replace(/<(nav|footer|header|aside|form)[\s\S]*?<\/\1>/gi, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote)>/gi, '\n\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  const lines = text.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
  // Drop nav-crumb-ish runs: many very short lines in a row are chrome.
  const kept = [];
  let shortRun = 0;
  for (const line of lines) {
    if (line.length < 40) {
      shortRun++;
      if (shortRun <= 3) kept.push(line);
      continue;
    }
    shortRun = 0;
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function extractHtmlTitle(html) {
  const og = String(html || '').match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) return og[1].trim().slice(0, 200);
  const title = String(html || '').match(/<title>([\s\S]*?)<\/title>/i);
  return title ? title[1].replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

export async function fetchPageText(url, { fetchImpl, timeoutMs = 20000 } = {}) {
  const fetchFn = fetchImpl || fetch;
  let res;
  try {
    res = await fetchFn(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw creativeError(`Could not fetch the page (${error.message || error}).`, 'fetch_failed');
  }
  if (!res.ok) throw creativeError(`The page returned HTTP ${res.status}.`, 'fetch_failed');
  const contentType = String(res.headers?.get?.('content-type') || '');
  const buf = await res.arrayBuffer().catch(() => null);
  if (!buf) throw creativeError('The page body could not be read.', 'fetch_failed');
  const bytes = new Uint8Array(buf).slice(0, MAX_PAGE_BYTES);
  const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (/application\/json|text\/plain|text\/csv/.test(contentType)) {
    return { text: raw.trim().slice(0, MAX_SOURCE_CHARS), title: url };
  }
  if (!/html|xml/.test(contentType) && !/<html|<!doctype|<article|<p/i.test(raw.slice(0, 5000))) {
    throw creativeError(`Unsupported content type (${contentType || 'unknown'}). Articles, docs and text pages can be ingested.`, 'bad_content', 400);
  }
  const text = htmlToText(raw).slice(0, MAX_SOURCE_CHARS);
  if (text.replace(/\s/g, '').length < 200) {
    throw creativeError('The page had no readable article text (it may be paywalled or app-rendered).', 'empty_page');
  }
  return { text, title: extractHtmlTitle(raw) || url };
}
