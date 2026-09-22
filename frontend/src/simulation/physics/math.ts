/**
 * math.ts — minimal, dependency-free 3D math for the physics scene layer.
 *
 * Plain JSON-safe objects (no classes on the wire values) so a scene spec,
 * telemetry sample or agent tool payload can round-trip through JSON without
 * (de)serialisation glue. Units: SI. Axis convention: X = east, Y = up,
 * Z = north. Quaternions are {x, y, z, w} with w the scalar part.
 *
 * This module must stay free of any DOM/React imports — it is bundled into
 * the headless Node runner (backend/app/mcp/physics-core.cjs) as well as the
 * browser.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const quatIdentity = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });

export function vAdd(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function vSub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function vScale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function vDot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vCross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function vLength(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

/** Normalise; a zero (or non-finite) vector comes back as the zero vector. */
export function vNormalize(v: Vec3): Vec3 {
  const len = vLength(v);
  if (!Number.isFinite(len) || len < 1e-12) return vec3();
  return vScale(v, 1 / len);
}

export function vClampMagnitude(v: Vec3, max: number): Vec3 {
  const len = vLength(v);
  if (!Number.isFinite(len) || len <= max) return v;
  return vScale(v, max / len);
}

/** Quaternion product a ⊗ b (Hamilton convention, w scalar). */
export function qMul(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

/** Normalise in place on a fresh object; degenerate input returns identity. */
export function qNormalize(q: Quat): Quat {
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  if (!Number.isFinite(n) || n < 1e-12) return quatIdentity();
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
}

export function qFromAxisAngle(axis: Vec3, angleRad: number): Quat {
  const a = vNormalize(axis);
  const s = Math.sin(angleRad / 2);
  return { x: a.x * s, y: a.y * s, z: a.z * s, w: Math.cos(angleRad / 2) };
}

/** Rotate a world-frame vector by a quaternion. */
export function qRotate(q: Quat, v: Vec3): Vec3 {
  const u: Vec3 = { x: q.x, y: q.y, z: q.z };
  // v' = v + 2w (u × v) + 2 (u × (u × v))
  const uv = vCross(u, v);
  return vAdd(v, vAdd(vScale(uv, 2 * q.w), vScale(vCross(u, uv), 2)));
}

/**
 * Integrate a body-frame angular velocity into a quaternion over dt.
 * q' = q ⊗ exp(0, ω·dt/2) — first-order, stable for the substep sizes the
 * world uses (≤ 10 ms, rates far below the Nyquist limit of the substep).
 */
export function qIntegrate(q: Quat, angularVelocity: Vec3, dt: number): Quat {
  const half: Quat = {
    x: angularVelocity.x * (dt / 2),
    y: angularVelocity.y * (dt / 2),
    z: angularVelocity.z * (dt / 2),
    w: 1,
  };
  return qNormalize(qMul(q, qNormalize(half)));
}

export function qConjugate(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}
