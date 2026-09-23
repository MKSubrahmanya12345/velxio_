// Research pipeline: research → gather → understand → data, per part.
//
// Domain-aware: the output schema comes from the project's profile, so hardware
// gets bomRow/wiring/config while software gets deps/interfaces/config. Adding a
// domain never touches this file.
//
// Includes live web search (Tavily/Brave if a key is in the Forge .env) and an
// indexer speed-up that reuses prior findings for similar topics.
import { generate, generateJSON } from './llm.js';
import { getProfile, schemaBlock, ladderText } from './profiles.js';

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

const buildSys = (profile) => `You are the research lead for a build project in the ${profile.label} domain.
For the given PART, run a research → gather → understand → data pass.

Return JSON ONLY:
{
  "research": [ "short note, with a source URL where known" ],
  "gathered": [ { "field": string, "value": string, "source": string } ],
  "understand": { "validation": [string], "openQuestions": [string], "conflicts": [string] },
${schemaBlock(profile)},
  "humanCheckpoint": boolean
}

Domain guidance: ${profile.verification}
Verification ladder available in this domain: ${ladderText(profile)}

Be concrete and buildable — cite real part numbers, specs, prices and versions when known.
If anything is uncertain, put it in openQuestions and set humanCheckpoint true.`;

// Turn what was learned into reusable index context. Gathered fields are the
// valuable part; raw search titles are not.
function indexSummary(out) {
  const gathered = (out.gathered || [])
    .slice(0, 10)
    .map((g) => `${g.field}=${g.value}`);
  const validated = (out.understand?.validation || []).slice(0, 4);
  return [...gathered, ...validated].join(' | ').slice(0, 1200);
}

export async function researchPart({ part, project, registry, emit, indexer, prefer }) {
  const profile = getProfile(project.profileId);
  const topic = `${project.goal} — ${part.name} (${part.domain})`;
  emit?.({ type: 'research', stage: 'research', partId: part.id, part: part.name, message: `Researching ${part.name}…` });

  // ── Prior knowledge: exact topic first, then the part itself (which is what
  // makes cross-project reuse possible — "Battery electronics" hits again).
  const cached = indexer?.find(topic) || indexer?.find(`${part.name} ${part.domain}`);
  let web = null;
  let prior = null;

  if (cached) {
    prior = cached;
    emit?.({
      type: 'research',
      stage: 'index',
      partId: part.id,
      part: part.name,
      message: `Index hit (${cached.overlap} term match) — reusing prior research on "${cached.topic}".`,
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
        // Titles + snippets, so even an un-enriched entry is useful prior context.
        summary: web.items
          .map((i) => `${i.title}: ${String(i.snippet || '').slice(0, 200)}`)
          .join(' | ')
          .slice(0, 1200),
        sources: web.items.map((i) => i.url),
        partName: part.name,
        profileId: profile.id,
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

  // Prior indexed research is REAL context — before this fix a cache hit sent
  // the model less information than a miss did.
  const context = prior
    ? `PRIOR RESEARCH ALREADY IN THE INDEX — reuse it, correct it, and fill the gaps; do not start from scratch.
${prior.summary || '(stored findings)'}${
        prior.sources?.length ? `\nSources: ${prior.sources.slice(0, 6).join(', ')}` : ''
      }`
    : web?.items?.length
      ? web.items.map((i) => `- ${i.title} (${i.url}): ${i.snippet}`).join('\n')
      : '(no live web results — relying on model knowledge)';

  const constraints = JSON.stringify(project.constraints || {});

  const user = `PROJECT GOAL: ${project.goal}
CONSTRAINTS: ${constraints}
PART: ${part.name} (domain: ${part.domain})
IDEA for this part: ${JSON.stringify(part.idea || {})}
${prior ? 'PRIOR FINDINGS FROM INDEX' : 'LIVE WEB RESULTS'}:
${context}`;

  const out = await generateJSON({
    registry,
    system: buildSys(profile),
    user,
    temperature: 0.2,
    maxTokens: 4096,
    emit,
    prefer,
  });

  // Store what was learned so the next part (or the next week) benefits.
  try {
    indexer?.enrich?.(topic, {
      summary: indexSummary(out) || undefined,
      sources: web?.items?.map((i) => i.url) || prior?.sources || [],
      fields: (out.gathered || []).map((g) => g.field),
      profileId: profile.id,
    });
  } catch {
    /* index is an optimisation only */
  }

  return {
    research: out.research || [],
    gathered: out.gathered || [],
    understand: out.understand || { validation: [], openQuestions: [], conflicts: [] },
    data: out.data || null,
    humanCheckpoint:
      Boolean(out.humanCheckpoint) || (out.understand?.openQuestions || []).length > 0,
    web: prior
      ? { engine: 'index', count: 0, reusedFrom: prior.topic }
      : web
        ? { engine: web.engine, count: web.items.length }
        : { engine: 'none', count: 0 },
  };
}
