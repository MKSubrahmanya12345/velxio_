// Forge client — types mirroring the server's ProjectState (schema.js).
// The server is the source of truth; these exist for the UI only.

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

export interface Proposal {
  type: 'substitute' | 'replan';
  need?: string;
  item?: { id?: string; name: string; note?: string };
  compatibility?: number;
  confidence?: number;
  stepId?: string;
  text?: string;
}

export interface Constraints {
  budget_usd: number | null;
  time: string;
  skill: string;
  notes: string;
}

export interface ProjectState {
  goal: string;
  constraints: Constraints;
  feasibility: {
    category: string;
    buildability: string;
    risk_tier: string;
    complexity: number;
  };
  status: 'planning' | 'active' | 'paused' | 'complete' | 'aborted';
  phases: Phase[];
  current: { phaseId: string | null; stepId: string | null };
  inventory: { id: string; name: string; note?: string }[];
  bom: BomItem[];
  acceptance: string[];
  log: LogEntry[];
  skill: Record<string, { successes: number; fails: number }>;
  safetyAcks: Record<string, boolean>;
  safetyGate: { stepId: string; flags: SafetyFlag[] } | null;
  counters: {
    messages: number;
    jevCalls: number;
    escalations: number;
    stepsCompleted: number;
    substitutions: number;
  };
  confidence: Record<string, number>;
  proposal: Proposal | null;
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
  project: Project;
  response: ResponsePayload;
  decisions: Decision[];
}

export interface CreateResult {
  project: Project;
  response: ResponsePayload;
  decisions: Decision[];
}

export interface Health {
  ok: boolean;
  service: string;
  time: string;
  providers: { jev: string; planner: string; store: string };
}
