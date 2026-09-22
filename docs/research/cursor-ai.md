# Cursor AI — architecture research (relevance to the Velxio agent)

Date: 2026-09-22 · Scope: what Cursor actually does about **latency and context**, and what
of it transfers to our server-side agent (`backend/app/agent/`). Components that do not
transfer are listed too, with the reason, so nobody re-litigates them.

**Source reliability note:** Cursor does not publish an engineering blog about internals.
The solid ground is (a) **priompt**, the prompt library Cursor open-sourced
(`github.com/anysphere/priompt`), (b) partner write-ups from **Together AI** (inference
serving) and **Fireworks** (Fast Apply), (c) statements by co-founder Aman Sanger.
Everything else below comes from independent analyses of the public surface — directionally
reliable, but treat exact numbers as "as reported", not audited.

---

## 1. What Cursor is

A fork of VS Code (not a plugin) with AI built into the editor loop. Four headline
architectural commitments, per independent analyses:

1. **Context engine** — the codebase is indexed and retrieved *before* the model sees it
   (the model never gets "the repo", it gets a curated slice).
2. **Latency-critical in-house models** — Tab (autocomplete, sub-100 ms budget) and
   Composer (multi-file edits) are custom models; everything else is model-agnostic
   orchestration (GPT / Claude / Gemini / Grok are all offered).
3. **Inference latency engineering** — speculative decoding, prefix caching, tuned
   low-latency serving (Together AI, NVIDIA Blackwell B200/GB200, FP4/TensorRT).
4. **Continuous quality loop** — a ~90-minute RL feedback loop over Tab accept/reject and
   Composer approval data; new checkpoints deployed multiple times a day
   (reported ~400 M requests/day, ~1 B edited characters/day for Tab alone).

Why a fork: editor-level control (render pipeline, filesystem hooks, extension host) is what
makes inline diff overlays, speculative suggestions, the hidden "shadow workspace", and
background agents in isolated VMs possible. No plugin API reaches there.

## 2. Component by component

### 2.1 Context engine (index → retrieve → rerank) — *adapt, heavily*

As reported: Tree-sitter chunks code at function/class boundaries (not arbitrary lines); a
Merkle tree of file hashes syncs with the server (~5 min) so only changed files are
re-uploaded; embeddings live in **Turbopuffer** (serverless vector DB over object storage;
reported ~500 ms cold, 8–10 ms warm queries); a reranker (a fine-tuned CodeLlama per the
analyses) reorders hits before they enter the prompt. Cursor's co-founder confirmed the
Pinecone → Turbopuffer switch "saved an order of magnitude in costs".

**Relevance to Velxio:** we do not need the indexing half. Our "codebase" is (a) a static
catalog (157 parts, shipped as `catalog.json`) and (b) the current project state, which is
small and already fully in memory on the server. What transfers is the *principle*:
**the model should receive a curated, de-duplicated slice, not the whole state blob
re-sent on every call.** In our loop that means: don't re-embed file content in tool
results when it already sits in the project message; don't keep 10 rounds of full
proposals when the last two are what matters.

### 2.2 Priompt — priority-based prompt budgeting — *adopt the pattern*

Open-sourced by Cursor (`github.com/anysphere/priompt`). Prompts are JSX-like components;
each child carries a priority (`p` absolute, `prel` relative). When the total exceeds the
token budget, the renderer finds the cutoff by binary search and **drops lowest-priority
blocks first**. Canonical example from the README: system message and latest user message
always included; history included newest-first as far as budget allows. It also offers
conditional children ("include first that fits, else emit an 'omitted' stub") and `Space`
to reserve output budget.

Their own caveat, and it matters for us: **overusing priorities makes prompts hard to
cache** — if blocks reorder or drop between calls, the byte-identical prefix that
prefix-caching needs disappears. The abstraction is: *budget the window, but keep the
stable front byte-stable.*

**Relevance to Velxio:** we don't need JSX. The pattern is a function:
`assemble(prefix_blocks, history_blocks, fresh_blocks, budget) -> list[Message]` where each
block has a priority, latest > older, and the stable front (system + state) never moves.
Our current `_base_messages` is hand-rolled and has no budget at all — history and tool
results grow unbounded until the model's window or our 240 s budget runs out.

### 2.3 Model routing ("own the latency-critical model") — *adapt*

Cursor's moat: the latency-sensitive calls (autocomplete, fast multi-file apply) run on
small in-house models; hard reasoning goes to frontier models, chosen per task at the
orchestration layer.

**Relevance to Velxio:** we don't train models, but we have exactly one "latency-critical,
low-intelligence" call: the **JSON repair call** (`_fix_json_via_model`) — it fixes
brackets on a truncated/malformed proposal, and today it runs on the *same* big model with
*the same* big context, in the middle of the user's wait. Routing it to a small fast
model (we already have `groq` configured) is the direct translation of this principle.
Second candidate: tool-round responses (the model answers with `tool_calls` only, no
patch) don't need frontier reasoning either.

### 2.4 Inference-layer speed — *partially adoptable*

- **Speculative decoding / speculative edits**: a draft model (or the user's own existing
  code as "draft tokens") proposes tokens that the big model verifies in parallel;
  reported ~1,000 tok/s and ~13× speedups, and Fireworks' Fast Apply (built around Cursor's
  workload) at ~1,000 tok/s with ~2× latency reduction. **Skip for us** — that is an
  inference-fleet technique; behind an OpenAI-compatible API we can't do it. The equivalent
  lever for us is *output budgeting*: we request `max_tokens: 10000` on **every** call,
  including tool-call-only rounds that emit a few hundred tokens. Cap per call type.
- **Prefix / prompt caching**: OpenAI-compatible endpoints cache byte-identical prefixes
  automatically (≥1k tokens); Anthropic-style APIs need explicit `cache_control`
  breakpoints (5-min TTL, refreshed on hit). **Adopt directly** — see §4 item 1. This is
  repeatedly called out in the industry analyses as *the highest-ROI context-engineering
  primitive*, precisely because our stable prefix (catalog index + board + tools + schema)
  is exactly the shape it is for.
- **Low-latency serving fleet (Blackwell, FP4, Together AI)**: skip; for us it means
  "pick faster providers", a config change, not architecture.

### 2.5 Shadow workspace — *we already have the equivalent; keep it*

Cursor compiles/lints a hidden copy of the file (a shadow VS Code instance with its own
language servers, launched on demand, torn down when idle) and feeds errors back to the
model **before** the user sees anything — a self-refinement loop hidden behind one response.

Our `draft_validate` / `draft_compile` / `draft_simulate` tools are the same idea (real
compiler + real emulator, results handed back as observations, nothing applied until the
final proposal). **This is the part of our design that already matches Cursor — protect it.**
The difference is budget: Cursor's shadow runs in parallel with the editor; ours is a
serial step in the loop, so each draft round costs a full round-trip plus toolchain time.
The fix is fewer, better draft rounds (priorities + compaction), not a redesign.

### 2.6 Agent context management: compaction — *adopt with the caching caveat*

Field consensus (analyses + platform docs): long agent sessions degrade ("context rot"),
so production systems **compact history**: summarize old turns into a structured note
(goal / progress / decisions / files / next steps) when the window reaches ~70–75% of the
model's limit (not 95–98% — late compaction produces "context-anxious" summaries).
Cursor itself: each chat starts fresh; no built-in cross-session memory (best practice is
one chat per task + `.cursor/rules` files); long-session memory leaks were fixed in
2.0; agent mode gets window trimming/compaction of the running conversation.

The one subtlety everyone flags: **compaction and prefix caching are in tension.** A
compaction rewrites the middle of the history, invalidating the cached prefix from that
point on (the stable system front still hits). So: compact rarely, keep the front
byte-stable, and put volatile content (timestamps, run ids, per-call state) only at the
very end of the message list.

**Relevance to Velxio:** our history compaction happens *inside a single run* (tool rounds),
which is more tractable than cross-session: the project state is immutable during a run, so
a compacted run can safely summarize "rounds 1..k" into a few lines while keeping the last
two rounds verbatim.

### 2.7 The RL loop — *skip now*

90-minute feedback loops, multiple daily checkpoints, A/B on latency/quality: this is a
fleet-and-scale play (tens of thousands of GPUs, hundreds of millions of requests). Not
actionable for us at current volume; note it as the end-state if the product grows.

## 3. Relevance matrix

| Cursor component | For the Velxio agent | Why |
| --- | --- | --- |
| VS Code fork, editor hooks | **Skip** | We're a browser emulator + server; no editor to fork. |
| Codebase indexing (Turbopuffer, Merkle sync) | **Skip** | Catalog is static JSON; project state is already in memory and small. |
| Retrieval + rerank before prompt | **Adapt** | We don't retrieve; we *de-duplicate*: stop re-embedding content that's already in the state message. |
| Priompt priority budgeting | **Adopt** | Replace "no budget, append forever" with prioritized assembly; keep stable front byte-stable. |
| In-house latency models | **Adapt** | Route cheap calls (JSON repair, tool rounds) to a small fast model (groq already configured). |
| Speculative decoding / Fast Apply | **Skip** | Inference-fleet technique; behind a chat API the translation is *output budgeting* (per-call-type max_tokens). |
| Prefix/prompt caching | **Adopt** | Highest-ROI primitive for our shape; make the prefix stable and measure hits. |
| Shadow workspace | **Keep ours** | `draft_*` tools are the equivalent; improve round count, not the mechanism. |
| History compaction | **Adopt** | Per-run compaction of old tool rounds (70–75% trigger), stable front untouched. |
| RL quality loop | **Skip (now)** | Scale-dependent; end-state idea only. |
| Multi-model orchestration UI | **Partial** | We already expose provider choice; extend it to per-call-type routing. |

## 4. Concrete work items (ordered by ROI)

These are the dispatch list — see the 5-agent tasking in chat for the split.

1. **Cacheable prefix + telemetry** (`service.py`): split the run-constant project state
   into its own message so the layout is `[system] → [chat history] → [state] → [request]
   → [tool rounds…]`; document the byte-stability invariant (nothing dynamic above the
   request); log `cached_tokens` from provider usage so we can *see* whether the prefix is
   actually being served from cache on each configured provider.
2. **Compaction / priority budgeting** (`service.py`, `tools.py`): keep the last 2 tool
   rounds verbatim; replace older assistant proposals with one-line summaries; replace the
   naive 4000/20000-char hard slice in `_clip`/`tool_results_message` with structured,
   JSON-safe truncation; stop echoing file content in tool results when it's already in the
   state message.
3. **Cheap-model routing** (`service.py`, `config.py`, `models.py`): JSON repair (and
   optionally tool rounds) go to a small fast model via a new setting; fail open to the
   main model if the fast one is unconfigured.
4. **Output budgeting + streaming** (`service.py`, `config.py`): per-call-type
   `max_tokens` (small for tool rounds, full only for draft/final); stream completions
   into the existing SSE event stream (`delta` events; UI may ignore unknown events).
5. **Forge off the critical path** (`service.py`, `forge.py`): start the forge turn
   concurrently with the first proposal instead of serially ahead of it; fold it in when
   it lands, skip it without penalty when it doesn't.
6. **Latency telemetry** (`runlog.py`, `service.py`): per-call records (stage, provider,
   prompt/completion/cached tokens, wall time), a run-level `latency_summary` event, so
   "which round was slow" is a question the logs answer, not a guess.

## 5. Sources

- anysphere/priompt — README (official, open source): https://github.com/anysphere/priompt
- Together AI — Cursor real-time low-latency inference partnership (partner, official):
  https://www.together.ai/blog/learn-how-cursor-partnered-with-together-ai-to-deliver-real-time-low-latency-inference-at-scale
- "How Cursor Actually Works: Architecture and Engineering" (independent analysis;
  context-engine details, Turbopuffer/Fireworks/Fusion numbers, RL loop):
  https://theaiengineer.substack.com/p/how-cursor-actually-works
- "How Cursor Actually Works (Researched From the Public Surface)" (independent; the four
  commitments, model lineup and strategy): https://howworks.ai/blog/how-cursor-actually-works
- "How Cursor Works Internally?" (independent; shadow workspace, windowing, LSP
  enrichment, search caching): https://adityarohilla.com/2025/05/08/how-cursor-works-internally/
- "Unveiling Cursor's AI Magic" (independent; 1k tok/s speculative decoding, 90-min RL
  loop): https://martinuke0.github.io/posts/2026-03-03-unveiling-cursor/
- "Cursor — case study" (independent; priompt binary-search dropping, "context is an
  engineering problem"): https://julien-riel.com/en/case-studies/cursor/
- Agent Context Compaction for Long-Running Sessions (2026 field survey; 70–75% threshold,
  caching/compaction tension, Cursor memory status):
  https://zylos.ai/research/2026-04-21-agent-context-compaction-long-running-sessions/
- Context Engineering at the Gateway Layer (prompt caching as highest-ROI primitive;
  cache behavior across compaction): https://www.truefoundry.com/blog/context-engineering-gateway-session-management
- Claude Platform docs — prompt caching (mechanics: TTL, minimums, usage fields):
  https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Context Management at Scale (Claude Code snip/micro-compact/collapse/auto-compact;
  Hermes ContextCompressor + cache breakpoints):
  https://kenhuangus.substack.com/p/chapter-6-context-management-at-scale
- Aman Sanger on priompt (founder, social): https://twitter.com/amanrsanger/status/1745922482090188998
