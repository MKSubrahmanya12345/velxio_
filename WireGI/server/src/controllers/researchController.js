import { webSearch } from '../services/research.js';
import { generate } from '../services/llm.js';

export function createResearchController({ registry, indexer }) {
  return {
    search: async ({ query }) => {
      const web = await webSearch(query);
      let summary = '';
      if (web && web.items.length) {
        const src = web.items.map((i) => `- ${i.title} (${i.url}): ${i.snippet}`).join('\n');
        summary = await generate({
          registry,
          system: 'Summarize these web results into 5 concise, build-relevant bullet points. Cite source URLs.',
          user: `QUERY: ${query}\n\n${src}`,
        });
      } else {
        summary = await generate({
          registry,
          system: 'Answer the query from your knowledge, concisely, with bullets. State this is model knowledge, not live web.',
          user: `QUERY: ${query}`,
        });
      }
      indexer?.add({ topic: query, summary, sources: web ? web.items.map((i) => i.url) : [], partName: '(manual)' });
      return {
        query,
        web: web ? { engine: web.engine, count: web.items.length, items: web.items } : null,
        summary,
      };
    },
  };
}
