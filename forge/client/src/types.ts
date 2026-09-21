// Forge client — chat-first types

export interface SafetyFlag {
  hazard: string;
  severity: 'info' | 'warn' | 'high';
  note?: string;
  present?: boolean;
  probability?: number;
}

export interface Step {
  id: string;
  title: string;
  track: 'sim' | 'physical';
  instructions: string;
  materials: string[];
  tools: string[];
  safety: SafetyFlag[];
  definition_of_done: string[];
  skills: string[];
  status: 'todo' | 'doing' | 'done';
  failed: number;
  sim: unknown;
}

export interface Phase {
  id: string;
  name: string;
  steps: Step[];
}

export interface BomItem {
  id: string;
  name: string;
  qty: number;
  cost_usd: number;
  spec?: string;
  status: string;
}

export interface LogEntry {
  at: string;
  kind: 'user' | 'system' | 'jev' | 'plan' | 'ai';
  text: string;
}

export interface Decision {
  id: string;
  name: string;
  kind: string;
  summary: string;
  confidence: number;
  detail: Record<string, unknown>;
}

export interface HumanToolCall {
  id: string;
  name: 'human';
  status: 'requires_action' | 'completed' | 'failed';
  at: string;
  arguments: {
    task: string;
    instructions: string;
    materials: string[];
    tools: string[];
    safety: SafetyFlag[];
    definition_of_done: string[];
    track: string;
    phase: string;
    stepId: string;
    reason?: string;
    attempt?: number;
  };
  result?: string | null;
  completedAt?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  at: string;
  decisions?: Decision[];
  toolCalls?: HumanToolCall[];
  toolCallId?: string | null;
  plan?: ProjectState | null;
  meta?: Record<string, unknown>;
}

export interface ProjectState {
  goal: string;
  constraints: { budget_usd: number | null; time: string; skill: string; notes: string };
  feasibility: { category: string; buildability: string; risk_tier: string; complexity: number };
  status: 'planning' | 'active' | 'paused' | 'complete' | 'aborted';
  phases: Phase[];
  current: { phaseId: string | null; stepId: string | null };
  inventory: { id: string; name: string; note?: string }[];
  bom: BomItem[];
  acceptance: string[];
  log: LogEntry[];
  skill: Record<string, { successes: number; fails: number }>;
  safetyAcks: Record<string, boolean>;
  safetyGate: { stepId: string; flags: SafetyFlag[]; ackRequired?: boolean } | null;
  counters: { messages: number; jevCalls: number; escalations: number; stepsCompleted: number; substitutions: number; humanCalls?: number };
  confidence: Record<string, number>;
  proposal: any | null;
}

export interface Conversation {
  memory?: ProjectMemory;
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  messages: ChatMessage[];
  projectState: ProjectState | null;
  pendingHumanTools: HumanToolCall[];
  counters: { messages: number; jevCalls: number; humanCalls: number; plans: number };
  // backward compat alias
  state?: ProjectState | null;
}

export interface Project {
  id: string;
  createdAt: string;
  updatedAt: string;
  state: ProjectState;
}

export interface ResponsePayload {
  text: string;
  suggestions?: string[];
  safety?: boolean;
}

export interface MessageResult {
  conversation: Conversation;
  response: ChatMessage;
  decisions: Decision[];
  // legacy
  project?: Project;
}

export interface CreateResult {
  conversation: Conversation;
  response: ChatMessage;
  decisions: Decision[];
  project?: Project;
}

export interface Health {
  ok: boolean;
  service: string;
  time: string;
  providers: { jev: string; planner: string; store: string };
  mode?: string;
  activeProvider?: { id: string; provider: string; note: string; model: string; origin: string } | null;
  failover?: { enabled: boolean; maxRounds: number; retryRejected: boolean; keys: number; configured: boolean } | null;
}

// ── Providers page ──────────────────────────────────────────────────────────
export type ProviderId = 'gemini' | 'openrouter' | 'bedrock' | 'ollama' | 'openai';

export interface ProviderCatalogEntry {
  id: ProviderId;
  label: string;
  short: string;
  credentialLabel: string;
  credentialPlaceholder: string;
  requiresKey: boolean;
  extraCredentials: { field: string; label: string; required: boolean; placeholder: string }[];
  defaultModel: string;
  modelPlaceholder: string;
  defaultBase: string;
  baseLabel: string;
  docs: string;
}

export interface ProviderKeyStats {
  calls: number;
  ok: number;
  failures: number;
  consecutiveFailures: number;
  lastStatus: number | null;
  lastError: string;
  lastErrorAt: string | null;
  lastUsedAt: string | null;
  lastLatencyMs: number | null;
}

// Keys are stored and served exactly as typed: `apiKey` is plain text and the
// UI renders it plainly (never masked) next to its note.
export interface ProviderKey {
  id: string;
  provider: ProviderId;
  providerLabel: string;
  note: string;
  apiKey: string;
  secret: string;
  sessionToken: string;
  region: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  origin: 'user' | 'env';
  createdAt: string;
  updatedAt: string;
  stats: ProviderKeyStats;
}

export interface FailoverSettings {
  enabled: boolean;
  maxRounds: number;
  retryRejected: boolean;
}

export interface ProviderAttempt {
  at: string;
  keyId: string;
  provider: ProviderId | '';
  note: string;
  outcome: 'ok' | 'error';
  status?: number | null;
  message?: string;
  permanent?: boolean;
  round?: number;
  attempt?: number;
  operation?: string;
  latencyMs?: number | null;
}

export interface ProvidersState {
  catalog: ProviderCatalogEntry[];
  keys: ProviderKey[];
  activeId: string;
  active: { id: string; provider: ProviderId; label: string; model: string; note: string } | null;
  failover: FailoverSettings;
  order: { id: string; provider: ProviderId; note: string; model: string }[];
  log: ProviderAttempt[];
  storage: { file: string };
  configured: boolean;
  env: { llm: boolean; bedrock: boolean };
}

export interface ProviderKeyInput {
  provider: ProviderId;
  apiKey?: string;
  secret?: string;
  sessionToken?: string;
  region?: string;
  baseUrl?: string;
  model?: string;
  note?: string;
  enabled?: boolean;
}

export interface ProviderTestResult {
  ok: boolean;
  keyId: string;
  provider: ProviderId;
  model: string;
  latencyMs: number;
  reply?: string;
  status?: number | null;
  error?: string;
  state: ProvidersState;
}

export type NoteKind = 'goal' | 'rule' | 'fact' | 'preference' | 'assumption' | 'suggestion' | 'question';
export type NoteDomain = 'production' | 'fiction' | 'creative' | 'meta' | 'unknown';
export interface MemoryNote {
  id: string;
  kind: NoteKind;
  domain?: NoteDomain | string;
  text: string;
  quote: string;
  origin: 'user' | 'ai';
  status: 'active' | 'pending' | 'proposed' | 'rejected' | 'superseded' | 'candidate';
  reason: string;
  supersedes: string[];
  supersededBy?: string;
  sourceMessageId: string;
  createdAt: string;
  review?: {
    classification: string | null;
    support: number | null;
    compatible: number | null;
    authorized: number | null;
    labelLean?: string | null;
    labelConfidence?: number | null;
    domain?: string | null;
    conflictsWith?: string | null;
    reconciled?: string | null;
  };
}
export interface RuleCheck {
  noteId: string;
  text: string;
  kind: NoteKind;
  value: number | null;
  verdict: 'pass' | 'conflict' | 'uncertain' | 'unknown';
  blocking?: boolean;
}
export interface MemoryEvent {
  id: string;
  turnId: string;
  stage: 'extract' | 'review' | 'context' | 'generate' | 'check' | 'repair' | 'ready' | 'provider';
  status: 'running' | 'complete' | 'blocked';
  label: string;
  at: string;
  providers: { generator: string; jev: string };
  proposals?: Pick<MemoryNote, 'id' | 'kind' | 'text' | 'quote' | 'supersedes'>[];
  notes?: MemoryNote[];
  noteIds?: string[];
  checks?: RuleCheck[];
  passed?: boolean;
  disposition?: string | null;
  attempt?: number;
  answers?: Record<string, unknown>;
  raw?: unknown;
  provider?: {
    type?: string;
    round?: number;
    attempt?: number;
    maxRounds?: number;
    keyId?: string;
    provider?: string;
    label?: string;
    note?: string;
    model?: string;
    status?: number | null;
    message?: string;
    permanent?: boolean;
    latencyMs?: number;
    switched?: boolean;
  };
  blocking?: { type: string; noteId?: string; text?: string; value?: number | null; detail?: string }[];
  soft?: RuleCheck[];
}
export interface ProjectMemory {
  version: number;
  revision: number;
  notes: MemoryNote[];
  events: MemoryEvent[];
}
