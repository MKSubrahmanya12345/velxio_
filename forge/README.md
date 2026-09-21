# Velxio Forge — project memory, governed by JEV

Forge is a domain-independent project conversation: describe what you want to
create, establish what matters, and carry that understanding into future output.
A horror film, app, event, or physical build can all start in the same workspace.

**The LLM proposes and generates. JEV evaluates. Code controls state changes.**

## The new primary conversation loop

```text
User message + project memory + recent conversation
    → same configured LLM proposes atomic notes
    → JEV evaluates origin, support, compatibility, change authorization
    → code applies accepted changes; uncertain notes stay pending
    → current project memory is supplied to the same LLM
    → LLM drafts a response
    → JEV checks every active goal / rule / fact / preference
    → pass: save and deliver
      fail / uncertain: one revision by the same LLM, then check again
      still unresolved: withhold draft and request clarification
```

The data structure is stable, but the **content and rule questions emerge from
what the user says**. There is no film-specific or electronics-specific schema in
the live memory pipeline. JEV receives `{ state, questions }` with typed `choice`,
`noul`, and `score` questions, not a request to write the assistant's response.

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

Each note has a stable ID, text, source-message ID, supporting user quote when
available, origin, status, timestamps, structured review values, and replacement
links. Statuses are `active`, `proposed`, `pending`, `rejected`, and `superseded`.

- Active user commitments need a quote grounded in the latest message and a
  sufficiently supported JEV review. A quote alone does not establish meaning.
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
- Per-note outcomes show respected, conflicting, or uncertain checks.
- **Why is this here?** reveals source quotes, review explanations, and history.
- **Change this note** prepares a user message; it never mutates memory directly.
- **Decision trail** lists actual recorded events and checks.
- **Replay recorded turn** plays the recorded sequence with an explicit replay
  label. It does not invoke providers or invent new decisions.
- Reduced-motion preferences disable visual animations. Failed streams retain the
  draft and distinguish unconfirmed working changes from persisted memory.

## Try the solo-film example

With the default offline providers:

1. Start: `I want to make a horror film. Only me, no other actors or crew.`
2. Inspect the binding solo-production rule and the separate AI suggestion.
3. Send: `I have a phone`. The rule persists and is included in the next checks.
4. Send: `My brother can help on Sunday`. The possible replacement stays pending;
   it does not silently erase the original rule.
5. Use **Change this note** on the pending update. Complete the prepared message:
   `Only me except my brother may operate the camera on Sunday.`
6. Inspect the new rule and the retired original, then reopen the conversation.
7. Use **Replay recorded turn** to watch the evaluated sequence.

**Important:** offline mode is a deliberately limited deterministic demo. The
solo-film response and extraction heuristics are examples, not unrestricted AI.
Both the provider badges and panel label this. Open-ended semantic extraction,
contextual generation, and rule checking require real generation and JEV providers.

## Running

Client development/tests: Node 22.12+ on 22.x, Node 24.x, or Node 26+.
The standalone server declares Node ≥18 support.

```bash
# Separate terminals, from repository root
cd forge/server
npm install
npm run dev                 # API :4321; exported environment variables

cd forge/client
npm install
npm run dev                 # UI :5174; same-origin /api proxy
```

No keys are needed for the demo. Vite binds to `0.0.0.0` and accepts preview hosts.
`VITE_API_PROXY` changes its server-side API target; browser requests stay relative.

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
model. Each provider can be configured independently; mixed/demo modes are labeled.
Missing credentials fall back to mock per `config.js`; check the displayed badges.

`.env` is **not automatically loaded by `npm run dev`**. On Node 22+, after creating
it locally, use `node --env-file=.env --watch src/index.js` from `forge/server`, or
export variables through your normal deployment secret configuration. Do not
commit credentials.

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
The existing mock-build smoke suite still tests feasibility, step reports, retries,
safety paths, final acceptance, and the SigV4 signer.

This change does not add external tool execution, photo evidence, simulation
integration, accounts, or guaranteed factual/physical verification.

## Implementation map

- `server/src/memory/reasoner.js`: domain-independent proposal/response prompts.
- `server/src/providers/jsonModel.js`: shared configured LLM/Bedrock generator.
- `server/src/memory/decisions.js`: typed JEV questions and conservative application.
- `server/src/memory/turn.js`: propose → review → contextualize → draft → check/repair.
- `server/src/memory/demo.js`: explicitly limited offline examples.
- `server/src/schema.js`, `store.js`: persistence and backward compatibility.
- `client/src/components/MemoryPanel.tsx`: live stages, note provenance, checks, replay.
- `client/src/api.ts`: incremental NDJSON parser and final-result handling.

## Validation

```bash
npm --prefix forge/server test       # memory, API, persistence, provider contracts
npm --prefix forge/server run smoke # original mock-build loop (11 checks)
npm --prefix forge/client test       # workspace, memory UI, streaming parser
npm --prefix forge/client run build # TypeScript + production bundle
```

The tests cover grounded notes, uncertain/missing decisions, unauthorized rule
replacement, repair and recheck, withheld drafts, rollback, concurrent API requests,
file reloads, streaming interruptions, source visibility, and explicit replay.
Provider request shapes are tested with stubbed HTTP, **not paid-provider E2E**.
Desktop/mobile Chromium checks exercise the actual demo API and UI, including rule
formation, future turns, scoped changes, replay, persisted reopening, and reduced motion.
