import { create } from 'zustand';
import { parsePhysicsScene } from '../simulation/physics';
import type { PhysicsScene, WorldTelemetry } from '../simulation/physics';

/**
 * Live physics scene state for the browser simulator.
 *
 * `scene` is the parsed scene spec (the document agents/MCP tools speak);
 * `telemetry` is a throttled snapshot (10 Hz) of the running world for UI
 * surfaces. The world instance itself lives in a module-level ref (see
 * hooks/usePhysicsWorld.ts) so per-frame stepping never re-renders React.
 */
interface PhysicsStoreState {
  scene: PhysicsScene | null;
  running: boolean;
  telemetry: WorldTelemetry | null;
  /** Last parse error from setScene (for UI feedback); null when valid. */
  error: string | null;
  setScene: (raw: unknown) => boolean;
  setRunning: (running: boolean) => void;
  setTelemetry: (telemetry: WorldTelemetry) => void;
  clear: () => void;
}

export const usePhysicsStore = create<PhysicsStoreState>((set) => ({
  scene: null,
  running: false,
  telemetry: null,
  error: null,
  setScene: (raw) => {
    const { scene, errors } = parsePhysicsScene(raw);
    if (!scene) {
      set({ scene: null, running: false, telemetry: null, error: errors.join('; ') });
      return false;
    }
    set({ scene, error: null });
    return true;
  },
  setRunning: (running) => set({ running }),
  setTelemetry: (telemetry) => set({ telemetry }),
  clear: () => set({ scene: null, running: false, telemetry: null, error: null }),
}));

/** Non-reactive world holder shared by the hook and the circuit bridge. */
export const physicsWorldRef: { current: import('../simulation/physics').PhysicsWorld | null } = {
  current: null,
};
