import { generateJSON } from './llm.js';
import { makeProject } from '../models/project.js';

const ROUTER_SYSTEM = `You route a user's hardware-agent message.
Return JSON ONLY:
{
  "action": "new_project" | "modify_project" | "answer",
  "reason": string,
  "goal": string,
  "constraints": object
}

Rules:
- new_project: the user wants a different hardware project, even if it is similar to the current one.
- modify_project: the user is clearly changing, extending, fixing, or constraining the current project.
- answer: the user is only asking a question and is not asking to build or modify anything.
- Similarity alone does NOT mean modify_project. A new request such as "make a similar temperature monitor but for humidity" is a new_project unless the user explicitly frames it as a change to the current build.
- Preserve the user's actual intent. Do not invent requirements.`;

export function createAgentOrchestrator({ agent, registry, store }) {
  async function routeMessage(project, text, { emit = () => {}, prefer } = {}) {
    const result = await generateJSON({
      registry,
      system: ROUTER_SYSTEM,
      user: JSON.stringify({
        currentProject: {
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

    return result?.action || 'modify_project';
  }

  async function message({ projectId, text, prefer, emit = () => {} }) {
    const project = await store.get(projectId);
    if (!project) throw Object.assign(new Error('project not found'), { status: 404 });

    const action = await routeMessage(project, text, { emit, prefer });
    emit({
      type: 'agent',
      stage: 'route',
      action,
      message: `Message routed → ${action}`,
    });

    if (action === 'new_project') {
      // A similar request is still a new IDEA. Do not mutate the previous
      // project; create a completely independent durable project.
      return agent.runProject(text, {}, { emit, prefer });
    }

    return agent.continueProject(projectId, text, { emit, prefer });
  }

  return { message };
}
