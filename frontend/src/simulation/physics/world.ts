/**
 * world.ts — the physics world: a deterministic rigid-body integrator over a
 * parsed {@link PhysicsScene}. This is the simulation half of the interface;
 * the browser hook, the headless Node runner and (later) any 3D renderer all
 * drive the same object.
 *
 * Model:
 *  - N rigid bodies, world-frame state (position, quaternion, velocity,
 *    body-frame angular velocity), principal-axis inertia.
 *  - Actuators bound to a body along a body-local axis, each with a
 *    first-order lag (τ = timeConstantMs) toward its commanded input 0..1.
 *    `thrust` adds a force along its axis. An `offset` makes that force
 *    also apply τ = r × F, which is how differential thrust tilts a
 *    vehicle; `reactionNmPerN` is prop-drag torque along the thrust axis.
 *    `torque` adds a body-frame torque. `signed` torques accept −1..1.
 *  - Environment: gravity, constant wind, linear drag (translational +
 *    rotational), and an optional ground plane with restitution + contact
 *    damping.
 *  - Integration: semi-implicit Euler on a fixed substep (default 1 ms),
 *    quaternion propagation via first-order body-frame integration.
 *
 * Deterministic and dependency-free: same scene + same input timeline ⇒
 * identical trajectory, in the browser and in Node. No Math.random anywhere.
 */

import {
  Quat, Vec3,
  qIntegrate, qNormalize, qRotate, qConjugate,
  vAdd, vCross, vLength, vNormalize, vScale, vSub,
  vec3,
} from './math';
import type {
  PhysicsActuatorSpec, PhysicsBodySpec, PhysicsScene,
} from './scene';

export interface BodyState {
  id: string;
  label?: string;
  position: Vec3;
  orientation: Quat;
  velocity: Vec3;
  angularVelocity: Vec3;
  /** Net force on this body this step (telemetry only). */
  force: Vec3;
}

export interface ActuatorState {
  id: string;
  name?: string;
  kind: 'thrust' | 'torque';
  /** Commanded input. 0..1, or −1..1 when the actuator is signed. */
  input: number;
  /** Lagged, actually-producing input, same range as `input`. */
  state: number;
  /** Current force (N) or torque (N·m) magnitude. */
  output: number;
}

export interface WorldTelemetry {
  tMs: number;
  bodies: BodyState[];
  actuators: ActuatorState[];
}

export interface StepOptions {
  /** Fixed substep size in ms. Default 1. */
  substepMs?: number;
}

interface BodyRuntime {
  spec: PhysicsBodySpec;
  position: Vec3;
  orientation: Quat;
  velocity: Vec3;
  angularVelocity: Vec3;
  force: Vec3;
}

interface ActuatorRuntime {
  spec: PhysicsActuatorSpec;
  kind: 'thrust' | 'torque';
  input: number;
  state: number;
  output: number;
}

export class PhysicsWorld {
  readonly scene: PhysicsScene;
  timeMs = 0;
  private readonly substepMs: number;
  private readonly bodies: BodyRuntime[];
  private readonly bodyIndex: Map<string, number>;
  private readonly actuators: ActuatorRuntime[];
  private readonly actuatorIndex: Map<string, number>;
  /** Pending scripted input changes: {tMs, actuatorIdx, value}, sorted by tMs. */
  private scheduled: { tMs: number; actuatorIdx: number; value: number }[] = [];
  private nextEvent = 0;

  constructor(scene: PhysicsScene, options: StepOptions = {}) {
    this.scene = scene;
    this.substepMs = Math.min(10, Math.max(0.05, options.substepMs ?? 1));
    this.bodyIndex = new Map();
    this.bodies = scene.bodies.map((spec, i) => {
      this.bodyIndex.set(spec.id, i);
      return {
        spec,
        position: { ...spec.position },
        orientation: qNormalize({ ...spec.orientation }),
        velocity: { ...spec.velocity },
        angularVelocity: { ...spec.angularVelocity },
        force: vec3(),
      };
    });
    this.actuatorIndex = new Map();
    this.actuators = scene.actuators
      .filter((a) => this.bodyIndex.has(a.bodyId))
      .map((spec, i) => {
        this.actuatorIndex.set(spec.id, i);
        return { spec, kind: spec.kind, input: spec.inputDefault, state: spec.inputDefault, output: 0 };
      });
  }

  get bodyCount(): number {
    return this.bodies.length;
  }

  get actuatorCount(): number {
    return this.actuators.length;
  }

  /** Schedule an input change for an actuator at a future (or past) time. */
  scheduleActuatorInput(actuatorId: string, atMs: number, value: number): boolean {
    const idx = this.actuatorIndex.get(actuatorId);
    if (idx === undefined) return false;
    this.scheduled.push({ tMs: atMs, actuatorIdx: idx, value: clampActuatorInput(this.actuators[idx].spec, value) });
    return true;
  }

  /** Set an actuator's input immediately (UI / live binding). */
  setActuatorInput(actuatorId: string, value: number): boolean {
    const idx = this.actuatorIndex.get(actuatorId);
    if (idx === undefined) return false;
    this.actuators[idx].input = clampActuatorInput(this.actuators[idx].spec, value);
    return true;
  }

  getBodyState(id: string): BodyState | null {
    const i = this.bodyIndex.get(id);
    return i === undefined ? null : this.bodyTelemetry(this.bodies[i]);
  }

  /** Advance the simulation by `elapsedMs` (clamped to 50 ms per call). */
  step(elapsedMs: number): number {
    const dt = Math.min(50, Math.max(0, elapsedMs));
    if (dt <= 0) return 0;
    const h = this.substepMs / 1000;
    const steps = Math.round(dt / (this.substepMs));
    if (steps > 0) {
      // Keep the scheduled-input timeline monotone (events may be added out
      // of order, e.g. an agent scripting the whole run up front).
      this.scheduled.sort((p, q) => p.tMs - q.tMs);
    }
    for (let s = 0; s < steps; s++) {
      const tTarget = this.timeMs + this.substepMs;
      // Fire any scheduled inputs whose time has arrived.
      while (this.nextEvent < this.scheduled.length && this.scheduled[this.nextEvent].tMs <= tTarget) {
        const ev = this.scheduled[this.nextEvent];
        this.actuators[ev.actuatorIdx].input = ev.value;
        this.nextEvent += 1;
      }
      this.integrate(h);
      this.timeMs += this.substepMs;
    }
    return steps * this.substepMs;
  }

  private integrate(h: number): void {
    const env = this.scene.environment;

    // 1) Actuator dynamics: first-order lag toward commanded input.
    for (const a of this.actuators) {
      const tau = Math.max(a.spec.timeConstantMs, 0.1) / 1000;
      const alpha = 1 - Math.exp(-h / tau);
      a.state += (a.input - a.state) * alpha;
      a.output = a.kind === 'thrust' ? a.spec.maxForce * a.state : a.spec.maxTorque * a.state;
    }

    // 2) Accumulate forces & torques per body.
    const forces = this.bodies.map(() => vec3());
    const torques = this.bodies.map(() => vec3());
    for (const b of this.bodies) {
      const i = this.bodyIndex.get(b.spec.id)!;
      // gravity
      vAddForces(forces[i], vScale(env.gravity, b.spec.mass));
      // drag vs relative air velocity
      const rel = vSub(b.velocity, env.wind);
      if (env.linearDrag > 0) {
        vAddForces(forces[i], vScale(rel, -env.linearDrag));
      }
      const qDrag = env.quadraticDrag ?? 0;
      if (qDrag > 0) {
        const speed = vLength(rel);
        if (speed > 0) vAddForces(forces[i], vScale(rel, -qDrag * speed));
      }
    }
    for (const a of this.actuators) {
      const bi = this.bodyIndex.get(a.spec.bodyId);
      if (bi === undefined) continue;
      const body = this.bodies[bi];
      const axisBody = vNormalize(a.spec.axis);
      if (a.kind === 'thrust') {
        const axisWorld = qRotate(body.orientation, axisBody);
        vAddForces(forces[bi], vScale(axisWorld, a.output));
        // Moment arm. Zero offset (the default) keeps the historical
        // "thrust through the CoM" behaviour the hover tests rely on.
        const off = a.spec.offset ?? vec3();
        if (off.x !== 0 || off.y !== 0 || off.z !== 0) {
          torques[bi] = vAdd(torques[bi], vCross(off, vScale(axisBody, a.output)));
        }
        const react = a.spec.reactionNmPerN ?? 0;
        if (react !== 0) {
          torques[bi] = vAdd(torques[bi], vScale(axisBody, react * a.output));
        }
      } else {
        // Torque is specified in the body frame. Axis is not normalised
        // so an existing scene that encoded magnitude in the axis is unchanged.
        torques[bi] = vAdd(torques[bi], vScale(a.spec.axis, a.output));
      }
    }

    // 3) Integrate each body (semi-implicit Euler).
    for (const b of this.bodies) {
      const i = this.bodyIndex.get(b.spec.id)!;
      const { mass, inertia } = b.spec;
      b.force = { ...forces[i] };
      const acc = vScale(forces[i], 1 / mass);
      b.velocity = vAdd(b.velocity, vScale(acc, h));
      b.position = vAdd(b.position, vScale(b.velocity, h));

      // Torques: angular drag (body frame) + actuator torques.
      let tauBody = torques[i];
      if (env.angularDrag > 0) {
        tauBody = vSub(tauBody, vScale(b.angularVelocity, env.angularDrag));
      }
      const alpha = vec3(
        tauBody.x / inertia.ix,
        tauBody.y / inertia.iy,
        tauBody.z / inertia.iz,
      );
      b.angularVelocity = vAdd(b.angularVelocity, vScale(alpha, h));
      b.orientation = qIntegrate(b.orientation, b.angularVelocity, h);
    }

    // 4) Ground plane.
    if (env.floorY !== null) {
      for (const b of this.bodies) {
        const r = this.supportRadius(b.spec);
        const floorContact = env.floorY + r;
        if (b.position.y < floorContact) {
          b.position.y = floorContact;
          if (b.velocity.y < 0) {
            b.velocity.y = -b.velocity.y * env.restitution;
            if (Math.abs(b.velocity.y) < 0.02) b.velocity.y = 0;
          }
          // Contact damping so a dropped body can rest. The coefficient
          // defaults to the historical 8/s; driven vehicles set it near 0.
          const damp = Math.max(0, 1 - (env.groundDamping ?? 8) * h);
          b.velocity.x *= damp;
          b.velocity.z *= damp;
          b.angularVelocity.x *= damp;
          b.angularVelocity.y *= damp;
          b.angularVelocity.z *= damp;
        }
      }
    }
  }

  /** Coarse contact radius from the shape (box → max half extent). */
  private supportRadius(spec: PhysicsBodySpec): number {
    if (spec.shape.type === 'sphere') return spec.shape.radius;
    if (spec.shape.type === 'box') {
      const he = spec.shape.halfExtents;
      return Math.max(he.x, he.y, he.z);
    }
    return 0;
  }

  /** Current body-frame specific force (proper acceleration, in g) + gyro.
   *  This is exactly what a real IMU reports: the accelerometer senses
   *  thrust/gravity, not inertial frame changes of the coordinate grid. */
  imuReading(bodyId: string): {
    accel: Vec3; // g, body frame
    gyro: Vec3;  // deg/s, body frame
  } | null {
    const b = this.bodies[this.bodyIndex.get(bodyId) ?? -1];
    if (!b) return null;
    const g = 9.81;
    // Net force excluding gravity = proper acceleration; to the IMU,
    // "up" (reaction against gravity) reads as +1 g on the Z/up axis.
    const env = this.scene.environment;
    const properWorld = vSub(b.force, vScale(env.gravity, b.spec.mass));
    const accelBody = qRotate(qConjugate(b.orientation), vScale(properWorld, 1 / (b.spec.mass * g)));
    const degPerRad = 180 / Math.PI;
    const gyroBody = vScale(b.angularVelocity, degPerRad);
    return { accel: accelBody, gyro: gyroBody };
  }

  telemetry(): WorldTelemetry {
    return {
      tMs: this.timeMs,
      bodies: this.bodies.map((b) => this.bodyTelemetry(b)),
      actuators: this.actuators.map((a) => ({
        id: a.spec.id,
        name: a.spec.name,
        kind: a.spec.kind,
        input: a.input,
        state: a.state,
        output: a.output,
      })),
    };
  }

  private bodyTelemetry(b: BodyRuntime): BodyState {
    return {
      id: b.spec.id,
      label: b.spec.label,
      position: { ...b.position },
      orientation: { ...b.orientation },
      velocity: { ...b.velocity },
      angularVelocity: { ...b.angularVelocity },
      force: { ...b.force },
    };
  }
}

function clampActuatorInput(spec: { signed?: boolean }, value: number): number {
  const lo = spec.signed ? -1 : 0;
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(lo, value));
}

function vAddForces(target: Vec3, f: Vec3): void {
  target.x += f.x;
  target.y += f.y;
  target.z += f.z;
}
