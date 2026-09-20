// @vitest-environment jsdom
/**
 * Pin-name drift guard for the agent catalog.
 *
 * `scripts/agent-pins.json` is a FROZEN measurement: it was taken once from the
 * live custom elements (`element.pinInfo`) and is now the pin vocabulary the
 * model writes wires in, the wire validator accepts, and the static analysis
 * reasons about. If an element renames or reorders a pin, every one of those
 * silently disagrees with the canvas — the model writes `led1.A` and the browser
 * drops the wire.
 *
 * So this test re-measures the elements and compares. It is the only place that
 * has both the DOM (jsdom) and the frozen file, and it must stay cheap: the
 * whole suite is skipped-with-a-report if an element refuses to instantiate,
 * but a *mismatch* always fails.
 *
 * Variants (`when` → pins) are measured too: a 7-segment's pin set depends on
 * `digits`, an LCD's on `pins`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Registers every custom element (upstream wokwi + velxio-local) without
// pulling in React or the stores — exactly what pin introspection needs.
import '../elements-register';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const frozen = JSON.parse(
  fs.readFileSync(path.join(root, 'scripts/agent-pins.json'), 'utf8'),
) as {
  components: Record<
    string,
    { tag: string; pins: string[]; variants?: Array<{ when: Record<string, string>; pins: string[] }> }
  >;
};
const metadata = JSON.parse(
  fs.readFileSync(path.join(root, 'frontend/public/components-metadata.json'), 'utf8'),
) as { components: Array<{ id: string; tagName: string }> };

beforeAll(() => {
  // The OLED elements build an ImageData-backed framebuffer in their
  // constructor; jsdom (correctly) has no canvas implementation.
  if (!('ImageData' in globalThis)) {
    (globalThis as unknown as { ImageData: unknown }).ImageData = class ImageData {
      data: Uint8ClampedArray;
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
        this.data = new Uint8ClampedArray(width * height * 4);
      }
    };
  }
});

/** Sorted, duplicate-free pin names: the canvas resolves positions, so the
 *  ORDER an element reports is not part of the contract — the NAMES are. */
const names = (pins: string[]): string[] => [...new Set(pins)].sort();

/** Pin names a live element reports, optionally with attributes applied. */
function measure(tag: string, attributes: Record<string, string> = {}): string[] | null {
  if (!customElements.get(tag)) return null;
  const element = document.createElement(tag) as HTMLElement & { pinInfo?: Array<{ name: string }> };
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  document.body.appendChild(element);
  const pins = Array.isArray(element.pinInfo) ? element.pinInfo.map((pin) => pin.name) : null;
  element.remove();
  return pins;
}

describe('frozen pin map vs the live custom elements', () => {
  it('measures every catalog tag, and agrees on the base pin set', () => {
    const unregistered: string[] = [];
    const mismatched: string[] = [];
    let measured = 0;
    for (const component of metadata.components) {
      const entry = frozen.components[component.id];
      expect(entry, `${component.id} missing from scripts/agent-pins.json`).toBeDefined();
      const pins = measure(entry.tag);
      if (pins === null || pins.length === 0) {
        unregistered.push(`${component.id} (${entry.tag})`);
        continue;
      }
      measured += 1;
      if (JSON.stringify(names(pins)) !== JSON.stringify(names(entry.pins))) {
        mismatched.push(`${component.id}: frozen=[${entry.pins.join(', ')}] live=[${pins.join(', ')}]`);
      }
    }
    expect(mismatched, 'pin names drifted — re-run scripts/agent-pins.json').toEqual([]);
    // Not a rubber stamp: if the element set stops loading, this catches it.
    // (The velxio-only parts — boards, breadboards, custom chips — have no
    // upstream element and are legitimately unmeasurable; everything else must
    // load, so the bar is "almost all of them".)
    expect(measured).toBeGreaterThan(80);
    if (unregistered.length) {
      console.log(`[agent-pins] no live element for: ${unregistered.join(', ')}`);
    }
  });

  it('agrees on every property-driven pin variant', () => {
    const mismatched: string[] = [];
    for (const [id, entry] of Object.entries(frozen.components)) {
      for (const variant of entry.variants ?? []) {
        const pins = measure(entry.tag, variant.when);
        if (pins === null || pins.length === 0) continue;
        if (JSON.stringify(names(pins)) !== JSON.stringify(names(variant.pins))) {
          mismatched.push(
            `${id} ${JSON.stringify(variant.when)}: frozen=[${variant.pins.join(', ')}] live=[${pins.join(', ')}]`,
          );
        }
      }
    }
    expect(mismatched).toEqual([]);
  });
});
