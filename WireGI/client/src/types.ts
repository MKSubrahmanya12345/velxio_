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
}

export interface Decision {
  label: string;
  at: string;
  source?: string;
  model?: string;
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
  state: {
    idea: any;
    current: any;
    verified: any;
    parts: Part[];
    decisions: Decision[];
    researchLog: Array<{ part: string; web: { engine: string; count: number }; ts: string }>;
    chat: ChatMsg[];
  };
}

export type StreamEvent =
  | { type: 'decision'; label: string; answers: any; source?: string }
  | { type: 'research'; stage: string; part: string; message: string; results?: any[] }
  | { type: 'project'; stage: string; projectId: string; parts: any[] }
  | { type: 'part'; stage: string; partId: string; part: string; data?: any; humanCheckpoint?: boolean }
  | { type: 'chat'; role: string; content: string }
  | { type: 'done'; projectId: string; status: string; summary: string }
  | { type: 'result'; result: Project }
  | { type: 'error'; error: string };
