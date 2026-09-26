/**
 * Agent reveal — the "watch the agent work" playback layer.
 *
 * After the agent's checkpoint has been applied in FULL (loadWorkspace), the
 * newly added parts, wires and files are revealed one by one: parts drop
 * onto the canvas, wires draw themselves pin-to-pin, and the code types out
 * in the editor. This is PURELY COSMETIC — the stores always hold the
 * complete, verified project, so the simulator, the journal, pre-flight and
 * the freshness guards never see a half-built state. Every reveal is a CSS
 * class + delay plus a typing overlay, and it can be skipped (button, any
 * canvas interaction, prefers-reduced-motion).
 */
import { create } from 'zustand';
import { scopeKey, type Snapshot } from './workspace';

export interface RevealFile {
  name: string;
  content: string;
  /** How long the typing overlay takes for this file (ms). */
  ms: number;
}

const PART_STAGGER_MAX = 300;
const PART_WINDOW_MS = 4500;
const PART_IN_MS = 460;
const WIRE_STAGGER_MAX = 240;
const WIRE_WINDOW_MS = 6000;
const WIRE_IN_MS = 620;
const BOARD_IN_MS = 650;
const FILE_MS_PER_CHAR = 9;
const FILE_MS_MIN = 900;
const FILE_MS_MAX = 4200;
const FILE_GAP_MS = 250;
const HARD_CAP_MS = 14000;

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

// ── Live typing (while the model is still generating) ─────────────────────

/** Files the live typing already streamed this run, so the post-result
 *  reveal does not re-type them. Consumed by beginAgentReveal. */
const liveTypedNames = new Set<string>();

interface AgentLiveTypeState {
  active: boolean;
  /** name -> content so far (the server sends the full prefix each beat). */
  files: Record<string, string>;
  /** Server update order (its dict order = the model's write order). */
  order: string[];
  begin: (files: Record<string, string>) => void;
  end: () => void;
}

export const useAgentLiveType = create<AgentLiveTypeState>((set) => ({
  active: false,
  files: {},
  order: [],
  begin: (files) =>
    set({ active: true, files: { ...files }, order: Object.keys(files) }),
  end: () => {
    for (const name of Object.keys(useAgentLiveType.getState().files)) {
      liveTypedNames.add(name);
    }
    set({ active: false, files: {}, order: [] });
  },
}));

interface AgentRevealState {
  active: boolean;
  scope: string | null;
  /** Board to fade in, when this run created the first board. */
  boardId: string | null;
  /** New component id -> animation delay (ms). Absent id = no animation. */
  partDelays: Record<string, number>;
  /** New wire id -> animation delay (ms). */
  wireDelays: Record<string, number>;
  /** Files to type out, in order. */
  files: RevealFile[];
  /** Files the typing overlay has finished. */
  typed: Record<string, boolean>;
  totalMs: number;
  skip: () => void;
  markTyped: (name: string) => void;
}

// One reveal at a time; `currentDone` is the single settlement point that
// every path (timeline end, skip, scope change) funnels through.
let currentDone: (() => void) | null = null;
let currentTimer: number | undefined;

export const useAgentReveal = create<AgentRevealState>((set) => ({
  active: false,
  scope: null,
  boardId: null,
  partDelays: {},
  wireDelays: {},
  files: [],
  typed: {},
  totalMs: 0,

  skip: () => {
    currentDone?.();
  },

  markTyped: (name: string) => {
    set((state) => (state.typed[name] ? {} : { typed: { ...state.typed, [name]: true } }));
  },
}));

function finishNow() {
  window.clearTimeout(currentTimer);
  currentTimer = undefined;
  const done = currentDone;
  currentDone = null;
  useAgentReveal.setState({
    active: false,
    boardId: null,
    partDelays: {},
    wireDelays: {},
    files: [],
    typed: {},
    totalMs: 0,
  });
  done?.();
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  } catch {
    return false;
  }
}

/**
 * Play back an applied checkpoint. Resolves when the playback is over (or
 * was skipped); resolving never mutates the workspace.
 */
export function beginAgentReveal(before: Snapshot, after: Snapshot): Promise<void> {
  // Tests drive runAgent with fake timers and bounded advancement; a reveal
  // would pin `await reveal` to a timer the test never advances. The
  // playback is cosmetic — skip it entirely under the test runner.
  if (import.meta.env.VITEST) {
    finishNow();
    return Promise.resolve();
  }

  // A fresh reveal cancels the previous one.
  finishNow();

  const scope = scopeKey();
  const oldPartIds = new Set(before.components.map((c) => c.id));
  const oldWireIds = new Set(before.wires.map((w) => w.id));
  const newParts = after.components.filter((c) => !oldPartIds.has(c.id));
  const newWires = after.wires.filter((w) => !oldWireIds.has(w.id));

  const boardId =
    before.boards.length === 0 && after.boards.length > 0 ? (after.boards[0]?.id ?? null) : null;

  const beforeGroup = before.boards[0]?.activeFileGroupId;
  const beforeFiles = new Map<string, string>(
    (beforeGroup ? before.fileGroups[beforeGroup] ?? [] : [])
      .map((f) => [f.name, f.content] as const),
  );
  const afterGroup = after.boards[0]?.activeFileGroupId;
  const afterFiles: { name: string; content: string }[] =
    afterGroup ? (after.fileGroups[afterGroup] ?? []) : [];
  // The live typing already streamed these files in front of the user while
  // the model generated — replaying them would be a re-run, not a reveal.
  const changedFiles = afterFiles.filter(
    (f) => beforeFiles.get(f.name) !== f.content && !liveTypedNames.has(f.name),
  );
  liveTypedNames.clear();

  if (
    reducedMotion() ||
    (newParts.length === 0 && newWires.length === 0 && changedFiles.length === 0 && !boardId)
  ) {
    return Promise.resolve();
  }

  // ── Timeline ─────────────────────────────────────────────────────────
  let t = 0;
  if (boardId) t += BOARD_IN_MS;

  const n = newParts.length;
  const partStagger = n ? Math.min(PART_STAGGER_MAX, PART_WINDOW_MS / n) : 0;
  const partDelays: Record<string, number> = {};
  newParts.forEach((c, i) => {
    partDelays[c.id] = Math.round(t + i * partStagger);
  });
  if (n) t += (n - 1) * partStagger + PART_IN_MS;

  const m = newWires.length;
  const wireStagger = m ? Math.min(WIRE_STAGGER_MAX, WIRE_WINDOW_MS / m) : 0;
  const wireDelays: Record<string, number> = {};
  newWires.forEach((w, i) => {
    wireDelays[w.id] = Math.round(t + i * wireStagger);
  });
  if (m) t += (m - 1) * wireStagger + WIRE_IN_MS;

  const canvasMs = t;
  let fileScale = 1;
  const rawFileMs = changedFiles.map((f) =>
    clamp(f.content.length * FILE_MS_PER_CHAR, FILE_MS_MIN, FILE_MS_MAX),
  );
  const rawFilesTotal = rawFileMs.reduce((a, b) => a + b, 0) + changedFiles.length * FILE_GAP_MS;
  if (canvasMs + rawFilesTotal > HARD_CAP_MS) {
    fileScale = Math.max(0.35, (HARD_CAP_MS - canvasMs) / Math.max(1, rawFilesTotal));
  }
  const files: RevealFile[] = changedFiles.map((f, i) => ({
    name: f.name,
    content: f.content,
    ms: Math.round(rawFileMs[i] * fileScale),
  }));
  const totalMs = Math.min(
    HARD_CAP_MS,
    canvasMs + files.reduce((a, f) => a + f.ms + FILE_GAP_MS, 0) + 250,
  );

  let settled = false;
  let resolve: (() => void) | null = null;
  const done = () => {
    if (settled) return;
    settled = true;
    finishNow();
    resolve?.();
  };
  currentDone = done;
  currentTimer = window.setTimeout(done, totalMs);

  useAgentReveal.setState({
    active: true,
    scope,
    boardId,
    partDelays,
    wireDelays,
    files,
    typed: {},
    totalMs,
  });

  return new Promise<void>((r) => {
    resolve = r;
  });
}
