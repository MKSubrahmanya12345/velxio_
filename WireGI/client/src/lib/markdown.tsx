import type { ReactNode } from 'react';

// Tiny, dependency-free markdown renderer for agent chat messages.
// Deliberately not a general markdown engine: it handles what WireGI produces
// (headings, bullets, bold, inline code, code fences) by building React
// elements — never dangerouslySetInnerHTML.

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

export function Markdown({ text }: { text: string }) {
  const lines = String(text ?? '').split('\n');
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let code: string[] | null = null;

  const flushList = (key: string) => {
    if (!list.length) return;
    blocks.push(
      <ul key={key}>
        {list.map((item, i) => (
          <li key={i}>{inline(item, `${key}-${i}`)}</li>
        ))}
      </ul>,
    );
    list = [];
  };

  lines.forEach((raw, idx) => {
    const line = raw.replace(/\s+$/, '');
    if (line.trim().startsWith('```')) {
      if (code) {
        blocks.push(
          <pre className="code" key={`code-${idx}`}>
            {code.join('\n')}
          </pre>,
        );
        code = null;
      } else {
        flushList(`ul-${idx}`);
        code = [];
      }
      return;
    }
    if (code) {
      code.push(raw);
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
      list.push(bullet[1]);
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
  if (code) {
    blocks.push(
      <pre className="code" key="code-final">
        {code.join('\n')}
      </pre>,
    );
  }
  return <div className="md">{blocks}</div>;
}
