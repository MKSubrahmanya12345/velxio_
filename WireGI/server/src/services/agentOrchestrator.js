import { generateJSON } from './llm.js';
import { runFastDelta } from './fastDelta.js';

const ROUTER_SYSTEM = `You route a user's hardware-agent message.
Return JSON ONLY:
{
  "action": "new_project" | "modify_project" | "answer",
  "reason": string,
  "goal": string,
  "constraints": object
}

Rules:
- new_project: the user asks to build a different project. Similarity does not make it a modification.
- modify_project: the user clearly changes, extends, fixes, or constrains the current project.
- answer: the user is asking a question only.
- Do not invent requirements.
- Preserve the user's wording and intent.`;

// Deterministic first-pass detector. These messages do not deserve an LLM
// routing call: they are small mutations to an existing hardware artifact.
function isFastDelta(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 120 || s.split(/\s+/).length > 16) return false;
  if (/^(build|create|design|make)\s+(me\s+)?(a|an|the)\b/i.test(s)) return false;
  return /\b(add|attach|remove|delete|replace|change|move|connect|disconnect|set|rename|swap|make)\b/i.test(s) &&
    /\b(led|button|switch|sensor|servo|motor|buzzer|display|lcd|wire|resistor|pin|gpio|component|arduino|esp32|blink|light)\b/i.test(s);
}

export function createAgentOrchestrator({ agent, registry, store, cfg }) {
  async function routeMessage(project, text, { emit = () => {}, prefer } = {}) {
    try {
      const result = await generateJSON({
        registry,
        system: ROUTER_SYSTEM,
        user: JSON.stringify({
          currentProject: {
            id: project.id,
            goal: project.goal,
            constraints: project.constraints,
            parts: (project.state?.parts || []).map((p) => ({ name: p.name, domain: p.domain })),
          },
          userMessage: text,
        }),
        temperature: 0,
        emit,
        prefer,
        operation: 'route-project-message',
      });
      return result || { action: 'modify_project', goal: text, constraints: {} };
    } catch {
      return { action: 'modify_project', goal: text, constraints: {} };
    }
  }

  async function fastDelta(project, text, { emit = () => {}, prefer } = {}) {
    emit({ type: 'agent', stage: 'fast-path', message: `Small hardware change detected — executing directly: ${text}` });
    const result = await runFastDelta({ project, instruction: text, registry, cfg, emit, prefer });
    project.state.sim = {
      ...(project.state.sim || {}),
      ...(result.circuit !== undefined ? { circuit: result.circuit } : {}),
      ...(result.files !== undefined ? { files: result.files } : {}),
      status: result.done ? 'simulated' : 'partial',
      summary: result.summary || project.state.sim?.summary || '',
      checks: result.checks || project.state.sim?.checks || [],
      toolLog: result.toolLog || [],
      rounds: result.rounds || 0,
    };
    project.state.chat.push({ role: 'user', content: text, ts: new Date().toISOString() });
    project.state.chat.push({
      role: 'agent',
      content: result.summary || `Applied: ${text}`,
      ts: new Date().toISOString(),
    });
    project.updatedAt = new Date().toISOString();
    await store.save(project);
    emit({
      type: 'done',
      projectId: project.id,
      status: project.status,
      fastPath: true,
      summary: result.summary,
      checks: result.checks,
      message: result.done ? 'Small hardware change applied and verified.' : 'Small hardware change applied partially.',
    });
    return project;
  }

  async function message({ projectId, text, prefer, emit = () => {} }) {
    const project = await store.get(projectId);
    if (!project) throw Object.assign(new Error('project not found'), { status: 404 });

    // This is intentionally BEFORE the LLM router. A trivial delta should cost
    // neither a routing call nor the full autonomous reasoning loop.
    if (isFastDelta(text) && project.state?.parts?.length) {
      try {
        return await fastDelta(project, text, { emit, prefer });
      } catch (err) {
        emit({ type: 'agent', stage: 'fast-path-fallback', level: 'warn', message: `Fast path failed; falling back to normal agent: ${err?.message || err}` });
      }
    }

    const route = await routeMessage(project, text, { emit, prefer });
    const action = ['new_project', 'modify_project', 'answer'].includes(route.action)
      ? route.action
      : 'modify_project';

    emit({ type: 'agent', stage: 'route', action, reason: route.reason || '', message: `Message routed → ${action}` });

    if (action === 'new_project') {
      return agent.runProject(route.goal || text, route.constraints || {}, { emit, prefer });
    }

    return agent.message
      ? agent.message(projectId, text, { emit, prefer })
      : agent.continueProject(projectId, text, { emit, prefer });
  }

  return { message };
}
