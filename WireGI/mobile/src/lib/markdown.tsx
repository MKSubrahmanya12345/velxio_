import type { ReactNode } from 'react';

// Tiny, dependency-free markdown renderer for agent chat messages — the same
// approach WireGI/client uses. Builds React elements, never
// dangerouslySetInnerHTML. Bullets are indentation-aware (2 spaces per level)
// so the WireGI summary renders as real nested lists on a phone too.

interface Bullet {
  text: string;
  children: Bullet[];
}

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith('**')) nodes.push(<strong key={`${keyPrefix}-b${i}`}>{token.slice(2, -2)}</strong>);
    else nodes.push(<code key={`${keyPrefix}-c${i}`}>{token.slice(1, -1)}</code>);
    last = m.index + token.length;
    i += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderBullets(root: Bullet[], key: string): ReactNode {
  return (
    <ul key={key}>
      {root.map((b, i) => (
        <li key={i}>
          {inline(b.text, `${key}-${i}`)}
          {b.children.length ? renderBullets(b.children, `${key}-${i}`) : null}
        </li>
      ))}
    </ul>
  );
}

function bulletDepth(line: string): number {
  const lead = (line.match(/^[ \t]*/) || [''])[0].length;
  return Math.min(6, Math.floor(lead / 2));
}

export function Markdown({ text }: { text: string }) {
  const lines = String(text ?? '').split('\n');
  const blocks: ReactNode[] = [];
  const fence = { open: false, lines: [] as string[] };
  let bullets: Bullet[] = [];
  let bulletStack: Bullet[] = [];

  const flushList = (key: string) => {
    if (!bullets.length) return;
    blocks.push(renderBullets(bullets, key));
    bullets = [];
    bulletStack = [];
  };

  lines.forEach((raw, idx) => {
    const line = raw.replace(/\s+$/, '');
    if (line.trim().startsWith('```')) {
      if (fence.open) {
        blocks.push(
          <pre className="code" key={`code-${idx}`}>
            {fence.lines.join('\n')}
          </pre>,
        );
        fence.open = false;
        fence.lines = [];
      } else {
        flushList(`ul-${idx}`);
        fence.open = true;
        fence.lines = [];
      }
      return;
    }
    if (fence.open) {
      fence.lines.push(raw);
      return;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushList(`ul-${idx}`);
      const level = h[1].length;
      blocks.push(
        <div className={`md-h md-h${level}`} key={`h-${idx}`}>
          {inline(h[2], `h-${idx}`)}
        </div>,
      );
      return;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      const depth = Math.min(bulletDepth(line), bulletStack.length);
      const node: Bullet = { text: bullet[1], children: [] };
      bulletStack.length = depth;
      if (depth === 0) bullets.push(node);
      else bulletStack[depth - 1].children.push(node);
      bulletStack[depth] = node;
      return;
    }
    if (!line.trim()) {
      flushList(`ul-${idx}`);
      return;
    }
    flushList(`ul-${idx}`);
    blocks.push(
      <p className="md-p" key={`p-${idx}`}>
        {inline(line, `p-${idx}`)}
      </p>,
    );
  });
  flushList('ul-final');
  if (fence.open) {
    blocks.push(
      <pre className="code" key="code-final">
        {fence.lines.join('\n')}
      </pre>,
    );
  }
  return <div className="md">{blocks}</div>;
}