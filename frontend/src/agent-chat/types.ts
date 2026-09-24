// WireGI chat types for the Velxio integration — same shapes as
// WireGI/mobile/src/lib/types.ts, plus the simulator state the agent now
// produces. Kept local so the Velxio build never imports from WireGI's app
// trees.

export interface ChatMsg {
  role: 'system' | 'user' | 'agent';
  content: string;
  ts?: string;
}

export interface Conflict {
  severity: 'blocking' | 'warning';
  parts?: string[];
  issue: string;
  resolution?: string;
  patchesApplied?: string[];
}

export interface Reconciliation {
  at: string;
  skipped?: boolean;
  failed?: boolean;
  reason?: string;
  coherent?: boolean;
  summary?: string;
  conflicts?: Conflict[];
  patchesApplied?: number;
}

export interface Part {
  id: string;
  name: string;
  domain: string;
  status: string;
  verified?: boolean;
  humanCheckpoint?: boolean;
  /** Needs an ANSWER, not approval — the agent's own data was insufficient. */
  needsInput?: boolean;
  openQuestions?: string[];
  humanInput?: Array<{ at: string; text: string; decision?: string }>;
  current?: {
    data?: { bomRow?: string; wiring?: string; config?: string; checklist?: string[] };
    gathered?: Array<{ field: string; value: string }>;
    understand?: { validation?: string[]; openQuestions?: string[]; conflicts?: string[] };
  } | null;
  checklist?: string[];
  data?: { bomRow?: string; wiring?: string; config?: string } | null;
  error?: string | null;
  tier?: string | null;
  evidence?: Array<{ rung: string; at?: string; by?: string; detail?: string }>;
  updatedAt?: string;
}

/** The simulation rung: what the agent built in the Velxio simulator. */
export interface SimState {
  status: 'simulated' | 'partial' | 'failed' | 'skipped';
  rounds?: number;
  verified?: string[];
  summary?: string;
  instructions?: string;
  checks?: string[];
  toolLog?: Array<{ tool: string; ok: boolean; ms: number; at: string }>;
  circuit?: unknown;
  files?: Array<{ name: string; content: string }>;
  ms?: number;
  at?: string;
  reason?: string;
}

export interface Project {
  id: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  currentRunId?: string | null;
  profileLabel?: string | null;
  state: {
    chat: ChatMsg[];
    parts: Part[];
    sim?: SimState | null;
    reconciliations?: Reconciliation[];
    runs?: unknown[];
    errors?: unknown[];
  };
}

export interface ProjectSummary {
  id: string;
  goal: string;
  status: string;
  profileLabel?: string | null;
  createdAt: string;
  updatedAt: string;
  parts: number;
  failed: number;
  runs: number;
  errors: number;
  needsYou: number;
  lastMessagePreview?: string;
  lastMessageRole?: string | null;
  lastMessageAt?: string | null;
}

/** Loose trace event from the ndjson stream. */
export interface FlowEntry {
  seq?: number;
  t?: number;
  ts?: string;
  runId?: string;
  level?: string;
  type: string;
  stage?: string;
  message?: string;
  partId?: string;
  part?: string;
  tool?: string;
  ok?: boolean;
  status?: string;
  error?: { name?: string; message?: string; where?: string } | string;
  fatal?: boolean;
  result?: Project;
  [k: string]: unknown;
}

export interface Health {
  ok: boolean;
  service: string;
  providers: number;
  activeProvider?: string | null;
  time: string;
}

export type HumanDecision = 'approve' | 'provide' | 'rerun' | 'reject';

/** Derives the "needs you" set the chat shows. */
export function checkpointPartsOf(p: Project | null): Part[] {
  if (!p) return [];
  return (p.state.parts || []).filter(
    (x) =>
      !x.verified &&
      x.status !== 'failed' &&
      Boolean(x.current?.data) &&
      (x.humanCheckpoint || x.needsInput || p.status === 'awaiting_human'),
  );
}

export const STATUS_LABEL: Record<string, string> = {
  init: 'no run yet',
  researching: 'working',
  awaiting_human: 'needs your eyes',
  partial: 'partial',
  complete: 'complete',
  failed: 'failed',
};

export function statusLabel(s: string): string {
  return STATUS_LABEL[s] || s;
}
