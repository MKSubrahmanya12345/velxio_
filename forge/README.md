# Velxio Forge — project synthesizer

> **"Give it a goal. It synthesizes the build, then lives at the workbench with you — one step at a time — until it works."**

Forge is a sub-project of Velxio: a **project synthesizer with human/AI communication**.
You type a goal — *"build me a working iron man helmet"*, *"build me an MP3 player"* —
and Forge turns it into a concrete build plan, then runs the build as a collaboration:

- **AI** brings knowledge + tools (plan synthesis, decisioning, and — for electronic
  sub-assemblies — the Velxio circuit emulator itself as a verification tool).
- **Humans** bring brain + body (they physically execute steps and report back).
- **The interface** between the two is the product: one step in front of you at a time,
  typed questions answered by Jev, and calibrated confidence shown as a first-class UI concept.

It is designed to work on **anything buildable**: the plan decomposes into steps, each
step is tagged `sim` (verifiable in the Velxio emulator before touching real parts) or
`physical` (executed by the human), and both tracks report into the same state object.

---

## Core idea: ProjectState **is** Jev's `state`

The load-bearing architectural decision, borrowed directly from how TypeSafe's Jev model
works (it evaluates typed *questions* against a *state* and returns structured decisions —
no text generation, no parsing):

```
                    ┌────────────────────────────────────────────┐
   goal ──────────► │  J1 feasibility gate (Jev)                 │
                    └──────────────────┬─────────────────────────┘
                                        │ buildable
                    ┌──────────────────▼─────────────────────────┐
                    │  Planner (LLM or mock KB)                  │
                    │  → phases / steps / BOM / acceptance       │
                    └──────────────────┬─────────────────────────┘
                                        │
            ┌───────────────────────────▼───────────────────────────┐
            │                PROJECT STATE OBJECT                  │
            │  goal · constraints · phases→steps (sim|physical)    │
            │  BOM · inventory · progress · log · skill · safety   │
            │                                                     │
            │  ◄── this same object is the `state` sent to Jev ──► │
            └───────────────────────────▲───────────────────────────┘
                                        │
      human message (text + chip) ─────┤
                                        │
              J2 triage ─► J3 verify ─► J4 substitutes ─► J6 safety
                          J8 fan-out   J9 acceptance    J10 difficulty
                                        │
                            ┌───────────▼───────────┐
                            │  state machine (code) │  deterministic transitions
                            │  + J5 confidence gate │  only: advance / retry /
                            └───────────────────────┘  clarify / escalate / halt
```

Three layers, three roles:

| Layer | Role | What it is |
|---|---|---|
| **Jev** | nervous system | high-volume, low-latency *decisions* (one batched call per decision; ~150ms on the real API) |
| **Planner (LLM)** | prefrontal cortex | *generation* — the plan itself, and escalation answers when Jev's confidence drops |
| **State machine (plain code)** | skeleton | every transition is a straight-line rule over structured verdicts; no LLM text is ever parsed for control flow |

### Why Jev is the heart of it

Every interaction in the build loop needs a *judgment*, not prose: is this message a
completion report? Was the step actually done? Is that part a valid substitute? Is this
step hazardous? Does the build meet its acceptance criteria? That is dozens-to-hundreds
of small decisions per project — exactly the "smart if-statement" workload Jev was
built for, at ~$0.0004/call and 70–500ms. An LLM-only loop would be ~100x more expensive
per decision and 3–300s slow, which is fatal when a human is standing at the bench
waiting. Jev makes a *persistent* human↔AI build companion economically and
perceptually viable; the LLM stays on call for the parts that genuinely need generation.

---

## The Jev decision catalog (J1–J10)

Each decision = **one batched Jev call** (the TypeSafe docs' "one call, many questions"
doctrine — questions in a request are evaluated in parallel and in isolation, so adding
questions barely changes latency) + a **pure verdict function** in
[`server/src/decisions/catalog.js`](server/src/decisions/catalog.js).

| # | Decision | Trigger | Jev question types | Code behavior |
|---|----------|---------|--------------------|----------------|
| J1 | **Feasibility gate** | project creation | Choice (category, buildability) · Noul (risky) · Score (complexity, budget) | `no` → project **aborted** with a refusal (weapons etc. die here); otherwise plan synthesis proceeds |
| J2 | **Message triage** (hot path) | every human message | Choice (intent, 9 options) · Noul (safety concern) · Score (frustration) | routes the message to the right branch; intent conf < 0.55 → **do not act**, ask for rephrase |
| J3 | **Step verification** | "done" reports | Noul (verified vs. the step's definition-of-done) · Score (quality) | pass + certainty ≥ 0.6 → advance · pass but < 0.6 → **clarify** · fail → retry (count failures) |
| J4 | **Substitute matching** | "I have X, not Y" / 2nd failure | per inventory item: Noul (valid substitute?) + Score (compatibility) — a map-reduce over your inventory | best item ≥ threshold → **proposal** (human accepts/declines); none → escalation note |
| J5 | **Confidence gating** | meta-rule over all verdicts | — (code) | the *stakes* of each decision set its threshold: low-stakes act, medium-stakes clarify, high-stakes escalate. Noul answers carry no separate confidence in the API, so their gating certainty is `max(p, 1−p)` |
| J6 | **Safety interlock** | each step start | Noul per hazard listed on the step | any high-severity hazard present → **acknowledge button required** before the step can complete. Fail-safe direction: uncertainty counts as hazard present |
| J7 | **Skill calibration** | step outcomes | — (code, M1: Jev-scored) | per-skill success/fail counters from completed/failed steps → smoothed level shown in the sidebar; future: drives instruction granularity |
| J8 | **Speculative fan-out** | after each advance | 3 Noul probes (inventory? checkpoint? open question?) | code picks whichever crossed 0.55 → rendered as suggestion chips. Asking is nearly free |
| J9 | **Completion acceptance** | "I think it's done" | Noul per acceptance criterion (≤8) | every criterion must be met **with certainty ≥ 0.8** or the claim is rejected with the unmet list. A false "done" is worse than a false "not done" — hence the highest bar in the system |
| J10 | **Plan difficulty match** | failures | Score (right level → over my head) | ≥ 2.5 → replan proposal (finer granularity) |

### Where Jev is **not** used (honest boundaries)

- **Plan generation** is the LLM's job — Jev cannot generate text, and a whole build
  plan is exactly the kind of extended-reasoning artifact the TypeSafe docs say to
  *decompose*, not ask in one shot.
- **Free-form questions** are answered from plan context in mock mode; in full mode
  they go to the LLM. Jev only *classifies* that a question was asked (J2).
- **Photos** — Jev is text-only today (TypeSafe's demos explicitly run "not on images
  (yet)"). Report-back is structured text + chips in M0/M1; photo verification is M3.

---

## Architecture & folder layout

MERN, **dual folder** (`client/` + `server/`), per the request:

```
forge/
├── README.md                  ← this file (idea + implementation notes)
├── .gitignore
├── client/                    React 18 + Vite + TypeScript (UI, mirrors Velxio design tokens)
│   ├── index.html             dark no-JS baseline (same doctrine as the main app)
│   ├── vite.config.ts         dev proxy /api → :4321 (single origin in dev and prod)
│   ├── package.json
│   └── src/
│       ├── main.tsx / App.tsx / api.ts / types.ts / state.ts
│       ├── index.css          compact mirror of frontend/src/tokens/* (see "UI")
│       └── components/
│           ├── ProviderStrip.tsx    JEV/PLANNER/STORE live badges (mock = amber)
│           ├── NewProjectForm.tsx   goal + constraints intake
│           ├── ProjectList.tsx
│           ├── BenchView.tsx        the bench: header, step column, side column
│           ├── StepCard.tsx         one step: track badge, safety, parts, tools, DOD
│           ├── ReportPanel.tsx      chips + free text, proposals, Jev decision readout
│           ├── SidePanel.tsx        phases, BOM, inventory, skill profile, log
│           └── ConfidenceMeter.tsx  the calibrated-honesty widget
└── server/                    Express + Node (plain ESM JS, zero build step)
    ├── package.json           deps: express, cors, mongodb
    ├── .env.example           every knob documented
    ├── scripts/smoke.mjs      dependency-free end-to-end core test (no npm install needed)
    └── src/
        ├── index.js           entry: providers + store + routes + static client serving
        ├── config.js          env parsing; real providers fall back to mock without keys
        ├── schema.js          the ProjectState model + sanitizePlan() (plan trust boundary)
        ├── pipeline.js        synthesizeProject() + handleMessage() — the skeleton
        ├── stateMachine.js    pure transition helpers (complete/advance/ack/skill)
        ├── store.js           FileStore (default) | MongoStore (MONGODB_URI set)
        ├── routes.js          REST API (thin — all logic is in pipeline.js)
        ├── decisions/
        │   └── catalog.js     J1–J10: question builders + verdicts + runDecision()
        └── providers/
            ├── jev.js             Jev factory: real TypeSafe API | mock
            ├── jevMock.js         deterministic offline Jev — **exact real API response shape**
            ├── planner.js         Planner factory: mock | OpenAI-compatible LLM | Bedrock
            ├── plannerMock.js     offline knowledge base: MP3 player, iron man helmet,
            │                      LED desk lamp + generic fallback template
            ├── plannerPrompt.js   shared planner system prompt + user prompt (all providers)
            ├── bedrock.js         AWS Bedrock **Converse API** planner (model-agnostic:
            │                      Claude, Nova, Llama, …) — zero AWS SDK deps
            └── sigv4.js           AWS SigV4 signer (node:crypto only) — verified against
                                   the official AWS test vector in scripts/smoke.mjs
```

### How each part was implemented

**`schema.js` — the state model.** Plain objects, zero deps. A `Project` is
`{ id, createdAt, updatedAt, state }` where `state` holds goal, constraints,
feasibility (from J1), `phases → steps[]` (each step: title, `track: sim|physical`,
instructions, materials, tools, `safety[]` with severity, `definition_of_done[]`,
`skills[]`, status, failure count), the BOM (with per-item status:
`pending | on_hand | ordered | used | substituted`), the builder's `inventory`
(the substitute-matching fuel), `acceptance[]` criteria (decomposed from the goal at
plan time — this is what J9 checks), a `log[]` (user / jev / system / plan entries —
the full audit trail, rendered in the sidebar), `skill` counters, `safetyAcks`,
`safetyGate` (the latest J6 result for the current step), `counters`
(messages, jevCalls, escalations, stepsCompleted, substitutions), `confidence`
(last-seen values for the UI), and the pending `proposal`.
`sanitizePlan()` is the **trust boundary** for plans: whatever the planner returns —
mock KB or LLM JSON — is coerced here (track whitelisting, severity whitelisting,
DOD backfill, BOM completion from step materials). An LLM that hallucinates a field
gets it dropped, not trusted.

**`decisions/catalog.js` — the decision catalog.** One file, ten decisions, each
`{ questions(ctx), verdict(answers, ctx) }`. `runDecision()` builds the question batch,
makes **one** Jev call, and returns `{ id, kind, summary, confidence, detail }` —
the `summary` string is rendered verbatim in the UI and the log, so every message
shows exactly what Jev decided and how confident it was. This is the "transparent
nervous system" feature.

**`providers/jevMock.js` — the offline Jev.** The mock is what makes the whole system
buildable and testable before a TypeSafe API key exists. It returns byte-for-byte the
same answer shapes as the real API (`choice`/`confidence`/`probabilities`,
`score`/`legend`, `noul`), pattern-matches the message text (fail words before done
words, chips as strong priors), and seeds confidences with a FNV hash of the input so
answers are **deterministic** — the smoke test is reproducible. The real adapter
(`providers/jev.js`) is a plain `fetch` to `POST /v1/systemone` with the `state`
serialized to JSON — if `TYPESAFE_API_KEY` is set, `config.js` flips the factory to it
with zero other changes.

**`providers/plannerMock.js` — the offline planner.** Knowledge base of three
electronics-first demo builds (MP3 player, iron man helmet, LED desk lamp) with
hand-written atomic steps, safety entries, DOD lists and realistic BOMs, plus a
generic 4-phase template for anything else (so "must work on anything buildable" holds
even with a mock). Each KB build deliberately includes at least one **`sim` step** —
the Velxio-emulator track — because that is the sub-project's unique edge over any
generic plan generator: electronic sub-assemblies get verified in simulation before a
human buys or solders anything.

**`providers/bedrock.js` + `providers/sigv4.js` — the Bedrock planner.** For
environments with AWS access: `PLANNER_PROVIDER=bedrock` uses the Bedrock **Converse
API** (`POST /model/{modelId}/converse`), which is model-agnostic — one request shape
and unified response across Claude, Nova, Llama, etc. (`BEDROCK_MODEL` picks the
inference profile, e.g. `anthropic.claude-sonnet-4-5` or `us.amazon.nova-pro-v1:0`).
The tricky part — request signing — is implemented as a dependency-free **SigV4
signer** in `sigv4.js` (node:crypto HMAC-SHA256 key-derivation chain, no AWS SDK),
and the smoke test pins it against the **official AWS SigV4 test vector**, so the
signing path is provably correct even though the sandbox can't call AWS. Credentials
come from `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
(+ optional `AWS_SESSION_TOKEN`); a `BEDROCK_ENDPOINT` override exists for LocalStack.
All three planner providers (mock / llm / bedrock) plan into the *same* prompt
(`plannerPrompt.js`) and the same `sanitizePlan()` trust boundary — the rest of the
system doesn't know or care which one generated the plan.

**`pipeline.js` — the skeleton.** Two entry points:

- `synthesizeProject()` — J1 gate → (abort if `no`) → planner → `sanitizePlan` →
  J6 on the first step → intro response.
- `handleMessage()` — the hot path, in order:
  1. **chip-only structural actions** (accept/decline proposal, safety ack) — no Jev
     call needed for these;
  2. **J2 triage** (one call: intent + safety + frustration);
  3. **branch on intent** with J5 gating at each branch (low intent confidence →
     rephrase; uncertain verify → clarify; second failure or "over my head" → J4
     substitutes / replan proposal);
  4. **safety incident override** — if J2 flagged a safety concern ≥ 0.5, a ⚠️ banner
     is layered on top of whatever the branch produced;
  5. log every Jev verdict and state transition, return `{ project, response, decisions }`.

  The `response.text` is the human-facing voice; the `decisions[]` array is the
  transparency payload. Nothing here parses free-form LLM text for control flow —
  every branch condition is a structured verdict.

**`stateMachine.js`** — pure helpers: `markStepComplete`, `advanceStep` (nulls the
pointer when the plan is exhausted), `skillOutcome` (J7 counters), `needsAck`
(fail-safe: `present !== false` counts as present).

**`store.js` — MERN with a practical twist.** The M in MERN is honored — set
`MONGODB_URI` and it runs on MongoDB (collection `forge`) — but the **default** is a
zero-dependency JSON file store (`data/projects.json`, atomic write-then-rename) so
the sub-project runs on a laptop with zero external services. Same 5-method contract
either way; routes don't know which is live.

**`routes.js` / `index.js`** — thin Express layer:
`GET /api/health` (reports which providers are live), `GET|POST /api/projects`,
`GET|DELETE /api/projects/:id`, `POST /api/projects/:id/messages` (the hot path),
`POST /api/projects/:id/inventory`. In production, `index.js` also serves
`client/dist` same-origin if it exists.

### The UI

The bench view implements the interface principles from the design:

1. **One next step, always** — `StepCard` renders exactly one step: track badge
   (SIM · Velxio / PHYSICAL), instructions, parts needed (✓ if you have them in
   inventory), tools, safety banner (red = acknowledge required before the step can
   complete), and "done when" checklist.
2. **Frictionless report-back** — `ReportPanel` chips (`Done / It failed / I have X,
   not Y / Question / I think it's done`) plus free text; chips are sent as
   structured signals, text goes through J2 triage.
3. **Calibrated honesty as UX** — every reply shows the Jev decisions that produced
   it (id + summary + confidence), the latest triage confidence is a meter in the
   bench header, and the system literally says "I'm only 58% sure that's actually
   done. Quick re-check: …" when certainty is low. No LLM chatbox can produce that
   sentence honestly; Jev's whole contract is about it.
4. **Proposals, not commands** — substitute and replan suggestions appear as
   accept/decline cards; the human keeps agency over every non-advance.
5. **The workbench sidebar** — phase timeline (✓ ▶ ·), BOM with live status and
   estimated cost, inventory editor (feeds J4), smoothed skill profile (J7), and the
   full log with Jev verdicts in mono.

**Design tokens** (`client/src/index.css`) are a compact **mirror** of the main app's
token system (`frontend/src/tokens/*`): same dark canvas `#0a0a0c`, same `--wb-*`
workbench ramp for the sidebar panels, same semantic colors (blue-600 solid primary
buttons — the main app's "Solid UI doctrine" — red/amber/green feedback), same radii
and Inter/JetBrains Mono stacks (loaded from Google Fonts in `index.html`, with the
system fallbacks already in the stack so it degrades offline). Same
dark-is-the-no-JS-baseline doctrine in `index.html`.

The polish pass on top: faint radial instrument glow behind the hero, a
3-card *Gate → Synthesize → Build together* strip so first-time visitors see the
concept before the form, fade-up animation on Forge replies (with the ⚒ Forge speaker
label), confidence-tier color coding on every Jev decision readout, a gentle pulse on
the active step in the sidebar, and hover transitions across interactive surfaces.

---

## Running it

Prereq: Node ≥ 18. **Everything works with zero keys** (mock Jev + mock planner +
file store). Add real providers by editing `forge/server/.env`.

```bash
# 1. API server (port 4321)
cd forge/server
npm install
npm run dev                 # or: npm start

# 2. Client (port 5174, proxies /api → 4321)
cd forge/client
npm install
npm run dev
```

Open http://localhost:5174. Production mode: `npm run build` in `client/` — the
server serves `client/dist` same-origin on 4321.

### Environment (server)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `4321` | API port |
| `MONGODB_URI` | *(empty)* | set → MongoDB (collection `forge`); empty → JSON file store |
| `DATA_FILE` | `./data/projects.json` | file-store location |
| `JEV_PROVIDER` | `mock` | `typesafe` **and** `TYPESAFE_API_KEY` set → real Jev; else mock (logged at boot) |
| `TYPESAFE_API_KEY` / `TYPESAFE_MODEL` / `TYPESAFE_BASE_URL` | `jev-latest` | real Jev endpoint config |
| `PLANNER_PROVIDER` | `mock` | `mock` \| `llm` (needs `LLM_API_KEY`) \| `bedrock` (needs region + key + secret) |
| `LLM_API_BASE` / `LLM_API_KEY` / `LLM_MODEL` | OpenAI, `gpt-4o` | OpenAI-compatible planner config |
| `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` | — | Bedrock credentials (standard AWS env vars) |
| `BEDROCK_MODEL` | `anthropic.claude-sonnet-4-5` | any Converse-capable model, e.g. `us.amazon.nova-pro-v1:0` |
| `BEDROCK_ENDPOINT` | *(AWS default)* | override, e.g. LocalStack `http://localhost:4566` |
| `CORS_ORIGIN` | *(open)* | e.g. `http://localhost:5174` |

### Suggested first demo (all mock)

1. Intake → example chip **"Build me an MP3 player"** → Synthesize.
2. Read step 1, reply `done` chip + "bench is set up and every part is identified".
3. Watch it advance to the **SIM · Velxio** step, then to the soldering step with a
   red safety banner — try replying "done" *before* acknowledging (it refuses), then
   acknowledge and report "joints are shiny and no bridges".
4. On the rail-verification step: "it failed, the 3v3 rail reads 2.8v".
5. Sidebar → add inventory: `10k potentiometer` → "i don't have the 10k resistor, i
   have a 10k potentiometer" → accept the proposal.
6. Try "I think it's done" mid-build (rejected with the unmet acceptance criteria),
   finish the remaining steps, claim done → acceptance gate passes.

---

## What was checked in the sandbox (and what wasn't)

Sandbox constraints: **no `npm install`, no running servers** — so the checks that
were possible are static + dependency-free:

| Check | Result |
|---|---|
| `node --check` on all 15 server JS/ESM files | ✅ all pass |
| JSON validation of all `package.json` / `tsconfig.json` | ✅ all parse |
| `node --experimental-transform-types --check` on the 3 plain-TS client files (`api.ts`, `state.ts`, `types.ts`) | ✅ all pass |
| Node-based **JSX scanner** on all 11 `.tsx` files (string/comment/template-aware bracket balance + real JSX tag pairing with self-closing and TS-generic handling) | ✅ all pass — it caught a real unescaped-apostrophe bug in `NewProjectForm.tsx` during the polish pass, fixed |
| `node scripts/smoke.mjs` — **end-to-end core-loop test** through the real `pipeline.js` (mock Jev returning exact real-API shapes + mock planner): intake gate → plan → verify/advance → safety interlock blocks completion until ack → ack + advance → failure + J10 → inventory → J4 substitute proposal (86% conf) → accept → early claim rejected → all 8 steps done → acceptance gate passes (91% min certainty) → weapon goal aborted at J1 | ✅ **15/15 PASS**, 43 Jev calls, 0 unhandled escalations |
| **SigV4 signer vs the official AWS test vector** (the exact AKIDEXAMPLE/us-east-1 vector from the AWS docs) — proves the Bedrock signing path byte-for-byte | ✅ pass |
| Planner provider selection (bedrock with creds → bedrock; bedrock without creds → mock; llm with key → llm; defaults → mock) | ✅ pass |
| `git status` — only `forge/` added; no reference/research files committed | ✅ clean |

**Not verifiable here** (needs `npm install` / network / a running service):

- TypeScript *type* checking of the client (`tsc --noEmit`) — syntax is checked
  (above); types are simple mirrors and should pass, but run the check after install.
- Express route behavior / MongoDB driver — the store contract is tiny and the routes
  are thin wrappers over the tested pipeline, but the HTTP layer itself wasn't exercised.
- The real TypeSafe endpoint, a live LLM planner, and a live Bedrock call — the
  adapters are plain `fetch` against the documented API shapes (Bedrock signing is
  vector-tested, but the network call itself hasn't been). Expect to verify response
  field names against your account on first live call.
- The UI was not rendered in the sandbox (no install/serve allowed) — the polish pass
  is static-checked only; open it and squint.

---

## Roadmap

- **M0 (done, this commit)** — state model, J1–J10 decision catalog, mock + real
  adapters, state machine, bench UI, smoke test.
- **M1** — photo report-back via an LLM describer feeding Jev judgments (until
  TypeSafe ships vision); Jev-scored skill calibration (J7) driving instruction
  granularity; per-domain confidence thresholds; light theme via the existing token
  mirror.
- **M2** — **sim-track integration**: electronic steps auto-routed into the existing
  Velxio agent workspace (research → draft → validate → live behavioural
  verification), with results written back into ProjectState and fed to J9 as
  machine-verified evidence. This is the step that makes Forge something no generic
  project planner can do.
- **M3** — multi-category plan quality (the generic template becomes per-category
  KBs), composite acceptance scoring, project sharing/export (a `.forge` file in the
  spirit of Velxio's `.vlx` convention).

## Design decisions & notes

- **Plain ESM JS server, TypeScript client** — the server has no build step
  (`node src/index.js` runs it), which matters for a sandbox-friendly sub-project;
  the typed contract lives in the decision catalog + state model, mirrored in
  `client/src/types.ts`.
- **Mock-first is a feature, not a shortcut** — the mock Jev returning the *exact*
  real API shape means the entire loop (including confidence-gating paths) is
  exercised offline, and flipping to real providers is a config change, not a
  refactor. The smoke test is the permanent guard for that contract.
- **The J1 gate refuses weapons** ("build me a rifle" → `buildability: no` →
  aborted project). Policy decision, one regex away from whatever you'd prefer.
- **Velxio synergy** — Forge reuses Velxio's design tokens and (in M2) its emulator
  and agent workspace; it does not fork either. Forge is orchestration, Velxio is
  the body the AI moves.
- **TypeSafe references** — the API shapes, question types, and patterns implemented
  here come from the official TypeSafe docs (docs.typesafe.ai: introduction,
  quickstart, primitives, confidence) and the Sept 15, 2026 launch post
  (typesafe.ai/blog/introducing-system-one-models-and-jev); no reference material was
  saved into the repo — only URLs cited in this file.
