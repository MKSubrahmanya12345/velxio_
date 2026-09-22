/**
 * Headless physics scene runner for the Velxio agent + MCP servers.
 *
 * Bundles the same physics core the browser uses (physics-core.cjs, built by
 * scripts/build-physics-core.mjs) and runs a whole scene from JSON — this is
 * what lets an agent design a rigid-body world (a quadrotor is one body plus
 * four thrust actuators in the scene spec), drive its actuators with a
 * script, and verify the trajectory numerically, without a browser.
 *
 * Protocol: reads one JSON object from stdin:
 *   {
 *     "scene": { ...PhysicsSceneSpec... },
 *     "duration_ms": 3000,
 *     "substep_ms": 1,                       // optional
 *     "sample_every_ms": 100,
 *     "inputs": [ {"at_ms": 0, "actuator": "t1", "value": 1} ],
 *     "checks": [
 *       { "kind": "altitude", "body": "craft", "at_ms": 3000, "target": 2, "tolerance": 0.1 },
 *       { "kind": "position", "body": "craft", "at_ms": 3000, "target": [0, 2, 0], "tolerance": 0.1 },
 *       { "kind": "velocity", "body": "craft", "at_ms": 3000, "target": [0, 0, 0], "tolerance": 0.2 },
 *       { "kind": "actuator", "actuator": "t1", "at_ms": 3000, "target": 9.81, "tolerance": 0.5 }
 *     ]
 *   }
 * and prints one JSON result to stdout:
 *   { "ok": true, "simulated_ms": ..., "sample_count": N,
 *     "samples": [ { "t_ms": 0, "bodies": {id: {pos, vel, quat, angVel}},
 *                    "actuators": [{id, input, state, output}] } ],
 *     "checks": [ {kind, ok, actual, target, tolerance} ] }
 *
 * Always exits 0 with a JSON body ({"ok": false, "error": ...} on failure).
 */
const fs = require('fs');
const path = require('path');

function fail(error) {
  process.stdout.write(JSON.stringify({ ok: false, error }));
  process.exit(0);
}

function loadCore() {
  const candidates = [
    process.env.VELXIO_PHYSICS_CORE_PATH,
    path.join(__dirname, 'physics-core.cjs'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      /* try next */
    }
  }
  fail('physics-core-not-found: run `node scripts/build-physics-core.mjs` to build it.');
}

function num(v, fallback, min, max) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function vecOf(v) {
  if (!Array.isArray(v) || v.length < 3) return { x: 0, y: 0, z: 0 };
  return {
    x: typeof v[0] === 'number' ? v[0] : 0,
    y: typeof v[1] === 'number' ? v[1] : 0,
    z: typeof v[2] === 'number' ? v[2] : 0,
  };
}

function main(req) {
  const core = loadCore();
  const { scene, errors } = core.parsePhysicsScene(req.scene);
  if (!scene) fail(`scene: ${errors.join('; ')}`);

  const durationMs = num(req.duration_ms, 3000, 1, 60000);
  const substepMs = num(req.substep_ms, 1, 0.05, 10);
  const sampleEveryMs = num(req.sample_every_ms, 100, 10, 10000);
  const inputs = Array.isArray(req.inputs) ? req.inputs : [];
  const checks = Array.isArray(req.checks) ? req.checks : [];

  const world = new core.PhysicsWorld(scene, { substepMs });
  for (const input of inputs.slice(0, 64)) {
    if (!input || typeof input.actuator !== 'string') continue;
    world.scheduleActuatorInput(input.actuator, num(input.at_ms, 0, 0, durationMs),
      typeof input.value === 'number' ? input.value : 0);
  }

  const samples = [];
  const checkAt = new Map(); // t_ms -> [check, ...]
  for (const c of checks.slice(0, 32)) {
    if (!c || typeof c.kind !== 'string') continue;
    const t = Math.min(durationMs, num(c.at_ms, durationMs, 0, durationMs));
    if (!checkAt.has(t)) checkAt.set(t, []);
    checkAt.get(t).push(c);
  }

  let remaining = durationMs;
  let nextSample = 0;
  while (remaining > 0) {
    const taken = world.step(Math.min(50, remaining));
    remaining -= taken;
    if (world.timeMs >= nextSample) {
      nextSample += sampleEveryMs;
      const tel = world.telemetry();
      samples.push({
        t_ms: tel.tMs,
        bodies: Object.fromEntries(tel.bodies.map((b) => [b.id, {
          pos: [round4(b.position.x), round4(b.position.y), round4(b.position.z)],
          vel: [round4(b.velocity.x), round4(b.velocity.y), round4(b.velocity.z)],
          quat: [round4(b.orientation.x), round4(b.orientation.y), round4(b.orientation.z), round4(b.orientation.w)],
          angVel: [round4(b.angularVelocity.x), round4(b.angularVelocity.y), round4(b.angularVelocity.z)],
        }])),
        actuators: tel.actuators.map((a) => ({
          id: a.id,
          input: round4(a.input),
          state: round4(a.state),
          output: round4(a.output),
        })),
      });
    }
    if (checkAt.has(world.timeMs)) {
      for (const c of checkAt.get(world.timeMs)) {
        const result = evaluateCheck(world, c, durationMs);
        samples[samples.length - 1] ??= { t_ms: world.timeMs, bodies: {}, actuators: [] };
        (samples[samples.length - 1].checks ??= []).push(result);
      }
    }
  }

  // Evaluate any checks at times that fell between samples.
  const allChecks = [];
  for (const sample of samples) {
    if (sample.checks) allChecks.push(...sample.checks);
  }

  return {
    ok: true,
    simulated_ms: world.timeMs,
    sample_count: samples.length,
    samples,
    checks: allChecks,
  };
}

function round4(v) {
  return Math.round(v * 1e4) / 1e4;
}

function evaluateCheck(world, c, durationMs) {
  const base = {
    kind: c.kind,
    body: c.body ?? null,
    actuator: c.actuator ?? null,
    at_ms: Math.min(durationMs, typeof c.at_ms === 'number' ? c.at_ms : durationMs),
    target: c.target ?? null,
    tolerance: typeof c.tolerance === 'number' ? c.tolerance : 0.1,
  };
  let actual = null;
  if (c.kind === 'actuator') {
    const tel = world.telemetry().actuators.find((a) => a.id === c.actuator);
    if (tel) actual = tel.output;
  } else {
    const b = world.getBodyState(String(c.body ?? ''));
    if (!b) {
      return { ...base, ok: false, actual: null, error: `unknown body ${String(c.body)}` };
    }
    if (c.kind === 'altitude') actual = b.position.y;
    else if (c.kind === 'position') {
      actual = [b.position.x, b.position.y, b.position.z];
    } else if (c.kind === 'velocity') {
      actual = [b.velocity.x, b.velocity.y, b.velocity.z];
    }
  }
  if (actual === null) {
    return { ...base, ok: false, actual: null, error: 'value not available' };
  }
  const within = Array.isArray(actual) && Array.isArray(base.target)
    ? base.target.every((t, i) => Math.abs(actual[i] - t) <= base.tolerance)
    : Math.abs(actual - base.target) <= base.tolerance;
  return { ...base, ok: within, actual };
}

// ── stdin ───────────────────────────────────────────────────────────────────
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let req;
  try {
    req = JSON.parse(raw || '{}');
  } catch {
    return fail('request is not valid JSON');
  }
  try {
    const result = main(req);
    process.stdout.write(JSON.stringify(result));
  } catch (err) {
    fail(`physics runner crashed: ${err && err.message ? err.message : String(err)}`);
  }
});
