# WireGI — agentic build assistant

WireGI turns a build request ("make me a drone") into a **decomposed, researched, decision-gated
project** with a persistent `IDEA → CURRENT → VERIFIED` state, and streams every decision and finding
back to a communication UI. No simulation — text output only.

It is built to mirror **Forge** (`../forge`): same backend/frontend split, `models / routes / controllers`
layout, and — critically — it **reuses Forge's exact AI plumbing** (multi-provider LLM failover + the
Jev typed-decision client) by importing it directly from `../forge/server/src`. It reads provider keys
from **`../forge/server/.env`** and does **not** create a new `.env`.

```
WireGI/
  server/                # Node (ESM), mirrors forge/server/src
    src/
      config.js          # loads Forge's config (=> forge/server/.env), overrides only paths/port
      store.js           # zero-dep JSON project store
      models/project.js  # Project + Part domain models (3-state: idea/current/verified)
      services/
        llm.js          # generate()/generateJSON() over Forge's failover loop
        jevClient.js    # Jev decisions; LLM fallback when no TYPESAFE_API_KEY
        indexer.js      # research index (speed-up: reuse prior findings)
        research.js     # webSearch() + research→gather→understand→data pipeline
        agent.js        # the orchestration: classify → decompose → parallel research → gate
      controllers/       # project / research / decision controllers
      routes/            # express routers (ndjson streaming for live UI)
      index.js          # express entry; mounts Forge's provider router too
  client/                # React + Vite (mirrors forge/client)
    src/
      api.ts            # REST + ndjson streaming client
      pages/            # HomePage, ProjectPage
      components/       # ChatView, PartCard, DecisionLog, ResearchLog, ProviderStrip,
                        # HowItWorks, ConfidenceMeter, StepCard (Forge UI vocabulary)
```

## How a request flows

```
PROMPT
  └─ Jev D1 (classify build + domains)
  └─ LLM decomposes into PARTS (frame, motors, ESC, FC, props, RX, video, battery, firmware…)
  └─ each PART runs, in PARALLEL:
        research  (live web search if TAVILY_API_KEY/BRAVE_API_KEY present, else model knowledge)
        → gather  (structured fields: part#, spec, price, source)
        → understand (validate constraints, flag open questions)
        → data    (BOM row, wiring, config, checklist)
        → indexed (similar topics reuse prior research)
  └─ Jev D4/D5/D6 gate: complete? needs-human-eyes? stop?
  └─ merge into project state; stream decisions + research + parts to the UI
```

The human approves parts that need their own eyes; the agent keeps iterating until satisfied.

## Run it

```bash
# 1) server (reuses forge keys from ../forge/server/.env)
cd WireGI/server && npm install && npm start        # listens on :4322

# 2) client (in another terminal)
cd WireGI/client && npm install && npm run dev      # http://localhost:5173 (proxies /api → :4322)
```

Then open the client, type **`make me a drone`**, and watch the live event stream, the per-part cards
(research/gather/understand/data), and the Jev decision log fill in.

## Configuration (no new .env)

WireGI does **not** create its own `.env`. It imports Forge's `loadConfig()`, which loads
`../forge/server/.env`. So:

- **LLM providers** (Groq, Gemini, OpenRouter, Ollama, OpenAI-compatible, Bedrock) — configured exactly as
  in Forge.
- **Jev** — set `TYPESAFE_API_KEY` in `forge/server/.env` (the decision-maker). Without it, WireGI falls
  back to an LLM acting as the typed decision model so the flow still runs.
- **Web search** (optional, for *proper* web research) — add `TAVILY_API_KEY` or `BRAVE_API_KEY` to
  `forge/server/.env`. Without it, research uses model knowledge and the log notes that.

WireGI overrides only its own runtime paths (`data/wiregi-*.json`) so it never clobbers Forge's data.

## Notes

- Text-only by design (no Velxio simulation here — that is Phase 2).
- Provider management UI endpoints are reused from Forge (`/api/providers/*`).
- Everything is durable: kill the server mid-project and resume — the project state is on disk.
