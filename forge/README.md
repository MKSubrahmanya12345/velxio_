# Velxio Forge — chat interface, human as a tool, JEV in between

> **"I wanna build X" → JEV decides → planner gives implementation plan → human tool executes → JEV verifies → repeat.**

Forge is now a **conversational build agent** where the human is a callable tool. You chat, the agent plans, and when physical work is needed it calls `human` with exact instructions. JEV (TypeSafe's decision model) sits between every turn as the nervous system.

---

## What you asked vs what was there

Old forge was a workbench UI with phases/BOM sidebar, step cards, chips. It worked, but it wasn't a chat interface and it didn't treat human as a tool.

Now:

- **Chat-first UI**: left list of conversations, right chat window. You type "I wanna build an MP3 player" and get back a full implementation plan in chat.
- **Human as tool**: agent emits `toolCalls: [{ name: 'human', arguments: { task, instructions, materials, tools, safety, definition_of_done } }]`. UI renders it as a card. You execute, report back, JEV verifies, agent advances.
- **JEV in between every message**: intent, goal clarity, feasibility, safety, verification, human-tool decision — all via JEV.

---

## Core loop (chat)

```
User: "I wanna build an MP3 player"
  │
  ├─► JEV CHAT_INTENT: build_request? (choice) + needs_plan? (noul) + frustration (score)
  ├─► JEV GOAL_PARSE: goal_clear? (noul) + specificity (score)
  ├─► JEV J1 feasibility: category, buildability, risky, complexity, budget
  │     └─► if buildability=no → abort (weapons etc die here)
  ├─► Planner (mock KB or LLM/Bedrock) → phases / steps / BOM / acceptance
  ├─► JEV J6 safety gate on first step
  ├─► JEV HUMAN_TOOL: call_human? + complexity + needs_clarification
  │
  └─► Assistant: markdown plan + human tool card for step 1 + JEV trace

User: "done, bench is set up..."
  │
  ├─► JEV CHAT_INTENT + J2 triage (intent 9-way, safety_concern, frustration)
  ├─► if safety_concern ≥0.5 → safety override banner
  ├─► JEV J3 verification: verified? (noul) + quality (score)
  │     ├─► fail → retry + re-call human tool
  │     ├─► low certainty → ask for re-check
  │     └─► pass → advance, J6 on next, HUMAN_TOOL decision → next human tool card
  └─► Assistant: ✅ verified, next step, new human tool call

... repeat until "I think it's done" → JEV J9 acceptance (each criterion needs certainty ≥0.8)
```

Three layers, same as before but chat-shaped:

| Layer | Role |
|---|---|
| **JEV** | nervous system — 70-500ms, $0.0004/call decisions, confidence-calibrated |
| **Planner** | prefrontal — generates the plan (mock KB offline, LLM/Bedrock live) |
| **State machine** | skeleton — pure code transitions over JEV verdicts, no LLM text parsed for control flow |

### Why JEV is essential here

Chat needs judgment, not prose, on every turn: is this a build request? Is goal clear? Is it buildable? Is safety involved? Was human's report actually done? Should we call human again? Does finished build meet acceptance? That's dozens of small decisions per conversation — JEV's workload. LLM-only would be 100x cost and 3-300s latency per turn.

---

## Human as tool — how it works

Tool definition (conceptually, for LLM planner):

```json
{
  "name": "human",
  "description": "Call the human to execute a physical step. Human has body, tools, bench. You have knowledge.",
  "parameters": {
    "task": "string — step title",
    "instructions": "string — exact how",
    "materials": ["string"],
    "tools": ["string"],
    "safety": [{"hazard": "string", "severity": "info|warn|high", "note": "string"}],
    "definition_of_done": ["string — checklist"]
  }
}
```

In mock mode, planner's steps already include this info, so `makeHumanToolCall(stepRef)` creates the tool call directly. In LLM mode, prompt tells model it has `human` tool.

**UI**: `HumanToolCard` shows instructions, materials, tools, safety (⚠️), DOD checklist, reason, attempt count. Pending banner at top: "🔧 Human tool pending: ...". User reports via composer ("done, ...", "it failed...") which completes the tool call, triggers JEV verification.

**Flow**: agent calls human → human status `requires_action` → user message → J3 verification → tool status `completed|failed` → next tool call.

This is the "human as a tool" pattern: same as function calling loop, but actuator is human.

---

## JEV decision catalog (chat + legacy)

| ID | Decision | When | Types | What happens |
|---|---|---|---|---|
| **CHAT_INTENT** | Chat intent | every user message | Choice (build_request, question, status_update, human_tool_result, claim_done, scope_change, general) + Noul (needs_plan) + Score (frustration) | Routes to build/new-plan/question/verify paths. Low conf (<0.55) → ask rephrase |
| **GOAL_PARSE** | Goal clarity | build request | Noul (clear?) + Score (specificity) | If not clear, ask clarification |
| **J1** | Feasibility gate | new plan | Choice category/buildability + Noul risky + Score complexity/budget | `no` → abort with refusal |
| **J2** | Message triage | every message with project | Choice 9-way + Noul safety + Score frustration | safety≥0.5 → safety override banner |
| **HUMAN_TOOL** | Should call human? | after each advance & first step | Noul call_human + Score complexity + Noul needs_clarify | true → create human tool card |
| **J3** | Step verification | done reports | Noul verified vs DOD + Score quality | pass+cert≥0.6 → advance, low cert → clarify, fail → retry |
| **J4** | Substitute matching | "I have X not Y" | per inventory: Noul valid? + Score compat | best≥threshold → proposal |
| **J6** | Safety interlock | each step start | Noul per hazard | high present → ack required banner |
| **J8** | Fan-out | after advance | 3 Noul probes | suggestions chips (inventory? checkpoint? question?) |
| **J9** | Acceptance | "I think it's done" | Noul per criterion ≤8 | all must met with cert≥0.8 or reject with unmet list |
| **J10** | Difficulty | failures | Score right level → over my head | ≥2.5 → replan proposal |

Each is one batched JEV call (`state` JSON + `questions` object) → `runDecision()` → structured verdict. UI shows `summary` verbatim for transparency.

---

## Architecture

```
forge/
├── client/  React 18 + Vite + TS
│   ├── src/
│   │   ├── App.tsx                chat layout: sidebar + main
│   │   ├── api.ts                 /api/chat wrapper
│   │   ├── types.ts               Conversation, ChatMessage, HumanToolCall, ProjectState
│   │   ├── index.css              dark tokens + chat styles
│   │   └── components/
│   │       ├── ChatView.tsx       messages + composer + human tool cards + JEV trace
│   │       ├── ConversationList.tsx
│   │       ├── ProviderStrip.tsx  JEV/PLANNER/STORE badges
│   │       └── (legacy BenchView etc kept for compat)
│   └── vite.config.ts             proxy /api → :4321, allowedHosts true for Arena preview
└── server/  Express ESM, no build
    ├── src/
    │   ├── index.js               entry, serves client/dist in prod
    │   ├── config.js              env → provider selection (mock fallback)
    │   ├── schema.js              Conversation model, ProjectState, human tool helpers, sanitizePlan trust boundary
    │   ├── pipeline.js            CHAT: synthesizeChatProject + handleChatMessage (human-as-tool loop) + legacy wrappers
    │   ├── stateMachine.js        pure helpers
    │   ├── store.js               FileStore default (conversations+projects) | MongoStore
    │   ├── routes.js              /api/chat CRUD + /api/chat/:id/messages (hot path) + legacy /api/projects aliases
    │   ├── decisions/catalog.js   CHAT_INTENT, GOAL_PARSE, HUMAN_TOOL + J1-J10
    │   └── providers/
    │       ├── jev.js             real TypeSafe fetch | mock
    │       ├── jevMock.js         deterministic mock, exact real shape, now supports chat intents
    │       ├── planner.js         mock | llm | bedrock
    │       ├── plannerMock.js     KB: MP3, iron man helmet, LED lamp + generic fallback (each has sim+physical steps)
    │       ├── plannerPrompt.js   shared prompt
    │       ├── bedrock.js         Converse API, model-agnostic
    │       └── sigv4.js           SigV4 signer, tested vs AWS vector
    └── scripts/smoke.mjs          chat-first end-to-end test, no deps
```

### Key implementation notes

**`schema.js`**: `makeConversation()` → `{ id, title, messages[], projectState, pendingHumanTools[], counters }`. `makeMessage()` includes `decisions[]`, `toolCalls[]`, `plan`. `makeHumanToolCall(stepRef)` builds the tool call. `sanitizePlan()` is trust boundary for planner output.

**`catalog.js`**: Each decision `{ questions(ctx), verdict(answers, ctx) }`. `runDecision()` does one JEV call. Confidence gating is in pipeline (intentConf<0.55 → rephrase, verify cert<0.6 → clarify).

**`jevMock.js`**: Pattern-based, FNV hash seeded for deterministic confidence. Now handles `chat_intent`, `needs_plan`, `goal_clear`, `goal_specificity`, `call_human`, etc. Exact real API shape: `choice`→{choice,confidence,probabilities}, `score`→{score,confidence,legend,probabilities}, `noul`→{noul}.

**`pipeline.js` chat**:

- `synthesizeChatProject(deps, conv, goal)`: GOAL_PARSE → J1 → planner → sanitize → J6 → HUMAN_TOOL → assistant message with markdown plan + toolCalls.
- `handleChatMessage(deps, conv, input)`: add user msg → CHAT_INTENT (JEV) → if build_request → synthesize → else if no project → guide → else J2 triage → safety override → branch on intent (step_done/human_tool_result/status_update → J3 verify → advance + HUMAN_TOOL, step_failed → J10 + re-call, question → answer from plan, claim_done → J9, blocked → help + re-call).

Every branch returns `{ conversation, response, decisions }` — response is a ChatMessage with content + toolCalls + decisions for UI transparency. No LLM text parsed for control flow.

**`store.js`**: FileStore now stores `conversations` map + legacy `projects` map, atomic write-then-rename. MongoStore uses two collections.

**Client**: `ChatView` renders messages (user blue bubble, assistant dark card, system dashed), JEV decisions under each assistant message (id + summary, color by confidence), human tool cards (pending amber border, done faded), pending banner, composer with quick chips (Question, Done, Failed) + ⌘+Enter hint, plan details collapsible. `ConversationList` shows title, date, JEV call count, phases.

---

## Running

Prereq: Node ≥18. Works with zero keys (mock JEV + mock planner + file store).

```bash
# API (4321)
cd forge/server
npm install
npm run dev

# Client (5174, proxies /api → 4321)
cd forge/client
npm install
npm run dev
```

Open http://localhost:5174.

Prod: `npm run build` in client, server serves `client/dist` same-origin.

### Env (server)

| Var | Default | Meaning |
|---|---|---|
| PORT | 4321 | API port |
| MONGODB_URI | empty | set → Mongo (forge_conversations + forge), else file |
| DATA_FILE | ./data/projects.json | file store |
| JEV_PROVIDER | mock | typesafe + TYPESAFE_API_KEY → real, else mock |
| TYPESAFE_API_KEY / MODEL / BASE_URL | jev-latest | real JEV |
| PLANNER_PROVIDER | mock | mock | llm (needs LLM_API_KEY) | bedrock (needs AWS creds) |
| LLM_API_BASE / KEY / MODEL | OpenAI, gpt-4o | LLM planner |
| AWS_REGION / ACCESS_KEY / SECRET / SESSION_TOKEN | — | Bedrock creds |
| BEDROCK_MODEL | anthropic.claude-sonnet-4-5 | any Converse model |
| BEDROCK_ENDPOINT | AWS default | override for LocalStack |
| CORS_ORIGIN | open | e.g. http://localhost:5174 |

### Demo (all mock)

1. New chat → type "I wanna build an MP3 player with ESP32" → Send (or Ctrl+Enter).
2. See JEV trace: CHAT_INTENT=build_request, GOAL_PARSE clear, J1 category=electronics, etc. Then implementation plan markdown + human tool card for "Set up workbench".
3. Report "done, bench is set up and every part is identified" → JEV verifies, advances, new human tool card for sim step.
4. "done, sim ran and checks out" → next step is physical with safety: soldering iron burn risk. Note J6 ack required in text.
5. "it failed, 3v3 rail reads 2.8v, not working" → J2 triage step_failed, J10 difficulty, human tool re-called.
6. "what tools do I need?" → answered from plan context.
7. Finish steps with "done..." until no active step, then "I think it's done" → J9 acceptance. If early, rejected with unmet criteria list.
8. Try new build in same chat: "I wanna build an LED desk lamp instead" → re-plan, new human tool.

---

## What was checked

| Check | Result |
|---|---|
| node --check all server ESM | ✅ |
| smoke.mjs chat-first: build_request → plan + human tool → verify → failure → question → re-plan → all steps → acceptance → weapon abort → SigV4 vector → provider selection | ✅ 11/11 PASS, 52 JEV calls |
| Client TSX syntax (manual bracket check) | ✅ |

Not checked (needs npm install / network):

- `tsc --noEmit` for client types — should pass, types are simple.
- Real TypeSafe / LLM / Bedrock calls — adapters are plain fetch against documented shapes, signing vector-tested.
- UI rendered — static check only.

---

## Roadmap

- M0 (done): chat-first, human as tool, JEV in between, mock providers, smoke test.
- M1: streaming assistant responses, photo upload → LLM describer → JEV verification, inventory scoring via J4 in chat, per-skill instruction granularity.
- M2: sim-track integration — electronic steps auto-routed to Velxio emulator, results fed to J9 as machine-verified evidence.
- M3: export .forge file, multi-agent (human + Velxio sim as two tools), voice input.

---

## Design decisions

- **Chat is primary, bench is secondary**: old bench view kept for compat but not used. Plan is rendered in chat as markdown + collapsible phase grid, not as separate columns.
- **Human tool is explicit**: not hidden "you do it" prose, but structured `toolCalls` array like OpenAI function calling, so UI can render actionable cards and track pending/completed.
- **JEV between every turn**: not just feasibility gate, but CHAT_INTENT, GOAL_PARSE, J2 triage, J3 verify, HUMAN_TOOL decision, J6 safety, J9 acceptance. Each decision's summary is shown in UI for transparency.
- **Mock-first**: deterministic mock returns exact real API shape, so whole loop (including low-confidence clarify paths) works offline. Flipping to real providers is config change.
- **Trust boundary**: `sanitizePlan()` coerces any planner output (mock or LLM) — track whitelisting, safety severity, DOD backfill, BOM completion from materials.
- **J1 refuses weapons**: regex, one line change if policy differs.
