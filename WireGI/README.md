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
        jevQuestions.js # choice/score/noul builders — the strict API wire format
        profiles.js     # DOMAIN LAYER: schema, guards, ladder per domain
        indexer.js      # research index (speed-up: reuse prior findings)
        research.js     # research→gather→understand→data, schema from the profile
        reconcile.js    # cross-part integration: find contradictions, patch them
        gate.js         # Jev pre-LLM gates: triage / tier / risk / dup / affected  (Gap A)
        queue.js        # semaphore + token bucket + worker-pool map              (Gap B)
        retry.js        # capped backoff + jitter, retry-safe error classes       (Gap B)
        agent.js        # the orchestration: classify → decompose → research → integrate
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
  └─ Jev D1 (classify build + domains) → DOMAIN PROFILE selected
       electronics | mechanical | software | robotics | generic
       ↳ decides the research schema, the safety guards, the verification ladder
  └─ LLM decomposes into PARTS (frame, motors, ESC, FC, props, RX, video, battery, firmware…)
  └─ each PART runs through a bounded pool (default 4 at a time), with retries:
        Jev gate  (needed? tier? risk? duplicate? affected?)  ← keeps cheap parts off the LLM
        research  (live web search if TAVILY_API_KEY/BRAVE_API_KEY present, else model knowledge)
        → gather  (structured fields: part#, spec, price, source)
        → understand (validate constraints, flag open questions)
        → data    (BOM row, wiring, config, checklist)
        → indexed (similar topics reuse prior research)
        → checkpointed (saved after every part, so a crash is resumable)
  └─ RECONCILIATION: one cross-part pass — do the parts actually agree?
        Jev gate (are they even coupled?) → LLM hunts contradictions → patches applied in code
        blocking conflicts escalate to the human
  └─ Jev D4/D5/D6 gate: complete? needs-human-eyes? stop?
  └─ merge into project state; stream decisions + research + parts to the UI
```

## Domain profiles — how one engine builds *anything*

`services/profiles.js` is the domain layer. A profile declares what a given kind
of build needs, so the engine itself never changes:

| Profile | Research output | Safety-critical guards | Verification ladder |
| --- | --- | --- | --- |
| **electronics** | bomRow · wiring · config | battery, ESC, KV, power, polarity, firmware | research → sim → bench-test → human-eyes |
| **mechanical** | material line · joining · dimensions | load, torque, pressure, safety factor | research → cad-sim → load-test → human-eyes |
| **software** | dep line · interfaces · config | secrets, auth, migrations, data loss | research → unit-test → integration-test → human-eyes |
| **robotics** | bomRow · power/signal routing · control params | battery, ESC, thrust, thermal, failsafe | research → sim → bench → field-test → human-eyes |
| **generic** | item line · attachment · settings | power, load, heat, structural | research → test → human-eyes |

The profile is chosen from Jev's D1 classification plus the goal text, and it
drives three things: the **research schema** the LLM must fill, which parts are
**never gated** (wrong math destroys hardware — or leaks secrets), and the
**ladder** the UI shows. Adding a domain is adding an entry to `profiles.js`.

## Reconciliation — the answer to "fragmentation"

Parts are researched independently, which is fast and is exactly how a build ends
up globally wrong while every part is locally right. Battery capacity ↔ motor KV ↔
ESC current ↔ prop size is a *coupled* system; nine isolated research calls cannot
see a coupling.

So after the batch, `services/reconcile.js` runs one integration pass:

1. a cheap Jev gate decides whether the parts are **even coupled** — independent
   parts skip the expensive call entirely (fail-safe: unclear → reconcile anyway)
2. one LLM pass hunts contradictions across parts and proposes **patches**
3. patches are applied **in code**, to the field the part actually owns — the
   model never edits state directly
4. **blocking** conflicts escalate to the human; warnings become open questions
5. the pass is recorded on the project and shown in the UI's Integration panel

## Evidence, not booleans

`VERIFIED` is meaningless on its own at week six. Every part carries an
`evidence[]` trail naming the rung that produced each conclusion —
`research` (with the source count), `reconcile` (what changed), and `human-eyes`
(who approved, and what they said). The UI renders it under each part.

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

## Resilience & throughput (Gap B)

Parts no longer run through an unbounded `Promise.all`. They go through a zero-dep concurrency layer:

- **Bounded concurrency** — `services/queue.js` caps in-flight provider calls with a semaphore, plus an
  optional token bucket for strict RPM ceilings. Prevention beats cleanup: this is what stops a 9-part
  build from becoming a 429 storm.
- **Per-part retry** — `services/retry.js` retries only transient failures (429 / 408 / 5xx / timeout /
  network) with capped exponential backoff + full jitter, honours `Retry-After`, and fails fast on
  auth/client errors so a bad key never burns the retry budget.
- **Failure isolation** — a part that still fails is marked `failed` with its error message. Its siblings
  keep going and the project lands in `partial` rather than dying mid-run.
- **Per-part checkpoints** — state is saved after every part (serialized through one save chain, atomic
  tmp+rename), so a crash mid-run leaves resumable progress instead of nothing.
- **Resume** — `POST /api/projects/:id/resume`, or the **Resume N part(s)** button in the UI, re-runs only
  the `pending` / stale `researching` / `failed` parts and then re-runs the D4–D6 gate. Idempotent: a
  fully-built project is a no-op.

Knobs (all optional; put them in `forge/server/.env` if you want them there):

| Var | Default | Meaning |
| --- | --- | --- |
| `WIREGI_CONCURRENCY` | `4` | max in-flight provider calls |
| `WIREGI_RPM` | `0` (off) | provider requests/minute ceiling |
| `WIREGI_RETRIES` | `4` | extra attempts after the first |
| `WIREGI_RETRY_BASE_MS` | `500` | first backoff delay (ms) |
| `WIREGI_RETRY_MAX_MS` | `30000` | backoff ceiling (ms) |
| `WIREGI_JEV_TIMEOUT_MS` | `8000` | live Jev deadline; slower than this, the decision is routed to the LLM |

## Gotchas (read before editing)

**1. Forge cross-imports are one level deeper inside `services/`.**

| File location | Correct prefix |
| --- | --- |
| `server/src/*.js` (`config`, `routes`, `index`) | `../../../forge/...` |
| `server/src/services/*.js` (`llm`, `jevClient`) | `../../../../forge/...` |

An off-by-one here is `ERR_MODULE_NOT_FOUND` at boot, and `node --check` cannot see it. Verify with:

```bash
node WireGI/scripts/check-imports.cjs
```

It is a static checker (no install, no run, no bundler) and runs three passes:

1. **RESOLVE** — every relative import exists on disk
2. **EXPORTS** — every named local import is actually exported by its target
3. **SYMBOLS** — every local export that a file *calls* is imported or defined there
   (catches "used `isSafetyCritical` but never imported it", which parses fine and
   fails at runtime)

It exits non-zero on any finding. It has already caught two real ones during
development — a missing `resumeProject` export and an unimported symbol.

> **Editing tip:** never issue two parallel edits to the same file — they race and
> one is silently lost. Edit sequentially, then run this checker to confirm.

**2. Never hand-write Jev question objects — use `services/jevQuestions.js`.**

The TypeSafe API is strict about `criteria`, and a violation fails the whole batched call with a 422:

```js
choice('What kind of build is this?', {
  electronics: 'Primarily an electronics/wiring build',   // choice -> DICT { key: description }
  mechanical:  'Primarily a mechanical/fabrication build',
});
score('How critical is this part?', ['low', 'medium', 'high']);  // score -> ARRAY (answer = index)
noul('Is the gathered data sufficient?');                        // noul  -> no criteria (answer = 0..1)
```

A `choice` with a bare array of strings is rejected: *"Input should be a valid dictionary"*. Builders enforce the
correct shape, and the readers (`answerValue`, `noulTrue`, `answerCertainty`) understand the real reply shapes:
`{choice:'<key>'}`, `{noul:0..1}`, `{score:<index>}`.

**3. The port is pinned to 4322.** The shared `forge/server/.env` sets `PORT=4321` (Forge's port), so WireGI must
not inherit it — it hard-codes 4322 and never reads `PORT`.

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
- Everything is durable: kill the server mid-project and hit **Resume** — finished parts are on disk,
  only the missing ones are re-run.
