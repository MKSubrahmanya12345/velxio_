/**
 * URL a phone on the same WiFi can open for the running board page.
 *
 * The phone does not join the simulated network. If this page was opened as
 * localhost, swap in a LAN address of this computer and keep the page port
 * so the existing /api proxy still carries the request. A page already opened
 * from a reachable host is shared as-is.
 */

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|::1|0\.0\.0\.0)$/i;

export function isShareableLanIp(ip: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return false;
  const [a, b, c] = parts;
  if (a === 127 || a === 0 || (a === 169 && b === 254)) return false;
  // Guest addresses that exist only inside the simulation.
  if (ip === '192.168.4.15') return false;
  if (a === 10 && b === 13 && c === 37) return false;
  return true;
}

export function phonePageUrl(pageOrigin: string, clientId: string, lanIps: string[]): string | null {
  if (!clientId || !/^[\w.:-]{1,160}$/.test(clientId)) return null;
  let origin: URL;
  try {
    origin = new URL(pageOrigin);
  } catch {
    return null;
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return null;
  if (origin.pathname !== '/' || origin.search || origin.hash) return null;
  const path = `/api/gateway/${clientId}/`;
  if (!LOOPBACK.test(origin.hostname)) return `${origin.origin}${path}`;
  const ip = lanIps.find(isShareableLanIp);
  if (!ip) return null;
  const port = origin.port ? `:${origin.port}` : '';
  return `${origin.protocol}//${ip}${port}${path}`;
}
