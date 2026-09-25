import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { getApiBase } from '../../lib/apiBase';
import { phonePageUrl } from '../../lib/phonePageUrl';

/**
 * The link a phone on this computer's WiFi can open. Shown only while a
 * board page is actually reachable. The phone does not join the board WiFi.
 */
export function PhonePageCard({ clientId }: { clientId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let cancel = false;
    const origin = window.location.origin;
    const ready = phonePageUrl(origin, clientId, []);
    if (ready) {
      setUrl(ready);
      setFailed(false);
      return;
    }
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/gateway/lan`);
        const data = res.ok ? await res.json() : { ips: [] };
        const ips = Array.isArray(data?.ips)
          ? data.ips.filter((item: unknown): item is string => typeof item === 'string')
          : [];
        const next = phonePageUrl(origin, clientId, ips);
        if (!cancel) {
          setUrl(next);
          setFailed(next == null);
        }
      } catch {
        if (!cancel) setFailed(true);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [clientId]);

  if (hidden) return null;

  const copy = () => {
    if (!url) return;
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(() => {});
      return;
    }
    done();
  };

  return createPortal(
    <div className="phone-page-card" role="status">
      <div className="phone-page-card-bar">
        <strong>Phone on this WiFi</strong>
        <button type="button" className="phone-page-card-hide" onClick={() => setHidden(true)}>
          Hide
        </button>
      </div>
      {url ? (
        <>
          <a className="phone-page-card-url" href={url} target="_blank" rel="noreferrer">
            {url}
          </a>
          <button type="button" className="phone-page-card-copy" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <p>
            Open this on a phone that is on the same WiFi as this computer, while the simulation
            is running. The phone does not join the board&apos;s WiFi. If the page will not load,
            allow this computer&apos;s page port through its firewall.
          </p>
        </>
      ) : failed ? (
        <p>
          This computer has no network address a phone can open. Open Velxio from this
          machine&apos;s address on the WiFi, not from a page that only exists on this computer.
        </p>
      ) : (
        <p>Finding an address your phone can open…</p>
      )}
    </div>,
    document.body,
  );
}
