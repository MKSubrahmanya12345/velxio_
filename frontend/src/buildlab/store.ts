/**
 * One active machine. The tab is the project — there is no account and no
 * second draft hiding behind this one.
 */

import { research } from './intent';
import type { MachineConfig } from './types';

export const BUILD_LAB_KEY = 'velxio.buildlab.v1';

export function loadProject(): MachineConfig | null {
  try {
    const raw = localStorage.getItem(BUILD_LAB_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { version?: number; config?: Partial<MachineConfig> };
    const saved = parsed.config;
    if (parsed.version !== 1 || !saved || typeof saved.archetype !== 'string') return null;
    const prompt = typeof saved.prompt === 'string' ? saved.prompt : '';
    const base = research(prompt || 'a machine');
    return {
      ...base,
      ...saved,
      prompt: prompt || base.prompt,
      confirmed: Array.isArray(saved.confirmed)
        ? saved.confirmed.filter((id): id is string => typeof id === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

export function saveProject(config: MachineConfig): void {
  try {
    localStorage.setItem(BUILD_LAB_KEY, JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      config,
    }));
  } catch {
    /* private mode, or a full disk — the tab still flies */
  }
}

export function clearProject(): void {
  try {
    localStorage.removeItem(BUILD_LAB_KEY);
  } catch {
    /* ignore */
  }
}
