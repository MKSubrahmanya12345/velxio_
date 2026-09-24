// WhatsApp-style contact avatar: initials on a project-derived color.
const PALETTE = ['#0b7a6b', '#128c7e', '#5a4b8f', '#a0561f', '#8f3a47', '#245c96', '#2f6b47', '#7a4368'];

function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export default function Avatar({ name, status, size = 48 }: { name: string; status?: string; size?: number }) {
  const words = name.split(/\s+/).filter(Boolean);
  const initials = (words.length ? words.slice(0, 2).map((w) => w[0]!.toUpperCase()) : ['?']).join('');
  const color = PALETTE[hash(name) % PALETTE.length];
  const busy = status === 'researching' || status === 'init';
  return (
    <div
      className={`avatar${busy ? ' avatar--busy' : ''}`}
      style={{ width: size, height: size, background: color, fontSize: size * 0.38 }}
    >
      {initials}
    </div>
  );
}