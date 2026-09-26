import { generateJSON } from './llm.js';

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

export function createAgentOrchestrator({ agent, registry, store }) {
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
      // A routing failure must not strand the user. Continuing the current
      // project is safer than silently creating a second project.
      return { action: 'modify_project', goal: text, constraints: {} };
    }
  }

  async function message({ projectId, text, prefer, emit = () => {} }) {
    const project = await store.get(projectId);
    if (!project) throw Object.assign(new Error('project not found'), { status: 404 });

    const route = await routeMessage(project, text, { emit, prefer });
    const action = ['new_project', 'modify_project', 'answer'].includes(route.action)
      ? route.action
      : 'modify_project';

    emit({ type: 'agent', stage: 'route', action, reason: route.reason || '', message: `Message routed → ${action}` });

    if (action === 'new_project') {
      return agent.runProject(route.goal || text, route.constraints || {}, { emit, prefer });
    }

    return agent.continueProject(projectId, text, { emit, prefer });
  }

  return { message };
}
