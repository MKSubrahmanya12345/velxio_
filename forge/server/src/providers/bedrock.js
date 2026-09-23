// Forge — Bedrock planner (legacy .env-only path, PLANNER_PROVIDER=bedrock).
//
// Uses the exact request/response shapes of the registry path (catalog.js):
// native Converse for Converse-served models, and the Bedrock Mantle
// chat-completions gateway for Kimi/Moonshot ids, which Converse refuses with
// HTTP 400 "Operation not allowed". SigV4-signed locally — no AWS SDK.

import { PLANNER_SYSTEM_PROMPT, plannerUserPrompt } from './plannerPrompt.js';
import { callProviderEntry, parsePlanText } from './failover.js';
import { envEntries } from './catalog.js';

export function createBedrockPlanner(cfg) {
  return async function plan(goal, constraints, feasibility) {
    const entry = envEntries(cfg).find(e => e.id === 'env:bedrock');
    if (!entry) throw new Error('Bedrock needs AWS_REGION, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in forge/server/.env.');
    const text = await callProviderEntry(entry, {
      system: PLANNER_SYSTEM_PROMPT,
      user: plannerUserPrompt(goal, constraints, feasibility),
      temperature: 0.3,
    });
    return parsePlanText(text);
  };
}
