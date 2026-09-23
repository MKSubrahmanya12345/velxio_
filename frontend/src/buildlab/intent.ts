/**
 * Prompt → preset. This is a classifier, not a language model.
 * It only claims what the words support, and it leaves a trail of which
 * words fired so the dossier can show the assumption instead of hiding it.
 */

import { applyPreset, fcFromText, jurisdictionFromText } from './knowledge';
import type { Archetype, MachineConfig } from './types';

export interface ParsedIntent {
  archetype: Archetype;
  preset: string;
  /** Words that picked the preset. Empty means we assumed. */
  explicit: string[];
  assumed: boolean;
  jurisdiction: MachineConfig['jurisdiction'] | null;
  fc: MachineConfig['fc'] | null;
  massKg: number | null;
  payloadKg: number | null;
  cells: number | null;
  mah: number | null;
  inches: number | null;
  indoor: boolean;
  gopro: boolean;
  under250: boolean;
  rotors: 4 | 6 | 8 | null;
}

const PRESET_RULES: { preset: string; archetype: Archetype; re: RegExp; label: string }[] = [
  { preset: 'whoop', archetype: 'multirotor', re: /\b(whoop|tiny whoop|2\s?inch|2″|2")\b/i, label: 'whoop' },
  { preset: 'seven-lr', archetype: 'multirotor', re: /\b(7\s?inch|7″|7"|long[- ]range|cruiser)\b/i, label: '7-inch' },
  { preset: 'five-freestyle', archetype: 'multirotor', re: /\b(5\s?inch|5″|5"|freestyle|racing quad)\b/i, label: '5-inch' },
  { preset: 'arduino-450', archetype: 'multirotor', re: /\b(450\s?mm|q450|arduino|from scratch|nano)\b/i, label: 'arduino 450' },
  { preset: 'first-light', archetype: 'multirotor', re: /\b(3\s?inch|3″|toothpick|sub-?250|under 250|250\s?g)\b/i, label: 'light quad' },
  { preset: 'trainer-wing', archetype: 'wing', re: /\b(plane|airplane|fixed[- ]wing|glider|rc plane|wing)\b/i, label: 'wing' },
  { preset: 'boat', archetype: 'surface', re: /\b(boat|hull|kayak|usv)\b/i, label: 'boat' },
  { preset: 'rover', archetype: 'surface', re: /\b(rover|robot car|rc car|line follower|tank|wheels)\b/i, label: 'rover' },
  { preset: 'bench-arm', archetype: 'arm', re: /\b(robot arm|robotic arm|manipulator|servo arm)\b/i, label: 'arm' },
  { preset: 'weather-station', archetype: 'station', re: /\b(weather station|sensor node|solar node|iot node)\b/i, label: 'station' },
  { preset: 'catapult', archetype: 'ballistic', re: /\b(catapult|trebuchet)\b/i, label: 'catapult' },
  { preset: 'model-rocket', archetype: 'ballistic', re: /\b(rocket|missile)\b/i, label: 'rocket' },
  { preset: 'first-light', archetype: 'multirotor', re: /\b(drone|quad|quadrotor|quadcopter|multirotor|uav|fpv|copter)\b/i, label: 'drone' },
];

export function parseIntent(prompt: string): ParsedIntent {
  const text = prompt.trim();
  const hits = PRESET_RULES.filter((r) => r.re.test(text));
  // More specific presets are listed before the bare "drone" catch-all.
  const hit = hits[0];
  const explicit = hits.filter((h) => h.label !== 'drone').map((h) => h.label);
  const assumed = !hit || (hit.label === 'drone' && explicit.length === 0);

  const mass = readMass(text);
  const payload = readPayload(text);
  const cells = readCells(text);
  const mah = readMah(text);
  const inches = readInches(text);
  const rotors = /\b(octo|8\s?motors?)\b/i.test(text) ? 8
    : /\b(hex|hexa|6\s?motors?)\b/i.test(text) ? 6
    : /\b(quad|4\s?motors?)\b/i.test(text) ? 4
    : null;

  return {
    archetype: hit?.archetype ?? 'ballistic',
    preset: hit?.preset ?? 'generic-body',
    explicit,
    assumed: hit ? assumed : true,
    jurisdiction: jurisdictionFromText(text),
    fc: fcFromText(text),
    massKg: mass,
    payloadKg: payload,
    cells,
    mah,
    inches,
    indoor: /\b(indoor|inside|living room)\b/i.test(text),
    gopro: /\b(gopro|action cam|hero)\b/i.test(text),
    under250: /\b(sub-?250|under 250|250\s?g|nano drone)\b/i.test(text),
    rotors,
  };
}

function readMass(text: string): number | null {
  // Skip a mass that is clearly a payload — readPayload owns that.
  const m = text.match(/\b(\d+(?:\.\d+)?)\s*(kg|g)\b/i);
  if (!m) return null;
  if (/\b(payload|camera|gimbal|gopro)\b/i.test(text.slice(Math.max(0, (m.index ?? 0) - 16), (m.index ?? 0) + m[0].length + 16))) {
    return null;
  }
  const n = Number(m[1]);
  const kg = m[2].toLowerCase() === 'kg' ? n : n / 1000;
  if (kg <= 0 || kg > 500) return null;
  return kg;
}

function readPayload(text: string): number | null {
  const patterns = [
    /(\d+(?:\.\d+)?)\s*(kg|g)\s*(payload|camera|gimbal|gopro)/i,
    /(payload|camera|gimbal|gopro)[^\d]{0,16}(\d+(?:\.\d+)?)\s*(kg|g)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const num = m[1].match(/^\d/) ? Number(m[1]) : Number(m[2]);
    const unit = (m[1].match(/^\d/) ? m[2] : m[3]).toLowerCase();
    const kg = unit === 'kg' ? num : num / 1000;
    if (kg > 0 && kg < 50) return kg;
  }
  return null;
}

function readCells(text: string): number | null {
  const m = text.match(/\b([2-8])\s*s\b/i);
  return m ? Number(m[1]) : null;
}

function readMah(text: string): number | null {
  const m = text.match(/\b(\d{3,5})\s*mah\b/i);
  return m ? Number(m[1]) : null;
}

function readInches(text: string): number | null {
  const m = text.match(/\b(\d+(?:\.\d+)?)\s*(?:inch|inches)\b/i);
  return m ? Number(m[1]) : null;
}

/** A fresh machine from a prompt. Does not look at the active project. */
export function research(prompt: string): MachineConfig {
  const intent = parseIntent(prompt);
  const config = applyPreset(intent.preset, prompt.trim());
  applyExtracts(config, intent, true);
  if (!config.prompt) config.prompt = prompt.trim();
  return config;
}

/**
 * A follow-up on the active machine. A different archetype is a switch —
 * the caller archives. The same archetype amends, and words in the new
 * prompt override even confirmed fields, because the human just said them.
 */
export function revise(current: MachineConfig, prompt: string): {
  action: 'amend' | 'switch';
  config: MachineConfig;
  reason: string;
} {
  const intent = parseIntent(prompt);
  if (intent.archetype !== current.archetype && !intent.assumed) {
    const config = research(prompt);
    return {
      action: 'switch',
      config,
      reason: `“${prompt.trim()}” is a ${intent.archetype}, and the active project is a ${current.archetype}.`,
    };
  }
  // Bare "drone" while already on a drone does not reset the preset.
  const presetExplicit = intent.explicit.length > 0 && intent.archetype === current.archetype;
  const next: MachineConfig = presetExplicit
    ? applyPreset(intent.preset, current.prompt)
    : { ...current, confirmed: [...current.confirmed] };
  if (presetExplicit) {
    // Keep fields the human already confirmed, then let this sentence override.
    for (const id of current.confirmed) {
      const key = id as keyof MachineConfig;
      (next as unknown as Record<string, unknown>)[id] = current[key];
    }
    next.confirmed = [...current.confirmed];
    next.prompt = current.prompt;
    next.jurisdiction = current.jurisdiction;
  }
  applyExtracts(next, intent, false);
  next.prompt = rememberPrompt(current.prompt, prompt);
  return {
    action: 'amend',
    config: next,
    reason: presetExplicit
      ? `Preset moved to ${intent.preset}. Confirmed fields were kept unless this sentence named them.`
      : 'Same machine. Only the numbers this sentence named were changed.',
  };
}

function rememberPrompt(prior: string, said: string): string {
  const a = prior.trim();
  const b = said.trim();
  if (!b) return a;
  if (!a || a === b || a.endsWith(b)) return a || b;
  return `${a}\n${b}`;
}

function applyExtracts(config: MachineConfig, intent: ParsedIntent, initial: boolean): void {
  if (intent.jurisdiction) config.jurisdiction = intent.jurisdiction;
  if (intent.fc) config.fc = intent.fc;
  if (intent.rotors && config.archetype === 'multirotor') config.rotors = intent.rotors;
  if (intent.cells && (config.archetype === 'multirotor' || config.archetype === 'wing')) config.cells = intent.cells;
  if (intent.mah) config.mah = intent.mah;
  if (intent.inches && config.archetype === 'multirotor' && intent.preset === 'generic-body') {
    config.propDiameterM = intent.inches * 0.0254;
  }
  if (intent.under250 && config.archetype === 'multirotor') {
    config.massKg = Math.min(config.massKg, 0.249);
  }
  if (intent.massKg != null && intent.massKg < 80) {
    config.massKg = intent.massKg;
  }
  if (intent.payloadKg != null) {
    config.massKg += intent.payloadKg;
    config.payloadKg = intent.payloadKg;
  } else if (intent.gopro && config.archetype === 'multirotor') {
    config.massKg += 0.12;
    config.payloadKg = 0.12;
  }
  if (intent.indoor) {
    config.windMs = 0;
    if (config.archetype === 'multirotor') config.maxTiltDeg = Math.min(config.maxTiltDeg, 18);
  }
  if (initial && config.archetype === 'ballistic' && config.preset === 'generic-body') {
    config.name = 'Unclassified body';
  }
}
