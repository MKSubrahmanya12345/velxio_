# Physics scene layer

A generic rigid-body extension layer for the Velxio simulator. It is the
interface for anything that *moves* — a drone, a rover, a spacecraft, a
pneumatic actuator — modelled as **bodies + actuators + sensor links** in a
JSON scene document, integrated by one deterministic core that runs
identically in the browser and headlessly in Node.

Nothing here is drone-specific: a quadrotor is one body plus four thrust
actuators in a scene document, and the same document shape builds a two-wheel
rover or a zero-gravity test article.

## Concepts

| Concept | What it is |
|---------|-----------|
| **Body** | Rigid body: position/quaternion/velocity/angular velocity, mass, principal-axis inertia, optional collision shape (`point`, `sphere`, `box`) |
| **Actuator** | Mounted on a body along a body-local axis. `thrust` adds a force, `torque` adds a body-frame torque. Each has a first-order lag (`timeConstantMs`, default 15 ms) toward its commanded input `0..1` |
| **Sensor link** | Feeds one body's state into an existing *virtual sensor* component (IMU → `mpu6050`, position → `gps-neo6m`) through the standard `dispatchSensorUpdate` injection API — firmware written for the real part works unchanged |
| **Environment** | Gravity, constant wind, linear/angular drag, optional ground plane (`floorY`, `null` = open world) with restitution + contact damping |

Conventions: SI units; **X = east, Y = up, Z = north**; quaternions
`{x, y, z, w}` (w scalar); angular velocity and inertia are body-frame;
integrator is deterministic semi-implicit Euler on a fixed 1 ms substep
(`PhysicsWorld.step()` clamps to 50 ms per call — callers loop).

## Scene document

```jsonc
{
  "version": 1,
  "name": "X-quad prototype",
  "environment": {
    "gravity": { "x": 0, "y": -9.81, "z": 0 },   // m/s²
    "wind": { "x": 0, "y": 0, "z": 0 },          // m/s
    "linearDrag": 0,                              // N·s/m
    "angularDrag": 0,                             // N·m·s
    "floorY": 0,                                  // number or null (open world)
    "restitution": 0.1                            // 0..1
  },
  "bodies": [{
    "id": "craft",
    "label": "quad frame",
    "position": { "x": 0, "y": 0.2, "z": 0 },     // m
    "orientation": { "x": 0, "y": 0, "z": 0, "w": 1 },
    "velocity": { "x": 0, "y": 0, "z": 0 },       // m/s
    "angularVelocity": { "x": 0, "y": 0, "z": 0 },// rad/s (body frame)
    "mass": 0.45,                                 // kg
    "inertia": { "ix": 0.004, "iy": 0.004, "iz": 0.008 },  // kg·m²
    "shape": { "type": "box", "halfExtents": { "x": 0.18, "y": 0.03, "z": 0.18 } }
  }],
  "actuators": [
    { "id": "t1", "name": "front-left",  "bodyId": "craft", "kind": "thrust",
      "axis": { "x": 0, "y": 1, "z": 0 }, "maxForce": 6.0, "timeConstantMs": 15 },
    { "id": "t2", "bodyId": "craft", "kind": "thrust", "maxForce": 6.0 },
    { "id": "t3", "bodyId": "craft", "kind": "thrust", "maxForce": 6.0 },
    { "id": "t4", "bodyId": "craft", "kind": "thrust", "maxForce": 6.0,
      "inputPin": { "componentId": "esc1", "pin": "PWM" } }  // optional live binding
  ],
  "sensorLinks": [
    { "sensorId": "imu1", "bodyId": "craft", "kind": "imu" },
    { "sensorId": "gps1", "bodyId": "craft", "kind": "gps",
      "refLat": 12.87, "refLng": 74.84, "refAltitude": 20 }
  ]
}
```

Limits: 8 bodies, 16 actuators, 8 sensor links. All fields have defaults;
`parsePhysicsScene()` validates and returns human-readable errors (unknown
body references and duplicate ids are hard errors).

## API surface

- **Core** — `frontend/src/simulation/physics/`
  - `parsePhysicsScene(raw)` / `emptyPhysicsScene()` — spec validation
  - `PhysicsWorld(scene, { substepMs })` — `step(elapsedMs)`,
    `setActuatorInput(id, v)`, `scheduleActuatorInput(id, atMs, v)`,
    `getBodyState(id)`, `imuReading(id)`, `telemetry()`
  - `sensorLinkValues(links, sources)` — body state → virtual sensor values
- **Browser live layer**
  - `usePhysicsStore` (`frontend/src/store/usePhysicsStore.ts`) — scene,
    running flag, 10 Hz telemetry snapshot
  - `usePhysicsWorld()` (`frontend/src/hooks/usePhysicsWorld.ts`) — mounts the
    world, steps it on rAF, pushes sensor values via
    `dispatchSensorUpdate`, samples optional circuit→actuator bindings
    (a `readActuatorInput` callback reads PWM duty from the PinManager)
- **Headless runner** — `backend/app/mcp/physics_sim.cjs`, built from the same
  core by `node scripts/build-physics-core.mjs` →
  `backend/app/mcp/physics-core.cjs` (checked in so the backend runs without
  the frontend toolchain; rebuild after core changes).

  Protocol (stdin → stdout JSON, always exits 0 with a JSON body):

  ```jsonc
  // in
  { "scene": {…}, "duration_ms": 3000, "substep_ms": 1,
    "sample_every_ms": 100,
    "inputs": [ { "at_ms": 0, "actuator": "t1", "value": 1 } ],
    "checks": [ { "kind": "altitude", "body": "craft", "at_ms": 3000,
                  "target": 2, "tolerance": 0.1 } ] }
  // out
  { "ok": true, "simulated_ms": 3000, "sample_count": 30,
    "samples": [ { "t_ms": 0,
                   "bodies": { "craft": { "pos": [0,0.2,0], "vel": [0,0,0],
                                          "quat": [0,0,0,1], "angVel": [0,0,0] } },
                   "actuators": [ { "id": "t1", "input": 1, "state": 0, "output": 0 } ],
                   "checks": [ { "kind": "altitude", "ok": true,
                                 "actual": 2.001, "target": 2, "tolerance": 0.1 } ] } ],
    "checks": [ …all checks… ] }
  ```

## Agent + MCP tool access

| Surface | Tools |
|---------|-------|
| In-editor agent (`backend/app/agent/`) | `physics_capabilities` (research), `physics_simulate` (draft family — runs a candidate scene inline, never touches the workspace) |
| MCP server (`backend/app/mcp/`, stdio + SSE) | `physics_capabilities`, `physics_simulate` |

The agent loop mirrors the existing firmware flow: design a scene →
`physics_simulate` → read telemetry/checks → iterate → then wire the circuit
(boards, ESC pins, IMU) around the verified design and verify the firmware
with `draft_simulate` as usual.

## Closed loop (browser)

1. Scene + circuit coexist in one project.
2. `usePhysicsWorld` steps the world each frame.
3. Actuators with `inputPin` read live PWM duty from the circuit; scripted
   inputs (agent/UI) drive the rest.
4. Each telemetry tick, linked bodies push IMU/GPS values into the virtual
   sensor components — so an ESP32 sketch reading the MPU6050 over I2C sees
   motion driven by the physics.

## Example: quadrotor hover (verification, not a product feature)

A 450 g craft with four 6 N max thrusts hovers at input
`4·(0.45·9.81/4)/6 ≈ 0.736`. A headless check:

```jsonc
physics_simulate({
  "scene": { /* the document above */ },
  "duration_ms": 3000, "sample_every_ms": 200,
  "inputs": [
    { "at_ms": 0, "actuator": "t1", "value": 0.736 },
    { "at_ms": 0, "actuator": "t2", "value": 0.736 },
    { "at_ms": 0, "actuator": "t3", "value": 0.736 },
    { "at_ms": 0, "actuator": "t4", "value": 0.736 }
  ],
  "checks": [
    { "kind": "altitude", "body": "craft", "at_ms": 3000, "target": 0.2, "tolerance": 0.15 },
    { "kind": "velocity", "body": "craft", "at_ms": 3000, "target": [0,0,0], "tolerance": 0.1 }
  ]
})
```

## Limitations (by design)

- No contacts beyond the single ground plane (no body–body collision yet).
- Box contact uses the max half-extent as the support radius (coarse,
  vehicle-scale only).
- Drag is linear in relative velocity (no turbulence, no vortex model).
- Deterministic single-threaded integration — no chaos tolerance, no parallel
  scenes.

These are the documented next steps for a 3D renderer pass and richer
dynamics, not bugs.
