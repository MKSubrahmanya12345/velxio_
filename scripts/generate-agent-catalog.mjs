#!/usr/bin/env node
/**
 * Generate the agent's component catalog.
 *
 * THREE inputs, ONE output pair — so the model, the backend validator and the
 * browser all reason about exactly the same component set:
 *
 *   frontend/public/components-metadata.json   ids, tags, categories, properties
 *   scripts/agent-pins.json                    pin NAMES measured from the live
 *                                              elements (committed; the vitest
 *                                              drift test re-measures them)
 *   scripts/agent-part-rules.json              electrical/wiring semantics
 *
 * Outputs (byte-identical):
 *   backend/app/agent/catalog.json             runtime authority (validation,
 *                                              tools, MCP, docs)
 *   frontend/src/agent/catalog.json            browser-side schema + workspace
 *                                              scope (parts, editable props)
 *
 * Usage:
 *   node scripts/generate-agent-catalog.mjs            # write both files
 *   node scripts/generate-agent-catalog.mjs --check    # fail if they are stale
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const metadata = read('frontend/public/components-metadata.json');
const pinsDoc = read('scripts/agent-pins.json');
const rules = read('scripts/agent-part-rules.json');

/* ---------------------------------------------------------------- pin map - */

/** Resolve the pins of a part for a given property set (7segment digits=4 …). */
/** Every pin name the part can have, across all property-driven variants. */
export function allPinsFor(id) {
  const entry = pinsDoc.components[id];
  if (!entry) return [];
  const all = new Set(entry.pins ?? []);
  for (const variant of entry.variants ?? []) for (const pin of variant.pins ?? []) all.add(pin);
  return [...all];
}

export function pinsFor(id, properties = {}) {
  const entry = pinsDoc.components[id];
  if (!entry) return [];
  for (const variant of entry.variants ?? []) {
    const matches = Object.entries(variant.when).every(
      ([key, value]) => String(properties[key] ?? '') === String(value),
    );
    if (matches) return variant.pins;
  }
  return entry.pins;
}

/* ------------------------------------------------- live-simulation coverage - */

/**
 * Which parts the canvas can actually simulate today: a `PartSimulationRegistry`
 * registration (hand-written part behaviour) or a SPICE mapping (the electrical
 * solve). Measured from the sources rather than hand-maintained, and
 * `frontend/src/agent/__tests__/agent-catalog.test.ts` re-derives the same set
 * from the live modules, so a part that loses its simulation is caught.
 */
function simulatedPartIds() {
  const ids = new Set();
  const root_ = join(root, 'frontend/src/simulation');
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) files.push(full);
    }
  };
  walk(root_);
  const source = files.map((f) => [f, readFileSync(f, 'utf8')]);

  // Literal registrations: PartSimulationRegistry.register('id', …)
  for (const [, src] of source) {
    for (const m of src.matchAll(/PartSimulationRegistry\.register\(\s*'([^']+)'/g)) ids.add(m[1]);
  }

  // Loops that register a computed list (e.g. the e-paper panel variants):
  // resolve the list to the ids of an array / object-literal / Object.keys().
  const symbols = new Map(); // symbol name -> Set(ids)
  const alias = new Map();
  for (const [, src] of source) {
    for (const m of src.matchAll(/(?:export\s+)?const (\w+)[^=]*=\s*\{([\s\S]*?)\n\};/g)) {
      const set = symbols.get(m[1]) ?? new Set();
      for (const key of m[2].matchAll(/^\s*'([^']+)':/gm)) set.add(key[1]);
      symbols.set(m[1], set);
    }
    for (const m of src.matchAll(/(?:export\s+)?const (\w+)[^=]*=\s*\[([\s\S]*?)\n?\];/g)) {
      const set = symbols.get(m[1]) ?? new Set();
      for (const key of m[2].matchAll(/'([^']+)'/g)) set.add(key[1]);
      symbols.set(m[1], set);
    }
    for (const m of src.matchAll(/(?:export\s+)?const (\w+)[^=]*=\s*Object\.keys\((\w+)\)/g)) {
      alias.set(m[1], m[2]);
    }
  }
  const resolveSymbol = (name) => {
    if (alias.has(name)) return symbols.get(alias.get(name)) ?? new Set();
    return symbols.get(name) ?? new Set();
  };
  for (const [, src] of source) {
    for (const m of src.matchAll(/for \(const (\w+) of (\w+)\)[\s\S]{0,400}?PartSimulationRegistry\.register\(\s*\1\s*,/g)) {
      for (const id of resolveSymbol(m[2])) ids.add(id);
    }
  }

  // SPICE mappings: MAPPERS / PASSIVE_PRESETS / MAPPER_ALIASES keys + aliases.
  const spice = readFileSync(join(root, 'frontend/src/simulation/spice/componentToSpice.ts'), 'utf8');
  for (const block of [
    spice.match(/const MAPPERS: Record<string, Mapper> = \{([\s\S]*?)\n\};/),
    spice.match(/const PASSIVE_PRESETS[^=]*= \{([\s\S]*?)\n\};/),
    spice.match(/const MAPPER_ALIASES[^=]*= \{([\s\S]*?)\n\};/),
  ]) {
    for (const m of block ? block[1].matchAll(/^\s*'?([a-z0-9][a-z0-9_-]*)'?\s*:/gm) : []) ids.add(m[1]);
  }
  for (const m of spice.matchAll(/MAPPERS\['([^']+)'\]\s*=/g)) ids.add(m[1]);
  return ids;
}

/* ----------------------------------------------------------------- catalog - */

const specFor = (id) => {
  let spec = {};
  for (const family of rules.families) {
    if (new RegExp(family.match).test(id)) spec = { ...spec, ...family.spec };
  }
  return { ...spec, ...(rules.parts[id] ?? {}) };
};

/**
 * Expand `pinPatterns` (regex -> signal rule) against the part's real pins.
 *
 * A pattern that matches nothing is a typo that would silently disable a check,
 * so it warns instead of vanishing (the whole reason the generator refuses
 * unknown interaction names).
 */
const expandPinPatterns = (id, spec, pins) => {
  const signal = { ...(spec.signal ?? {}) };
  for (const pattern of spec.pinPatterns ?? []) {
    const re = new RegExp(pattern.match);
    const matched = pins.filter((pin) => re.test(pin));
    if (!matched.length) {
      console.warn(`⚠  ${id}: pinPatterns /${pattern.match}/ matches none of [${pins.join(', ')}]`);
      continue;
    }
    for (const pin of matched) {
      if (signal[pin]) continue; // an explicit signal rule wins
      signal[pin] = {
        cap: pattern.cap ?? 'any',
        dir: pattern.dir ?? 'bidir',
        ...(pattern.optional ? { optional: true } : {}),
        ...(pattern.severity ? { severity: pattern.severity } : {}),
      };
    }
  }
  return signal;
};

const simulated = simulatedPartIds();
const parts = {};

/** Board-family labels let the validator add the right core headers without
 * making ESP32-only APIs legal on AVR boards. The FQBN is the single source of
 * truth for this classification, so adding a board cannot silently fall back
 * to the Uno header set. */
const boardFamily = (board, key = '') => {
  const fqbn = String(board.fqbn ?? '').toLowerCase();
  if (String(key).startsWith('raspberry-pi-') && key !== 'raspberry-pi-pico') return 'python';
  if (fqbn.startsWith('esp32:')) return 'esp32';
  if (fqbn.startsWith('rp2040:')) return 'rp2040';
  if (fqbn.startsWith('python:')) return 'python';
  if (fqbn.startsWith('stmicroelectronics:')) return 'stm32';
  if (fqbn.startsWith('attinycore:') || fqbn.startsWith('attiny:')) return 'attiny';
  return 'arduino';
};
const unknownRules = Object.keys(rules.parts).filter(
  (id) => !metadata.components.some((c) => c.id === id),
);

for (const component of [...metadata.components].sort((a, b) => a.id.localeCompare(b.id))) {
  const id = component.id;
  const spec = specFor(id);
  // A component that is ALSO a supported board (id present in the `boards`
  // table) is a placeable MCU board, derived straight from the board data — no
  // per-part rule needed, and a new board added to `boards` + the component
  // metadata becomes placeable automatically. Its pins are the BOARD's pin
  // names (the ones the simulator wires to), not the art's element pins.
  const boardDef = rules.boards[id];
  const isBoardPart = Boolean(boardDef) && component.category === 'boards';
  const runtimeFor = new Set([
    ...(rules.runtimeProperties.global ?? []),
    ...(rules.runtimeProperties.parts?.[id] ?? []),
  ]);
  const editable = (component.properties ?? [])
    .map((p) => p.name)
    .filter((name) => !runtimeFor.has(name));
  // `rotation` is a canvas property (a CSS transform every element honours), not
  // part metadata, so it is added here rather than in components-metadata.json.
  if (!editable.includes('rotation')) editable.push('rotation');
  const resolvedPins = pinsFor(id, component.defaultValues ?? {});
  const signal = expandPinPatterns(id, spec, allPinsFor(id));
  const entry = {
    name: component.name,
    tag: component.tagName,
    category: component.category,
    class: spec.class ?? 'misc',
    pins: resolvedPins,
    ...(pinsDoc.components[id]?.variants ? { pinVariants: pinsDoc.components[id].variants } : {}),
    properties: editable,
    defaults: Object.fromEntries(
      // Per-part, like `properties`: a global name like `value` is live state on
      // an LED but a real setting on a resistor.
      Object.entries(component.defaultValues ?? {}).filter(([key]) => !runtimeFor.has(key)),
    ),
    placeable: spec.placeable !== false,
    sim: simulated.has(id),
    tags: component.tags ?? [],
    ...(component.description ? { description: component.description } : {}),
    ...(spec.why ? { why: spec.why } : {}),
    ...(spec.notes ? { notes: spec.notes } : {}),
    ...(spec.power ? { power: spec.power } : {}),
    ...(Object.keys(signal).length ? { signal } : {}),
    ...(spec.bus ? { bus: spec.bus } : {}),
    ...(spec.libraries ? { libraries: spec.libraries } : {}),
    ...(spec.powerOut ? { powerOut: spec.powerOut } : {}),
    ...(spec.sourcePins ? { sourcePins: spec.sourcePins } : {}),
    ...(spec.selfShortPairs ? { selfShortPairs: spec.selfShortPairs } : {}),
    ...(spec.internalPairs ? { internalPairs: spec.internalPairs } : {}),
    ...(spec.tracePairs ? { tracePairs: spec.tracePairs } : {}),
    ...(spec.seriesResistor ? { seriesResistor: spec.seriesResistor } : {}),
    ...(spec.gateResistor ? { gateResistor: spec.gateResistor } : {}),
    ...(spec.externalDriver ? { externalDriver: spec.externalDriver } : {}),
    ...(spec.addressProperty ? { addressProperty: spec.addressProperty } : {}),
    interactions: spec.interactions ?? [],
    ...(spec.stimulusKeys ? { stimulusKeys: spec.stimulusKeys } : {}),
    ...(spec.rotary ? { rotary: spec.rotary } : {}),
    ...(spec.potPins ? { potPins: spec.potPins } : {}),
  };
  // Adding a key to the rules file must never be a silent no-op: anything we
  // did not copy through is reported.
  const KNOWN_SPEC_KEYS = new Set([
    'class', 'placeable', 'why', 'notes', 'power', 'signal', 'pinPatterns', 'bus', 'libraries',
    'powerOut', 'sourcePins', 'selfShortPairs', 'internalPairs', 'tracePairs', 'seriesResistor',
    'gateResistor', 'externalDriver', 'addressProperty', 'interactions', 'stimulusKeys', 'rotary',
    'potPins',
  ]);
  for (const key of Object.keys(spec)) {
    if (!KNOWN_SPEC_KEYS.has(key))
      console.warn(`⚠  ${id}: rule key '${key}' is not part of the catalog vocabulary (ignored)`);
  }
  // A part that declares interactions must have them all declared in the rules —
  // an unknown interaction name would silently never run in the browser.
  const KNOWN = new Set(['press', 'pot', 'switch', 'stimulus', 'rotary']);
  const bad = entry.interactions.filter((k) => !KNOWN.has(k));
  if (bad.length) throw new Error(`${id}: unknown interaction(s) ${bad.join(', ')}`);
  if (entry.interactions.includes('stimulus') && !entry.stimulusKeys?.length)
    throw new Error(`${id}: declares a 'stimulus' interaction without stimulusKeys`);
  if (isBoardPart) {
    // Supported boards are always placeable — that is what being in the
    // `boards` table means for a component entry.
    entry.class = 'board';
    entry.placeable = true;
    entry.pins = [...boardDef.pins];
    delete entry.pinVariants;
    delete entry.why;
    // AVR boards emulate live in the browser, so a placed board of that
    // family is verifiable; other families keep the measured sim coverage.
    if (boardFamily(boardDef, id) === 'arduino') entry.sim = true;
    entry.notes =
      spec.notes ??
      `Place as an extra ${component.name}: an independent MCU board with its own pins, sketch group and simulation. Wire it pin-to-pin to the primary board or components; the first board stays the build target.`;
  }
  parts[id] = entry;
}

const catalog = {
  $comment:
    'GENERATED by scripts/generate-agent-catalog.mjs — do not edit by hand. ' +
    'Sources: frontend/public/components-metadata.json, scripts/agent-pins.json, ' +
    'scripts/agent-part-rules.json. backend and frontend copies must stay identical.',
  version: 2,
  boards: Object.fromEntries(
    Object.entries(rules.boards)
      .filter(([key]) => !key.startsWith('$'))
      .map(([key, board]) => [key, { ...board, family: boardFamily(board, key) }]),
  ),
  boardCoreHeaders: rules.boardCoreHeaders ?? {},
  boardCoreHeadersByBoard: rules.boardCoreHeadersByBoard ?? {},
  severity: rules.severity,
  // Properties the canvas owns at runtime (render/live state). Never sent to the
  // model, and a patch may not set them — the browser and the backend must agree
  // on this list, so it travels with the catalog instead of in two source files.
  runtimeProperties: rules.runtimeProperties,
  parts,
};

const targets = ['backend/app/agent/catalog.json', 'frontend/src/agent/catalog.json'];
const serialized = JSON.stringify(catalog, null, 1) + '\n';

if (unknownRules.length) {
  console.warn(`⚠  rules reference unknown component ids: ${unknownRules.join(', ')}`);
}

if (process.argv.includes('--check')) {
  let stale = false;
  for (const target of targets) {
    const current = readFileSync(join(root, target), 'utf8');
    if (current !== serialized) {
      console.error(`✗ ${target} is stale — run: node scripts/generate-agent-catalog.mjs`);
      stale = true;
    }
  }
  if (stale) process.exit(1);
  console.log(`✓ agent catalog is up to date (${Object.keys(parts).length} parts)`);
} else {
  for (const target of targets) writeFileSync(join(root, target), serialized);
  const placeable = Object.values(parts).filter((p) => p.placeable).length;
  console.log(
    `✓ agent catalog: ${Object.keys(parts).length} parts ` +
      `(${placeable} placeable, ${Object.values(parts).filter((p) => p.sim).length} simulatable) ` +
      `→ ${targets.join(', ')}`,
  );
}
