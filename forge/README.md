# Velxio Forge — project memory, governed by JEV

Forge is a domain-independent project conversation: describe what you want to
create, establish what matters, and carry that understanding into future output.
A horror film, app, event, or physical build can all start in the same workspace.

**The LLM proposes and generates. JEV evaluates. Code controls state changes.**

## The new primary conversation loop

```text
User message + project memory + recent conversation
    → same configured LLM proposes atomic notes (with a scope/domain)
    → JEV evaluates origin, support, compatibility, conflicts, change authorization
      and reconciles earlier pending notes and open questions against this message
    → code applies accepted changes; uncertain notes stay pending with the exact reason
    → current project memory is supplied to the same LLM
    → LLM drafts a response
    → JEV checks every active goal / rule / fact / preference
    → pass (including a clarifying question response): save and deliver
      confirmed contradiction, unusable check value, or uncertain RULE check:
        one revision by the same LLM, then check again
      still unresolved: withhold the draft and state the exact blocking reason
```

The data structure is stable, but the **content and rule questions emerge from
what the user says**. There is no film-specific or electronics-specific schema in
the live memory pipeline. JEV receives `{ state, questions }` with typed `choice`,
`noul`, and `score` questions, not a request to write the assistant's response.

### How decisions are applied

- **Remembering is separate from classifying.** An active user commitment needs a
  grounded quote and a supporting JEV review (`support ≥ 0.85`). A confident kind
  label is NOT required: if JEV splits between fact/rule/preference, the statement
  is still remembered under the proposed kind and the lean is recorded. Only an
  explicit confident rejection, weak/absent support, an identified contradiction,
  uncertain compatibility, or an unauthorized replacement keeps a note pending.
- **Uncertainty is not contradiction.** `compatibility ≤ 0.15` is reported as a
  contradiction and must name the affected note (a `conflicts_with` choice over
  active note IDs). The middle band is reported as uncertainty — never as a
  conflict. Missing/malformed JEV values fail closed as "unknown" and say so.
- **JEV `confidence` is distribution spread, not a probability.** It gates only
  firm binary decisions (classification, replacement authorization). Disposition
  `deliver`/`clarify`/`revise` uses the argmax; only `revise` holds a draft, and a
  missing disposition never blocks a draft whose checks all passed.
- **Different scopes never conflict.** Every note carries a domain: `production`
  (real-world making), `fiction` (story world, including the supernatural),
  `creative` (style), `meta` (collaboration). A one-person production rule does
  not conflict with two fictional characters. Undecidable/supernatural elements
  are not explained or over-classified.
- **Questions stay free.** Asking clarifying questions is a normal, approved
  outcome (`clarify`), never a defect, and is never limited by the memory guard.
  Rule replacement and retiring an established commitment still require explicit
  user authorization (`change ≥ 0.9`); answering an open question does not.
- **Every turn reconciles memory.** Pending interpretations and open questions are
  revisited against the latest message (confirm / answer / drop / stay open). A
  re-stated pending declaration is confirmed in place — same note ID, no
  duplicates. Answered questions retire to history.
- **Exact values are visible.** Raw JEV responses are recorded on review/check
  events and in decision detail, a held draft lists what actually blocked it, and
  `npm --prefix forge/server run raw-reviews` prints one raw memory-review and one
  raw output-review response (live TypeSafe when configured, otherwise a
  read-only test fixture — the server itself never runs on mocks).

### What memory remembers

| Kind | Meaning |
|---|---|
| Goal | An explicitly stated outcome |
| Rule | A binding user constraint, including its scope and exceptions |
| Fact | A resource or project fact stated by the user |
| Preference | A non-binding user preference |
| Assumption | An AI inference, not a user commitment |
| Suggestion | An option, not an adopted requirement |
| Question | Something still unresolved |

Each note also carries a **domain** — `production`, `fiction`, `creative`, `meta`,
or `unknown` — so real-world constraints, story-world facts, and creative
direction are judged in their own scopes.

Each note has a stable ID, text, source-message ID, supporting user quote when
available, origin, status, timestamps, structured review values (including the
recorded label lean and named conflict targets), and replacement links. Statuses
are `active`, `proposed`, `pending`, `rejected`, and `superseded`.

- AI inferences/suggestions remain tentative; they cannot silently become rules.
- Changing an established note requires explicit user authorization, checked by
  JEV. Partial exceptions must preserve the old rule's scope or ask clarification.
- Superseded notes remain in history. They are excluded from active generation
  context and output checks.
- The transcript window is limited to 20 messages, but **all active notes** are
  supplied on every turn. Decision traces are not recursively fed into the LLM.
- Model judgments can be wrong. This is a consistency guard, not a proof system,
  security boundary, or verification of real-world work.

## Visible in the UI

The **Project Memory** panel sits next to the conversation on desktop and opens
from **Project memory** on smaller screens.

- Animated candidate cards show notes forming.
- The stage rail follows actual server events: Form → JEV → Context → Draft → Check.
- Active rules are prominent; AI ideas are visually tentative.
- A scan animation highlights notes while JEV checks a draft.
- Per-note outcomes show respected, conflicting, or uncertain checks —
  uncertainty is labeled as such, never as a conflict.
- **Why is this here?** reveals source quotes, review explanations and values,
  scope, and history. The decision trail exposes raw JEV responses and the exact
  blocking reasons for held drafts.
- **Change this note** prepares a user message; it never mutates memory directly.
- **Decision trail** lists actual recorded events and checks.
- **Replay recorded turn** plays the recorded sequence with an explicit replay
  label. It does not invoke providers or invent new decisions.
- Reduced-motion preferences disable visual animations. Failed streams retain the
  draft and distinguish unconfirmed working changes from persisted memory.

## Try the solo-film example

The Forge server runs **live AI providers only** — there are no mocks in the
app. JEV must point at TypeSafe and the planner at a real generation model; the
server refuses to boot without them (see [Real providers](#real-providers)).
Provider selection is credential-driven: a provider that is not fully configured
throws instead of silently switching to a fake one.

1. Start: `I want to make a horror film. Only me, no other actors or crew.`
2. Inspect the binding solo-production rule and the separate AI suggestion.
3. Send: `I have a phone`. The rule persists and is included in the next checks.
4. Send: `My brother can help on Sunday`. The possible replacement stays pending;
   it does not silently erase the original rule.
5. Use **Change this note** on the pending update. Complete the prepared message:
   `Only me except my brother may operate the camera on Sunday.`
6. Inspect the new rule and the retired original, then reopen the conversation.
7. Use **Replay recorded turn** to watch the evaluated sequence.

## Running

Client development/tests: Node 22.12+ on 22.x, Node 24.x, or Node 26+.
The standalone server declares Node ≥18 support.

```bash
# Separate terminals, from repository root
cd forge/server
npm install
npm run dev                 # API :4321; loads forge/server/.env, real providers only

cd forge/client
npm install
npm run dev                 # UI :5174; same-origin /api proxy
```

`server/.env` (copy from `server/.env.example`) supplies the credentials;
`config.js` loads it automatically on import. Vite binds to `0.0.0.0` and accepts
preview hosts. `VITE_API_PROXY` changes its server-side API target; browser
requests stay relative.

### Real providers

Configure the server environment using `server/.env.example`:

- `PLANNER_PROVIDER=llm`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_API_BASE` for an
  OpenAI-compatible chat-completions model; or
- `PLANNER_PROVIDER=bedrock` plus the documented AWS environment credentials,
  region, and `BEDROCK_MODEL` for signed Bedrock Converse requests.
- `JEV_PROVIDER=typesafe`, `TYPESAFE_API_KEY`, `TYPESAFE_MODEL`, and optionally
  `TYPESAFE_BASE_URL` for TypeSafe's `/v1/systemone` API.

Despite its legacy name, `PLANNER_PROVIDER` selects the same generation model for
memory proposal, response generation, and repair. JEV remains a separate decision
model. Each provider can be configured independently. The provider badges always
show the real configured provider — the app never silently runs on a mock.

`.env` is loaded by `config.js` on import (real environment variables win). On
Node 22+, you can alternatively use `node --env-file=.env --watch src/index.js`
from `forge/server`. Do not commit credentials.

### Storage and deployment

- Default file: `forge/server/data/projects.json` when run from the server directory.
  Override with `DATA_FILE`.
- Set `MONGODB_URI` for MongoDB, collection `forge_conversations` (legacy: `forge`).
- Memory and events survive conversation normalization and storage reloads.
- File writes are serialized and atomically renamed; memory is published only after
  a successful save. Corrupt/unreadable files stop startup instead of being reset.
- Per-conversation locks reject concurrent turns/deletes/legacy writes with HTTP
  409. These locks are process-local, **not distributed locking**. Use one server
  process until multi-instance concurrency control is implemented.
- `npm --prefix forge/client run build` type-checks and builds the client. Express
  serves `client/dist` when present.
- There is still no authentication or per-user authorization. Do not expose a
  shared instance containing private projects to untrusted users.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Actual configured providers |
| `GET /api/chat` | Saved conversations |
| `POST /api/chat` | Start a memory-first project with `{ goal }` or `{ message }` |
| `GET /api/chat/:id` | Conversation, memory, and recorded events |
| `POST /api/chat/:id/messages` | Run a guarded turn with `{ text }` |
| `DELETE /api/chat/:id` | Delete a conversation |

JSON is the default. The UI requests `Accept: application/x-ndjson` on create/send:

```json
{"type":"progress","event":{"stage":"review","status":"running","label":"..."}}
{"type":"result","result":{"conversation":{},"response":{},"decisions":[]}}
```

An `error` packet terminates a failed streamed turn. Progress is provisional; only
`result` confirms persistence. Unchecked drafts are never streamed to the browser
or stored in the trace. A disconnected client may miss a successful commit: reopen
the project before resending. There is no automatic mutation retry/idempotency key.

Generation requests have a 90-second timeout, JEV a 60-second timeout. Messages are
limited to 12,000 characters, proposals to 8 per turn, and draft output to 24,000
characters. The most recent 120 events are retained. At the 500-note boundary new
turns are stopped rather than silently evicting rules; archival is future work.

## Existing structured-build workflow

The earlier phase/step/BOM/human-task pipeline remains in `pipeline.js` and under
`/api/projects`. New primary conversations no longer automatically turn every idea
into a physical assembly plan. They start with project understanding and can produce
plans in the conversation without imposing an electronics template.

Existing conversations with `projectState` keep their structured execution loop.
Its state transition and tool cards are treated as a draft: they only commit if
memory checks pass. On repair, unapproved plan changes are discarded. Legacy
message endpoints also use the memory guard once a conversation has memory.
The existing offline smoke suite (test fixtures, dev-only) still tests
feasibility, step reports, retries, safety paths, final acceptance, and the
SigV4 signer.

This change does not add external tool execution, photo evidence, simulation
integration, accounts, or guaranteed factual/physical verification.

## Implementation map

- `server/src/memory/reasoner.js`: domain-independent proposal/response prompts.
- `server/src/providers/jsonModel.js`: shared configured LLM/Bedrock generator.
- `server/src/memory/decisions.js`: typed JEV questions and conservative application.
- `server/src/memory/turn.js`: propose → review → contextualize → draft → check/repair.
- `server/src/schema.js`, `store.js`: persistence and backward compatibility.
- `client/src/components/MemoryPanel.tsx`: live stages, note provenance, checks, replay.
- `client/src/api.ts`: incremental NDJSON parser and final-result handling.

## Validation

```bash
npm --prefix forge/server test       # memory, API, persistence, provider contracts
npm --prefix forge/server run smoke # original build loop (11 checks, offline fixtures)
npm --prefix forge/server run raw-reviews # one raw memory-review + one raw output-review response
npm --prefix forge/client test       # workspace, memory UI, streaming parser
npm --prefix forge/client run build # TypeScript + production bundle
```

The tests cover grounded notes, label-split and uncertain/missing decisions,
uncertainty-vs-contradiction wording, named conflict targets, unauthorized rule
replacement, question answering and turn-end reconciliation, disposition gating,
repair and recheck, withheld drafts, raw-answer capture, rollback, concurrent API
requests, file reloads, streaming interruptions, source visibility, and explicit
replay.
Provider request shapes are tested with stubbed HTTP, **not paid-provider E2E**.
Desktop/mobile Chromium checks exercise the actual demo API and UI, including rule
formation, future turns, scoped changes, replay, persisted reopening, and reduced motion.
