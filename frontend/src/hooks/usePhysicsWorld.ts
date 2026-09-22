import { useEffect, useRef } from 'react';
import { usePhysicsStore, physicsWorldRef } from '../store/usePhysicsStore';
import {
  PhysicsWorld,
  sensorLinkValues,
  type PhysicsActuatorSpec,
} from '../simulation/physics';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';

const TELEMETRY_EVERY_MS = 100;

export interface ActuatorInputReader {
  /**
   * Read the live circuit value (0..1) driving an actuator bound to a pin
   * (e.g. the PWM duty on an ESC pin). Return null to fall back to the
   * scripted input. Provided by the caller that owns the PinManager.
   */
  (spec: PhysicsActuatorSpec): number | null;
}

/**
 * usePhysicsWorld — the live browser half of the physics scene layer.
 *
 * Owns a `PhysicsWorld` built from the store's scene, steps it on
 * requestAnimationFrame (fixed 1 ms substeps, ≤ 50 ms per frame), and on
 * each telemetry tick:
 *
 *  - publishes a `telemetry()` snapshot into the store (10 Hz, UI-safe)
 *  - pushes body-derived readings into the scene's virtual sensors through
 *    the existing `dispatchSensorUpdate` injection API, so firmware reading
 *    an MPU6050 over I2C (or a GPS over UART) sees values driven by the
 *    physics, not static stubs
 *  - samples `readActuatorInput` for actuators with an `inputPin` binding
 *
 * Mount it once, anywhere under the simulator (it is a no-op while the
 * store has no scene or the sim is paused).
 */
export function usePhysicsWorld(readActuatorInput?: ActuatorInputReader): void {
  const scene = usePhysicsStore((s) => s.scene);
  const running = usePhysicsStore((s) => s.running);
  const setTelemetry = usePhysicsStore((s) => s.setTelemetry);
  const readerRef = useRef(readActuatorInput);
  readerRef.current = readActuatorInput;

  // Rebuild the world whenever the scene document changes.
  useEffect(() => {
    if (!scene) {
      physicsWorldRef.current = null;
      return;
    }
    physicsWorldRef.current = new PhysicsWorld(scene);
    return () => {
      physicsWorldRef.current = null;
    };
  }, [scene]);

  // Step loop + telemetry/sensor ticks.
  useEffect(() => {
    if (!running || !scene) return;
    let raf = 0;
    let last = performance.now();
    let lastTick = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const world = physicsWorldRef.current;
      if (!world) return;
      world.step(now - last);
      last = now;

      // Live circuit → actuator bindings (PWM pins driving thrusters).
      const reader = readerRef.current;
      if (reader) {
        for (const actuator of world.scene.actuators) {
          if (!actuator.inputPin) continue;
          const value = reader(actuator);
          if (value !== null) world.setActuatorInput(actuator.id, value);
        }
      }

      if (now - lastTick < TELEMETRY_EVERY_MS) return;
      lastTick = now;
      const tel = world.telemetry();
      setTelemetry(tel);

      // Physics → virtual sensors (IMU / GPS) via the standard injection API.
      if (scene.sensorLinks.length > 0) {
        const values = sensorLinkValues(
          scene.sensorLinks,
          {
            imu: (bodyId) => world.imuReading(bodyId),
            state: (bodyId) => {
              const b = world.getBodyState(bodyId);
              return b ? { position: b.position, velocity: b.velocity } : null;
            },
          },
        );
        for (const [sensorId, valuesForSensor] of Object.entries(values)) {
          dispatchSensorUpdate(sensorId, valuesForSensor as Record<string, number>);
        }
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [running, scene, setTelemetry]);
}
