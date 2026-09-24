// Research pipeline: research → gather → understand → data, per part.
//
// Domain-aware: the output schema comes from the project's profile, so hardware
// gets bomRow/wiring/config while software gets deps/interfaces/config. Adding a
// domain never touches this file.
//
// Includes live web search (Tavily/Brave, key from WireGI/server/.env) and an
// indexer speed-up that reuses prior findings for similar topics.
//
// Debugging: every stage emits a timed event, a failed web search reports WHY
// (HTTP status + body excerpt) instead of silently degrading to model
// knowledge, and the research call returns which provider/key/model answered.
import { generateWithMeta } from './llm.js';
import { getProfile, schemaBlock, ladderText } from './profiles.js';
import { errorSummary, trimText } from './debug.js';

// Runs that have already been told there is no web-search key. Keyed on the
// run's `emit` function, so the notice shows up once per run and never again —
// see researchPart(). Weak, so a finished run's emitter is collectable.
const noWebKeyWarned = new WeakSet();

// Live web search. Uses TAVILY_API_KEY or BRAVE_API_KEY when present. Returns
// null when no key is configured — never mocks results.
export async function webSearch(query, { maxResults = 5, emit } = {}) {
  const tavily = process.env.TAVILY_API_KEY;
  const brave = process.env.BRAVE_API_KEY;
  if (!tavily && !brave) return null;

  const fail = (engine, detail) => {
    emit?.({
      type: 'research',
      stage: 'web-error',
      level: 'warn',
      message: `${engine} search failed (${detail}) — falling back to model knowledge.`,
      engine,
      detail,
    });
    return { engine, query, items: [], error: detail };
  };

  if (tavily) {
    try {
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: tavily, query, max_results: maxResults, search_depth: 'advanced' }),
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) return fail('tavily', `HTTP ${r.status} ${trimText(await r.text().catch(() => ''), 160)}`);
      const d = await r.json();
      const items = (d.results || []).map((x) => ({ title: x.title, url: x.url, snippet: x.content }));
      return { engine: 'tavily', query, items };
    } catch (err) {
      return fail('tavily', errorSummary(err));
    }
  }
  try {
    const r = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`,
      {
        headers: { Accept: 'application/json', 'X-Subscription-Token': brave },
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!r.ok) return fail('brave', `HTTP ${r.status} ${trimText(await r.text().catch(() => ''), 160)}`);
    const d = await r.json();
    const items = (d.web?.results || []).map((x) => ({ title: x.title, url: x.url, snippet: x.description }));
    return { engine: 'brave', query, items };
  } catch (err) {
    return fail('brave', errorSummary(err));
  }
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

"humanCheckpoint" — the escalation rule, and it is deliberately narrow.
Set it true ONLY when the build is genuinely blocked on the human:
  · a PREFERENCE only they hold (budget ceiling, brand loyalty, size, colour)
  · a FACT only they can observe (what is already on their bench, which tools
    they own, whether the frame is 5" or 3")
  · a SAFETY sign-off that must happen before power is applied

Do NOT set it for ordinary uncertainty. An approximate spec, a part with three
equally good options, a price that varies by vendor, a detail a datasheet would
settle — none of these block anyone. Put them in "openQuestions" and carry on.

Rule of thumb: if you could pick a sensible default and the build would still
work, pick the default and set humanCheckpoint false. Every checkpoint you raise
costs the builder an interruption, and a build that asks them to verify all
twelve parts has not saved them any work — it has just moved it.`;

// Turn what was learned into reusable index context. Gathered fields are the
// valuable part; raw search titles are not.
function indexSummary(out) {
  const gathered = (out.gathered || []).slice(0, 10).map((g) => `${g.field}=${g.value}`);
  const validated = (out.understand?.validation || []).slice(0, 4);
  return [...gathered, ...validated].join(' | ').slice(0, 1200);
}

export async function researchPart({ part, project, registry, emit, indexer, prefer }) {
  const profile = getProfile(project.profileId);
  const topic = `${project.goal} — ${part.name} (${part.domain})`;
  const startedAt = Date.now();
  emit?.({
    type: 'research',
    stage: 'research',
    partId: part.id,
    part: part.name,
    message: `Researching ${part.name}…`,
  });

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
      reusedFrom: cached.topic,
    });
  } else {
    const webStart = Date.now();
    web = await webSearch(topic, { emit: emit ? (e) => emit({ ...e, partId: part.id, part: part.name }) : undefined });
    if (web && web.items.length) {
      emit?.({
        type: 'research',
        stage: 'web',
        partId: part.id,
        part: part.name,
        ms: Date.now() - webStart,
        message: `Web search (${web.engine}): ${web.items.length} results in ${Date.now() - webStart}ms.`,
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
    } else if (web?.error) {
      // already reported by webSearch — record it on the part's flow too
      emit?.({
        type: 'research',
        stage: 'web',
        partId: part.id,
        part: part.name,
        level: 'warn',
        message: `Web search unavailable (${web.error}) — using model knowledge.`,
      });
    } else if (!noWebKeyWarned.has(emit)) {
      // Said once per run, not once per part: twelve identical "no web-search
      // key" rows push the twelve things you actually wanted to read off the
      // bottom of the trace. The condition is a property of the run, not of any
      // single part, so it belongs in the trace once.
      if (emit) noWebKeyWarned.add(emit);
      emit?.({
        type: 'research',
        stage: 'web',
        partId: part.id,
        part: part.name,
        message:
          'No web-search key configured — using model knowledge for every part in this run (set TAVILY_API_KEY or BRAVE_API_KEY).',
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

  // What the HUMAN said at the checkpoint. This is the top rung of the
  // verification ladder, so it outranks both the index and the web results:
  // if they corrected a spec or answered an open question, the model must
  // honour that instead of re-deriving it.
  const humanNotes = (part.humanInput || []).filter((h) => h?.text);
  const humanBlock = humanNotes.length
    ? `\nHUMAN INPUT (authoritative — the builder told us this; treat it as a hard requirement and do not contradict it):\n${humanNotes
        .slice(-5)
        .map((h) => `- [${h.decision || 'note'}] ${h.text}`)
        .join('\n')}`
    : '';

  const user = `PROJECT GOAL: ${project.goal}
CONSTRAINTS: ${constraints}
PART: ${part.name} (domain: ${part.domain})
IDEA for this part: ${JSON.stringify(part.idea || {})}${humanBlock}
${prior ? 'PRIOR FINDINGS FROM INDEX' : 'LIVE WEB RESULTS'}:
${context}`;

  const llmStart = Date.now();
  const call = await generateWithMeta({
    registry,
    system: buildSys(profile),
    user,
    temperature: 0.2,
    maxTokens: 4096,
    emit,
    prefer,
    operation: `research:${part.name}`,
  });
  const out = parseResearchJSON(call, { emit, part });

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
    // Deliberately NOT `|| openQuestions.length > 0` any more.
    //
    // That clause meant every part with a single open question escalated to the
    // human. On a drone build that is all of them — there is always something
    // approximate about a motor, a prop or a price — so a twelve-part run came
    // back with twelve "needs your eyes" and the agent had not saved the builder
    // any work, it had just handed it back. Open questions are information; a
    // checkpoint is an interruption. They are different things.
    humanCheckpoint: Boolean(out.humanCheckpoint),
    web: prior
      ? { engine: 'index', count: 0, reusedFrom: prior.topic }
      : web
        ? { engine: web.engine, count: web.items.length }
        : { engine: 'none', count: 0 },
    // Provenance for the debugger: who answered, how fast, how many attempts.
    meta: {
      ...call.used,
      llmMs: Date.now() - llmStart,
      totalMs: Date.now() - startedAt,
      webEngine: prior ? 'index' : web?.engine || 'none',
      webCount: prior ? 0 : web?.items?.length || 0,
    },
  };
}

// Parse the research reply, tolerating fences/prose — and when it is unusable,
// fail with an error that names the provider, the model and the raw head.
function parseResearchJSON(call, { emit, part }) {
  const cleaned = call.text
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
  if (!out) {
    const error = new Error(
      `${call.used?.provider || 'provider'}/${call.used?.model || '?'} returned unusable JSON for ${part.name} ` +
        `(${cleaned.length} chars). First 300: ${trimText(cleaned, 300)}`,
    );
    error.name = 'InvalidJSONError';
    error.provider = call.used?.provider;
    error.where = `research:${part.name}`;
    error.raw = cleaned;
    emit?.({
      type: 'log',
      level: 'warn',
      partId: part?.id,
      part: part?.name,
      message: errorSummary(error),
      text: trimText(cleaned, 1200),
    });
    throw error;
  }
  return out;
}
