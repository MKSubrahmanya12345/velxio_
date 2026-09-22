# Velxio Create — learn from links, ship validated scripts

Velxio Create is the **CREATE** tab in the agent sidebar: a chat-only content
workspace. It has no access to your circuit or code — it learns from content
you feed it and turns prompts into JEV-validated creator packs.

## The loop

```
LEARN                              CREATE
paste link ─► transcript/text ─►   prompt ─► ranked ideas ─► full pack
YouTube, article, or pasted text    (script + hooks + titles +
stored as JEV-governed nodes        thumbnails + sources)
```

1. **Learn** — drop a YouTube link, an article URL, or pasted text into a
   **collection**. The transcript/text is pulled, distilled into atomic
   **nodes** (Forge memory notes), and JEV-reviewed before storage.
2. **Create** — pick a collection + format, describe what you want. The
   pipeline retrieves matching nodes, proposes idea candidates grounded in
   them, has **JEV cross-compare each idea** against the stored nodes
   (support score, conflicts flagged), and expands your pick into a **full
   pack**: script, alternate hooks, title options, thumbnail concepts, the
   sources used, and claims to verify.
3. **Curate** — nodes are yours: edit or delete any of them instantly from
   the Library. Manual edits never trigger JEV interruptions; they are
   logged to the collection's event trail.

## Setup

Create runs on the Forge service, same as the circuit agent's memory layer:

```bash
# backend/.env
FORGE_ENABLED=true
FORGE_BASE_URL=http://127.0.0.1:4321
FORGE_AUTOSTART=true   # spawn `node --watch` on forge/server automatically
```

Forge needs generation providers (Providers page or `forge/server/.env`):

- **Gemini key** — unlocks native YouTube transcription: the model watches
  the video server-side (transcript + visuals), so no video bytes pass
  through Forge and YouTube's datacenter bot-wall never applies.
- **Any other key** (OpenRouter, Bedrock, Ollama, Groq, OpenAI-compatible) —
  joins the failover loop for summaries, ideas, and scripts.
- **JEV (`TYPESAFE_API_KEY`)** — idea scoring and ingest review. When JEV is
  down or unconfigured the pipeline fails open: imports store by user
  authority, ideas return unscored. Nothing blocks.

Without a Gemini key, YouTube ingest falls back to a keyless public-caption
pull, cleaned up through the normal failover loop.

## How transcription failover works

`forge/server/src/creative/transcribe.js`: every configured Gemini key is
tried in registry order (10-round budget shared with the rest of Forge —
see `providers/failover.js`). Only when all Gemini attempts fail does the
pipeline pull public captions. Transcription attempts are returned on the
ingest response (`attempts[]`) so the UI can show what route succeeded.

## API

Python (`/api/creative/*`) is a thin proxy to Forge (`/api/creative/*`).
No provider URLs or keys ever touch the browser.

| Method | Path | What |
| --- | --- | --- |
| GET | `/status` | Forge reachability + output formats |
| POST / GET | `/collections` | Create / list collections |
| GET / DELETE | `/collections/:id` | Detail (notes + source previews) / delete |
| POST | `/collections/:id/ingest` | `{url}` or `{text, title}` → nodes |
| GET | `/collections/:id/notes?q=` | All nodes, or keyword retrieval |
| PATCH / DELETE | `/collections/:id/notes/:noteId` | Manual node edit / delete |
| POST | `/collections/:id/ideas` | `{prompt, count}` → JEV-ranked ideas |
| POST | `/collections/:id/script` | `{idea, prompt, format}` → full pack |

Formats: `video-script`, `blog-post`, `tutorial`, `social-captions`,
`product-copy`.

## Limits (by design)

- 1 YouTube video per ingest; public videos only (~8 hrs/day per Gemini key).
- 8 nodes max per ingest, 500 notes per collection (same cap as chat memory).
- Articles must be publicly readable — paywalled/app-rendered pages fail
  with a clear error. Private/local URLs are rejected (SSRF guard).
- Two concurrent creative jobs per backend worker; extra requests get 429.
- Retrieval is keyword-based (no embeddings) — precise prompts retrieve
  better. A stale `data/projects.json` is never reset: corrupt stores throw
  instead of wiping memory (Forge store contract).

## Tests

- `forge/server/test/creative.test.js` — transcription routes, caption/page
  parsing, note ops, retrieval ranking, idea scoring, ingest (`npm test`).
- `backend/tests/test_creative.py` — proxy shaping, validation, fail-open
  status (`pytest backend/tests/test_creative.py`).
