var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// frontend/src/simulation/physics/index.ts
var index_exports = {};
__export(index_exports, {
  DEFAULT_ENVIRONMENT: () => DEFAULT_ENVIRONMENT,
  PHYSICS_SCENE_LIMITS: () => PHYSICS_SCENE_LIMITS,
  PHYSICS_SCENE_VERSION: () => PHYSICS_SCENE_VERSION,
  PhysicsWorld: () => PhysicsWorld,
  bodyToGpsValues: () => bodyToGpsValues,
  bodyToImuValues: () => bodyToImuValues,
  emptyPhysicsScene: () => emptyPhysicsScene,
  parsePhysicsScene: () => parsePhysicsScene,
  qConjugate: () => qConjugate,
  qFromAxisAngle: () => qFromAxisAngle,
  qIntegrate: () => qIntegrate,
  qMul: () => qMul,
  qNormalize: () => qNormalize,
  qRotate: () => qRotate,
  quatIdentity: () => quatIdentity,
  sensorLinkValues: () => sensorLinkValues,
  vAdd: () => vAdd,
  vClampMagnitude: () => vClampMagnitude,
  vCross: () => vCross,
  vDot: () => vDot,
  vLength: () => vLength,
  vNormalize: () => vNormalize,
  vScale: () => vScale,
  vSub: () => vSub,
  vec3: () => vec3
});
module.exports = __toCommonJS(index_exports);

// frontend/src/simulation/physics/math.ts
var vec3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
var quatIdentity = () => ({ x: 0, y: 0, z: 0, w: 1 });
function vAdd(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function vSub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function vScale(v, s) {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}
function vDot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function vCross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}
function vLength(v) {
  return Math.hypot(v.x, v.y, v.z);
}
function vNormalize(v) {
  const len = vLength(v);
  if (!Number.isFinite(len) || len < 1e-12) return vec3();
  return vScale(v, 1 / len);
}
function vClampMagnitude(v, max) {
  const len = vLength(v);
  if (!Number.isFinite(len) || len <= max) return v;
  return vScale(v, max / len);
}
function qMul(a, b) {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w
  };
}
function qNormalize(q) {
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  if (!Number.isFinite(n) || n < 1e-12) return quatIdentity();
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
}
function qFromAxisAngle(axis, angleRad) {
  const a = vNormalize(axis);
  const s = Math.sin(angleRad / 2);
  return { x: a.x * s, y: a.y * s, z: a.z * s, w: Math.cos(angleRad / 2) };
}
function qRotate(q, v) {
  const u = { x: q.x, y: q.y, z: q.z };
  const uv = vCross(u, v);
  return vAdd(v, vAdd(vScale(uv, 2 * q.w), vScale(vCross(u, uv), 2)));
}
function qIntegrate(q, angularVelocity, dt) {
  const half = {
    x: angularVelocity.x * (dt / 2),
    y: angularVelocity.y * (dt / 2),
    z: angularVelocity.z * (dt / 2),
    w: 1
  };
  return qNormalize(qMul(q, qNormalize(half)));
}
function qConjugate(q) {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

// frontend/src/simulation/physics/scene.ts
var PHYSICS_SCENE_VERSION = 1;
var PHYSICS_SCENE_LIMITS = {
  maxBodies: 8,
  maxActuators: 16,
  maxSensorLinks: 8,
  maxLabelChars: 80,
  minMass: 1e-3,
  maxMass: 1e6,
  maxForce: 1e6,
  maxTorque: 1e5,
  maxSpeed: 1e4,
  // m/s initial velocities
  maxAngularSpeed: 1e3,
  // rad/s
  maxExtent: 1e4
  // m (half extents / radius / initial position)
};
var DEFAULT_ENVIRONMENT = {
  gravity: { x: 0, y: -9.81, z: 0 },
  wind: { x: 0, y: 0, z: 0 },
  linearDrag: 0,
  angularDrag: 0,
  floorY: 0,
  restitution: 0.1
};
var ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
function num(v, field, errors, fallback, min, max) {
  if (v === void 0 || v === null) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    errors.push(`${field} must be a finite number`);
    return fallback;
  }
  if (v < min || v > max) {
    errors.push(`${field} is out of range [${min}, ${max}]: ${v}`);
    return Math.min(max, Math.max(min, v));
  }
  return v;
}
function vec3Of(v, field, errors, fallback, max) {
  if (v === void 0 || v === null) return fallback;
  if (typeof v !== "object" || Array.isArray(v)) {
    errors.push(`${field} must be {x, y, z}`);
    return fallback;
  }
  const o = v;
  return {
    x: num(o.x, `${field}.x`, errors, fallback.x, -max, max),
    y: num(o.y, `${field}.y`, errors, fallback.y, -max, max),
    z: num(o.z, `${field}.z`, errors, fallback.z, -max, max)
  };
}
function quatOf(v, field, errors, fallback) {
  if (v === void 0 || v === null) return fallback;
  if (typeof v !== "object" || Array.isArray(v)) {
    errors.push(`${field} must be {x, y, z, w}`);
    return fallback;
  }
  const o = v;
  return {
    x: num(o.x, `${field}.x`, errors, fallback.x, -2, 2),
    y: num(o.y, `${field}.y`, errors, fallback.y, -2, 2),
    z: num(o.z, `${field}.z`, errors, fallback.z, -2, 2),
    w: num(o.w, `${field}.w`, errors, fallback.w, -2, 2)
  };
}
function idOf(v, field, errors) {
  if (typeof v !== "string" || !ID_RE.test(v)) {
    errors.push(`${field} must match ${ID_RE} (got ${JSON.stringify(v)})`);
    return null;
  }
  return v;
}
function parsePhysicsScene(raw, version = PHYSICS_SCENE_VERSION) {
  const errors = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { scene: null, errors: ["scene must be a JSON object"] };
  }
  const doc = raw;
  if (doc.version !== void 0 && doc.version !== version) {
    errors.push(`unsupported scene version ${String(doc.version)} (expected ${version})`);
  }
  const L = PHYSICS_SCENE_LIMITS;
  const envRaw = typeof doc.environment === "object" && doc.environment !== null ? doc.environment : {};
  const environment = {
    gravity: vec3Of(envRaw.gravity, "environment.gravity", errors, DEFAULT_ENVIRONMENT.gravity, 1e3),
    wind: vec3Of(envRaw.wind, "environment.wind", errors, DEFAULT_ENVIRONMENT.wind, 1e3),
    linearDrag: num(envRaw.linearDrag, "environment.linearDrag", errors, 0, 0, 1e6),
    angularDrag: num(envRaw.angularDrag, "environment.angularDrag", errors, 0, 0, 1e6),
    floorY: envRaw.floorY === void 0 ? DEFAULT_ENVIRONMENT.floorY : envRaw.floorY === null ? null : typeof envRaw.floorY === "number" && Number.isFinite(envRaw.floorY) ? Math.min(L.maxExtent, Math.max(-L.maxExtent, envRaw.floorY)) : (errors.push("environment.floorY must be a number or null"), DEFAULT_ENVIRONMENT.floorY),
    restitution: num(envRaw.restitution, "environment.restitution", errors, 0.1, 0, 1)
  };
  const bodies = [];
  const bodyIds = /* @__PURE__ */ new Set();
  const rawBodies = Array.isArray(doc.bodies) ? doc.bodies : [];
  if (rawBodies.length === 0) errors.push("scene needs at least one body (bodies: [])");
  if (rawBodies.length > L.maxBodies) errors.push(`at most ${L.maxBodies} bodies per scene`);
  for (const [i, rb] of rawBodies.entries()) {
    if (typeof rb !== "object" || rb === null) {
      errors.push(`bodies[${i}] must be an object`);
      continue;
    }
    const b = rb;
    const id = idOf(b.id, `bodies[${i}].id`, errors);
    if (id === null || bodyIds.has(id)) {
      if (id !== null) errors.push(`duplicate body id ${id}`);
      continue;
    }
    bodyIds.add(id);
    const mass = num(b.mass, `bodies[${i}].mass`, errors, 1, L.minMass, L.maxMass);
    const inertiaRaw = typeof b.inertia === "object" && b.inertia !== null ? b.inertia : {};
    const defaultI = mass * 0.1 * 0.1 / 6;
    const inertia = {
      ix: num(inertiaRaw.ix, `bodies[${i}].inertia.ix`, errors, defaultI, 1e-12, 1e9),
      iy: num(inertiaRaw.iy, `bodies[${i}].inertia.iy`, errors, defaultI, 1e-12, 1e9),
      iz: num(inertiaRaw.iz, `bodies[${i}].inertia.iz`, errors, defaultI, 1e-12, 1e9)
    };
    let shape = { type: "point" };
    if (b.shape !== void 0 && b.shape !== null) {
      const s = b.shape;
      if (s.type === "sphere") {
        const radius = num(s.radius, "shape.radius", errors, 0.05, 0, L.maxExtent);
        shape = { type: "sphere", radius };
      } else if (s.type === "box") {
        const he = vec3Of(s.halfExtents, "shape.halfExtents", errors, { x: 0.05, y: 0.05, z: 0.05 }, L.maxExtent);
        shape = { type: "box", halfExtents: he };
      } else if (s.type === "point") {
        shape = { type: "point" };
      } else {
        errors.push(`bodies[${i}].shape.type must be 'point' | 'sphere' | 'box'`);
      }
    }
    bodies.push({
      id,
      label: typeof b.label === "string" ? b.label.slice(0, L.maxLabelChars) : void 0,
      position: vec3Of(b.position, `bodies[${i}].position`, errors, { x: 0, y: 0, z: 0 }, L.maxExtent),
      orientation: quatOf(b.orientation, `bodies[${i}].orientation`, errors, { x: 0, y: 0, z: 0, w: 1 }),
      velocity: vec3Of(b.velocity, `bodies[${i}].velocity`, errors, { x: 0, y: 0, z: 0 }, L.maxSpeed),
      angularVelocity: vec3Of(
        b.angularVelocity,
        `bodies[${i}].angularVelocity`,
        errors,
        { x: 0, y: 0, z: 0 },
        L.maxAngularSpeed
      ),
      mass,
      inertia,
      shape
    });
  }
  const actuators = [];
  const actuatorIds = /* @__PURE__ */ new Set();
  const rawActuators = Array.isArray(doc.actuators) ? doc.actuators : [];
  if (rawActuators.length > L.maxActuators) errors.push(`at most ${L.maxActuators} actuators per scene`);
  for (const [i, ra] of rawActuators.entries()) {
    if (typeof ra !== "object" || ra === null) {
      errors.push(`actuators[${i}] must be an object`);
      continue;
    }
    const a = ra;
    const id = idOf(a.id, `actuators[${i}].id`, errors);
    if (id === null || actuatorIds.has(id)) {
      if (id !== null) errors.push(`duplicate actuator id ${id}`);
      continue;
    }
    const bodyId = idOf(a.bodyId, `actuators[${i}].bodyId`, errors);
    const kind = a.kind === "torque" ? "torque" : "thrust";
    if (a.kind !== void 0 && a.kind !== "thrust" && a.kind !== "torque") {
      errors.push(`actuators[${i}].kind must be 'thrust' | 'torque'`);
    }
    const pinRaw = typeof a.inputPin === "object" && a.inputPin !== null ? a.inputPin : null;
    actuators.push({
      id,
      name: typeof a.name === "string" ? a.name.slice(0, L.maxLabelChars) : void 0,
      bodyId: bodyId ?? "",
      kind,
      axis: vec3Of(a.axis, `actuators[${i}].axis`, errors, { x: 0, y: 1, z: 0 }, 1e3),
      maxForce: num(a.maxForce, `actuators[${i}].maxForce`, errors, 10, 0, L.maxForce),
      maxTorque: num(a.maxTorque, `actuators[${i}].maxTorque`, errors, 1, 0, L.maxTorque),
      timeConstantMs: num(a.timeConstantMs, `actuators[${i}].timeConstantMs`, errors, 15, 0, 5e3),
      inputDefault: num(a.inputDefault, `actuators[${i}].inputDefault`, errors, 0, 0, 1),
      inputPin: pinRaw ? {
        componentId: typeof pinRaw.componentId === "string" ? pinRaw.componentId.slice(0, 64) : "",
        pin: typeof pinRaw.pin === "string" ? pinRaw.pin.slice(0, 16) : ""
      } : void 0
    });
    actuatorIds.add(id);
  }
  const sensorLinks = [];
  const rawLinks = Array.isArray(doc.sensorLinks) ? doc.sensorLinks : [];
  if (rawLinks.length > L.maxSensorLinks) errors.push(`at most ${L.maxSensorLinks} sensor links per scene`);
  for (const [i, rl] of rawLinks.entries()) {
    if (typeof rl !== "object" || rl === null) {
      errors.push(`sensorLinks[${i}] must be an object`);
      continue;
    }
    const s = rl;
    if (s.kind !== "imu" && s.kind !== "gps") {
      errors.push(`sensorLinks[${i}].kind must be 'imu' | 'gps'`);
      continue;
    }
    sensorLinks.push({
      sensorId: typeof s.sensorId === "string" ? s.sensorId.slice(0, 64) : `sensor${i}`,
      bodyId: typeof s.bodyId === "string" ? s.bodyId.slice(0, 64) : "",
      kind: s.kind,
      refLat: num(s.refLat, `sensorLinks[${i}].refLat`, errors, 0, -90, 90),
      refLng: num(s.refLng, `sensorLinks[${i}].refLng`, errors, 0, -180, 180),
      refAltitude: num(s.refAltitude, `sensorLinks[${i}].refAltitude`, errors, 0, -1e4, 1e4)
    });
  }
  if (bodies.length === 0) {
    return { scene: null, errors: [...errors, "no usable bodies"] };
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
      version,
      name: typeof doc.name === "string" ? doc.name.slice(0, L.maxLabelChars) : void 0,
      environment,
      bodies,
      actuators,
      sensorLinks
    },
    errors: []
  };
}
function emptyPhysicsScene() {
  const { scene } = parsePhysicsScene({
    version: PHYSICS_SCENE_VERSION,
    name: "Empty scene",
    bodies: [{ id: "body1", mass: 1, position: { x: 0, y: 1, z: 0 } }]
  });
  return scene;
}

// frontend/src/simulation/physics/world.ts
var PhysicsWorld = class {
  scene;
  timeMs = 0;
  substepMs;
  bodies;
  bodyIndex;
  actuators;
  actuatorIndex;
  /** Pending scripted input changes: {tMs, actuatorIdx, value}, sorted by tMs. */
  scheduled = [];
  nextEvent = 0;
  constructor(scene, options = {}) {
    this.scene = scene;
    this.substepMs = Math.min(10, Math.max(0.05, options.substepMs ?? 1));
    this.bodyIndex = /* @__PURE__ */ new Map();
    this.bodies = scene.bodies.map((spec, i) => {
      this.bodyIndex.set(spec.id, i);
      return {
        spec,
        position: { ...spec.position },
        orientation: qNormalize({ ...spec.orientation }),
        velocity: { ...spec.velocity },
        angularVelocity: { ...spec.angularVelocity },
        force: vec3()
      };
    });
    this.actuatorIndex = /* @__PURE__ */ new Map();
    this.actuators = scene.actuators.filter((a) => this.bodyIndex.has(a.bodyId)).map((spec, i) => {
      this.actuatorIndex.set(spec.id, i);
      return { spec, kind: spec.kind, input: spec.inputDefault, state: spec.inputDefault, output: 0 };
    });
  }
  get bodyCount() {
    return this.bodies.length;
  }
  get actuatorCount() {
    return this.actuators.length;
  }
  /** Schedule an input change for an actuator at a future (or past) time. */
  scheduleActuatorInput(actuatorId, atMs, value) {
    const idx = this.actuatorIndex.get(actuatorId);
    if (idx === void 0) return false;
    this.scheduled.push({ tMs: atMs, actuatorIdx: idx, value: Math.min(1, Math.max(0, value)) });
    return true;
  }
  /** Set an actuator's input immediately (UI / live binding). */
  setActuatorInput(actuatorId, value) {
    const idx = this.actuatorIndex.get(actuatorId);
    if (idx === void 0) return false;
    this.actuators[idx].input = Math.min(1, Math.max(0, value));
    return true;
  }
  getBodyState(id) {
    const i = this.bodyIndex.get(id);
    return i === void 0 ? null : this.bodyTelemetry(this.bodies[i]);
  }
  /** Advance the simulation by `elapsedMs` (clamped to 50 ms per call). */
  step(elapsedMs) {
    const dt = Math.min(50, Math.max(0, elapsedMs));
    if (dt <= 0) return 0;
    const h = this.substepMs / 1e3;
    const steps = Math.round(dt / this.substepMs);
    if (steps > 0) {
      this.scheduled.sort((p, q) => p.tMs - q.tMs);
    }
    for (let s = 0; s < steps; s++) {
      const tTarget = this.timeMs + this.substepMs;
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
  integrate(h) {
    const env = this.scene.environment;
    for (const a of this.actuators) {
      const tau = Math.max(a.spec.timeConstantMs, 0.1) / 1e3;
      const alpha = 1 - Math.exp(-h / tau);
      a.state += (a.input - a.state) * alpha;
      a.output = a.kind === "thrust" ? a.spec.maxForce * a.state : a.spec.maxTorque * a.state;
    }
    const forces = this.bodies.map(() => vec3());
    const torques = this.bodies.map(() => vec3());
    for (const b of this.bodies) {
      const i = this.bodyIndex.get(b.spec.id);
      vAddForces(forces[i], vScale(env.gravity, b.spec.mass));
      if (env.linearDrag > 0) {
        const rel = vSub(b.velocity, env.wind);
        vAddForces(forces[i], vScale(rel, -env.linearDrag));
      }
    }
    for (const a of this.actuators) {
      const bi = this.bodyIndex.get(a.spec.bodyId);
      if (bi === void 0) continue;
      const body = this.bodies[bi];
      const axisWorld = qRotate(body.orientation, vNormalize(a.spec.axis));
      if (a.kind === "thrust") {
        vAddForces(forces[bi], vScale(axisWorld, a.output));
      } else {
        torques[bi] = vAdd(torques[bi], vScale(a.spec.axis, a.output));
      }
    }
    for (const b of this.bodies) {
      const i = this.bodyIndex.get(b.spec.id);
      const { mass, inertia } = b.spec;
      b.force = { ...forces[i] };
      const acc = vScale(forces[i], 1 / mass);
      b.velocity = vAdd(b.velocity, vScale(acc, h));
      b.position = vAdd(b.position, vScale(b.velocity, h));
      let tauBody = torques[i];
      if (env.angularDrag > 0) {
        tauBody = vSub(tauBody, vScale(b.angularVelocity, env.angularDrag));
      }
      const alpha = vec3(
        tauBody.x / inertia.ix,
        tauBody.y / inertia.iy,
        tauBody.z / inertia.iz
      );
      b.angularVelocity = vAdd(b.angularVelocity, vScale(alpha, h));
      b.orientation = qIntegrate(b.orientation, b.angularVelocity, h);
    }
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
          const damp = Math.max(0, 1 - 8 * h);
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
  supportRadius(spec) {
    if (spec.shape.type === "sphere") return spec.shape.radius;
    if (spec.shape.type === "box") {
      const he = spec.shape.halfExtents;
      return Math.max(he.x, he.y, he.z);
    }
    return 0;
  }
  /** Current body-frame specific force (proper acceleration, in g) + gyro.
   *  This is exactly what a real IMU reports: the accelerometer senses
   *  thrust/gravity, not inertial frame changes of the coordinate grid. */
  imuReading(bodyId) {
    const b = this.bodies[this.bodyIndex.get(bodyId) ?? -1];
    if (!b) return null;
    const g = 9.81;
    const env = this.scene.environment;
    const properWorld = vSub(b.force, vScale(env.gravity, b.spec.mass));
    const accelBody = qRotate(qConjugate(b.orientation), vScale(properWorld, 1 / (b.spec.mass * g)));
    const degPerRad = 180 / Math.PI;
    const gyroBody = vScale(b.angularVelocity, degPerRad);
    return { accel: accelBody, gyro: gyroBody };
  }
  telemetry() {
    return {
      tMs: this.timeMs,
      bodies: this.bodies.map((b) => this.bodyTelemetry(b)),
      actuators: this.actuators.map((a) => ({
        id: a.spec.id,
        name: a.spec.name,
        kind: a.spec.kind,
        input: a.input,
        state: a.state,
        output: a.output
      }))
    };
  }
  bodyTelemetry(b) {
    return {
      id: b.spec.id,
      label: b.spec.label,
      position: { ...b.position },
      orientation: { ...b.orientation },
      velocity: { ...b.velocity },
      angularVelocity: { ...b.angularVelocity },
      force: { ...b.force }
    };
  }
};
function vAddForces(target, f) {
  target.x += f.x;
  target.y += f.y;
  target.z += f.z;
}

// frontend/src/simulation/physics/sensors.ts
var METERS_PER_DEG_LAT = 111320;
function bodyToImuValues(accel, gyro) {
  return {
    accelX: accel.x,
    accelY: accel.y,
    accelZ: accel.z,
    gyroX: gyro.x,
    gyroY: gyro.y,
    gyroZ: gyro.z
  };
}
function bodyToGpsValues(position, velocity, link) {
  const cosLat = Math.max(0.01, Math.cos(link.refLat * Math.PI / 180));
  return {
    lat: link.refLat + position.z / METERS_PER_DEG_LAT,
    lng: link.refLng + position.x / (METERS_PER_DEG_LAT * cosLat),
    altitude: link.refAltitude + position.y,
    speed: Math.hypot(velocity.x, velocity.z)
  };
}
function sensorLinkValues(links, input) {
  const out = {};
  for (const link of links) {
    if (link.kind === "imu") {
      const r = input.imu(link.bodyId);
      if (r) out[link.sensorId] = bodyToImuValues(r.accel, r.gyro);
    } else {
      const s = input.state(link.bodyId);
      if (s) out[link.sensorId] = bodyToGpsValues(s.position, s.velocity, link);
    }
  }
  return out;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_ENVIRONMENT,
  PHYSICS_SCENE_LIMITS,
  PHYSICS_SCENE_VERSION,
  PhysicsWorld,
  bodyToGpsValues,
  bodyToImuValues,
  emptyPhysicsScene,
  parsePhysicsScene,
  qConjugate,
  qFromAxisAngle,
  qIntegrate,
  qMul,
  qNormalize,
  qRotate,
  quatIdentity,
  sensorLinkValues,
  vAdd,
  vClampMagnitude,
  vCross,
  vDot,
  vLength,
  vNormalize,
  vScale,
  vSub,
  vec3
});
