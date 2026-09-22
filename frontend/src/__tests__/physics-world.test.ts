import { describe, expect, it } from 'vitest';
import {
  parsePhysicsScene,
  emptyPhysicsScene,
  PhysicsWorld,
  bodyToGpsValues,
  qFromAxisAngle,
  qRotate,
  qIntegrate,
  vCross,
  vNormalize,
  PHYSICS_SCENE_VERSION,
} from '../simulation/physics';

// ─────────────────────────────────────────────────────────────────────────────
// Math
// ─────────────────────────────────────────────────────────────────────────────

describe('physics math', () => {
  it('rotates a vector with a 90° yaw quaternion', () => {
    // Yaw +90° (about +Y) takes +X (east) to −Z ... check east → north:
    const q = qFromAxisAngle({ x: 0, y: 1, z: 0 }, -Math.PI / 2);
    const r = qRotate(q, { x: 1, y: 0, z: 0 });
    expect(r.x).toBeCloseTo(0, 9);
    expect(r.z).toBeCloseTo(1, 9);
  });

  it('integrates a constant body-frame angular velocity into a rotation', () => {
    let q = { x: 0, y: 0, z: 0, w: 1 };
    const w = { x: 0, y: 0, z: 1 }; // 1 rad/s about body Z
    for (let i = 0; i < 1000; i++) q = qIntegrate(q, w, 0.001);
    const r = qRotate(q, { x: 1, y: 0, z: 0 });
    // +1 rad about +Z takes +X toward +Y (right-hand rule)
    expect(r.x).toBeCloseTo(Math.cos(1), 5);
    expect(r.y).toBeCloseTo(Math.sin(1), 5);
    expect(r.z).toBeCloseTo(0, 5);
  });

  it('cross product is orthogonal', () => {
    const c = vCross({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    expect(c).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('vNormalize of a zero vector is safe', () => {
    expect(vNormalize({ x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
    expect(vNormalize({ x: NaN, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scene spec parsing
// ─────────────────────────────────────────────────────────────────────────────

describe('parsePhysicsScene', () => {
  it('fills defaults for a minimal scene', () => {
    const { scene, errors } = parsePhysicsScene({
      version: PHYSICS_SCENE_VERSION,
      bodies: [{ id: 'b', mass: 2 }],
    });
    expect(errors).toEqual([]);
    expect(scene).not.toBeNull();
    const b = scene!.bodies[0];
    expect(b.mass).toBe(2);
    expect(b.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(b.orientation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(b.shape).toEqual({ type: 'point' });
    expect(scene!.environment.gravity.y).toBeCloseTo(-9.81);
    expect(scene!.environment.floorY).toBe(0);
    // inertia defaults to a small but non-zero moment
    expect(b.inertia.ix).toBeGreaterThan(0);
  });

  it('rejects an empty body list', () => {
    const { scene, errors } = parsePhysicsScene({ version: 1, bodies: [] });
    expect(scene).toBeNull();
    expect(errors.join(' ')).toMatch(/at least one body/);
  });

  it('rejects duplicate body ids and unknown actuator body refs', () => {
    const { scene, errors } = parsePhysicsScene({
      version: 1,
      bodies: [
        { id: 'a', mass: 1 },
        { id: 'a', mass: 1 },
      ],
      actuators: [{ id: 't', bodyId: 'ghost', kind: 'thrust', maxForce: 5 }],
    });
    expect(scene).toBeNull();
    expect(errors.join(' ')).toMatch(/duplicate body id a/);
    expect(errors.join(' ')).toMatch(/unknown body ghost/);
  });

  it('rejects bad ids and out-of-range numbers (hard errors)', () => {
    const { scene, errors } = parsePhysicsScene({
      version: 1,
      bodies: [{ id: '9bad', mass: 1 }],
    });
    expect(errors.some((e) => e.includes('bodies[0].id'))).toBe(true);
    expect(scene).toBeNull(); // hard error → no scene

    const range = parsePhysicsScene({
      version: 1,
      bodies: [{ id: 'a', mass: 1 }],
      actuators: [{ id: 't', bodyId: 'a', maxForce: 1e9 }],
    });
    expect(range.scene).toBeNull();
    expect(range.errors.join(' ')).toMatch(/maxForce is out of range/);
  });

  it('rejects a wrong version', () => {
    const { scene, errors } = parsePhysicsScene({ version: 99, bodies: [{ id: 'a', mass: 1 }] });
    expect(scene).toBeNull();
    expect(errors.join(' ')).toMatch(/unsupported scene version/);
  });

  it('parses shapes, wind and an open world (null floor)', () => {
    const { scene, errors } = parsePhysicsScene({
      version: 1,
      environment: {
        wind: { x: 3, y: 0, z: 0 },
        floorY: null,
        linearDrag: 0.5,
      },
      bodies: [
        { id: 'a', mass: 1, shape: { type: 'sphere', radius: 0.2 } },
        { id: 'b', mass: 1, shape: { type: 'box', halfExtents: { x: 0.2, y: 0.1, z: 0.3 } } },
      ],
    });
    expect(errors).toEqual([]);
    expect(scene!.environment.floorY).toBeNull();
    expect(scene!.environment.wind.x).toBe(3);
    expect(scene!.bodies[0].shape).toEqual({ type: 'sphere', radius: 0.2 });
  });

  it('emptyPhysicsScene returns a valid scene', () => {
    const s = emptyPhysicsScene();
    expect(s.bodies).toHaveLength(1);
    expect(s.environment.gravity.y).toBeCloseTo(-9.81);
  });
});


// step() clamps to one 50 ms frame (browser-safety); callers — headless
// runner included — loop it. Mirrors that convention in the tests.
function stepUntil(w: PhysicsWorld, ms: number): void {
  let remaining = ms;
  while (remaining > 0) {
    const taken = w.step(Math.min(50, remaining));
    remaining -= taken;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// World integration
// ─────────────────────────────────────────────────────────────────────────────

describe('PhysicsWorld', () => {
  it('free fall matches the analytic position', () => {
    const { scene } = parsePhysicsScene({
      version: 1,
      environment: { floorY: null },
      bodies: [{ id: 'ball', mass: 1, position: { x: 0, y: 10, z: 0 } }],
    });
    const w = new PhysicsWorld(scene!);
    stepUntil(w, 1000);
    const b = w.getBodyState('ball')!;
    const t = 1; // s
    expect(b.position.y).toBeCloseTo(10 - 0.5 * 9.81 * t * t, 1);
    expect(b.velocity.y).toBeCloseTo(-9.81 * t, 1);
  });

  it('zero gravity + null floor: an inertial body coasts straight', () => {
    const { scene } = parsePhysicsScene({
      version: 1,
      environment: { gravity: { x: 0, y: 0, z: 0 }, floorY: null },
      bodies: [{ id: 'p', mass: 1, velocity: { x: 1, y: 2, z: 0.5 } }],
    });
    const w = new PhysicsWorld(scene!);
    stepUntil(w, 2000);
    const b = w.getBodyState('p')!;
    expect(b.position.x).toBeCloseTo(2, 5);
    expect(b.position.y).toBeCloseTo(4, 5);
    expect(b.position.z).toBeCloseTo(1, 5);
  });

  it('a 4-thruster vehicle hovers when total thrust equals weight', () => {
    const m = 1;
    const g = 9.81;
    const { scene, errors } = parsePhysicsScene({
      version: 1,
      bodies: [
        {
          id: 'craft', mass: m, position: { x: 0, y: 1, z: 0 },
          inertia: { ix: 0.01, iy: 0.01, iz: 0.01 },
          shape: { type: 'box', halfExtents: { x: 0.2, y: 0.05, z: 0.2 } },
        },
      ],
      actuators: [
        { id: 't1', bodyId: 'craft', kind: 'thrust', axis: { x: 0, y: 1, z: 0 }, maxForce: (m * g) / 4 },
        { id: 't2', bodyId: 'craft', kind: 'thrust', axis: { x: 0, y: 1, z: 0 }, maxForce: (m * g) / 4 },
        { id: 't3', bodyId: 'craft', kind: 'thrust', axis: { x: 0, y: 1, z: 0 }, maxForce: (m * g) / 4 },
        { id: 't4', bodyId: 'craft', kind: 'thrust', axis: { x: 0, y: 1, z: 0 }, maxForce: (m * g) / 4 },
      ],
    });
    expect(errors).toEqual([]);
    const w = new PhysicsWorld(scene!);
    for (const id of ['t1', 't2', 't3', 't4']) w.setActuatorInput(id, 1);
    stepUntil(w, 500); // let the motor lag settle (τ = 15 ms)
    const b = w.getBodyState('craft')!;
    expect(Math.abs(b.velocity.y)).toBeLessThan(0.1);
    expect(b.position.y).toBeGreaterThan(1.7); // barely dropped while spooling up
    const a = w.telemetry().actuators[0];
    expect(a.state).toBeGreaterThan(0.99);
  });

  it('unbalanced thrust produces rotation (body-frame quaternion drifts)', () => {
    const { scene } = parsePhysicsScene({
      version: 1,
      environment: { floorY: null },
      bodies: [
        { id: 'craft', mass: 1, position: { x: 0, y: 5, z: 0 }, inertia: { ix: 0.01, iy: 0.01, iz: 0.01 } },
      ],
      // Single upward thrust through an offset axis still goes through the
      // CoM, so add an asymmetric torque actuator to spin it:
      actuators: [
        { id: 'lift', bodyId: 'craft', kind: 'thrust', axis: { x: 0, y: 1, z: 0 }, maxForce: 19.62 },
        { id: 'spin', bodyId: 'craft', kind: 'torque', axis: { x: 0, y: 1, z: 0 }, maxTorque: 0.05 },
      ],
    });
    const w = new PhysicsWorld(scene!);
    w.setActuatorInput('lift', 1);
    w.setActuatorInput('spin', 1);
    stepUntil(w, 2000);
    const b = w.getBodyState('craft')!;
    // spun ~0.05 N·m / 0.01 kg·m² = 5 rad/s² for 2 s → ~10 rad of yaw
    expect(b.angularVelocity.y).toBeGreaterThan(4);
    expect(b.orientation.w).toBeLessThan(0.99);
  });

  it('a body dropped on the floor bounces then rests', () => {
    const { scene } = parsePhysicsScene({
      version: 1,
      environment: { floorY: 0, restitution: 0.3 },
      bodies: [{ id: 'ball', mass: 1, position: { x: 0, y: 1, z: 0 }, shape: { type: 'sphere', radius: 0.1 } }],
    });
    const w = new PhysicsWorld(scene!);
    stepUntil(w, 2000);
    const b = w.getBodyState('ball')!;
    expect(b.position.y).toBeCloseTo(0.1, 5); // resting on the floor
    expect(Math.abs(b.velocity.y)).toBeLessThan(0.01);
  });

  it('linear drag brings a thrown body to rest relative to the wind', () => {
    const { scene } = parsePhysicsScene({
      version: 1,
      environment: { gravity: { x: 0, y: 0, z: 0 }, floorY: null, linearDrag: 2 },
      bodies: [{ id: 'p', mass: 1, velocity: { x: 10, y: 0, z: 0 } }],
    });
    const w = new PhysicsWorld(scene!);
    stepUntil(w, 5000);
    const b = w.getBodyState('p')!;
    expect(Math.abs(b.velocity.x)).toBeLessThan(0.1); // e^{-2·5} ≈ 4e-5
  });

  it('is deterministic: identical input timelines give identical trajectories', () => {
    const make = () => {
      const { scene } = parsePhysicsScene({
        version: 1,
        environment: { floorY: null, gravity: { x: 0, y: -9.81, z: 0 } },
        bodies: [{ id: 'c', mass: 1, position: { x: 0, y: 1, z: 0 } }],
        actuators: [
          { id: 't', bodyId: 'c', kind: 'thrust', axis: { x: 0, y: 1, z: 0 }, maxForce: 12 },
        ],
      });
      const w = new PhysicsWorld(scene!);
      w.scheduleActuatorInput('t', 0, 0.8);
      w.scheduleActuatorInput('t', 300, 1);
      w.scheduleActuatorInput('t', 900, 0.3);
      for (let i = 0; i < 30; i++) w.step(100);
      return w.telemetry();
    };
    const a = make();
    const b = make();
    expect(a.bodies[0].position).toEqual(b.bodies[0].position);
    expect(a.bodies[0].orientation).toEqual(b.bodies[0].orientation);
  });

  it('clamps a huge step to 50 ms', () => {
    const { scene } = parsePhysicsScene({
      version: 1,
      environment: { floorY: null },
      bodies: [{ id: 'b', mass: 1 }],
    });
    const w = new PhysicsWorld(scene!);
    w.step(60_000);
    expect(w.timeMs).toBe(50);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sensor mapping
// ─────────────────────────────────────────────────────────────────────────────

describe('sensor values', () => {
  it('GPS conversion maps ENU metres to degrees around the reference', () => {
    const v = bodyToGpsValues(
      { x: 111_320, y: 10, z: 55_660 },
      { x: 5, y: 0, z: 12 },
      { refLat: 0, refLng: 0, refAltitude: 100 },
    );
    expect(v.lng).toBeCloseTo(1, 6);
    expect(v.lat).toBeCloseTo(0.5, 6);
    expect(v.altitude).toBeCloseTo(110, 6);
    expect(v.speed).toBeCloseTo(13, 6); // hypot(5, 12)
  });

  it('a hovering craft reports +1 g on its up axis; a falling one reports 0 g', () => {
    const hover = parsePhysicsScene({
      version: 1,
      bodies: [{ id: 'c', mass: 1, position: { x: 0, y: 2, z: 0 } }],
      actuators: [{ id: 't', bodyId: 'c', kind: 'thrust', axis: { x: 0, y: 1, z: 0 }, maxForce: 9.81 }],
    });
    const w = new PhysicsWorld(hover.scene!);
    w.setActuatorInput('t', 1);
    stepUntil(w, 300);
    const r = w.imuReading('c')!;
    expect(r.accel.y).toBeCloseTo(1, 1);
    expect(Math.hypot(r.accel.x, r.accel.z)).toBeLessThan(0.01);

    const fall = parsePhysicsScene({
      version: 1,
      environment: { floorY: null },
      bodies: [{ id: 'c', mass: 1, position: { x: 0, y: 10, z: 0 } }],
    });
    const wf = new PhysicsWorld(fall.scene!);
    stepUntil(wf, 100);
    const rf = wf.imuReading('c')!;
    expect(Math.hypot(rf.accel.x, rf.accel.y, rf.accel.z)).toBeLessThan(0.01);
  });
});
