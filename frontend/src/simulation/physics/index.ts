/**
 * physics — the generic physics/scene extension layer for the Velxio
 * simulator.
 *
 * A *scene* is a declarative document (bodies, actuators, sensor links,
 * environment) that a `PhysicsWorld` integrates deterministically. The same
 * core runs in three places:
 *
 *  - browser  — `usePhysicsWorld` hooks a live world into the circuit sim
 *               (PWM pins drive actuators, body state feeds virtual sensors)
 *  - headless — `backend/app/mcp/physics_sim.cjs` bundles this module and
 *               runs whole scenes from JSON (agent/MCP verification)
 *  - (later)  — a 3D renderer will draw `telemetry()` samples
 *
 * Nothing here knows about drones: a quadrotor is one body + four thrust
 * actuators in a scene document.
 */

export * from './math';
export * from './scene';
export * from './world';
export * from './sensors';
