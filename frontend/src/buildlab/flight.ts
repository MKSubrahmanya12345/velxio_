/**
 * Closed-loop drivers for a SimPlan.
 *
 * Multirotor: geometric attitude (rotation that takes body-up onto the
 * commanded lean) plus a position/altitude loop. Motor forces are allocated
 * with the same r × F and reaction torque the integrator applies, so the
 * mixer and the physics cannot disagree about the sign of a tilt.
 *
 * The other archetypes are smaller models, named as such in the dossier.
 * Nothing here uses Math.random. Same config, same stick, same time → same flight.
 */

import {
  PhysicsWorld,
  parsePhysicsScene,
  qConjugate,
  qRotate,
  vCross,
  vDot,
  vNormalize,
  type PhysicsScene,
  type Quat,
  type Vec3,
} from '../simulation/physics';
import type {
  ArmPlan,
  BallisticPlan,
  MotorMount,
  MultiPlan,
  SimPlan,
  StationPlan,
  Stick,
  SurfacePlan,
  WingPlan,
} from './types';

const HOLD_STICK: Stick = { roll: 0, pitch: 0, yaw: 0, throttle: 0.45, mode: 'hold' };

export function placeRotors(n: number, wheelbase: number): Omit<MotorMount, 'id' | 'maxForce'>[] {
  const arm = wheelbase / 2;
  if (n === 4) {
    const d = arm / Math.SQRT2;
    return [
      { name: 'front-right', x: d, z: d, spin: 1 },
      { name: 'front-left', x: -d, z: d, spin: -1 },
      { name: 'rear-right', x: d, z: -d, spin: -1 },
      { name: 'rear-left', x: -d, z: -d, spin: 1 },
    ];
  }
  const count = n === 8 ? 8 : 6;
  const out: Omit<MotorMount, 'id' | 'maxForce'>[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    out.push({
      name: `rotor-${i + 1}`,
      x: arm * Math.sin(a),
      z: arm * Math.cos(a),
      spin: i % 2 === 0 ? 1 : -1,
    });
  }
  return out;
}

export function quadInertia(mass: number, wheelbase: number): { ix: number; iy: number; iz: number } {
  // About 45% of the mass sits out at the arm radius (motors, props, arms).
  // The battery is near the centre and adds little. This is an estimate;
  // the dossier says so, and attitudeWn is what the human actually tunes.
  const arm = Math.max(wheelbase / 2, 0.02);
  const iYaw = 0.45 * mass * arm * arm;
  const iRoll = 0.5 * iYaw;
  return {
    ix: Math.max(iRoll, 1e-6),
    iy: Math.max(iYaw, 1e-6),
    iz: Math.max(iRoll, 1e-6),
  };
}

export function openSim(plan: SimPlan): LiveSim {
  const world = 'scene' in plan ? new PhysicsWorld(plan.scene) : null;
  return {
    plan,
    world,
    energyWh: plan.energyWh,
    armed: false,
    stick: { ...HOLD_STICK },
    killed: [],
    ix: 0,
    iz: 0,
    ialt: 0,
    trail: [],
    missionI: 0,
    spin: 0,
    theta: -0.4,
    omega: 0,
    hour: 6,
    soc: 0.8,
    apogee: 0,
    saturated: false,
    powerW: 0,
    last: null,
  };
}

export function resetSim(live: LiveSim): void {
  const fresh = openSim(live.plan);
  fresh.stick = live.stick;
  fresh.killed = live.killed;
  Object.assign(live, fresh);
}

export function tick(live: LiveSim, dtMs: number): SimSample {
  const dt = Math.min(50, Math.max(0, dtMs));
  if (!live.armed || dt <= 0) {
    live.last = sample(live);
    return live.last;
  }
  let left = dt;
  while (left > 0.1) {
    const h = Math.min(5, left);
    stepControl(live, h / 1000);
    live.world?.step(h);
    left -= h;
  }
  const s = sample(live);
  live.last = s;
  if (live.world && s.tMs % 40 < 8) {
    live.trail.push({ x: s.x, z: s.z });
    if (live.trail.length > 240) live.trail.shift();
  }
  live.spin += dt * 0.02 * (0.2 + averageThrottle(live));
  return s;
}

function stepControl(live: LiveSim, dt: number): void {
  const plan = live.plan;
  if (plan.kind === 'multirotor') stepMulti(live, plan, dt);
  else if (plan.kind === 'surface') stepSurface(live, plan, dt);
  else if (plan.kind === 'wing') stepWing(live, plan, dt);
  else if (plan.kind === 'ballistic') stepBallistic(live, plan);
  else if (plan.kind === 'arm') stepArm(live, plan, dt);
  else stepStation(live, plan, dt);
}

function stepMulti(live: LiveSim, plan: MultiPlan, dt: number): void {
  const world = live.world!;
  const b = world.getBodyState('craft');
  if (!b) return;
  const q = b.orientation;
  const up = qRotate(q, { x: 0, y: 1, z: 0 });
  const grounded = b.position.y <= plan.belly + 0.04;

  let desUp: Vec3;
  const yawRate = live.stick.yaw * 2.2;
  if (live.stick.mode === 'manual') {
    const lean = Math.tan(plan.maxTilt);
    desUp = limitedLean(live.stick.roll * plan.gravity * lean, live.stick.pitch * plan.gravity * lean, plan.maxTilt);
  } else {
    const target = live.stick.mode === 'mission' ? squarePoint(live.missionI) : { x: 0, z: 0 };
    const ex = target.x - b.position.x;
    const ez = target.z - b.position.z;
    if (!grounded) {
      live.ix = clamp(live.ix + ex * dt, -4, 4);
      live.iz = clamp(live.iz + ez * dt, -4, 4);
    }
    const ax = plan.posKp * ex + plan.posKd * (0 - b.velocity.x) + plan.posKi * live.ix;
    const az = plan.posKp * ez + plan.posKd * (0 - b.velocity.z) + plan.posKi * live.iz;
    desUp = limitedLean(ax, az, plan.maxTilt);
    if (live.stick.mode === 'mission') {
      const dist = Math.hypot(ex, ez);
      const speed = Math.hypot(b.velocity.x, b.velocity.z);
      if (dist < 0.45 && speed < 0.55) live.missionI = Math.min(live.missionI + 1, 4);
    }
  }

  const eWorld = vCross(up, desUp);
  const eBody = qRotate(qConjugate(q), eWorld);
  const w = b.angularVelocity;
  const tau = {
    x: plan.attKp.x * eBody.x - plan.attKd.x * w.x,
    y: plan.attKp.y * (yawRate - w.y),
    z: plan.attKp.z * eBody.z - plan.attKd.z * w.z,
  };

  const totalAlive = plan.mounts.reduce(
    (s, m) => s + (live.killed.includes(m.id) || live.energyWh <= 0 ? 0 : m.maxForce),
    0,
  );
  let thrust: number;
  if (live.stick.mode === 'manual') {
    thrust = live.stick.throttle * totalAlive;
  } else {
    const altErr = plan.hoverAltitude - b.position.y;
    if (!grounded) live.ialt = clamp(live.ialt + altErr * dt, -2, 2);
    const fz = plan.mass * plan.gravity
      + plan.altKp * altErr
      + plan.altKd * (0 - b.velocity.y)
      + plan.altKi * live.ialt;
    const cosT = Math.max(0.4, vDot(up, { x: 0, y: 1, z: 0 }));
    thrust = Math.max(0, fz / cosT);
  }
  if (live.energyWh <= 0) thrust = 0;
  const cap = totalAlive * 0.84;
  const saturatedCollective = thrust > cap && cap > 0;
  if (thrust > cap) thrust = cap;

  const A = wrenchMatrix(plan.mounts, plan.reactionM);
  const alive = plan.mounts.map((m) => !live.killed.includes(m.id) && live.energyWh > 0 && m.maxForce > 0);
  const T = allocate(A, [thrust, tau.x, tau.y, tau.z], plan.mounts.map((m) => m.maxForce), alive);
  live.saturated = saturatedCollective || T.some((t, i) => alive[i] && t >= plan.mounts[i].maxForce * 0.98);

  let power = 0;
  plan.mounts.forEach((m, i) => {
    const u = m.maxForce > 0 ? T[i] / m.maxForce : 0;
    world.setActuatorInput(m.id, u);
    if (T[i] > 0 && plan.propArea > 0) {
      const vi = Math.sqrt(T[i] / (2 * plan.rho * plan.propArea));
      power += (T[i] * vi) / Math.max(0.08, plan.fm * plan.eta);
    }
  });
  live.powerW = power;
  live.energyWh = Math.max(0, live.energyWh - power * dt / 3600);
}

function stepSurface(live: LiveSim, plan: SurfacePlan, dt: number): void {
  const world = live.world!;
  const b = world.getBodyState('craft');
  if (!b) return;
  const fwd = qRotate(b.orientation, { x: 0, y: 0, z: 1 });
  const speed = vDot(b.velocity, fwd);
  const target = live.stick.mode === 'manual'
    ? live.stick.throttle * 1.3
    : live.stick.mode === 'mission' ? 0.7 : 0;
  const drive = clamp(plan.mass * 3.2 * (target - speed), -plan.wheelForce * 2, plan.wheelForce * 2);
  const yaw = Math.atan2(fwd.x, fwd.z);
  const rateCmd = live.stick.mode === 'manual' ? live.stick.yaw * 1.2 : -1.6 * wrapPi(0 - yaw);
  // Positive stick yaws toward +X (east). See the comment in the test if this flips.
  const diff = plan.mass * 0.35 * (rateCmd - b.angularVelocity.y);
  const left = (drive / 2 - diff) / plan.wheelForce;
  const right = (drive / 2 + diff) / plan.wheelForce;
  world.setActuatorInput('left', clamp(left, -1, 1));
  world.setActuatorInput('right', clamp(right, -1, 1));
  const mechanical = Math.abs(drive) * Math.abs(speed);
  live.powerW = mechanical / 0.55 + 1.5;
  live.energyWh = Math.max(0, live.energyWh - live.powerW * dt / 3600);
  void dt;
}

function stepWing(live: LiveSim, plan: WingPlan, dt: number): void {
  const world = live.world!;
  const b = world.getBodyState('craft');
  if (!b) return;
  const q = b.orientation;
  const up = qRotate(q, { x: 0, y: 1, z: 0 });
  const fwd = qRotate(q, { x: 0, y: 0, z: 1 });
  const speed = vDot(b.velocity, fwd);
  const altErr = plan.hoverAltitude - b.position.y;
  // Throttle holds altitude. Lift is the wing, not a second motor: it is
  // ½ρv²ClS, commanded through a thrust actuator the dossier names as the wing.
  const thrust = clamp(plan.maxThrust * 0.45 + plan.mass * 1.1 * altErr - plan.mass * 1.6 * b.velocity.y, 0, plan.maxThrust);
  const dynamic = 0.5 * plan.rho * speed * Math.abs(speed) * plan.cl * plan.area;
  const lift = clamp(dynamic, 0, plan.maxLift);
  world.setActuatorInput('prop', thrust / plan.maxThrust);
  world.setActuatorInput('wing', plan.maxLift > 0 ? lift / plan.maxLift : 0);
  // Hold wings level. Pitch torque fights a nose-down from the high wing mount we don't have;
  // a rate damper on all axes is enough to keep a trainer from tumbling.
  const e = qRotate(qConjugate(q), vCross(up, { x: 0, y: 1, z: 0 }));
  const w = b.angularVelocity;
  world.setActuatorInput('pitch', clamp(1.2 * e.x - 0.35 * w.x, -1, 1));
  world.setActuatorInput('roll', clamp(1.2 * e.z - 0.35 * w.z, -1, 1));
  world.setActuatorInput('yaw', clamp(-0.4 * w.y, -1, 1));
  live.powerW = thrust * Math.max(speed, 4) / 0.6;
  live.energyWh = Math.max(0, live.energyWh - live.powerW * dt / 3600);
  if (live.energyWh <= 0) world.setActuatorInput('prop', 0);
}

function stepBallistic(live: LiveSim, plan: BallisticPlan): void {
  const world = live.world!;
  const burning = world.timeMs < plan.burnS * 1000 && live.energyWh > 0;
  world.setActuatorInput('boost', burning ? 1 : 0);
  const b = world.getBodyState('craft');
  if (b && b.position.y > live.apogee) live.apogee = b.position.y;
  live.powerW = burning ? plan.thrustN * 40 : 0;
}

function stepArm(live: LiveSim, plan: ArmPlan, dt: number): void {
  const target = (live.stick.mode === 'manual' ? live.stick.pitch : 0.6) * (Math.PI / 2);
  const err = target - live.theta;
  const avail = plan.availableTorque;
  // θ = 0 is horizontal. Gravity torque is maximum there and tries to drop the link.
  // Feedforward cancels it, or a modest PD gain stalls just below horizontal.
  const tauG = -plan.gravityTorque * Math.cos(live.theta);
  const cmd = clamp(-tauG + plan.inertia * 36 * err - plan.inertia * 12 * live.omega, -avail, avail);
  const alpha = (cmd + tauG) / plan.inertia;
  live.omega += alpha * dt;
  live.theta += live.omega * dt;
  live.powerW = Math.abs(cmd * live.omega) + 0.4;
  live.energyWh = Math.max(0, live.energyWh - live.powerW * dt / 3600);
}

function stepStation(live: LiveSim, plan: StationPlan, dt: number): void {
  // One simulated hour per second, so a day is watchable.
  live.hour = (live.hour + dt / 1) % 24;
  const day = solarFraction(live.hour, plan.nightHours);
  const p = plan.solarW * day - plan.loadW;
  live.powerW = p;
  live.soc = clamp(live.soc + (p * dt) / 3600 / Math.max(plan.batteryWh, 0.1), 0, 1);
  live.energyWh = live.soc * plan.batteryWh;
}

function solarFraction(hour: number, nightHours: number): number {
  const dayHours = Math.max(4, 24 - nightHours);
  const sunrise = 12 - dayHours / 2;
  const sunset = 12 + dayHours / 2;
  if (hour < sunrise || hour > sunset) return 0;
  const x = (hour - sunrise) / dayHours;
  return Math.sin(x * Math.PI);
}

function sample(live: LiveSim): SimSample {
  const motors = motorReadout(live);
  if (!live.world) {
    return {
      tMs: live.plan.kind === 'station' ? live.hour * 3600_000 : live.theta * 1000,
      x: 0,
      y: live.plan.kind === 'arm' ? Math.sin(live.theta) : live.soc,
      z: live.plan.kind === 'arm' ? Math.cos(live.theta) : live.hour,
      alt: live.plan.kind === 'station' ? live.soc : live.theta,
      speed: live.omega,
      energyWh: live.energyWh,
      powerW: live.powerW,
      tiltDeg: Math.abs(live.theta) * 180 / Math.PI,
      yawDeg: 0,
      rollDeg: 0,
      pitchDeg: live.theta * 180 / Math.PI,
      grounded: false,
      saturated: live.saturated,
      apogee: live.apogee,
      motors,
      quat: { x: 0, y: 0, z: 0, w: 1 },
    };
  }
  const b = live.world.getBodyState('craft') ?? live.world.telemetry().bodies[0];
  const up = qRotate(b.orientation, { x: 0, y: 1, z: 0 });
  const fwd = qRotate(b.orientation, { x: 0, y: 0, z: 1 });
  const tilt = Math.acos(clamp(up.y, -1, 1)) * 180 / Math.PI;
  const belly = live.plan.kind === 'multirotor' ? live.plan.belly : 0.04;
  return {
    tMs: live.world.timeMs,
    x: b.position.x,
    y: b.position.y,
    z: b.position.z,
    alt: b.position.y,
    speed: Math.hypot(b.velocity.x, b.velocity.y, b.velocity.z),
    energyWh: live.energyWh,
    powerW: live.powerW,
    tiltDeg: tilt,
    yawDeg: Math.atan2(fwd.x, fwd.z) * 180 / Math.PI,
    rollDeg: Math.asin(clamp(up.x, -1, 1)) * 180 / Math.PI,
    pitchDeg: Math.asin(clamp(up.z, -1, 1)) * 180 / Math.PI,
    grounded: b.position.y <= belly + 0.02,
    saturated: live.saturated,
    apogee: live.apogee,
    motors,
    quat: b.orientation,
  };
}

function motorReadout(live: LiveSim): SimSample['motors'] {
  if (!live.world) return [];
  return live.world.telemetry().actuators.map((a) => ({
    id: a.id,
    name: a.name ?? a.id,
    input: a.input,
    output: a.output,
    killed: live.killed.includes(a.id),
  }));
}

function averageThrottle(live: LiveSim): number {
  const motors = live.last?.motors ?? [];
  if (motors.length === 0) return 0;
  return motors.reduce((s, m) => s + Math.abs(m.input), 0) / motors.length;
}

export interface LiveSim {
  plan: SimPlan;
  world: PhysicsWorld | null;
  energyWh: number;
  armed: boolean;
  stick: Stick;
  killed: string[];
  ix: number;
  iz: number;
  ialt: number;
  trail: { x: number; z: number }[];
  missionI: number;
  spin: number;
  theta: number;
  omega: number;
  hour: number;
  soc: number;
  apogee: number;
  saturated: boolean;
  powerW: number;
  last: SimSample | null;
}

export interface SimSample {
  tMs: number;
  x: number;
  y: number;
  z: number;
  alt: number;
  speed: number;
  energyWh: number;
  powerW: number;
  tiltDeg: number;
  yawDeg: number;
  rollDeg: number;
  pitchDeg: number;
  grounded: boolean;
  saturated: boolean;
  apogee: number;
  motors: { id: string; name: string; input: number; output: number; killed: boolean }[];
  quat: Quat;
}

function wrenchMatrix(mounts: MotorMount[], k: number): number[][] {
  const A = [[], [], [], []] as number[][];
  for (const m of mounts) {
    A[0].push(1);
    A[1].push(-m.z);
    A[2].push(m.spin * k);
    A[3].push(m.x);
  }
  return A;
}

/** Least-squares thrust allocation, then clip to [0, max]. One redistribution pass. */
export function allocate(A: number[][], desired: number[], maxForce: number[], alive: boolean[]): number[] {
  const T = maxForce.map(() => 0);
  const free = alive.slice();
  const demand = desired.slice();
  for (let pass = 0; pass < 3; pass++) {
    const idx = free.map((on, i) => (on ? i : -1)).filter((i) => i >= 0);
    if (idx.length === 0) break;
    const Ar = [0, 1, 2, 3].map((r) => idx.map((i) => A[r][i]));
    const solved = solveReduced(Ar, demand);
    let clipped = false;
    for (let j = 0; j < idx.length; j++) {
      const motor = idx[j];
      const raw = solved[j];
      const clamped = clamp(raw, 0, maxForce[motor]);
      T[motor] = clamped;
      if (Math.abs(clamped - raw) > 1e-3) {
        clipped = true;
        free[motor] = false;
        for (let r = 0; r < 4; r++) demand[r] -= A[r][motor] * clamped;
      }
    }
    if (!clipped) break;
  }
  return T;
}

function solveReduced(Ar: number[][], b: number[]): number[] {
  const k = Ar[0]?.length ?? 0;
  if (k === 0) return [];
  if (k === 4) return solve4(Ar, b) ?? Ar[0].map(() => 0);
  // T = Arᵀ (Ar Arᵀ)⁻¹ b
  const At = transpose(Ar);
  const AAt = mul(Ar, At);
  const y = solve4(AAt, b);
  if (!y) return Ar[0].map(() => b[0] / k);
  return matVec(At, y);
}

function solve4(A: number[][], b: number[]): number[] | null {
  const n = 4;
  if (A.length !== 4 || b.length !== 4) return null;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-10) return null;
    const tmp = M[col];
    M[col] = M[pivot];
    M[pivot] = tmp;
    const div = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

function transpose(A: number[][]): number[][] {
  const rows = A.length;
  const cols = A[0].length;
  const out: number[][] = [];
  for (let c = 0; c < cols; c++) {
    const row: number[] = [];
    for (let r = 0; r < rows; r++) row.push(A[r][c]);
    out.push(row);
  }
  return out;
}

function mul(A: number[][], B: number[][]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < A.length; i++) {
    const row: number[] = [];
    for (let j = 0; j < B[0].length; j++) {
      let s = 0;
      for (let k = 0; k < B.length; k++) s += A[i][k] * B[k][j];
      row.push(s);
    }
    out.push(row);
  }
  return out;
}

function matVec(A: number[][], v: number[]): number[] {
  return A.map((row) => row.reduce((s, a, i) => s + a * v[i], 0));
}

function limitedLean(ax: number, az: number, maxTilt: number): Vec3 {
  let x = ax / 9.81;
  let z = az / 9.81;
  const horiz = Math.hypot(x, z);
  const maxH = Math.tan(maxTilt);
  if (horiz > maxH && horiz > 0) {
    x *= maxH / horiz;
    z *= maxH / horiz;
  }
  return vNormalize({ x, y: 1, z });
}

function squarePoint(i: number): { x: number; z: number } {
  const pts = [
    { x: 0, z: 0 },
    { x: 0, z: 4 },
    { x: 4, z: 4 },
    { x: 4, z: 0 },
    { x: 0, z: 0 },
  ];
  return pts[Math.max(0, Math.min(pts.length - 1, i))];
}

function wrapPi(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(hi, Math.max(lo, n));
}

/** Used by derive to build a scene the parser will accept. */
export function mustScene(raw: unknown): PhysicsScene {
  const parsed = parsePhysicsScene(raw);
  if (!parsed.scene) {
    throw new Error(parsed.errors.join('; ') || 'scene failed to parse');
  }
  return parsed.scene;
}
