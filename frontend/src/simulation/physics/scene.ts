/**
 * scene.ts — the physics scene *spec*: a declarative, JSON-safe document that
 * describes a rigid-body world. This is the interface the agents, MCP tools,
 * browser store and headless runner all speak; anything that can be expressed
 * here can be built by a model in one tool call and verified headlessly.
 *
 * The spec is deliberately generic (bodies + actuators + sensor links + an
 * environment) — a quadrotor is *one* instantiation of it (one body, four
 * thrust actuators), not a special case in the code.
 *
 * Units: SI (metres, kilograms, seconds, newtons, radians). Axis convention:
 * X = east, Y = up, Z = north.
 */

import type { Quat, Vec3 } from './math';

export const PHYSICS_SCENE_VERSION = 1;

/** Hard limits on a scene. Kept small on purpose: an agent describing a
 *  vehicle, not a city. */
export const PHYSICS_SCENE_LIMITS = {
  maxBodies: 8,
  maxActuators: 16,
  maxSensorLinks: 8,
  maxLabelChars: 80,
  minMass: 0.001,
  maxMass: 1_000_000,
  maxForce: 1_000_000,
  maxTorque: 100_000,
  maxSpeed: 10_000, // m/s initial velocities
  maxAngularSpeed: 1000, // rad/s
  maxExtent: 10_000, // m (half extents / radius / initial position)
} as const;

export interface PhysicsEnvironment {
  /** Gravitational acceleration, m/s². Default [0, -9.81, 0]. */
  gravity: Vec3;
  /** Constant wind velocity in the world frame, m/s. Default [0,0,0]. */
  wind: Vec3;
  /** Linear drag: F = -k · (v − wind), units N·s/m. Default 0. */
  linearDrag: number;
  /**
   * Quadratic drag: F = -k · |v − wind| · (v − wind), units N·s²/m².
   * Default 0. This is the ½ρCdA term, not a turbulence model.
   */
  quadraticDrag: number;
  /** Angular drag: τ = -k · ω, units N·m·s. Default 0. */
  angularDrag: number;
  /** Ground plane at world Y = floorY, or null for an open world (space). */
  floorY: number | null;
  /** Bounce on the floor, 0..1. Default 0.1. */
  restitution: number;
  /**
   * Contact stick while touching the floor, 1/s. Default 8 (the historical
   * behaviour — a dropped body comes to rest). Driven vehicles set this near
   * 0 and model rolling resistance with drag, or the floor eats their speed.
   */
  groundDamping: number;
}

export type PhysicsBodyShape =
  | { type: 'point' }
  | { type: 'sphere'; radius: number }
  | { type: 'box'; halfExtents: Vec3 };

export interface PhysicsBodySpec {
  id: string;
  label?: string;
  position: Vec3;
  orientation: Quat;
  velocity: Vec3;
  angularVelocity: Vec3;
  /** kg */
  mass: number;
  /** Principal moments of inertia about the body frame, kg·m². */
  inertia: { ix: number; iy: number; iz: number };
  shape: PhysicsBodyShape;
}

export type PhysicsActuatorKind = 'thrust' | 'torque';

export interface PhysicsActuatorSpec {
  id: string;
  name?: string;
  bodyId: string;
  kind: PhysicsActuatorKind;
  /** Body-local axis the force/torque acts along. Default [0,1,0]. */
  axis: Vec3;
  /** Max force (N) at input = 1 — thrust only. */
  maxForce: number;
  /** Max torque (N·m) at input = 1 — torque only. */
  maxTorque: number;
  /** First-order lag toward the commanded input, ms. Default 15. */
  timeConstantMs: number;
  /**
   * Commanded input before any script overrides it.
   * 0..1 normally; −1..1 when `signed` is set (torque that must reverse).
   */
  inputDefault: number;
  /**
   * When true, commanded input is −1..1 and output may be negative.
   * Thrust stays unipolar — a prop does not push the other way.
   */
  signed: boolean;
  /**
   * Body-frame point the actuator acts at, metres from the centre of mass.
   * Thrust there produces τ = r × F. Zero (the default) means the force
   * goes through the CoM and cannot tilt the body by itself.
   */
  offset: Vec3;
  /**
   * Reaction torque along the thrust axis, N·m per N of thrust, already
   * signed (prop drag torque on the body). Zero for torque actuators.
   */
  reactionNmPerN: number;
  /**
   * Optional circuit binding: when the browser simulator is running, the
   * actuator is driven by the PWM duty (0..1) present on this component pin
   * instead of by script/UI. Omitted → script-driven.
   */
  inputPin?: { componentId: string; pin: string };
}

export type PhysicsSensorKind = 'imu' | 'gps';

export interface PhysicsSensorLink {
  /** Canvas component id of the virtual sensor to feed (e.g. an mpu6050 instance). */
  sensorId: string;
  bodyId: string;
  kind: PhysicsSensorKind;
  /** GPS reference point (WGS84 degrees) that world origin maps to. */
  refLat: number;
  refLng: number;
  /** Meters the world origin sits above/below the GPS reference altitude. */
  refAltitude: number;
}

export interface PhysicsScene {
  version: 1;
  name?: string;
  environment: PhysicsEnvironment;
  bodies: PhysicsBodySpec[];
  actuators: PhysicsActuatorSpec[];
  sensorLinks: PhysicsSensorLink[];
}

export const DEFAULT_ENVIRONMENT: PhysicsEnvironment = {
  gravity: { x: 0, y: -9.81, z: 0 },
  wind: { x: 0, y: 0, z: 0 },
  linearDrag: 0,
  quadraticDrag: 0,
  angularDrag: 0,
  floorY: 0,
  restitution: 0.1,
  groundDamping: 8,
};

const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export interface ParseResult {
  scene: PhysicsScene | null;
  errors: string[];
}

function num(v: unknown, field: string, errors: string[], fallback: number, min: number, max: number): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    errors.push(`${field} must be a finite number`);
    return fallback;
  }
  if (v < min || v > max) {
    errors.push(`${field} is out of range [${min}, ${max}]: ${v}`);
    return Math.min(max, Math.max(min, v));
  }
  return v;
}

function vec3Of(v: unknown, field: string, errors: string[], fallback: Vec3, max: number): Vec3 {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'object' || Array.isArray(v)) {
    errors.push(`${field} must be {x, y, z}`);
    return fallback;
  }
  const o = v as Record<string, unknown>;
  return {
    x: num(o.x, `${field}.x`, errors, fallback.x, -max, max),
    y: num(o.y, `${field}.y`, errors, fallback.y, -max, max),
    z: num(o.z, `${field}.z`, errors, fallback.z, -max, max),
  };
}

function quatOf(v: unknown, field: string, errors: string[], fallback: Quat): Quat {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'object' || Array.isArray(v)) {
    errors.push(`${field} must be {x, y, z, w}`);
    return fallback;
  }
  const o = v as Record<string, unknown>;
  return {
    x: num(o.x, `${field}.x`, errors, fallback.x, -2, 2),
    y: num(o.y, `${field}.y`, errors, fallback.y, -2, 2),
    z: num(o.z, `${field}.z`, errors, fallback.z, -2, 2),
    w: num(o.w, `${field}.w`, errors, fallback.w, -2, 2),
  };
}

function idOf(v: unknown, field: string, errors: string[]): string | null {
  if (typeof v !== 'string' || !ID_RE.test(v)) {
    errors.push(`${field} must match ${ID_RE} (got ${JSON.stringify(v)})`);
    return null;
  }
  return v;
}

/**
 * Parse and normalise an untrusted scene document (from an agent, MCP client
 * or saved project). Returns the validated scene (with all defaults filled
 * in) plus human-readable errors; the scene is null when a hard error made
 * it unusable (unknown body references, duplicate ids, empty body list).
 */
export function parsePhysicsScene(raw: unknown, version: number = PHYSICS_SCENE_VERSION): ParseResult {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { scene: null, errors: ['scene must be a JSON object'] };
  }
  const doc = raw as Record<string, unknown>;
  if (doc.version !== undefined && doc.version !== version) {
    errors.push(`unsupported scene version ${String(doc.version)} (expected ${version})`);
  }

  const L = PHYSICS_SCENE_LIMITS;

  // ── environment ──────────────────────────────────────────────────────────
  const envRaw = (typeof doc.environment === 'object' && doc.environment !== null
    ? doc.environment
    : {}) as Record<string, unknown>;
  const environment: PhysicsEnvironment = {
    gravity: vec3Of(envRaw.gravity, 'environment.gravity', errors, DEFAULT_ENVIRONMENT.gravity, 1000),
    wind: vec3Of(envRaw.wind, 'environment.wind', errors, DEFAULT_ENVIRONMENT.wind, 1000),
    linearDrag: num(envRaw.linearDrag, 'environment.linearDrag', errors, 0, 0, 1e6),
    quadraticDrag: num(envRaw.quadraticDrag, 'environment.quadraticDrag', errors, 0, 0, 1e6),
    angularDrag: num(envRaw.angularDrag, 'environment.angularDrag', errors, 0, 0, 1e6),
    floorY: envRaw.floorY === undefined
      ? DEFAULT_ENVIRONMENT.floorY
      : envRaw.floorY === null
        ? null // explicit null = open world (e.g. space)
        : (typeof envRaw.floorY === 'number' && Number.isFinite(envRaw.floorY)
          ? Math.min(L.maxExtent, Math.max(-L.maxExtent, envRaw.floorY))
          : (errors.push('environment.floorY must be a number or null'), DEFAULT_ENVIRONMENT.floorY)),
    restitution: num(envRaw.restitution, 'environment.restitution', errors, 0.1, 0, 1),
    groundDamping: num(envRaw.groundDamping, 'environment.groundDamping', errors, 8, 0, 1e4),
  };

  // ── bodies ───────────────────────────────────────────────────────────────
  const bodies: PhysicsBodySpec[] = [];
  const bodyIds = new Set<string>();
  const rawBodies = Array.isArray(doc.bodies) ? doc.bodies : [];
  if (rawBodies.length === 0) errors.push('scene needs at least one body (bodies: [])');
  if (rawBodies.length > L.maxBodies) errors.push(`at most ${L.maxBodies} bodies per scene`);
  for (const [i, rb] of rawBodies.entries()) {
    if (typeof rb !== 'object' || rb === null) {
      errors.push(`bodies[${i}] must be an object`);
      continue;
    }
    const b = rb as Record<string, unknown>;
    const id = idOf(b.id, `bodies[${i}].id`, errors);
    if (id === null || bodyIds.has(id)) {
      if (id !== null) errors.push(`duplicate body id ${id}`);
      continue;
    }
    bodyIds.add(id);

    const mass = num(b.mass, `bodies[${i}].mass`, errors, 1, L.minMass, L.maxMass);
    const inertiaRaw = (typeof b.inertia === 'object' && b.inertia !== null
      ? b.inertia
      : {}) as Record<string, unknown>;
    // Default to a small 10 cm cube's moments so a point-ish body still
    // resists tumbling; callers model real inertia explicitly.
    const defaultI = (mass * 0.1 * 0.1) / 6;
    const inertia = {
      ix: num(inertiaRaw.ix, `bodies[${i}].inertia.ix`, errors, defaultI, 1e-12, 1e9),
      iy: num(inertiaRaw.iy, `bodies[${i}].inertia.iy`, errors, defaultI, 1e-12, 1e9),
      iz: num(inertiaRaw.iz, `bodies[${i}].inertia.iz`, errors, defaultI, 1e-12, 1e9),
    };

    let shape: PhysicsBodyShape = { type: 'point' };
    if (b.shape !== undefined && b.shape !== null) {
      const s = b.shape as Record<string, unknown>;
      if (s.type === 'sphere') {
        const radius = num(s.radius, 'shape.radius', errors, 0.05, 0, L.maxExtent);
        shape = { type: 'sphere', radius };
      } else if (s.type === 'box') {
        const he = vec3Of(s.halfExtents, 'shape.halfExtents', errors, { x: 0.05, y: 0.05, z: 0.05 }, L.maxExtent);
        shape = { type: 'box', halfExtents: he };
      } else if (s.type === 'point') {
        shape = { type: 'point' };
      } else {
        errors.push(`bodies[${i}].shape.type must be 'point' | 'sphere' | 'box'`);
      }
    }

    bodies.push({
      id,
      label: typeof b.label === 'string' ? b.label.slice(0, L.maxLabelChars) : undefined,
      position: vec3Of(b.position, `bodies[${i}].position`, errors, { x: 0, y: 0, z: 0 }, L.maxExtent),
      orientation: quatOf(b.orientation, `bodies[${i}].orientation`, errors, { x: 0, y: 0, z: 0, w: 1 }),
      velocity: vec3Of(b.velocity, `bodies[${i}].velocity`, errors, { x: 0, y: 0, z: 0 }, L.maxSpeed),
      angularVelocity: vec3Of(
        b.angularVelocity, `bodies[${i}].angularVelocity`, errors,
        { x: 0, y: 0, z: 0 }, L.maxAngularSpeed,
      ),
      mass,
      inertia,
      shape,
    });
  }

  // ── actuators ────────────────────────────────────────────────────────────
  const actuators: PhysicsActuatorSpec[] = [];
  const actuatorIds = new Set<string>();
  const rawActuators = Array.isArray(doc.actuators) ? doc.actuators : [];
  if (rawActuators.length > L.maxActuators) errors.push(`at most ${L.maxActuators} actuators per scene`);
  for (const [i, ra] of rawActuators.entries()) {
    if (typeof ra !== 'object' || ra === null) {
      errors.push(`actuators[${i}] must be an object`);
      continue;
    }
    const a = ra as Record<string, unknown>;
    const id = idOf(a.id, `actuators[${i}].id`, errors);
    if (id === null || actuatorIds.has(id)) {
      if (id !== null) errors.push(`duplicate actuator id ${id}`);
      continue;
    }
    const bodyId = idOf(a.bodyId, `actuators[${i}].bodyId`, errors);
    const kind: PhysicsActuatorKind = a.kind === 'torque' ? 'torque' : 'thrust';
    if (a.kind !== undefined && a.kind !== 'thrust' && a.kind !== 'torque') {
      errors.push(`actuators[${i}].kind must be 'thrust' | 'torque'`);
    }
    const pinRaw = (typeof a.inputPin === 'object' && a.inputPin !== null
      ? a.inputPin
      : null) as Record<string, unknown> | null;
    const signed = a.signed === true;
    if (a.signed !== undefined && a.signed !== true && a.signed !== false) {
      errors.push(`actuators[${i}].signed must be a boolean`);
    }
    actuators.push({
      id,
      name: typeof a.name === 'string' ? a.name.slice(0, L.maxLabelChars) : undefined,
      bodyId: bodyId ?? '',
      kind,
      axis: vec3Of(a.axis, `actuators[${i}].axis`, errors, { x: 0, y: 1, z: 0 }, 1e3),
      maxForce: num(a.maxForce, `actuators[${i}].maxForce`, errors, 10, 0, L.maxForce),
      maxTorque: num(a.maxTorque, `actuators[${i}].maxTorque`, errors, 1, 0, L.maxTorque),
      timeConstantMs: num(a.timeConstantMs, `actuators[${i}].timeConstantMs`, errors, 15, 0, 5000),
      inputDefault: num(a.inputDefault, `actuators[${i}].inputDefault`, errors, 0, signed ? -1 : 0, 1),
      signed,
      offset: vec3Of(a.offset, `actuators[${i}].offset`, errors, { x: 0, y: 0, z: 0 }, L.maxExtent),
      reactionNmPerN: num(a.reactionNmPerN, `actuators[${i}].reactionNmPerN`, errors, 0, -100, 100),
      inputPin: pinRaw
        ? {
            componentId: typeof pinRaw.componentId === 'string' ? pinRaw.componentId.slice(0, 64) : '',
            pin: typeof pinRaw.pin === 'string' ? pinRaw.pin.slice(0, 16) : '',
          }
        : undefined,
    });
    actuatorIds.add(id);
  }

  // ── sensor links ─────────────────────────────────────────────────────────
  const sensorLinks: PhysicsSensorLink[] = [];
  const rawLinks = Array.isArray(doc.sensorLinks) ? doc.sensorLinks : [];
  if (rawLinks.length > L.maxSensorLinks) errors.push(`at most ${L.maxSensorLinks} sensor links per scene`);
  for (const [i, rl] of rawLinks.entries()) {
    if (typeof rl !== 'object' || rl === null) {
      errors.push(`sensorLinks[${i}] must be an object`);
      continue;
    }
    const s = rl as Record<string, unknown>;
    if (s.kind !== 'imu' && s.kind !== 'gps') {
      errors.push(`sensorLinks[${i}].kind must be 'imu' | 'gps'`);
      continue;
    }
    sensorLinks.push({
      sensorId: typeof s.sensorId === 'string' ? s.sensorId.slice(0, 64) : `sensor${i}`,
      bodyId: typeof s.bodyId === 'string' ? s.bodyId.slice(0, 64) : '',
      kind: s.kind,
      refLat: num(s.refLat, `sensorLinks[${i}].refLat`, errors, 0, -90, 90),
      refLng: num(s.refLng, `sensorLinks[${i}].refLng`, errors, 0, -180, 180),
      refAltitude: num(s.refAltitude, `sensorLinks[${i}].refAltitude`, errors, 0, -1e4, 1e4),
    });
  }

  // ── cross-reference checks (hard errors) ─────────────────────────────────
  if (bodies.length === 0) {
    return { scene: null, errors: [...errors, 'no usable bodies'] };
  }
  for (const a of actuators) {
    if (!bodyIds.has(a.bodyId)) errors.push(`actuator ${a.id} references unknown body ${a.bodyId}`);
  }
  for (const l of sensorLinks) {
    if (!bodyIds.has(l.bodyId)) errors.push(`sensor link ${l.sensorId} references unknown body ${l.bodyId}`);
  }
  if (errors.length > 0) return { scene: null, errors };

  return {
    scene: {
      version: version as 1,
      name: typeof doc.name === 'string' ? doc.name.slice(0, L.maxLabelChars) : undefined,
      environment,
      bodies,
      actuators,
      sensorLinks,
    },
    errors: [],
  };
}

/** An empty scene: one unit-mass point body at the origin above the floor. */
export function emptyPhysicsScene(): PhysicsScene {
  const { scene } = parsePhysicsScene({
    version: PHYSICS_SCENE_VERSION,
    name: 'Empty scene',
    bodies: [{ id: 'body1', mass: 1, position: { x: 0, y: 1, z: 0 } }],
  });
  return scene!;
}
