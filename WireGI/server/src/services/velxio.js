// The Velxio bridge — the agent's hands in the simulator.
//
// WireGI's research pipeline knows WHAT a build needs (parts, wiring, config);
// until now it had nowhere to PUT that knowledge. The Velxio backend exposes
// its whole simulation toolset (component catalog, board pinouts, circuit
// create/update, electrical validation, the real arduino-cli compiler,
// headless firmware simulation, and a physics runner for mechanical designs)
// over plain JSON:
//
//   GET  {VELXIO_URL}/api/agent/tools          → discover the tools
//   POST {VELXIO_URL}/api/agent/tools/invoke   → { tool, args } → result
//
// runSimPhase() is the loop the VISION calls the "simulation rung": the agent
// takes the researched parts, BUILDS an artifact with the tools, watches it
// fail or pass, repairs it, and only then hands the human instructions. It
// never throws and never mutates the project — it returns a record that
// agent.js applies, so a dead Velxio backend degrades to "no sim rung this
// run", never to a failed run.
//
// Flow per round (bounded by VELXIO_SIM_ROUNDS + a wall-clock budget):
//   model → {"tool_calls":[{tool,args}]} → execute → results appended → model
//   model → {"final":{done, summary, instructions, circuit, files, checks}}
import { generateWithMeta } from './llm.js';

const TOOLS_CACHE_MS = 10 * 60 * 1000; // the catalog does not change mid-run
let toolsCache = { at: 0, tools: null };

/** Balanced-brace clip: a truncated JSON tool result the model "reads" is
 * worse than a shorter complete one — cut at the last balanced close. */
function clipJson(value, limit) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return '"(unserialisable result)"';
  }
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const end = Math.max(cut.lastIndexOf('}'), cut.lastIndexOf(']'));
  return (end > limit / 2 ? cut.slice(0, end + 1) : cut) + '…[truncated]';
}

async function fetchJson(url, { method = 'GET', body, timeoutMs, emit }) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw Object.assign(new Error(`HTTP ${res.status} ${detail}`.trim()), { status: res.status });
  }
  return res.json();
}

/** Discover the Velxio toolset (cached — the catalog is stable). Returns
 * [{name, summary, params}] or throws with a reason the trace can show. */
export async function listVelxioTools({ cfg, emit }) {
  const v = cfg?.velxio || {};
  const url = v.url || 'http://localhost:8000';
  if (toolsCache.tools && Date.now() - toolsCache.at < TOOLS_CACHE_MS) return toolsCache.tools;
  const out = await fetchJson(`${url}/api/agent/tools`, { timeoutMs: 10_000 });
  const tools = Array.isArray(out?.tools) ? out.tools : [];
  if (!tools.length) throw new Error('Velxio exposed no tools');
  toolsCache = { at: Date.now(), tools };
  emit?.({
    type: 'sim',
    stage: 'tools',
    message: `Velxio simulator online — ${tools.length} tools available (${tools
      .map((t) => t.name)
      .slice(0, 6)
      .join(', ')}, …)`,
  });
  return tools;
}

/** One tool call. Returns the backend's envelope {ok, result|error, dropped}.
 * Never throws — a tool failure is data the model repairs from. */
export async function invokeVelxioTool({ cfg, tool, args, emit }) {
  const v = cfg?.velxio || {};
  const url = v.url || 'http://localhost:8000';
  const started = Date.now();
  try {
    const out = await fetchJson(`${url}/api/agent/tools/invoke`, {
      method: 'POST',
      body: { tool, args: args || {} },
      timeoutMs: v.toolTimeoutMs || 120_000,
    });
    return { ...out, ms: Date.now() - started };
  } catch (err) {
    emit?.({
      type: 'sim',
      stage: 'tool-error',
      level: 'warn',
      tool,
      message: `${tool} failed to reach Velxio: ${err?.message || err}`,
    });
    return { ok: false, error: `transport: ${err?.message || err}`, ms: Date.now() - started };
  }
}

/** The part of the project the design loop needs: researched specs, the
 * human's answers, open questions — the CURRENT state, not the IDEA. */
function partsBrief(project) {
  return (project.state.parts || []).map((p) => ({
    name: p.name,
    domain: p.domain,
    status: p.status,
    bom: p.current?.data?.bomRow || p.data?.bomRow || null,
    wiring: p.current?.data?.wiring || p.data?.wiring || null,
    config: p.current?.data?.config || p.data?.config || null,
    checklist: p.checklist || p.current?.data?.checklist || [],
    openQuestions: p.openQuestions || [],
    humanInput: (p.humanInput || []).map((h) => h.text).filter(Boolean).slice(-3),
  }));
}

function toolCatalogText(tools) {
  return tools
    .map((t) => {
      const params = (t.params || [])
        .map((p) => (p.required ? p.name : `${p.name}?`))
        .join(', ');
      return `- ${t.name}(${params}) — ${t.summary || ''}`;
    })
    .join('\n');
}

// Tolerant JSON parse (fences, prose around the object) — same approach as
// research.js, local so this module stays dependency-free.
function parseLoopJson(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const tryParse = (s) => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === 'object' ? v : null;
    } catch {
      return null;
    }
  };
  let out = tryParse(cleaned);
  if (!out) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) out = tryParse(cleaned.slice(start, end + 1));
  }
  return out;
}

function buildSystem(tools) {
  return `You are WireGI's build engineer. You have researched a project and now must TURN IT INTO A WORKING ARTIFACT using the Velxio simulator's tools, verify it actually works, and write the human's next steps.

TOOLS (Velxio simulator — call them by returning tool_calls):
${toolCatalogText(tools)}

STRATEGY:
- Electronics: consult list_components / component_info / board_pinout for the exact parts in the BOM FIRST (real pin names, properties), then create_circuit, generate_code_files, then validate_circuit → compile_project → simulate_firmware. Fix what fails and retry — that is the whole point of having the tools.
- Mechanical / robotics aspects (a drone lifting, a rover driving): use physics_capabilities then physics_simulate with a scene + checks.
- One or two tool calls per round. Wait for results — later calls depend on earlier ones (you cannot compile before the circuit exists).
- If a tool returns an error, that is information: read it, fix the args or the design, call again (or a different tool).

Respond with JSON ONLY, one of:
{"tool_calls": [{"tool": "<name>", "args": {...}}]}
{"final": {
  "done": true|false,
  "summary": "one paragraph: what you built and how far it got",
  "instructions": "markdown for the human: EXACTLY what to do next — steps, wiring to double-check with their own eyes, what to watch in the simulator, what you already verified",
  "circuit": <the final circuit object or null>,
  "files": [{"name": "sketch.ino", "content": "..."}],
  "checks": ["what passed, e.g. 'validated: no electrical conflicts'", "compiled: ok"]
}}

Finish with "final" when the artifact is verified (or you are honestly stuck — then done:false, say what is missing). Never invent tool results you did not receive.`;
}

/**
 * The simulation phase. Returns a record for agent.js to apply, or null when
 * there is nothing to do (Velxio down / no researched parts / no provider).
 * Never throws; every failure is a status on the record.
 */
export async function runSimPhase({ project, registry, cfg, emit = () => {}, prefer }) {
  const v = cfg?.velxio || {};
  const parts = project.state.parts || [];
  const researched = parts.filter((p) => p.current?.data || p.data);
  if (!researched.length) return null; // nothing to build from (yet)

  const started = Date.now();
  const toolLog = [];
  const budgetMs = v.budgetMs || 420_000;
  const maxRounds = v.maxRounds || 12;
  const clip = v.resultClip || 3800;

  let tools;
  try {
    tools = await listVelxioTools({ cfg, emit });
  } catch (err) {
    emit?.({
      type: 'sim',
      stage: 'skipped',
      message: `Simulator rung skipped — Velxio backend not reachable at ${v.url || 'http://localhost:8000'} (${err?.message || err}). Research stands on its own.`,
    });
    return null;
  }

  emit?.({
    type: 'sim',
    stage: 'start',
    message: `Designing and verifying the build in the Velxio simulator (${researched.length} researched part${researched.length === 1 ? '' : 's'})…`,
  });

  const system = buildSystem(tools);
  const messages = [
    {
      role: 'user',
      content: `PROJECT GOAL: ${project.goal}
CONSTRAINTS: ${JSON.stringify(project.constraints || {})}
RESEARCHED PARTS (CURRENT state — your design must honour these):
${JSON.stringify(partsBrief(project), null, 2)}

Build the artifact now. Start by looking up the parts you will place.`,
    },
  ];

  let final = null;
  let rounds = 0;

  for (let round = 0; round < maxRounds && Date.now() - started < budgetMs; round++) {
    rounds += 1;
    let out;
    try {
      const call = await generateWithMeta({
        registry,
        system,
        user: messages.map((m) => m.content).join('\n\n---\n\n'),
        temperature: 0.2,
        maxTokens: 8192,
        emit,
        prefer,
        operation: `sim:round${round + 1}`,
      });
      out = parseLoopJson(call.text);
      if (!out) {
        // Unparseable round: tell the model and continue — do not abort the phase.
        messages.push({
          role: 'user',
          content:
            'Your last response was not valid JSON. Respond with {"tool_calls":[…]} or {"final":{…}} only — no prose, no markdown fences.',
        });
        continue;
      }
    } catch (err) {
      // Provider down / no key: the sim rung degrades, the run survives.
      emit?.({
        type: 'sim',
        stage: 'skipped',
        level: 'warn',
        message: `Simulator rung skipped — no provider available for the design loop (${err?.message || err}).`,
      });
      return {
        status: 'skipped',
        reason: `provider unavailable: ${err?.message || err}`,
        rounds,
        toolLog,
        at: new Date().toISOString(),
      };
    }

    const calls = Array.isArray(out.tool_calls) ? out.tool_calls.slice(0, 2) : null;
    if (calls && calls.length) {
      const results = [];
      for (const c of calls) {
        const tool = String(c?.tool || '').trim();
        if (!tool) continue;
        const res = await invokeVelxioTool({ cfg, tool, args: c.args, emit });
        toolLog.push({ tool, ok: Boolean(res.ok), ms: res.ms, at: new Date().toISOString() });
        emit?.({
          type: 'sim',
          stage: 'tool',
          tool,
          ok: Boolean(res.ok),
          ms: res.ms,
          message: `${tool} ${res.ok ? '✓' : '✖'} (${res.ms}ms)`,
        });
        results.push({
          tool,
          ok: res.ok,
          dropped: res.dropped || [],
          result: res.ok ? clipJson(res.result, clip) : String(res.error || 'failed'),
        });
      }
      if (!results.length) {
        // The round produced tool_calls but nothing usable — correct the model
        // instead of re-sending the identical conversation (which would loop).
        messages.push({
          role: 'user',
          content:
            'Your tool_calls named no valid tool. Respond with {"tool_calls":[{"tool":"<exact name>","args":{…}}]} using a tool name from the list, or {"final":{…}}.',
        });
        continue;
      }
      messages.push({ role: 'assistant', content: JSON.stringify(out) });
      messages.push({
        role: 'user',
        content: `TOOL RESULTS (round ${round + 1}; ${maxRounds - round - 1} rounds left):\n${results
          .map((r) => `${r.tool} → ${r.ok ? 'ok' : 'ERROR'}${r.dropped?.length ? ` (ignored unknown args: ${r.dropped.join(', ')})` : ''}\n${r.result}`)
          .join('\n\n')}`,
      });
      continue;
    }

    if (out.final && typeof out.final === 'object') {
      final = out.final;
      break;
    }

    messages.push({
      role: 'user',
      content:
        'Respond with {"tool_calls":[…]} to use a tool, or {"final":{…}} when you are done. JSON only.',
    });
  }

  const verified = [
    toolLog.some((t) => t.tool === 'validate_circuit' && t.ok) ? 'validated' : null,
    toolLog.some((t) => t.tool === 'compile_project' && t.ok) ? 'compiled' : null,
    toolLog.some((t) => (t.tool === 'simulate_firmware' || t.tool === 'physics_simulate') && t.ok)
      ? 'simulated'
      : null,
  ].filter(Boolean);

  if (!final) {
    final = {
      done: false,
      summary: `The design loop used its ${rounds}-round budget without a final answer. ${verified.length ? `Verified so far: ${verified.join(', ')}.` : 'Nothing was verified.'}`,
      instructions:
        'The agent ran out of its simulator budget before finishing the artifact. Ask it to continue ("keep building it in the simulator") and it will resume where the tool log ends.',
      circuit: null,
      files: [],
      checks: verified,
    };
  }

  const status = final.done && verified.length ? 'simulated' : verified.length ? 'partial' : 'failed';
  emit?.({
    type: 'sim',
    stage: 'done',
    status,
    rounds,
    verified,
    message: `Simulator rung ${status} — ${rounds} rounds, ${toolLog.length} tool calls${verified.length ? `, verified: ${verified.join(', ')}` : ''}`,
  });

  return {
    status,
    rounds,
    toolLog,
    verified,
    summary: String(final.summary || '').slice(0, 2000),
    instructions: String(final.instructions || '').slice(0, 6000),
    circuit: final.circuit && typeof final.circuit === 'object' ? final.circuit : null,
    files: Array.isArray(final.files)
      ? final.files
          .filter((f) => f && typeof f.name === 'string')
          .map((f) => ({ name: String(f.name).slice(0, 120), content: String(f.content || '').slice(0, 100_000) }))
          .slice(0, 12)
      : [],
    checks: Array.isArray(final.checks) ? final.checks.map(String).slice(0, 20) : [],
    ms: Date.now() - started,
    at: new Date().toISOString(),
  };
}
