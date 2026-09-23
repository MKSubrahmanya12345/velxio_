export interface Part {
  id: string;
  name: string;
  domain: string;
  status: string;
  idea?: any;
  current?: any;
  verified?: boolean;
  humanCheckpoint?: boolean;
  research?: string[];
  gathered?: Array<{ field: string; value: string; source: string }>;
  data?: { bomRow?: string; wiring?: string; config?: string; checklist?: string[] } | null;
  checklist?: string[];
  openQuestions?: string[];
  updatedAt?: string;
  attempts?: number; // Gap B: research passes run for this part
  error?: string | null; // set when status === 'failed'
  // Verification ladder: how each conclusion was reached (research → test → human)
  evidence?: Array<{ rung: string; at?: string; by?: string; detail?: string }>;
}

export interface ReconcileConflict {
  severity: 'blocking' | 'warning' | string;
  parts: string[];
  issue: string;
  resolution: string;
  patchesApplied?: string[];
}

export interface Reconciliation {
  at: string;
  skipped?: boolean;
  failed?: boolean;
  reason?: string;
  coupled?: boolean;
  source?: string;
  coherent?: boolean;
  summary?: string;
  conflicts?: ReconcileConflict[];
  patchesApplied?: number;
}

export interface Decision {
  label: string;
  at: string;
  source?: string;
  model?: string;
  note?: string; // why a decision degraded (e.g. live Jev timed out → LLM)
  answers?: any;
}

export interface ChatMsg {
  role: 'system' | 'user' | 'agent';
  content: string;
  ts?: string;
}

export interface Project {
  id: string;
  createdAt: string;
  updatedAt: string;
  goal: string;
  constraints: any;
  status: string;
  profileId?: string | null; // domain profile: electronics | software | mechanical | robotics
  profileLabel?: string | null;
  state: {
    idea: any;
    current: any;
    verified: any;
    parts: Part[];
    decisions: Decision[];
    researchLog: Array<{ part: string; web: { engine: string; count: number }; ts: string }>;
    reconciliations?: Reconciliation[]; // cross-part integration passes
    chat: ChatMsg[];
  };
}

export type StreamEvent =
  | { type: 'decision'; label: string; answers: any; source?: string }
  | { type: 'research'; stage: string; part: string; message: string; results?: any[] }
  | { type: 'project'; stage: string; projectId: string; parts: any[] }
  | {
      type: 'part';
      stage: string;
      partId: string;
      part: string;
      data?: any;
      humanCheckpoint?: boolean;
      error?: string;
      note?: string;
    }
  | { type: 'retry'; partId: string; part: string; attempt: number; retries: number; waitMs: number; message: string }
  | { type: 'batch'; stage: string; total: number; concurrency?: number; ok?: number; failed?: number; note?: string }
  | {
      type: 'reconcile';
      stage: string;
      reason?: string;
      total?: number;
      profile?: string;
      coherent?: boolean;
      conflicts?: number;
      blocking?: number;
      patchesApplied?: number;
      summary?: string;
      conflict?: ReconcileConflict;
    }
  | { type: 'chat'; role: string; content: string }
  | { type: 'done'; projectId: string; status: string; summary: string }
  | { type: 'result'; result: Project }
  | { type: 'error'; error: string };
