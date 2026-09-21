// Forge — planner provider factory.
//
// Contract: plan(goal, constraints, feasibility) → RAW plan object
// { phases, bom, acceptance } — always coerced by sanitizePlan() downstream.
//
// Providers:
//   mock    — offline knowledge base (no keys needed)
//   llm     — any OpenAI-compatible /chat/completions endpoint
//   bedrock — AWS Bedrock Converse API (SigV4, zero SDK deps)

import { createPlannerMock } from './plannerMock.js';
import { createBedrockPlanner } from './bedrock.js';
import { PLANNER_SYSTEM_PROMPT, plannerUserPrompt } from './plannerPrompt.js';

export function createPlanner(cfg) {
  if (cfg.planner.provider === 'bedrock') return createBedrockPlanner(cfg);
  if (cfg.planner.provider === 'llm' && cfg.planner.apiKey) return llmPlanner(cfg);
  return createPlannerMock();
}

function llmPlanner(cfg) {
  return async function plan(goal, constraints, feasibility) {
    const res = await fetch(`${cfg.planner.apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.planner.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.planner.model,
        temperature: 0.3,
        messages: [
          { role: 'system', content: PLANNER_SYSTEM_PROMPT },
          { role: 'user', content: plannerUserPrompt(goal, constraints, feasibility) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM planner ${res.status}: ${await res.text()}`);
    const data = await res.json();
    let text = String(data.choices?.[0]?.message?.content || '');
    text = text.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    return JSON.parse(text);
  };
}
