# WireGI — agentic build assistant

WireGI turns a build request ("make me a drone") into a **decomposed, researched, decision-gated
project** with a persistent `IDEA → CURRENT → VERIFIED` state, and streams every decision and finding
back to a communication UI. No simulation — text output only.

It is built to mirror **Forge** (`../forge`): same backend/frontend split, `models / routes / controllers`
layout, and — critically — it **reuses Forge's exact AI plumbing** (multi-provider LLM failover + the
Jev typed-decision client) by importing it directly from `../forge/server/src`.

**WireGI owns its configuration now**: `WireGI/server/.env` (copy `.env.example`) is loaded first and
always wins; `forge/server/.env` is only an optional fallback, used for keys this file does not define
(switch it off with `WIREGI_INHERIT_FORGE_ENV=false`).

## Ports — the four apps side by side

| App | UI | API |
| --- | --- | --- |
| **Velxio** (repo root, `frontend/`) | **5173** | 8000/8080 |
| **Forge** (`forge/client`) | **5174** | 4321 |
| **WireGI** (`WireGI/client`) | **5175** | 4322 |
| **WireGI mobile** (`WireGI/mobile`) | **5176** (dev) · **4322/m/** (prod) | — |

WireGI reads its own ports from `WIREGI_CLIENT_PORT` / `WIREGI_PORT`, so `PORT=4321` in a Forge `.env`
can never drag it onto Forge's port.

```
WireGI/
  server/                # Node (ESM), mirrors forge/server/src
    src/
      env.js             # loads WireGI/server/.env FIRST, remembers where each key came from
      config.js          # WireGI config (ports 4322/5175, paths, debug knobs) + Forge fallback
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
        debug.js        # THE DEBUGGER: tracer, levels, timings, full error records
        agent.js        # the orchestration: classify → decompose → research → integrate
                        #  + runs/runLog/errors per project, respondHuman() checkpoint
      controllers/       # project / research / decision controllers
      routes/            # express routers (ndjson streaming for live UI)
        debugRoutes.js  # /api/debug/{env,health,llm-test,web-test,index}
      ../scripts/
        mock-llm.mjs    # DEV FIXTURE: fake OpenAI-compatible provider (not the product)
        smoke.mjs       # end-to-end flow test over the real HTTP stream
      index.js          # express entry; mounts Forge's provider router too
  client/                # React + Vite (mirrors forge/client)
    src/
      api.ts            # REST + ndjson streaming client (+ respondHuman, exportTrace)
      lib/events.ts     # event → level/title/detail/error (never prints `undefined`)
      lib/useProject.ts # the store: project + live trace + run state + human checkpoint
      lib/markdown.tsx  # dependency-free markdown for agent replies
      pages/            # HomePage, ProjectPage
      components/       # ChatPanel (chat, left) · InspectorPanel (info, right) with
                        # OverviewPanel, PartCard, FlowPanel (the debugger), DecisionLog,
                        # ResearchLog, ReconcileLog, DebugPanel, HumanCheckpoint,
                        # ProviderStrip, TopBar, HowItWorks, ConfidenceMeter, StepCard
  mobile/                # WhatsApp-style mobile chat app for the human checkpoint
    src/
      lib/api.ts        # trimmed REST + ndjson streaming client (sendMessage, respondHuman)
      lib/types.ts      # Project / Part / ChatMsg + checkpointPartsOf() (needs-your-eyes set)
      lib/markdown.tsx  # dependency-free markdown for agent replies
      components/       # ChatsList (list) · ChatThread (chat + checkpoint card) · CheckpointCard
      App.tsx           # hash router: #/ = chats, #/p/:id = thread
```

## How a request flows

Every run is traced end to end, so this diagram is also the Flow panel you debug with:

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
  └─ HUMAN CHECKPOINT (chat): approve / answer / re-run / reject — deterministic,
     recorded on the evidence ladder, and the way out of `awaiting_human`
```

Stage order on the wire (each stage is a `phase.start` / `phase.end` pair):
`classify → decompose-plan → decompose → research (per part: triage → research → sufficiency) →
reconcile → verify → done`, with `batch.*`, `provider.*`, `human.*` and `run.*` events around them.

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
# 1) configure (WireGI's OWN env — copy the example and fill in one provider key)
cp WireGI/server/.env.example WireGI/server/.env

# 2) server
cd WireGI/server && npm install && npm start        # listens on :4322

# 3) client (another terminal)
cd WireGI/client && npm install && npm run dev      # http://localhost:5175 (proxies /api → :4322)

# 4) mobile (optional — the checkpoint chat, WhatsApp-style)
cd WireGI/mobile && npm install && npm run dev      # http://localhost:5176 (proxies /api → :4322)
#    open it on a phone: http://<your-LAN-ip>:5176 — the dev server binds 0.0.0.0.
#    production build:  npm run build, then the server serves it at http://localhost:4322/m/
```

Then open **http://localhost:5175**, type **`make me a drone`**, and watch the chat on the left and the
inspector on the right fill in: parts, the live flow, decisions and the integration pass. When a build
hits `awaiting_human`, the parts that need your eyes are also a WhatsApp-style chat at **5176** (or
`/m/` on a phone) — approve, answer & re-research, note, or reject & re-run straight from chat.

### Verify it without spending tokens

```bash
cd WireGI/server && npm run smoke     # dev mock provider + assertions over the real HTTP stream
cd WireGI/client && npm run test:render   # renders the panels; fails if any "undefined" reaches the UI
node WireGI/scripts/check-imports.cjs     # every relative import resolves and exports what it claims
```

`npm run smoke` starts `scripts/mock-llm.mjs` (a dev fixture — the product itself only ever uses real
providers), drives a full build, then injects a provider failure, resumes, and exercises the human
checkpoint. It asserts: 60+ trace events, one event per part, a non-empty message on every event,
monotonic sequence numbers, a persisted run log, and a working `/api/debug/*`.

## The debugger

WireGI previously told you *that* something failed; it now tells you **what, where, when and why** —
and it is impossible for it to print `ERROR undefined`:

| Surface | What it gives you |
| --- | --- |
| **Flow** (right panel) | Every event with level, sequence, `+1.23s` timing, part context and expandable payload. Filter by level/part/text; expand any row for the full object. |
| **Errors** | A full record — `name`, `message`, `where`, `status`, provider, `stack`, and the per-key **attempt table** (status + latency + message for every credential the failover loop tried). |
| **Runs** | One record per run (`build`/`message`/`resume`/`human`): status, wall-clock ms, event count, error. |
| **Debug tab** | Which `.env` files are in play, every key with its **provenance** (real env / WireGI .env / Forge fallback) and why one is missing, a live **Test LLM now** button, web-search test, the port map, and this project's run/error history. |
| **Export** | The whole trace as JSON, in one click. |
| **stdout** | With `WIREGI_DEBUG=1`, one labelled line per event, including a trimmed stack for errors. |

Event contract (the UI depends on it): `{ seq, ts, t, runId, level, type, stage, message, …payload }`.
`message` is always a non-empty string; a provider attempt failure is `type: 'provider'` (never
`'error'`); a terminal failure is a single `{ type: 'error', fatal: true, error: {…} }`.

## The human checkpoint

`awaiting_human` used to be a dead end — the project said "needs you" and the only way out was a
free-text message whose intent an LLM had to guess. It is now a first-class, **deterministic** path
(no Jev, no LLM, no tokens — it works with zero provider keys):

```
POST /api/projects/:id/human   { partId?, decision, text }
  decision: approve | provide | rerun | reject
```

- **approve** → the part becomes `verified`, and a `human-eyes` rung is appended to its evidence trail
  with who approved and what they said. "Approve all" covers every researched part.
- **provide** → your answer is stored on the part (`humanInput`) and recorded in the conversation.
- **rerun / reject** → the part is re-researched with your input, which is injected into the research
  prompt as authoritative (`HUMAN INPUT … do not contradict it`).

In the UI this is a card in the chat: each waiting part lists its open questions, the researched BOM
and wiring it wants you to confirm, a box for your answer, and **Approve / Answer & re-research / note
only / Reject & re-run**. The card also appears whenever the project itself is `awaiting_human`, even if
no single part raised a checkpoint.

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

**3. Ports are WireGI's own.** The UI is **5175** (Velxio 5173, Forge 5174), the mobile chat is **5176**,
and the API is **4322**.
Both come from WireGI's `.env` (`WIREGI_CLIENT_PORT` / `WIREGI_PORT`) — WireGI never reads `PORT`, so a
Forge `.env` with `PORT=4321` cannot drag it onto Forge's port.

**4. The mock LLM is a test fixture, never a fallback.** `scripts/mock-llm.mjs` exists so the flow can be
tested without keys; nothing in `src/` starts it or degrades to it. A run with no provider fails with a
precise error, by design.

## Configuration — `WireGI/server/.env`

Copy `WireGI/server/.env.example` and fill in at least one provider key. Precedence, highest first:

1. **real environment** (shell / docker / CI) — never overridden by a file
2. **`WireGI/server/.env`** — WireGI's own config, always wins over a file fallback
3. **`forge/server/.env`** — optional fallback, used only for keys not defined above

Set `WIREGI_INHERIT_FORGE_ENV=false` to switch the fallback off completely. Every key the server sees is
reported by `/api/debug/env` and shown in the UI's **Debug** tab **with its source** — so "why is this
key not working?" has an answer that does not require reading code. Secrets are masked; they are never
sent to the browser.

| Group | Keys |
| --- | --- |
| Server | `WIREGI_PORT` (4322) · `WIREGI_CLIENT_PORT` (5175) · `CORS_ORIGIN` · `DATA_FILE` · `PROVIDERS_FILE` · `GLOBAL_RULES_FILE` |
| Debug | `WIREGI_DEBUG` · `WIREGI_LOG_LEVEL` · `WIREGI_RUNLOG_LIMIT` · `WIREGI_LOG_PROVIDER_ATTEMPTS` |
| LLM | `GEMINI_API_KEY` · `OPENROUTER_API_KEY` · `GROQ_API_KEY` · `LLM_API_KEY`/`LLM_API_BASE` · `OPENCODE_API_KEY` · `OLLAMA_MODEL`/`OLLAMA_BASE` · AWS Bedrock keys · `PLANNER_PROVIDER` · `FAILOVER_MAX_ROUNDS` |
| Jev | `TYPESAFE_API_KEY` · `TYPESAFE_MODEL` · `WIREGI_JEV_TIMEOUT_MS` |
| Web search | `TAVILY_API_KEY` · `BRAVE_API_KEY` |
| Throughput | `WIREGI_CONCURRENCY` · `WIREGI_RPM` · `WIREGI_RETRIES` · `WIREGI_RETRY_BASE_MS` · `WIREGI_RETRY_MAX_MS` |
| Env | `WIREGI_INHERIT_FORGE_ENV` |

With **no** LLM key the server still boots, still streams a full trace, and fails *visibly*: the header
shows `no LLM key`, a banner explains the fix, and the first failed call carries a precise message (plus
a `hint`) instead of an empty error. `POST /api/debug/llm-test` tells you exactly which credential was
tried, with which status and latency.

## Notes

- Text-only by design (no Velxio simulation here — that is Phase 2).
- Provider management UI endpoints are reused from Forge (`/api/providers/*`).
- Everything is durable: kill the server mid-project and hit **Resume** — finished parts are on disk,
  only the missing ones are re-run.
