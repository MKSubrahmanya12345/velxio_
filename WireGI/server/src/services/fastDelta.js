import { generateWithMeta } from './llm.js';
import { listVelxioTools, invokeVelxioTool } from './velxio.js';

const MAX_ROUNDS = 3;
const BUDGET_MS = 90_000;

function catalog(tools) {
  return tools.map((t) => {
    const params = (t.params || []).map((p) => (p.required ? p.name : `${p.name}?`)).join(', ');
    return `- ${t.name}(${params}) — ${t.summary || ''}`;
  }).join('\n');
}

function currentArtifact(project) {
  const sim = project.state?.sim || {};
  return {
    goal: project.goal,
    constraints: project.constraints,
    parts: (project.state?.parts || []).map((p) => ({
      name: p.name,
      domain: p.domain,
      status: p.status,
      bom: p.current?.data?.bomRow || p.data?.bomRow || null,
      wiring: p.current?.data?.wiring || p.data?.wiring || null,
      config: p.current?.data?.config || p.data?.config || null,
    })),
    circuit: sim.circuit || null,
    files: sim.files || [],
    previousSummary: sim.summary || null,
  };
}

/**
 * Fast path for small mutations to an already-built hardware project.
 * No classification, decomposition, research, reconciliation or Jev call.
 * One short model/tool loop is enough for things like "add an LED".
 */
export async function runFastDelta({ project, instruction, registry, cfg, emit = () => {}, prefer }) {
  const started = Date.now();
  const tools = await listVelxioTools({ cfg, emit });
  if (!tools.length) throw new Error('Velxio exposed no tools');

  const system = `You are the fast hardware editor for WireGI.
The user is making a SMALL CHANGE to an EXISTING hardware project.
Do NOT redesign the project. Do NOT research parts. Do NOT decompose the project.
Use the Velxio tools directly to make only the requested delta, then validate/compile if appropriate.
Prefer the minimum number of tool calls. You may make at most 2 tool calls in a response.
Return JSON ONLY:
{"tool_calls":[{"tool":"name","args":{}}]}
or
{"final":{"done":true,"summary":"...","checks":["..."]}}

Available tools:\n${catalog(tools)}

CURRENT ARTIFACT:\n${JSON.stringify(currentArtifact(project))}`;

  let context = `USER DELTA: ${instruction}\nCURRENT ARTIFACT:\n${JSON.stringify(currentArtifact(project))}`;
  const toolLog = [];

  for (let round = 0; round < MAX_ROUNDS && Date.now() - started < BUDGET_MS; round += 1) {
    const result = await generateWithMeta({
      registry,
      system,
      user: context,
      temperature: 0,
      emit,
      prefer,
      operation: 'fast-hardware-delta',
    });
    const text = typeof result?.text === 'string' ? result.text : result?.content || result;
    let plan;
    try {
      const cleaned = String(text || '').replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
      plan = JSON.parse(cleaned);
    } catch {
      throw new Error('Fast hardware editor returned invalid JSON.');
    }

    if (plan?.final) {
      return { ...plan.final, rounds: round + 1, toolLog, ms: Date.now() - started };
    }

    const calls = Array.isArray(plan?.tool_calls) ? plan.tool_calls.slice(0, 2) : [];
    if (!calls.length) throw new Error('Fast hardware editor returned no tool calls.');

    const results = [];
    for (const call of calls) {
      const out = await invokeVelxioTool({ cfg, tool: call.tool, args: call.args, emit });
      toolLog.push({ tool: call.tool, args: call.args, ok: Boolean(out?.ok), result: out?.result ?? null, error: out?.error ?? null, ms: out?.ms ?? 0 });
      results.push({ tool: call.tool, ok: Boolean(out?.ok), result: out?.result ?? null, error: out?.error ?? null });
    }
    context = `USER DELTA: ${instruction}\nTOOL RESULTS:\n${JSON.stringify(results)}\nCURRENT ARTIFACT:\n${JSON.stringify(currentArtifact(project))}\nIf the requested change is complete and verified, return final. Otherwise make only the next necessary tool call(s).`;
  }

  return { done: false, summary: 'Fast edit reached its bounded execution limit.', checks: [], rounds: MAX_ROUNDS, toolLog, ms: Date.now() - started };
}
