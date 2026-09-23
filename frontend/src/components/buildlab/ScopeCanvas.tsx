/**
 * The instrument. A close view of the machine you configured, not a
 * screenshot of a game. Altitude and position are tapes and a map, because
 * a 140 mm quad and a 1.4 m hover cannot share one honest scale.
 */

import { useEffect, useRef, type RefObject } from 'react';
import { qRotate, type Vec3 } from '../../simulation/physics';
import type { LiveSim, SimSample } from '../../buildlab/flight';
import { tick } from '../../buildlab/flight';

interface Hit {
  id: string;
  x: number;
  y: number;
  r: number;
}

interface Hist {
  t: number;
  alt: number;
  x: number;
  z: number;
}

const BED = '#07110d';
const INK = '#d7efe2';
const DIM = '#7d9c8c';
const GRID = 'rgba(140, 190, 160, 0.16)';
const GOOD = '#3dce86';
const HOT = '#e2b15a';
const BAD = '#e15b55';
const LINE = 'rgba(215, 239, 226, 0.55)';

export function ScopeCanvas({
  liveRef,
  onReadout,
  onKill,
}: {
  liveRef: RefObject<LiveSim | null>;
  onReadout: (sample: SimSample) => void;
  onKill: (id: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hitsRef = useRef<Hit[]>([]);
  const histRef = useRef<Hist[]>([]);
  const onReadoutRef = useRef(onReadout);
  const onKillRef = useRef(onKill);
  useEffect(() => {
    onReadoutRef.current = onReadout;
    onKillRef.current = onKill;
  }, [onReadout, onKill]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const frame = (now: number) => {
      const dt = Math.min(50, Math.max(0, now - last));
      last = now;
      const live = liveRef.current;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cssW = Math.max(2, rect.width);
      const cssH = Math.max(2, rect.height);
      const bw = Math.floor(cssW * dpr);
      const bh = Math.floor(cssH * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      const ctx = canvas.getContext('2d');
      if (ctx && live) {
        if (live.armed) tick(live, dt);
        else if (!live.last) tick(live, 0);
        const sample = live.last;
        if (sample) {
          const prev = histRef.current[histRef.current.length - 1];
          if (!prev || sample.tMs < prev.t - 1) histRef.current = [];
          if (!prev || sample.tMs - prev.t >= 80) {
            histRef.current.push({ t: sample.tMs, alt: sample.alt, x: sample.x, z: sample.z });
            if (histRef.current.length > 360) histRef.current.shift();
          }
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        hitsRef.current = [];
        draw(ctx, live, cssW, cssH, histRef.current, hitsRef.current);
      }
      acc += dt;
      if (acc > 110 && live?.last) {
        acc = 0;
        onReadoutRef.current(live.last);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [liveRef]);

  return (
    <canvas
      ref={canvasRef}
      className="bl-canvas"
      aria-label="Simulation scope. Click a motor to kill it."
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const hit = hitsRef.current.find((h) => (h.x - x) ** 2 + (h.y - y) ** 2 <= h.r * h.r);
        if (hit) onKillRef.current(hit.id);
      }}
    />
  );
}

function draw(
  ctx: CanvasRenderingContext2D,
  live: LiveSim,
  w: number,
  h: number,
  hist: Hist[],
  hits: Hit[],
): void {
  ctx.fillStyle = BED;
  ctx.fillRect(0, 0, w, h);
  vignette(ctx, w, h);
  const kind = live.plan.kind;
  if (kind === 'arm') drawArm(ctx, live, w, h);
  else if (kind === 'station') drawStation(ctx, live, w, h);
  else if (kind === 'ballistic') drawBallistic(ctx, live, w, h, hist);
  else drawVehicle(ctx, live, w, h, hist, hits);
  hud(ctx, live, w, h);
}

function drawVehicle(
  ctx: CanvasRenderingContext2D,
  live: LiveSim,
  w: number,
  h: number,
  hist: Hist[],
  hits: Hit[],
): void {
  const sample = live.last;
  const q = sample?.quat ?? { x: 0, y: 0, z: 0, w: 1 };
  const cx = w * 0.4;
  const cy = h * 0.54;
  horizon(ctx, cx, cy, Math.min(w, h) * 0.34, sample?.rollDeg ?? 0, sample?.pitchDeg ?? 0);

  const span = vehicleSpan(live);
  const scale = Math.min(w * 0.34, h * 0.4) / Math.max(span, 0.05);
  const project = (local: Vec3) => {
    const p = qRotate(q, local);
    return {
      x: cx + p.x * scale,
      y: cy - (p.y * 0.84 - p.z * 0.34) * scale,
    };
  };

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (live.plan.kind === 'multirotor') {
    const mounts = live.plan.mounts;
    const hub = project({ x: 0, y: 0, z: 0 });
    for (const m of mounts) {
      const tip = project({ x: m.x, y: 0, z: m.z });
      ctx.strokeStyle = LINE;
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(hub.x, hub.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.stroke();
    }
    const propR = Math.max(11, (live.plan.propDiameterM / 2) * scale);
    mounts.forEach((m, i) => {
      const tip = project({ x: m.x, y: 0.004, z: m.z });
      const motor = sample?.motors.find((a) => a.id === m.id);
      const killed = live.killed.includes(m.id);
      const input = motor?.input ?? 0;
      ctx.beginPath();
      ctx.ellipse(tip.x, tip.y, propR, propR * 0.72, live.spin + i, 0, Math.PI * 2);
      ctx.strokeStyle = killed ? BAD : input > 0.8 ? HOT : GOOD;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = killed ? BAD : input > 0.8 ? HOT : GOOD;
      ctx.fill();
      if (killed) {
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(tip.x - 3, tip.y - 3);
        ctx.lineTo(tip.x + 3, tip.y + 3);
        ctx.moveTo(tip.x + 3, tip.y - 3);
        ctx.lineTo(tip.x - 3, tip.y + 3);
        ctx.stroke();
      }
      label(ctx, m.name, tip.x, tip.y + propR * 0.72 + 12, DIM, 10);
      hits.push({ id: m.id, x: tip.x, y: tip.y, r: Math.max(16, propR) });
    });
    ctx.beginPath();
    ctx.arc(hub.x, hub.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = INK;
    ctx.fill();
  } else if (live.plan.kind === 'surface') {
    const track = live.plan.track;
    const body = [
      { x: -track * 0.7, y: 0.02, z: 0.18 },
      { x: track * 0.7, y: 0.02, z: 0.18 },
      { x: track * 0.55, y: 0.02, z: -0.16 },
      { x: -track * 0.55, y: 0.02, z: -0.16 },
    ].map(project);
    strokePoly(ctx, body, INK, 2);
    for (const side of [-1, 1]) {
      const wheel = project({ x: side * track / 2, y: 0, z: 0 });
      ctx.beginPath();
      ctx.arc(wheel.x, wheel.y, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#1c2a24';
      ctx.fill();
      ctx.strokeStyle = GOOD;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    const nose = project({ x: 0, y: 0.03, z: 0.22 });
    ctx.fillStyle = HOT;
    ctx.fillRect(nose.x - 3, nose.y - 3, 6, 6);
  } else if (live.plan.kind === 'wing') {
    const pts = (locals: Vec3[]) => locals.map(project);
    strokePoly(ctx, pts([
      { x: 0, y: 0, z: 0.42 },
      { x: 0.06, y: 0, z: -0.28 },
      { x: -0.06, y: 0, z: -0.28 },
    ]), INK, 2);
    ctx.beginPath();
    const left = project({ x: -0.55, y: 0, z: 0.05 });
    const right = project({ x: 0.55, y: 0, z: 0.05 });
    const root = project({ x: 0, y: 0, z: 0.08 });
    ctx.moveTo(left.x, left.y);
    ctx.lineTo(root.x, root.y);
    ctx.lineTo(right.x, right.y);
    ctx.strokeStyle = GOOD;
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  drawMap(ctx, live, hist, 16, h - 124, 108, 108);
  if (live.plan.kind !== 'surface') drawTape(ctx, live, w, h);
  else drawSpeedTape(ctx, live, w);
}

function vehicleSpan(live: LiveSim): number {
  if (live.plan.kind === 'multirotor') {
    const arm = live.plan.mounts.reduce((m, p) => Math.max(m, Math.hypot(p.x, p.z)), 0.05);
    return Math.max(arm * 2.6, live.plan.propDiameterM * 1.4);
  }
  if (live.plan.kind === 'surface') return Math.max(live.plan.track * 2.2, 0.28);
  return 1.2;
}

function drawTape(ctx: CanvasRenderingContext2D, live: LiveSim, w: number, h: number): void {
  const alt = live.last?.alt ?? 0;
  const target = live.plan.kind === 'multirotor' || live.plan.kind === 'wing'
    ? live.plan.hoverAltitude
    : 0;
  const x = w - 58;
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, 36);
  ctx.lineTo(x, h - 28);
  ctx.stroke();
  const pxPerM = 42;
  const mid = h * 0.5;
  for (let m = Math.floor(alt) - 4; m <= Math.ceil(alt) + 4; m++) {
    const y = mid - (m - alt) * pxPerM;
    if (y < 28 || y > h - 20) continue;
    ctx.fillStyle = DIM;
    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(String(m), x + 8, y + 3);
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.moveTo(x - 6, y);
    ctx.lineTo(x, y);
    ctx.stroke();
  }
  if (target > 0) {
    const y = mid - (target - alt) * pxPerM;
    if (y > 28 && y < h - 20) {
      ctx.strokeStyle = HOT;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x - 14, y);
      ctx.lineTo(x + 6, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.fillStyle = INK;
  ctx.fillRect(x - 46, mid - 11, 42, 22);
  ctx.fillStyle = BED;
  ctx.font = '12px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.fillText(alt.toFixed(2), x - 8, mid + 4);
  label(ctx, 'ALT m', x - 8, 24, DIM, 10);
}

function drawSpeedTape(ctx: CanvasRenderingContext2D, live: LiveSim, w: number): void {
  label(ctx, 'SPEED', w - 78, 28, DIM, 10);
  ctx.fillStyle = INK;
  ctx.font = '22px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.fillText(`${(live.last?.speed ?? 0).toFixed(2)}`, w - 16, 56);
  label(ctx, 'm/s', w - 16, 72, DIM, 10);
}

function drawMap(
  ctx: CanvasRenderingContext2D,
  live: LiveSim,
  hist: Hist[],
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.fillStyle = 'rgba(7, 17, 13, 0.72)';
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, 6);
  ctx.fill();
  ctx.stroke();
  const cx = x + w / 2;
  const cy = y + h / 2;
  let reach = 1.5;
  for (const p of hist) reach = Math.max(reach, Math.hypot(p.x, p.z) * 1.25);
  if (live.last) reach = Math.max(reach, Math.hypot(live.last.x, live.last.z) * 1.25);
  const s = (Math.min(w, h) * 0.42) / reach;
  ctx.strokeStyle = GRID;
  ctx.beginPath();
  ctx.moveTo(x + 8, cy);
  ctx.lineTo(x + w - 8, cy);
  ctx.moveTo(cx, y + 8);
  ctx.lineTo(cx, y + h - 8);
  ctx.stroke();
  if (hist.length > 1) {
    ctx.beginPath();
    hist.forEach((p, i) => {
      const px = cx + p.x * s;
      const py = cy - p.z * s;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.strokeStyle = GOOD;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }
  if (live.last) {
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(cx + live.last.x * s, cy - live.last.z * s, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  label(ctx, 'N', cx, y + 12, DIM, 9);
}

function drawBallistic(
  ctx: CanvasRenderingContext2D,
  live: LiveSim,
  w: number,
  h: number,
  hist: Hist[],
): void {
  const pad = { l: 46, r: 24, t: 36, b: 32 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const apogee = Math.max(live.last?.apogee ?? 0, live.last?.alt ?? 0, 8);
  const tMax = Math.max(6, (live.last?.tMs ?? 0) / 1000, 1);
  const xOf = (tMs: number) => pad.l + (tMs / 1000 / tMax) * plotW;
  const yOf = (alt: number) => pad.t + plotH - (alt / (apogee * 1.15)) * plotH;

  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.l, pad.t);
  ctx.lineTo(pad.l, pad.t + plotH);
  ctx.lineTo(pad.l + plotW, pad.t + plotH);
  ctx.stroke();
  label(ctx, 'altitude, m', 12, 20, DIM, 10);
  label(ctx, `${tMax.toFixed(0)} s`, pad.l + plotW - 8, h - 12, DIM, 10);

  if (live.plan.kind === 'ballistic') {
    const burnX = xOf(live.plan.burnS * 1000);
    ctx.fillStyle = 'rgba(226, 177, 90, 0.12)';
    ctx.fillRect(pad.l, pad.t, Math.max(0, burnX - pad.l), plotH);
    label(ctx, 'burn', pad.l + 6, pad.t + 14, HOT, 10);
  }

  if (hist.length > 1) {
    ctx.beginPath();
    hist.forEach((p, i) => {
      const px = xOf(p.t);
      const py = yOf(Math.max(0, p.alt));
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.strokeStyle = GOOD;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  if (live.last) {
    const px = xOf(live.last.tMs);
    const py = yOf(Math.max(0, live.last.alt));
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = INK;
  ctx.font = '20px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.fillText(`apogee ${(live.last?.apogee ?? 0).toFixed(1)} m`, w - 16, 28);
}

function drawArm(ctx: CanvasRenderingContext2D, live: LiveSim, w: number, h: number): void {
  if (live.plan.kind !== 'arm') return;
  const pivot = { x: w * 0.28, y: h * 0.62 };
  const len = Math.min(w, h) * 0.42;
  const theta = live.theta;
  const target = (live.stick.mode === 'manual' ? live.stick.pitch : 0.6) * (Math.PI / 2);
  ctx.strokeStyle = 'rgba(226, 177, 90, 0.7)';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(pivot.x, pivot.y);
  ctx.lineTo(pivot.x + Math.cos(target) * len, pivot.y - Math.sin(target) * len);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pivot.x - 30, pivot.y);
  ctx.lineTo(pivot.x + len + 24, pivot.y);
  ctx.stroke();

  const tip = { x: pivot.x + Math.cos(theta) * len, y: pivot.y - Math.sin(theta) * len };
  ctx.strokeStyle = INK;
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(pivot.x, pivot.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
  ctx.fillStyle = HOT;
  ctx.fillRect(tip.x - 8, tip.y - 8, 16, 16);
  ctx.beginPath();
  ctx.arc(pivot.x, pivot.y, 7, 0, Math.PI * 2);
  ctx.fillStyle = GOOD;
  ctx.fill();
  label(ctx, 'θ = 0 is horizontal', pivot.x, pivot.y + 28, DIM, 11);
  ctx.fillStyle = INK;
  ctx.font = '22px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`${(theta * 180 / Math.PI).toFixed(1)}°`, w * 0.62, h * 0.38);
  label(ctx, 'joint angle', w * 0.62, h * 0.38 + 18, DIM, 11);
  const margin = live.plan.availableTorque / Math.max(live.plan.gravityTorque, 1e-6);
  label(ctx, `torque margin ${margin.toFixed(2)}×`, w * 0.62, h * 0.38 + 40, margin < 1 ? BAD : GOOD, 12);
}

function drawStation(ctx: CanvasRenderingContext2D, live: LiveSim, w: number, h: number): void {
  if (live.plan.kind !== 'station') return;
  const cx = w * 0.38;
  const cy = h * 0.52;
  const r = Math.min(w, h) * 0.28;
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  const night = live.plan.nightHours;
  const day = 24 - night;
  const sunrise = 12 - day / 2;
  const sunset = 12 + day / 2;
  // Clock: 6 at the left, 12 at the top, 18 at the right.
  const ang = (hour: number) => ((hour - 6) / 24) * Math.PI * 2 - Math.PI / 2;
  ctx.strokeStyle = 'rgba(226, 177, 90, 0.35)';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.arc(cx, cy, r - 6, ang(sunrise), ang(sunset));
  ctx.stroke();
  const sun = ang(live.hour);
  ctx.fillStyle = live.powerW >= 0 ? HOT : DIM;
  ctx.beginPath();
  ctx.arc(cx + Math.cos(sun) * (r - 6), cy + Math.sin(sun) * (r - 6), 7, 0, Math.PI * 2);
  ctx.fill();
  label(ctx, '06', cx - r - 4, cy + 4, DIM, 10);
  label(ctx, '12', cx - 6, cy - r - 8, DIM, 10);
  label(ctx, '18', cx + r - 8, cy + 4, DIM, 10);

  const soc = live.soc;
  const bx = w * 0.68;
  const by = h * 0.34;
  const bw = 36;
  const bh = 92;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(bx, by, bw, bh);
  ctx.fillRect(bx + 10, by - 6, 16, 6);
  ctx.fillStyle = soc < 0.2 ? BAD : GOOD;
  const fill = bh * soc;
  ctx.fillRect(bx + 3, by + bh - 3 - fill, bw - 6, fill);
  ctx.fillStyle = INK;
  ctx.font = '20px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`${(soc * 100).toFixed(0)}%`, bx + bw + 14, by + 28);
  label(ctx, hourLabel(live.hour), bx, by + bh + 22, INK, 13);
  label(ctx, `${live.powerW >= 0 ? '+' : ''}${live.powerW.toFixed(2)} W`, bx, by + bh + 40, live.powerW >= 0 ? GOOD : HOT, 12);
}

function hud(ctx: CanvasRenderingContext2D, live: LiveSim, w: number, h: number): void {
  const armed = live.armed;
  ctx.font = '11px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillStyle = armed ? GOOD : HOT;
  ctx.fillText(armed ? 'ARMED' : 'SAFE', 14, 22);
  ctx.fillStyle = DIM;
  ctx.fillText(live.stick.mode.toUpperCase(), 68, 22);
  if (live.saturated) {
    ctx.fillStyle = BAD;
    ctx.textAlign = 'right';
    ctx.fillText('SAT', w - 70, 22);
  }
  const energy = live.plan.energyWh > 0 ? live.energyWh / live.plan.energyWh : 0;
  const barW = Math.min(160, w * 0.28);
  const x = 14;
  const y = h - 16;
  ctx.fillStyle = 'rgba(215, 239, 226, 0.12)';
  ctx.fillRect(x, y, barW, 4);
  ctx.fillStyle = energy < 0.15 ? BAD : GOOD;
  ctx.fillRect(x, y, barW * Math.max(0, Math.min(1, energy)), 4);
  ctx.fillStyle = DIM;
  ctx.textAlign = 'left';
  ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillText(`${live.energyWh.toFixed(1)} Wh`, x + barW + 8, y + 5);
}

function horizon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  rollDeg: number,
  pitchDeg: number,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.rotate(-rollDeg * Math.PI / 180);
  const shift = Math.max(-r, Math.min(r, pitchDeg * 3));
  ctx.fillStyle = '#12302a';
  ctx.fillRect(-r * 2, -r * 2 + shift, r * 4, r * 2);
  ctx.fillStyle = '#1a3a28';
  ctx.fillRect(-r * 2, shift, r * 4, r * 2);
  ctx.strokeStyle = 'rgba(215, 239, 226, 0.45)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-r, shift);
  ctx.lineTo(r, shift);
  ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = 'rgba(215, 239, 226, 0.2)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
}

function vignette(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const g = ctx.createRadialGradient(w * 0.4, h * 0.5, w * 0.2, w * 0.4, h * 0.5, w * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function strokePoly(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[], color: string, width: number): void {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.closePath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, size: number): void {
  ctx.fillStyle = color;
  ctx.font = `${size}px "JetBrains Mono", ui-monospace, monospace`;
  ctx.textAlign = 'left';
  ctx.fillText(text, x, y);
}

function hourLabel(hour: number): string {
  const h = Math.floor(hour) % 24;
  const m = Math.floor((hour % 1) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
