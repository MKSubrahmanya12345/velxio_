export interface PartMeta {
  provider?: string;
  providerLabel?: string;
  model?: string;
  latencyMs?: number;
  attempts?: number;
  switched?: boolean;
  llmMs?: number;
  totalMs?: number;
  webEngine?: string;
  webCount?: number;
  operation?: string;
}

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
  startedAt?: string | null;
  finishedAt?: string | null;
  attempts?: number;
  error?: string | null;
  errorDetail?: ErrorRecord | null;
  tier?: string | null;
  triageReason?: string | null;
  meta?: PartMeta | null;
  /** What the human said at the checkpoint (feeds the next research pass). */
  humanInput?: Array<{ at: string; text: string; decision?: string }>;
  /** Live-only: filled in from the stream while a run is in progress. */
  live?: boolean;
  /** Verification ladder: how each conclusion was reached (research → test → human) */
  evidence?: Array<{ rung: string; at?: string; by?: string; detail?: string }>;
}

export interface ErrorAttempt {
  provider?: string;
  model?: string;
  keyId?: string;
  status?: number | null;
  latencyMs?: number | null;
  message?: string;
}

export interface ErrorRecord {
  name?: string;
  message?: string;
  stack?: string;
  status?: number;
  provider?: string;
  keyId?: string;
  permanent?: boolean;
  where?: string;
  partId?: string;
  part?: string;
  cause?: ErrorRecord;
  attempts?: ErrorAttempt[];
  at?: string;
  runId?: string;
  recovered?: boolean;
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
  note?: string;
  answers?: any;
}

export interface ChatMsg {
  role: 'system' | 'user' | 'agent';
  content: string;
  ts?: string;
}

export interface RunRecord {
  id: string;
  kind: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  ms?: number;
  events?: number;
  note?: string;
  error?: string;
}

export interface Project {
  id: string;
  createdAt: string;
  updatedAt: string;
  goal: string;
  constraints: any;
  status: string;
  currentRunId?: string | null;
  profileId?: string | null;
  profileLabel?: string | null;
  state: {
    idea: any;
    current: any;
    verified: any;
    parts: Part[];
    decisions: Decision[];
    researchLog: Array<{ part: string; web: { engine: string; count: number }; ts: string; error?: string; meta?: PartMeta }>;
    reconciliations?: Reconciliation[];
    chat: ChatMsg[];
    runs?: RunRecord[];
    errors?: ErrorRecord[];
    runLog?: FlowEntry[];
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
}

/**
 * One trace event, as it arrives on the stream. Every field except `type` may be
 * missing on old events, so consumers must degrade gracefully — never render
 * `undefined`. `message` is guaranteed by the server, but the UI still guards.
 */
export interface FlowEntry {
  seq?: number;
  ts?: string;
  /** ms since the run started */
  t?: number;
  runId?: string;
  level?: 'debug' | 'info' | 'success' | 'warn' | 'error' | string;
  type: string;
  stage?: string;
  message?: string;
  partId?: string;
  part?: string;
  name?: string;
  phase?: string;
  ms?: number;
  attempt?: number;
  attempts?: number;
  retries?: number;
  waitMs?: number;
  tier?: string;
  action?: string;
  reason?: string;
  note?: string;
  source?: string;
  label?: string;
  answers?: any;
  provider?: string;
  providerLabel?: string;
  model?: string;
  keyId?: string;
  status?: any;
  latencyMs?: number;
  permanent?: boolean;
  providerMessage?: string;
  ok?: number;
  failed?: number;
  total?: number;
  humanCheckpoint?: boolean;
  decision?: string;
  concurrency?: number;
  coherent?: boolean;
  conflicts?: number;
  blocking?: number;
  patchesApplied?: number;
  summary?: string;
  conflict?: ReconcileConflict;
  error?: ErrorRecord | string;
  fatal?: boolean;
  where?: string;
  role?: string;
  content?: string;
  goal?: string;
  kind?: string;
  profileId?: string;
  profileLabel?: string;
  ladder?: string[];
  classification?: string;
  domains?: string[];
  counts?: { total: number; done: number; failed: number; needsHuman: number };
  parts?: Array<{ id: string; name: string; domain: string }>;
  data?: any;
  results?: Array<{ title: string; url: string; snippet?: string }>;
  text?: string;
  /** local receive time (client-side only) */
  receivedAt?: number;
  /** terminal payload of a create/message/resume request */
  result?: Project;
}

export interface EnvKeyInfo {
  key: string;
  group: string;
  secret?: boolean;
  present: boolean;
  source: string;
  value: string;
}

export interface EnvInfo {
  files: Array<{ role: string; path: string; relative: string; exists: boolean; keys: number; enabled?: boolean }>;
  inheritForge: boolean;
  keys: EnvKeyInfo[];
  llm: { configured: boolean; keys: string[]; missing: boolean };
  webSearch: { engine: string | null };
  jev: { configured: boolean };
}

export interface Health {
  ok: boolean;
  service: string;
  version?: string;
  ports?: { server?: number; client?: number };
  jev: string;
  providers: number;
  activeProvider?: string | null;
  webSearch?: string | null;
  env?: { files: EnvInfo['files']; inheritForge: boolean; llmConfigured: boolean; llmKeys: string[] };
  debug?: { enabled?: boolean; level?: string; runLogLimit?: number };
  time: string;
}

export interface DebugBundle {
  projectId: string;
  status: string;
  runs: RunRecord[];
  errors: ErrorRecord[];
  parts: Array<Partial<Part> & { id: string; name: string }>;
  runLog: FlowEntry[];
  env: EnvInfo | null;
  debug: { enabled?: boolean; level?: string };
  time: string;
}
