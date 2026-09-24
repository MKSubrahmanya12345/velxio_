// Minimal type surface for the mobile chat app. Same shapes as WireGI/client
// src/types.ts — trimmed to what the "needs your eyes" chat actually renders,
// plus a loose `FlowEntry` for the live trace (never render raw `undefined`).

export interface ChatMsg {
  role: 'system' | 'user' | 'agent';
  content: string;
  ts?: string;
}

export interface Part {
  id: string;
  name: string;
  domain: string;
  status: string;
  verified?: boolean;
  humanCheckpoint?: boolean;
  openQuestions?: string[];
  humanInput?: Array<{ at: string; text: string; decision?: string }>;
  current?: {
    data?: { bomRow?: string; wiring?: string; config?: string; checklist?: string[] };
  } | null;
  error?: string | null;
  tier?: string | null;
  evidence?: Array<{ rung: string; at?: string; by?: string; detail?: string }>;
  updatedAt?: string;
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

/** Loose trace event — see client types for the full contract. */
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

/** Derives the same "needs your eyes" set the desktop chat shows. */
export function checkpointPartsOf(p: Project | null): Part[] {
  if (!p) return [];
  return (p.state.parts || []).filter(
    (x) =>
      !x.verified &&
      x.status !== 'failed' &&
      Boolean(x.current?.data) &&
      (x.humanCheckpoint || p.status === 'awaiting_human'),
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