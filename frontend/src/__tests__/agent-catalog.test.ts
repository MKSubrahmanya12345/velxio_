/**
 * The agent catalog is GENERATED (scripts/generate-agent-catalog.mjs) from the
 * component metadata, the frozen pin map and the hand-written rules file. These
 * tests are the arbiter of the two claims the generator makes by *reading
 * source* rather than by running it:
 *
 *   sim   — every part the catalog claims the canvas can simulate really has a
 *           PartSimulationRegistry registration or a SPICE mapping;
 *   stimulus — the sensor keys the model may drive are the keys the browser's
 *           SensorControlPanel actually exposes (a key the panel does not know
 *           is a silently dead interaction).
 *
 * It also pins the twin-file invariant the whole design leans on: the browser
 * and the backend must load an identical catalog, because a part that exists on
 * one side only is a part that renders but cannot be validated (or vice versa).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import '../simulation/parts'; // side effect: registers every hand-written part
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import { PASSIVE_PRESETS, mappedMetadataIds } from '../simulation/spice/componentToSpice';
import { SENSOR_CONTROLS } from '../simulation/sensorControlConfig';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const catalog = JSON.parse(
  fs.readFileSync(path.join(root, 'frontend/src/agent/catalog.json'), 'utf8'),
) as {
  version: number;
  boards: Record<string, Record<string, unknown>>;
  boardCoreHeaders?: Record<string, string[]>;
  boardCoreHeadersByBoard?: Record<string, string[]>;
  severity: Record<string, string>;
  runtimeProperties: { global: string[]; parts: Record<string, string[]> };
  parts: Record<string, CatalogEntry>;
};
const frozenPins = JSON.parse(
  fs.readFileSync(path.join(root, 'scripts/agent-pins.json'), 'utf8'),
) as { components: Record<string, { tag: string; pins: string[]; variants?: Array<{ when: Record<string, string>; pins: string[] }> }> };

interface CatalogEntry {
  name: string;
  tag: string;
  category: string;
  class: string;
  pins: string[];
  pinVariants?: Array<{ when: Record<string, string>; pins: string[] }>;
  properties: string[];
  defaults: Record<string, unknown>;
  placeable: boolean;
  sim: boolean;
  interactions: string[];
  stimulusKeys?: string[];
  bus?: Array<{ type: string }>;
  libraries?: string[];
}

const entries = Object.entries(catalog.parts);

describe('agent catalog — generated from the live sources', () => {
  it('is the same file on both sides (browser and backend)', () => {
    const backend = fs.readFileSync(path.join(root, 'backend/app/agent/catalog.json'), 'utf8');
    const frontend = fs.readFileSync(path.join(root, 'frontend/src/agent/catalog.json'), 'utf8');
    expect(frontend).toBe(backend);
  });

  it('covers every component in components-metadata.json, and nothing else', () => {
    const metadata = JSON.parse(
      fs.readFileSync(path.join(root, 'frontend/public/components-metadata.json'), 'utf8'),
    ) as { components: Array<{ id: string; tagName: string }> };
    const metadataIds = metadata.components.map((c) => c.id).sort();
    expect(Object.keys(catalog.parts).sort()).toEqual(metadataIds);
    for (const component of metadata.components) {
      expect(catalog.parts[component.id].tag).toBe(component.tagName);
    }
  });

  it('claims exactly the simulation coverage the live registries provide', () => {
    const live = new Set<string>([
      ...PartSimulationRegistry.listRegisteredParts(),
      ...mappedMetadataIds(),
      ...Object.keys(PASSIVE_PRESETS),
    ]);
    const claimed = entries.filter(([, e]) => e.sim).map(([id]) => id).sort();
    const real = [...live].filter((id) => id in catalog.parts).sort();
    expect(claimed).toEqual(real);
    // A part the canvas can simulate must be placeable, otherwise the claim is
    // unreachable from the canvas.
    for (const [id, entry] of entries) {
      if (entry.sim) expect(entry.placeable, `${id} is simulatable but not placeable`).toBe(true);
    }
  });

  it('names only the pin names the frozen pin map measured', () => {
    for (const [id, entry] of entries) {
      const frozen = frozenPins.components[id];
      expect(frozen, `${id} missing from scripts/agent-pins.json`).toBeDefined();
      expect(entry.pins, `${id} pins drifted from scripts/agent-pins.json`).toEqual(frozen.pins);
      if (frozen.variants) {
        expect(entry.pinVariants ?? []).toEqual(frozen.variants);
      }
    }
  });

  it('never lets a runtime property be edited by a patch', () => {
    const runtime = new Set([
      ...catalog.runtimeProperties.global,
      ...Object.values(catalog.runtimeProperties.parts).flat(),
    ]);
    // `value` is live state on an LED but a real setting on a resistor, so the
    // per-part list is what matters; the global list must never leak into
    // `properties` at all.
    for (const id of catalog.runtimeProperties.global) {
      for (const [partId, entry] of entries) {
        expect(entry.properties, `${partId} exposes the runtime property ${id}`).not.toContain(id);
      }
    }
    expect([...runtime].length).toBeGreaterThan(0);
  });

  it('declares interactions the browser can actually run, with real stimulus keys', () => {
    const kinds = new Set(['press', 'pot', 'switch', 'rotary', 'stimulus']);
    const stimulusParts = entries.filter(([, e]) => e.interactions.includes('stimulus'));
    for (const [id, entry] of entries) {
      for (const kind of entry.interactions) {
        expect(kinds, `${id} declares an unknown interaction ${kind}`).toContain(kind);
      }
      if (entry.interactions.includes('stimulus')) {
        expect(entry.stimulusKeys?.length, `${id} stimulus without keys`).toBeGreaterThan(0);
      }
    }
    // The browser drives `stimulus` through SENSOR_CONTROLS: a stimulus part
    // must have a panel, and may only claim keys that panel exposes. Panels for
    // parts the agent drives through a PIN instead (the joystick's axes are
    // wired to analog pins, so `pot` is the honest primitive) still have to be
    // reachable, i.e. the part must declare some interaction.
    for (const [id, entry] of stimulusParts) {
      const config = SENSOR_CONTROLS[id as keyof typeof SENSOR_CONTROLS];
      expect(config, `${id} declares a stimulus but has no sensor panel`).toBeDefined();
      const exposed = new Set(config.controls.map((control) => control.key));
      for (const key of entry.stimulusKeys ?? []) {
        expect(exposed, `${id} claims stimulus '${key}' that its panel does not expose`).toContain(key);
      }
    }
    for (const id of Object.keys(SENSOR_CONTROLS)) {
      expect(catalog.parts[id], `sensor panel for unknown part ${id}`).toBeDefined();
      expect(catalog.parts[id].interactions.length, `${id} has a panel but no interaction`)
        .toBeGreaterThan(0);
    }
  });

  it('agrees with the board pinout the pin map measured, plus the GND alias', () => {
    const board = catalog.boards['arduino-uno'];
    const measured = frozenPins.components['arduino-uno'].pins;
    expect(board.pins).toEqual([...measured, 'GND']);
    expect(board.pwm).toEqual([3, 5, 6, 9, 10, 11]);
    expect(board.analog).toEqual(['A0', 'A1', 'A2', 'A3', 'A4', 'A5']);
    expect(board.i2c).toEqual({ SDA: 'A4', SCL: 'A5' });
  });

  it('binds the browser catalog to all 30 boards and scopes WiFi.h', () => {
    expect(Object.keys(catalog.boards)).toHaveLength(30);
    expect(catalog.boards['esp32']?.family).toBe('esp32');
    expect(catalog.boards['raspberry-pi-3']?.family).toBe('python');
    expect(catalog.boardCoreHeaders?.esp32).toContain('WiFi.h');
    expect(catalog.boardCoreHeaders?.default).not.toContain('WiFi.h');
    expect(catalog.boardCoreHeadersByBoard?.['pi-pico-w']).toContain('WiFi.h');
  });

  it('only allows headers a part in this catalog needs (or the AVR core)', () => {
    const fromParts = new Set(entries.flatMap(([, e]) => e.libraries ?? []));
    // The core ships with every arduino:avr install; anything else must come
    // from a part, which is what makes the allowed-header list self-maintaining.
    expect(fromParts.has('Servo.h')).toBe(true);
    expect(fromParts.has('Wire.h')).toBe(true);
    expect(fromParts.has('LiquidCrystal_I2C.h')).toBe(true);
  });
});
