/**
 * Build lab. A sentence becomes a researched configuration the human edits,
 * and only then a simulation of that configuration. One project, in this tab.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import { AppHeader } from '../components/layout/AppHeader';
import { ScopeCanvas } from '../components/buildlab/ScopeCanvas';
import {
  clearProject,
  derive,
  dossierText,
  EXAMPLES,
  loadProject,
  research,
  resetSim,
  revise,
  saveProject,
  setField,
} from '../buildlab';
import { openSim, type LiveSim, type SimSample } from '../buildlab/flight';
import type { Confidence, Dossier, FieldSpec, MachineConfig, Stick } from '../buildlab/types';
import { useSEO } from '../utils/useSEO';
import './BuildLabPage.css';

const DEFAULT_STICK: Stick = { roll: 0, pitch: 0, yaw: 0, throttle: 0.45, mode: 'hold' };

const SEO = {
  title: 'Build lab — research a machine, then simulate it | Velxio',
  description:
    'Describe a machine. Velxio researches the class, hands you the numbers to confirm, and simulates the configuration you keep. A drone, a rover, a wing, a rocket, an arm, a weather station — one project, in the browser.',
  url: 'https://velxio.dev/build',
};

function boot(): { config: MachineConfig; dossier: Dossier; live: LiveSim } | null {
  const saved = loadProject();
  if (!saved) return null;
  try {
    const dossier = derive(saved);
    return { config: saved, dossier, live: openSim(dossier.plan) };
  } catch {
    clearProject();
    return null;
  }
}

export function BuildLabPage() {
  useSEO(SEO);
  const [started] = useState(boot);
  const [config, setConfig] = useState<MachineConfig | null>(started?.config ?? null);
  const [dossier, setDossier] = useState<Dossier | null>(started?.dossier ?? null);
  const [prompt, setPrompt] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [readout, setReadout] = useState<SimSample | null>(null);
  const [stick, setStick] = useState<Stick>(started?.live.stick ?? DEFAULT_STICK);
  const [armed, setArmed] = useState(false);
  const liveRef = useRef<LiveSim | null>(started?.live ?? null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!liveRef.current) return;
      if (event.code === 'Space') {
        event.preventDefault();
        setArmed((on) => {
          if (liveRef.current) liveRef.current.armed = !on;
          return !on;
        });
      } else if (event.key === 'r' || event.key === 'R') {
        resetSim(liveRef.current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function adopt(next: MachineConfig, note: string | null) {
    let nextDossier: Dossier;
    try {
      nextDossier = derive(next);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'That configuration does not parse.');
      return;
    }
    const prev = liveRef.current;
    const live = openSim(nextDossier.plan);
    if (prev && prev.plan.kind === live.plan.kind) {
      live.stick = { ...stick };
      live.armed = armed;
      live.killed = prev.killed.filter((id) =>
        live.plan.kind === 'multirotor' && live.plan.mounts.some((m) => m.id === id),
      );
    }
    liveRef.current = live;
    setStick(live.stick);
    setArmed(live.armed);
    setConfig(next);
    setDossier(nextDossier);
    setNotice(note);
    setReadout(null);
    saveProject(next);
  }

  function submit(text: string) {
    const said = text.trim();
    if (!said) return;
    if (!config) {
      adopt(research(said), null);
    } else {
      const result = revise(config, said);
      adopt(result.config, result.reason);
    }
    setPrompt('');
  }

  function wipe() {
    clearProject();
    liveRef.current = null;
    setConfig(null);
    setDossier(null);
    setNotice(null);
    setReadout(null);
    setPrompt('');
    setStick(DEFAULT_STICK);
    setArmed(false);
  }

  function updateStick(patch: Partial<Stick>) {
    setStick((prev) => {
      const next = { ...prev, ...patch };
      if (liveRef.current) liveRef.current.stick = next;
      return next;
    });
  }

  function toggleArm() {
    setArmed((on) => {
      const next = !on;
      if (liveRef.current) liveRef.current.armed = next;
      return next;
    });
  }

  return (
    <div className="bl">
      <AppHeader />
      {!config || !dossier ? (
        <Hero prompt={prompt} setPrompt={setPrompt} onSubmit={submit} />
      ) : (
        <Workbench
          config={config}
          dossier={dossier}
          prompt={prompt}
          setPrompt={setPrompt}
          notice={notice}
          setNotice={setNotice}
          readout={readout}
          setReadout={setReadout}
          liveRef={liveRef}
          stick={stick}
          armed={armed}
          onStick={updateStick}
          onArm={toggleArm}
          onSubmit={submit}
          onField={(id, raw) => {
            const next = setField(config, id, raw);
            if (next !== config) adopt(next, null);
          }}
          onWipe={wipe}
          onKill={(id) => {
            const live = liveRef.current;
            if (!live) return;
            live.killed = live.killed.includes(id)
              ? live.killed.filter((k) => k !== id)
              : [...live.killed, id];
          }}
        />
      )}
    </div>
  );
}

function Hero({
  prompt,
  setPrompt,
  onSubmit,
}: {
  prompt: string;
  setPrompt: (v: string) => void;
  onSubmit: (text: string) => void;
}) {
  return (
    <main className="bl-main">
      <div className="bl-hero">
        <p className="bl-kicker">Build lab</p>
        <h1>Tell it what you want to build.</h1>
        <p className="bl-lede">
          It researches the class, puts the numbers in front of you, and waits.
          You change the ones that are yours. Then it simulates that machine —
          not a finished aircraft it invented behind the form.
        </p>
        <form
          className="bl-prompt"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(prompt);
          }}
        >
          <input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="I wanna build a drone"
            aria-label="What do you want to build?"
            autoFocus
          />
          <button className="bl-go" type="submit">Research</button>
        </form>
        <ul className="bl-chips">
          {EXAMPLES.map((ex) => (
            <li key={ex.prompt}>
              <button type="button" onClick={() => onSubmit(ex.prompt)}>
                {ex.prompt}
                <span>{ex.note}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="bl-fine">
          One project, stored in this browser. A follow-up amends it. A different
          kind of machine replaces it. Nothing here files a flight plan.
        </p>
      </div>
    </main>
  );
}

function Workbench({
  config,
  dossier,
  prompt,
  setPrompt,
  notice,
  setNotice,
  readout,
  setReadout,
  liveRef,
  stick,
  armed,
  onStick,
  onArm,
  onSubmit,
  onField,
  onWipe,
  onKill,
}: {
  config: MachineConfig;
  dossier: Dossier;
  prompt: string;
  setPrompt: (v: string) => void;
  notice: string | null;
  setNotice: (v: string | null) => void;
  readout: SimSample | null;
  setReadout: (s: SimSample) => void;
  liveRef: RefObject<LiveSim | null>;
  stick: Stick;
  armed: boolean;
  onStick: (patch: Partial<Stick>) => void;
  onArm: () => void;
  onSubmit: (text: string) => void;
  onField: (id: string, raw: string) => void;
  onWipe: () => void;
  onKill: (id: string) => void;
}) {
  const groups = groupFields(dossier.fields);
  const openCount = dossier.fields.filter((f) =>
    f.confidence === 'needs-you' && !config.confirmed.includes(f.id),
  ).length;

  function download() {
    const blob = new Blob([dossierText(config, dossier)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug(config.name)}-sheet.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="bl-main">
      <div className="bl-top">
        <h1 className="bl-name">
          {dossier.title}
          <small>{dossier.archetype} · {openCount === 0 ? 'fields touched or cited' : `${openCount} still to measure`}</small>
        </h1>
        <form
          className="bl-follow"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(prompt);
          }}
        >
          <input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder='Follow up — “make it a 5-inch on 6S”'
            aria-label="Amend this machine"
          />
          <button className="bl-ghost" type="submit">Apply</button>
        </form>
        <button className="bl-ghost" type="button" onClick={download}>Download sheet</button>
        <button className="bl-ghost" type="button" onClick={onWipe}>Start over</button>
      </div>

      {notice && (
        <div className="bl-banner">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">Close</button>
        </div>
      )}

      {dossier.warnings.length > 0 && (
        <div className="bl-warns">
          {dossier.warnings.map((w) => (
            <div key={w.text} className={`bl-warn bl-warn-${w.level}`}>{w.text}</div>
          ))}
        </div>
      )}

      <div className="bl-grid">
        <section className="bl-col bl-sheet" aria-label="Configuration">
          <p className="bl-summary">{dossier.summary}</p>
          {groups.map(([group, fields]) => (
            <div key={group}>
              <h2>{group}</h2>
              {fields.map((field) => (
                <FieldRow
                  key={`${field.id}:${valueOf(config, field.id)}`}
                  field={field}
                  value={valueOf(config, field.id)}
                  confirmed={config.confirmed.includes(field.id)}
                  onCommit={(raw) => onField(field.id, raw)}
                />
              ))}
            </div>
          ))}
        </section>

        <section className="bl-col bl-scope-col" aria-label="Simulation">
          <div className="bl-metrics">
            {dossier.metrics.map((m) => (
              <div key={m.id} className="bl-metric">
                <span>{m.label}</span>
                <strong>{m.value}</strong>
              </div>
            ))}
          </div>
          <div className="bl-scope">
            <ScopeCanvas liveRef={liveRef} onReadout={setReadout} onKill={onKill} />
            <div className="bl-readout">
              <div><span>{readLabel(config, 'a')}</span><strong>{readValue(config, readout, 'a')}</strong></div>
              <div><span>{readLabel(config, 'b')}</span><strong>{readValue(config, readout, 'b')}</strong></div>
              <div><span>Power</span><strong>{readout ? `${readout.powerW.toFixed(0)} W` : '—'}</strong></div>
              <div><span>Energy</span><strong>{readout ? `${readout.energyWh.toFixed(1)}` : '—'}</strong></div>
            </div>
          </div>
          <p className="bl-caption">{caption(config)}</p>
          <div className="bl-controls">
            <button
              type="button"
              className={armed ? 'bl-arm is-on' : 'bl-arm'}
              onClick={onArm}
            >
              {armed ? 'Disarm' : 'Arm'}
            </button>
            <button
              type="button"
              className="bl-ghost"
              onClick={() => {
                if (liveRef.current) resetSim(liveRef.current);
              }}
            >
              Reset
            </button>
            {config.archetype === 'multirotor' && (
              <>
                <ModeButtons stick={stick} setStick={onStick} />
                {stick.mode === 'manual' && (
                  <>
                    <StickSlider name="Throttle" value={stick.throttle} min={0} max={1} step={0.01} onChange={(v) => onStick({ throttle: v })} />
                    <StickSlider name="Pitch" value={stick.pitch} min={-1} max={1} step={0.01} onChange={(v) => onStick({ pitch: v })} />
                    <StickSlider name="Roll" value={stick.roll} min={-1} max={1} step={0.01} onChange={(v) => onStick({ roll: v })} />
                  </>
                )}
                <StickSlider name="Yaw" value={stick.yaw} min={-1} max={1} step={0.01} onChange={(v) => onStick({ yaw: v })} />
              </>
            )}
            {config.archetype === 'surface' && (
              <>
                <StickSlider name="Throttle" value={stick.throttle} min={0} max={1} step={0.01} onChange={(v) => onStick({ mode: 'manual', throttle: v })} />
                <StickSlider name="Steer" value={stick.yaw} min={-1} max={1} step={0.01} onChange={(v) => onStick({ mode: 'manual', yaw: v })} />
              </>
            )}
            {config.archetype === 'arm' && (
              <StickSlider name="Target" value={stick.pitch} min={-0.2} max={1} step={0.01} onChange={(v) => onStick({ mode: 'manual', pitch: v })} />
            )}
            {config.archetype === 'multirotor' && readout && (
              <div className="bl-motors">
                {readout.motors.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={m.killed ? 'is-dead' : undefined}
                    onClick={() => onKill(m.id)}
                  >
                    {m.name} {Math.round(m.input * 100)}%
                  </button>
                ))}
              </div>
            )}
          </div>
          <p className="bl-caption">Space arms. R resets. Click a motor to kill it. The picture uses the numbers in the sheet — change a field and the flight restarts on those numbers.</p>
        </section>

        <section className="bl-col" aria-label="Research">
          {dossier.classCard && (
            <article className="bl-card">
              <h2>{dossier.classCard.title}</h2>
              {dossier.classCard.lines.map((line) => (
                <div key={line.label} className="bl-line">
                  <span>{line.label}</span>
                  <div>{line.value}</div>
                </div>
              ))}
            </article>
          )}
          {dossier.notes.map((note) => (
            <article key={note.id} className="bl-note">
              <p className="bl-kind">{note.kind}</p>
              <h3>{note.title}</h3>
              <p>{note.body}</p>
            </article>
          ))}
          {dossier.wires.length > 0 && (
            <article className="bl-card">
              <h2>Wiring, on your bench</h2>
              <ul>
                {dossier.wires.map((w) => (
                  <li key={w.from + w.to}><strong>{w.from}</strong> → {w.to}. {w.note}</li>
                ))}
              </ul>
            </article>
          )}
          {dossier.sources.length > 0 && (
            <article className="bl-card">
              <h2>Sources</h2>
              <ul>
                {dossier.sources.map((s) => (
                  <li key={s.id}>
                    <a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a>
                    {' — '}{s.usedFor}
                  </li>
                ))}
              </ul>
            </article>
          )}
        </section>
      </div>
    </main>
  );
}

function FieldRow({
  field,
  value,
  confirmed,
  onCommit,
}: {
  field: FieldSpec;
  value: string;
  confirmed: boolean;
  onCommit: (raw: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const open = field.confidence === 'needs-you' && !confirmed;
  return (
    <div className={open ? 'bl-field is-open' : 'bl-field'}>
      <label htmlFor={`bl-${field.id}`}>{field.label}{field.unit ? ` (${field.unit})` : ''}</label>
      <span className={`bl-pill bl-pill-${field.confidence}`}>{pill(field.confidence, confirmed)}</span>
      {field.kind === 'select' ? (
        <select
          id={`bl-${field.id}`}
          value={value}
          onChange={(event) => onCommit(event.target.value)}
        >
          {field.options?.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      ) : (
        <input
          id={`bl-${field.id}`}
          inputMode="decimal"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (draft !== value) onCommit(draft);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onCommit(draft);
            }
          }}
        />
      )}
      <p className="bl-why">{field.why}</p>
    </div>
  );
}

function ModeButtons({
  stick,
  setStick,
}: {
  stick: LiveSim['stick'] | undefined;
  setStick: (patch: Partial<LiveSim['stick']>) => void;
}) {
  const mode = stick?.mode ?? 'hold';
  return (
    <>
      {(['hold', 'manual', 'mission'] as const).map((m) => (
        <button
          key={m}
          type="button"
          className="bl-ghost"
          aria-pressed={mode === m}
          onClick={() => setStick({ mode: m })}
        >
          {m === 'hold' ? 'Hold' : m === 'manual' ? 'Manual' : 'Square'}
        </button>
      ))}
    </>
  );
}

function StickSlider({
  name,
  value,
  min,
  max,
  step,
  onChange,
}: {
  name: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="bl-stick">
      {name} {value.toFixed(2)}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function groupFields(fields: FieldSpec[]): [string, FieldSpec[]][] {
  const order: string[] = [];
  const map = new Map<string, FieldSpec[]>();
  for (const f of fields) {
    if (!map.has(f.group)) {
      map.set(f.group, []);
      order.push(f.group);
    }
    map.get(f.group)!.push(f);
  }
  return order.map((g) => [g, map.get(g)!]);
}

function valueOf(config: MachineConfig, id: string): string {
  const v = (config as unknown as Record<string, unknown>)[id];
  return v == null ? '' : String(v);
}

function pill(confidence: Confidence, confirmed: boolean): string {
  if (confirmed) return 'you set this';
  if (confidence === 'cited') return 'cited';
  if (confidence === 'class-band') return 'class band';
  if (confidence === 'needs-you') return 'measure this';
  return 'estimate';
}

function caption(config: MachineConfig): string {
  if (config.archetype === 'multirotor') {
    return 'Close view of the airframe, so the props stay readable. Altitude is the tape on the right — a dashed mark is the hold you set. The map is position, north up. Horizon disk is attitude.';
  }
  if (config.archetype === 'surface') return 'Differential drive. The nose mark is +Z, the direction throttle pushes. The map is the bench.';
  if (config.archetype === 'wing') return 'The wing is already flying when you arm. Lift is ½ρv²ClS applied as a force, not a polar. If it diverges, the sheet is still the sizing — the picture is not a flight test.';
  if (config.archetype === 'ballistic') return 'Altitude against time. The shaded band is the burn you set. Apogee is the high-water mark, including the way down.';
  if (config.archetype === 'arm') return 'One link. Dashed line is the target. θ = 0 is horizontal; gravity is worst there. This is not a second joint.';
  return 'One simulated hour per second. The gold arc is daylight. The cell is state of charge, not a weather forecast.';
}

function readLabel(config: MachineConfig, slot: 'a' | 'b'): string {
  if (config.archetype === 'station') return slot === 'a' ? 'Hour' : 'Charge';
  if (config.archetype === 'arm') return slot === 'a' ? 'Angle' : 'Rate';
  if (config.archetype === 'ballistic') return slot === 'a' ? 'Altitude' : 'Apogee';
  return slot === 'a' ? 'Altitude' : 'Speed';
}

function readValue(config: MachineConfig, sample: SimSample | null, slot: 'a' | 'b'): string {
  if (!sample) return '—';
  if (config.archetype === 'station') {
    if (slot === 'b') return `${(sample.alt * 100).toFixed(0)}%`;
    const h = Math.floor(sample.z) % 24;
    const m = Math.floor((sample.z % 1) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  if (config.archetype === 'arm') {
    return slot === 'a' ? `${sample.pitchDeg.toFixed(1)}°` : `${sample.speed.toFixed(2)}`;
  }
  if (config.archetype === 'ballistic' && slot === 'b') return `${sample.apogee.toFixed(1)} m`;
  if (slot === 'a') return `${sample.alt.toFixed(2)} m`;
  return `${sample.speed.toFixed(2)} m/s`;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'machine';
}
