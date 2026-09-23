// Research pipeline: research -> gather -> understand -> data, per part.
// Includes live web search (Tavily/Brave if a key is in the Forge .env) and an
// indexer speed-up that reuses prior findings for similar topics.
import { generate, generateJSON } from './llm.js';

// Live web search. Uses TAVILY_API_KEY or BRAVE_API_KEY when present (read from
// the Forge environment). Returns null when no key is configured — never mocks.
export async function webSearch(query, { maxResults = 5 } = {}) {
  const tavily = process.env.TAVILY_API_KEY;
  const brave = process.env.BRAVE_API_KEY;
  try {
    if (tavily) {
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: tavily, query, max_results: maxResults, search_depth: 'advanced' }),
      });
      if (r.ok) {
        const d = await r.json();
        const items = (d.results || []).map((x) => ({ title: x.title, url: x.url, snippet: x.content }));
        return { engine: 'tavily', query, items };
      }
    }
    if (brave) {
      const r = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`,
        { headers: { Accept: 'application/json', 'X-Subscription-Token': brave } },
      );
      if (r.ok) {
        const d = await r.json();
        const items = (d.web?.results || []).map((x) => ({ title: x.title, url: x.url, snippet: x.description }));
        return { engine: 'brave', query, items };
      }
    }
  } catch {
    /* network issues -> treat as no web */
  }
  return null;
}

const SYS_RESEARCH = `You are the research lead for a physical/software build project.
For the given PART, run a research -> gather -> understand -> data pass.
Return JSON ONLY:
{
  "research": [ "short note with source URL where known" ],
  "gathered": [ { "field": string, "value": string, "source": string } ],
  "understand": { "validation": [string], "openQuestions": [string], "conflicts": [string] },
  "data": { "bomRow": string, "wiring": string, "config": string, "checklist": [string] },
  "humanCheckpoint": boolean
}
Be concrete and buildable. Cite real part numbers, specs, and prices when known.
If anything is uncertain, put it in openQuestions and set humanCheckpoint true.`;

export async function researchPart({ part, project, registry, emit, indexer, prefer }) {
  const topic = `${project.goal} — ${part.name} (${part.domain})`;
  emit?.({ type: 'research', stage: 'research', partId: part.id, part: part.name, message: `Researching ${part.name}…` });

  // Indexing speed-up: reuse prior findings for similar topics.
  const cached = indexer?.find(topic);
  let web = null;
  if (cached) {
    emit?.({
      type: 'research',
      stage: 'index',
      partId: part.id,
      part: part.name,
      message: `Index hit — reusing prior research on "${cached.topic}".`,
    });
  } else {
    web = await webSearch(topic);
    if (web && web.items.length) {
      emit?.({
        type: 'research',
        stage: 'web',
        partId: part.id,
        part: part.name,
        message: `Web search (${web.engine}): ${web.items.length} results.`,
        results: web.items,
      });
      indexer?.add({
        topic,
        summary: web.items.map((i) => i.title).join('; '),
        sources: web.items.map((i) => i.url),
        partName: part.name,
      });
    } else {
      emit?.({
        type: 'research',
        stage: 'web',
        partId: part.id,
        part: part.name,
        message: 'No web-search key configured — using model knowledge.',
      });
    }
  }

  const sources = web?.items?.length
    ? web.items.map((i) => `- ${i.title} (${i.url}): ${i.snippet}`).join('\n')
    : '(no live web results — relying on model knowledge)';
  const constraints = JSON.stringify(project.constraints || {});

  const user = `PROJECT GOAL: ${project.goal}
CONSTRAINTS: ${constraints}
PART: ${part.name} (domain: ${part.domain})
IDEA for this part: ${JSON.stringify(part.idea || {})}
LIVE WEB RESULTS:
${sources}`;

  const out = await generateJSON({ registry, system: SYS_RESEARCH, user, temperature: 0.2, maxTokens: 4096, emit, prefer });

  return {
    research: out.research || [],
    gathered: out.gathered || [],
    understand: out.understand || { validation: [], openQuestions: [], conflicts: [] },
    data: out.data || null,
    humanCheckpoint: Boolean(out.humanCheckpoint) || (out.understand?.openQuestions || []).length > 0,
    web: web ? { engine: web.engine, count: web.items.length } : { engine: 'none', count: 0 },
  };
}
