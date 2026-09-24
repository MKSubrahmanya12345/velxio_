/**
 * Board-kind parity guard: the browser's agent protocol must accept exactly
 * what the backend Board model accepts.
 *
 * Regression: projectSchema used a strict `hasOwnProperty(catalog.boards)`
 * check, so short aliases the backend normalizes (`uno` → `arduino-uno`,
 * `pico-w` → `pi-pico-w`, …) were rejected in the browser with
 * `Unsupported board kind` at path `project.board.boardKind` — before the
 * workspace conversion (which already normalized) ever ran.
 */
import { describe, expect, it } from 'vitest';
import { projectSchema } from '../agent/protocol';
import { catalog, normalizeBoardKind } from '../agent/catalog';

const base = { components: [], wires: [], files: [] };
const board = (boardKind: string) => ({ ...base, board: { id: 'b1', boardKind, x: 0, y: 0 } });

describe('agent boardKind aliases', () => {
  it('accepts every canonical catalog id unchanged', () => {
    for (const kind of Object.keys(catalog.boards)) {
      const parsed = projectSchema.safeParse(board(kind));
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.board?.boardKind).toBe(kind);
    }
  });

  it('accepts backend short aliases and canonicalizes them', () => {
    for (const [alias, canonical] of [
      ['uno', 'arduino-uno'],
      ['uno-r3', 'arduino-uno'],
      ['arduino-uno-r3', 'arduino-uno'],
      ['arduino uno', 'arduino-uno'],
      ['nano', 'arduino-nano'],
      ['arduino nano', 'arduino-nano'],
      ['mega', 'arduino-mega'],
      ['mega2560', 'arduino-mega'],
      ['mega-2560', 'arduino-mega'],
      ['arduino-mega-2560', 'arduino-mega'],
      ['arduino mega', 'arduino-mega'],
      ['esp32dev', 'esp32'],
      ['esp32devkit', 'esp32'],
      ['esp32-devkit', 'esp32'],
      ['esp32-devkit-v1', 'esp32'],
      ['esp32-wroom', 'esp32'],
      ['esp32-wroom-32', 'esp32'],
      ['lolin32', 'wemos-lolin32-lite'],
      ['pico', 'raspberry-pi-pico'],
      ['pi-pico', 'raspberry-pi-pico'],
      ['rpipico', 'raspberry-pi-pico'],
      ['rp2040', 'raspberry-pi-pico'],
      ['picow', 'pi-pico-w'],
      ['pico-w', 'pi-pico-w'],
      ['rpipicow', 'pi-pico-w'],
      ['raspberry-pi-pico-w', 'pi-pico-w'],
      ['nano-esp32', 'arduino-nano-esp32'],
      ['xiao-s3', 'xiao-esp32-s3'],
      ['esp32-s3-devkit', 'esp32-s3'],
      ['xiao-c3', 'xiao-esp32-c3'],
      ['esp32-c3-devkit', 'esp32-c3'],
      ['supermini', 'aitewinrobot-esp32c3-supermini'],
      ['bluepill', 'stm32-bluepill'],
      ['blackpill', 'stm32-blackpill'],
      ['attiny', 'attiny85'],
    ] as const) {
      expect(normalizeBoardKind(alias)).toBe(canonical);
      const parsed = projectSchema.safeParse(board(alias));
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.board?.boardKind).toBe(canonical);
    }
  });

  it('is case-insensitive and whitespace-tolerant like the backend', () => {
    for (const [input, canonical] of [
      ['  PICO-W  ', 'pi-pico-w'],
      ['ESP32', 'esp32'],
      ['Arduino-Uno', 'arduino-uno'],
      ['PI-PICO-W', 'pi-pico-w'],
      ['arduino_uno', 'arduino-uno'],
      ['ARDUINO_MEGA_2560', 'arduino-mega'],
      ['BluePill', 'stm32-bluepill'],
    ] as const) {
      const parsed = projectSchema.safeParse(board(input));
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.board?.boardKind).toBe(canonical);
    }
  });

  it('still allows an omitted boardKind (inferred from id downstream)', () => {
    const parsed = projectSchema.safeParse({ ...base, board: { id: 'b1', x: 0, y: 0 } });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.board?.boardKind).toBeUndefined();
  });

  it('still rejects unknown kinds, naming the offending value', () => {
    const parsed = projectSchema.safeParse(board('not-a-velxio-board'));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].code).toBe('custom');
      expect(parsed.error.issues[0].path).toEqual(['board', 'boardKind']);
      expect(parsed.error.issues[0].message).toContain('not-a-velxio-board');
    }
  });
});
