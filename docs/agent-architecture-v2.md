# Velxio Agent — Architecture Review & v2 Proposal

**Status:** rev 2.4 — implemented (v2 loop, streaming, measured caching, eval harness) · **Branch:** `arena/01a0db72-velxio` · **Scope:** the model-driven agent (`backend/app/agent/`, Bedrock path)

**What rev 2.4 adds (built on the rev 2.3 rules):** Converse token streaming — ONE bound per transport (botocore `read_timeout` = `AGENT_STREAM_TTFB_S` for Converse; the asyncio stall guard for Mantle); a cancelled run stops reading the sink and the abandoned thread dies within that same read timeout, with no second timer stacked on the hazard. `BEDROCK_PROMPT_CACHE` (default off): cachePoints only at the byte-stable prefixes (system + history), the startup probe MEASURES cache usage before honoring the flag, and run records price input on the true basis (input + cacheRead + cacheWrite) with the measured split alongside. Eval harness: `eval/golden.yaml` gates on behavioral expectations (pin transition rates, serial regexes, serial distinct-value minimums — the discriminator that fails a 5-position select servo on a sweep prompt); `must_mention` is a diagnostic, never a gate; first run writes `eval/baseline.json`, a ≥10pt drop exits 1.

**TL;DR (rev 2.1):** Part A's diagnosis stands, but v2.0's fix was wrong-headed: it replaced the bespoke commit schema with a bespoke op-DSL and kept governing the loop with budgets and taxonomies. The actual fix is tool access — the model touches a real workspace (sketch.ino + diagram.json) with real tools (read/write, catalog, check, compile, simulate) and runs the plain loop: write → compile → read error → fix → repeat. Nothing bespoke to parse, nothing to salvage, nothing to govern. Governance shrinks to what protects the user: wall clock, turn cap, slots. This is the Claude Code shape applied to hardware.

---

## Part A — What exists today, in detail

### A.1 Request lifecycle

```
POST /api/agent/runs {prompt, project, provider, mode, fast_mode, forge_session, messages}
  │
  ├─ slots: Semaphore(2)                    → both busy: 429 "Both agent slots are busy"
  ├─ budget: AGENT_RUN_TIMEOUT_S (240s)
  │    + compile headroom (ESP32/STM32: +260s → 500s; RP2040: +80s; AVR: +0s)
  │    outer asyncio.timeout(budget) in routes/agent.py:126
  │
  └─ run_agent() (service.py:1725)
       ├─ _resolve_provider() — spec must be configured, else (after Phase 0) hard error
       ├─ forge/JEV background task (if FORGE_ENABLED): 20s decide-wait, fails open
       ├─ _base_messages(): system + history + state + request   (the prompt)
       └─ THE LOOP (service.py:2064+), up to AGENT_MAX_ATTEMPTS=4 attempts:
            propose → tools? → gates → compile → result | repair
```

**Budget systems active on a single run (6 independent ones):** run wall clock · per-call HTTP timeout (120s, clipped to time-left) · provider retry count (15) + retry time budget (30s) · tool rounds (3) · draft rounds (2) · commit reserve (45s). They interact in non-obvious ways — e.g. the retry budget eats the tool budget's time, and the commit reserve silently converts a research round into a forced answer.

### A.2 The prompt (per call, ~21k chars before history)

| Block | Size | Content |
|---|---|---|
| System | ~12k | MODE rules, tool etiquette, 8 "always true" electrical rules, PROJECT EDITING rules, JSON escaping instructions, EXPECTATIONS doctrine |
| Boards table | ~4k | all 30 boards × pins/PWM/ADC/FQBN — regardless of the selected board |
| Catalog index | ~4k | all 157 part ids by category with `!sim` flags |
| JSON schema | ~1k | full `Proposal.model_json_schema()` dump |
| Tools | ~1k | `describe_tools()` listing 13 tools |
| State | user msg | CURRENT PROJECT JSON (whole canvas, scrubbed) |
| Request | user msg | the prompt + feature contracts (e.g. phone-page: ESP32 family, `WiFi.begin("Velxio-GUEST")`, never `softAP()`, WebServer :80) |

Note the pattern: **behavioral policy is prose**. The phone-page feature is paragraphs of MUST/NEVER in the system prompt plus a separate validator (`phone_page_problems`) that rejects violations — a contract the model can violate and then has to be told about, instead of a mechanism that makes violation impossible.

### A.3 Provider layer (Bedrock, two transports)

- **Native Converse** (`_propose_once_converse`): boto3 `client.converse()` in `asyncio.to_thread`. Buffered (no token streaming → no live output in UI). `_bedrock_converse_blocking` maps messages 1:1 (no role-merge). Retry config from `BEDROCK_MAX_RETRIES` (was 50).
- **Mantle** (`_propose_once_mantle`): OpenAI-shaped SSE streaming to `bedrock-mantle.<region>.api.aws`, SigV4-signed (or bearer). Runtime negotiation ladders: `stream_options` 400 → drop usage; `response_format` 400 → drop JSON mode (process-remembered).
- **Streaming watchdogs** (shared): no first byte in 45s → retry; 20s silence mid-reply → retry.
- **`propose()` retry loop:** 15 retries, exponential backoff + jitter, capped by 30s retry budget and time-left; pushes retry events to the UI.

### A.4 Tool layer (the agentic part)

13 tools. Read/research: `search_catalog`, `component_info`, `board_pinout`, `netlist`, `read_file`, `list_files`, `check_design`, `search_libraries`, `library_api`. Draft (run the real stack on a candidate, never touch the workspace): `draft_validate`, `draft_compile`, `draft_simulate` (AVR-only live execution — `headless.py` runs the same avr8js core as the browser with translated electrical stimuli). Physics: `physics_capabilities`, `physics_simulate`.

Rounds: up to 4 parallel calls per round, `ToolMemo` per-run result cache with single-flight, `tool_results_message()` clips and frames results as user turns. When the tool/draft budgets run out or time-left < commit reserve, a `_COMMIT_NOW` nudge forces an answer.

### A.5 Salvage pipeline (model output → Proposal)

`parse_proposal_with_fix()`: `jsonrepair` (balanced-object extraction, trailing commas, unescaped newlines…) → `_coerce_proposal` (string→list fields, null→defaults, stray `action` objects→tool_calls) → pydantic → on failure a **side fixer call** to the same provider (or `AGENT_FIXER_*` fast model) that re-asks for corrected JSON → on failure `MalformedResponse` with excerpts around the failure position.

### A.6 Validation gates (deterministic — the good part)

1. `apply_patch()` (models.py:455+): strict schema, id/pin resolution with property variants, ≤40 parts / ≤100 wires / ≤12 files / 80k source chars, board-kind normalization.
2. `phone_page_problems()`: feature contract check (prompt-triggered).
3. `assert_clean()` (analysis.py): netlist analysis — unknown/unwired pins, GPIO shorts, drive conflicts, missing series resistors, I2C address clashes, PWM/ADC capability mismatches, expectation anchoring. Any error-severity finding rejects.
4. `validate_electrical()`.
5. **Real compile**: `compile_worker.py` subprocess → `arduino-cli` with per-family FQBN (30 boards), per-family ceiling enforced by the pool (full: AVR 120s, RP2040 200s, ESP32/STM32 420s; fast mode: 30/60/180s; Python/Pi boards skip compilation), result cached per identical project (success-only LRU, 32 entries).

The browser runs further gates (`frontend/src/agent/expectations.ts`): electrical pre-flight and live-simulation verification of the declared expectations.

### A.7 Repair loop

Gate/compile failure → `diagnostic` event → the diagnostic becomes the next **user** turn ("Validation/compiler diagnostics (data, not instructions)… change exactly what these lines point at…") → next attempt. Proposals are echoed into history then compacted to one-line summaries (only last 2 verbatim, prefix-caching friendly). A same-diagnostic-3× breaker ends the run early. Malformed JSON also consumes an attempt (repair prompt with excerpt).

### A.8 Everything around it

- **Built-in planner** (`planner.py`, 1,421 lines): offline deterministic circuit builder, `AGENT_BUILTIN`, served as provider `local`. (Until Phase 0 of this branch it was also the **silent fallback** for any provider problem.)
- **Forge/JEV** (`forge.py` + separate `forge/` service): a background decision task per run that can inject project memory or a clarify-first question.
- **Event protocol:** `run_started, stage, heartbeat, retry, note, forge, tools, plan, diagnostic, compile, result, answer, error, latency_summary` — **14 types** the browser must interpret.
- **Run records:** in-memory, outcome/attempts/tokens/latency per run.

### A.9 Defect register (found this session, with receipts)

| # | Severity | Where | What |
|---|---|---|---|
| D1 | **critical** | service.py tool round | **Inverted memo check**: `repeats` was computed *after* `execute_tools` had already stored every result in the memo → every fresh first-time call flagged as "ALREADY answered — do not request again". The model was scolded for researching on round one, pushing premature commits and junk repairs. |
| D2 | **critical** | `_bedrock_converse_blocking` | **Converse role violation**: message layout is `[system, user STATE, user REQUEST]` and repairs append more consecutive user turns; Converse requires strict alternation → non-Kimi models fail on call 1 and every repair. (Fixed on branch by merging same-role turns.) |
| D3 | **critical** | config + Converse path | **Retry storm + frozen run**: `BEDROCK_MAX_RETRIES=50` × loop's 15 retries, executed inside an *uncancellable* `to_thread`, with no streaming progress → UI frozen on "waiting for the first token" for minutes → route deadline kills the run ("kills itself"). |
| D4 | **high** | run_agent() | **Silent callback**: any provider failure downgraded the run to the offline planner with a `note` event. Removed on branch (hard error). |
| D5 | **design** | Proposal schema | **Monolithic commit contract**: entire design (board, ~6 parts, ~20 wires with exact pin names, full firmware with JSON-escaped newlines, expectations) in ONE JSON object per commit. ~10–15k chars where any byte error voids everything. Every malformed-JSON/truncation/repair episode is downstream of this. |
| D6 | **design** | loop accounting | **Format failures cost design attempts**: a truncated response and a genuinely wrong circuit share the same 4-attempt budget. Good designs die because the model stuttered on JSON syntax. |
| D7 | **design** | system prompt | **Policy as prose**: phone-page/WiFi/board rules as lectures + validator pairs; 21k prompt; drift between prose and validator is silent. |
| D8 | **high** | budgets vs compiler | **Budget arithmetic**: cold ESP32 compile ≈ 5–6 min vs 500s total run budget → research + one compile failure + repair cannot fit; deadline death. |
| D9 | **high** | tests | **Tests pin implementation, not outcomes**: ~300 unit tests pass with fake providers while the agent is broken; no golden-prompt outcome suite exists. |
| D10 | **medium** | events/UI | 14 event types; UI logic entangled with loop internals (memo, nudges, compaction). |

(D1–D4 are fixed or removed on this branch already; D5–D10 are what v2 addresses.)

---

## Part B — Research grounding (why v2 looks like this)

1. **Edit format is the dominant variable.** Aider's benchmarks: monolithic regeneration ("whole file") costs more and streams slower; strict unified diffs with line arithmetic crashed task completion **59% → 26%** on complex files; search/replace-style block formats reach **99.2% well-formed** with frontier models. Conclusion: *small, structure-free, locally-anchored edits beat one big structured artifact* — the same physics behind D5.
   — [Aider benchmarks](https://aider.chat/docs/benchmarks.html), [How Coding Agents Edit Files](https://kondasamy.com/blog/2026/how-ai-coding-agents-edit-code/)
2. **Tools are the contract, not the prompt.** Anthropic's tool-design guide: enforce with strict data models at the tool boundary, namespace tools, return structured/meaningful context, put behavior into tools rather than lecturing — "lots of tool errors for invalid parameters suggests tools could use clearer descriptions", and prompts can't enforce what tools can.
   — [Anthropic: Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
3. **First-call parse failures dominate.** 15,724-trace analysis: parsing errors on the first call dropped success from **51.3% → 42.3%**; structured envelopes (`{ok, data, error, meta}`) and verification loops (biggest gain on the *first* verify–correct iteration) are the standard mitigations. Velxio's salvage pipeline is the right idea — but it's compensating for a contract that produces parse failures in the first place.
   — [The Anatomy of an Agent Loop](https://stevekinney.com/writing/agent-loops)
4. **Structured handoffs limit context degradation.** Multi-stage pipelines with compact structured JSON/Markdown handoffs outperform monolithic prompt accumulation and stabilize verify–correct loops.
   — [Hybrid multi-agent pipeline (2026)](https://pmc.ncbi.nlm.nih.gov/articles/PMC13287573/)

**Design rule that falls out:** *complexity belongs in what the model can DO (tools with hard validation), never in how calls are governed (budgets, fallbacks, retries).* All four critical bugs of the current system (D1–D4) live in the governance layer; none live in the tool loop.

---

## Part C — v2 Architecture (rev 2.1: file tools)

> **What changed from v2.0:** the op-DSL commit (C.2 place_part/wire/set_firmware), the failure taxonomy (C.4), the 8-call cap, and the 7-event redesign are **deleted**. They were reliability engineering layered over the real problem. The real problem: the model had no hands. Give it files and a compiler, and that pathology class (blob parsing, salvage, format-vs-design attempts) stops existing rather than getting managed.
>
> **What changed in rev 2.2 (review fixes):** `edit_file` added so `diagram.json` fixes are small diffs, not whole-file rewrites (whole-file on structured data was v2.0's blob rebased into a file); `check()` doubles as the corruption detector so a truncated write is a named tool result, never silent; `done()` verifies the design against what the user actually named before ending the run; transport selection moves from model-id substring matching to an explicit setting + one-time probe; `simulate()` gets hard execution bounds so hanging firmware costs one bounded tool result; the cost model now counts input tokens honestly.
>
> **What changed in rev 2.3 (review fixes II):** the simulate bounds were four guards stacked on one failure — the exact A.1 disease — and are cut to two (one virtual-time cap + one fixed wall-clock kill); the intent check's "or explain why it is absent" escape hatch is deleted (a prose gate is talk-through-able, D7 in one line) and the check is stated honestly: it catches MISSING parts only, wrong-part substitution is decided by the user at the pending checkpoint, not by keyword matching; and the retry-layer rule is made explicit — ONE retry count, ever.

### C.1 The workspace
The project IS a file set (Wokwi-compatible — this repo already speaks it):

- `sketch.ino` — entry firmware (+ optional flat headers; `main.py` for Pi targets)
- `diagram.json` — parts + connections (boards, components, wires)

A pure converter module maps `Project` ↔ workspace files, shared by the agent tools and the browser's apply step. A run-scoped workspace materializes the current project at run start; at the end, the **diff** goes to the browser through the existing checkpoint/undo machinery.

### C.2 Tools — the complete list (8)
Native tool use on both transports (Converse `toolConfig`, Mantle OpenAI `tools`). **No Proposal artifact exists anywhere** — the transport parses tool calls, so our JSON schema, the salvage pipeline and the fixer are simply deleted.

| Tool | Does |
|---|---|
| `list_files` | workspace listing |
| `read_file` | one file |
| `write_file` | create/replace a whole file — for code and for brand-new circuits (whole-file is the most reliable *creation* format: Aider ~99% well-formed) |
| `edit_file` | exact `old_string → new_string` replacement, fails loudly when the anchor isn't found — the default for **fixing** `diagram.json` (one wire, one part) so a one-line fix is a ~40-token diff instead of a whole-circuit rewrite |
| `catalog(query)` | part ids, pins, the selected board's pinout |
| `check()` | deterministic linter: parses both files (a truncated/corrupted write is a **named tool result**, never silent), then `assert_clean` + `validate_electrical`; auto-runs before every compile — a pre-commit hook, not a gate ritual |
| `compile()` | arduino-cli via the warm pool; returns stdout/stderr (clipped to the tail) like a real command |
| `simulate()` | headless AVR run of the workspace with stimuli — **exactly two enforcement mechanisms, nothing stacked**: one virtual-time cap (`observe_ms`, default 3s, max 10s simulated) and one fixed wall-clock kill (10s, isolated subprocess). The wall clock exists only because runaway firmware can avoid advancing virtual time; it is a constant, not a multiplier, and there is no instruction ceiling — insurance-on-insurance was the A.1 disease. A `while(1);` sketch costs one bounded tool result ("ended at budget, loop never yields"), not a stall |
| `done(summary, expectations?)` | terminal call — see C.3 for the intent check it must pass |

Size caps enforced by the tools with clear errors (never silent truncation): single file ≤ 64 KB, workspace ≤ 200 KB. Typical `diagram.json` for a max design (40 parts / 100 wires) is ~15–30 KB — inside one comfortable write.

### C.3 The loop
```
write/edit → check/compile → read error → fix → repeat → done()
```
Governance is three protections that belong to the **user**, never to the model's behavior:

1. wall clock (the existing run budget)
2. turn cap (`AGENT_MAX_TURNS`, generous — 24)
3. the existing 2-slot semaphore

No memo, no single-flight, no nudges, no `_COMMIT_NOW`, no commit reserve, no salvage, no failure classes. An error is a tool result the model reads exactly like a developer does.

**The intent check (compiles ≠ what the user meant) — stated honestly.** Two mechanisms with strictly divided jobs:

1. `done()` runs one deterministic cross-reference before accepting: catalog part names mentioned in the user's prompt vs parts actually present in the workspace. Missing → `done()` rejects with the fact and nothing else: `"prompt names slider; no slider part in the circuit"`. **No justification path** — the remedy is to add the part, not to write prose; a talk-your-way-past hatch would be D7 rebuilt one line deep. What this check catches: a part being **missing**.
2. What no keyword match can catch: a part being **wrong** (a 5-position selector and a continuous slider both say "servo"). That is not decidable from prose, so it is not attempted. Wrongness is decided by the **pending checkpoint**: diff + summary land as an accept/reject proposal with one-click undo (the flow that already exists). The user — not a matcher, not an essay — is the intent verifier for everything the deterministic check cannot see.

### C.4 Provider layer
Unchanged from Phase 0 (already on this branch): Bedrock only; Converse role-merge + `wait_for` bound + retry clamp in place. The one addition: native tool-use payloads on both transports — with them, "malformed JSON" stops being our error class at all.

**Transport selection is configuration, not string matching.** `BEDROCK_TRANSPORT = converse | mantle` (default `converse`). A one-time startup probe sends two tiny calls down the configured pair and caches the verdict, logging it at boot; a mismatch fails fast with "model X needs BEDROCK_TRANSPORT=mantle". The per-call `kimi/moonshot` substring heuristic is deleted — a model rename can no longer silently reroute traffic.

**On Bedrock-only (deliberate, kept):** "Bedrock has a bad day" is answered by bounded call-level retries (already in place) and a clear error — not by a second provider. A silent fallback was the original sin of v1 (the planner callback); the fix is one path that fails honestly, and it stays.

**Retry discipline (the D3 rule: ONE retry count, ever).** D3 was two retry layers stacked (botocore 50 under a loop of 15) inside an uncancellable thread. Today's branch has the stack bounded (botocore ≤5, whole call `wait_for`-clamped, loop 15×/30s and heartbeated) so the freeze cannot recur — but it is still two counters. Phase 2 collapses them for good: botocore `max_attempts=1` (transport errors surface immediately as data), and `propose()`'s loop is the only retry mechanism in the system. One counter, visible, budgeted.

### C.5 Compile & simulate services
Warm pool (1–2 arduino-cli workers) behind `compile()`; per-family ceiling enforced by the pool; a cold first build queues with heartbeats instead of burning the run's budget. `draft_compile` and the final compile collapse into the same tool.

`simulate()` enforcement (see C.2) is two mechanisms — one virtual-time cap, one fixed wall-clock kill in an isolated subprocess. Hanging firmware is impossible as a stall mode, and the timeout is ordinary data: a tool result the model reads and fixes.

### C.6 Browser contract
Events stay close to today's (`run_started, stage, tools, plan, heartbeat, compile, result, answer, error, retry, note, forge`) minus the memo/nudge internals — there is no separate `output` event; the live text preview rides `heartbeat`. Final step: the workspace diff + summary + expectations land as a **pending checkpoint** (accept/reject, one-click undo), then the existing electrical pre-flight and live-simulation verification run — still the last gate, unchanged.

### C.7 Evals (unchanged from v2.0 — still the missing suite)
Golden prompts, nightly, real Bedrock, outcome checks only: compiles → expectations pass in the headless sim. Tracked per model (success rate, turns, tokens, wall clock). PR gate on a ≥10pt success-rate drop.

### C.8 What v2.0 proposed that rev 2.1 kills
| v2.0 | why it's gone |
|---|---|
| op-DSL commit (`place_part`/`wire`/`set_firmware`/`build`/`submit`) | small-file-edits-with-validation reinvented as a hardware DSL; file tools + a compiler are the same thing natively |
| failure taxonomy (transport/format/design) | structure used to control the loop; with real tools the loop needs no interpretation |
| 8-call cap + budget hierarchy | one turn cap + wall clock; more governors meant less trust in the only part that works |
| 7-event protocol redesign | event surface shrinks by deleting loop internals, not by redesigning the protocol |
| "policy lives in tools" (v2.0 C.7) | subsumed — there are only tools now; the system prompt is role + a few electrical rules + the workspace snapshot (~4–6k chars) |

### C.9 Migration (rev 2.1)
| Phase | Content | Size | Risk |
|---|---|---|---|
| 0 — done | Bedrock-only; fallback removed; retry clamp; role-merge; wait_for bound; memo fix | shipped | — |
| 1 | Project ↔ workspace converter + run-scoped workspace | small | low |
| 2 | Native tool-use + the 9 tools (incl. `edit_file`), size caps, simulate's two-mode enforcement, transport setting + probe, single retry layer (botocore `max_attempts=1`) | medium | low |
| 3 | Loop replacement in `service.py` (delete salvage/memo/nudge/proposal paths; `done()` carries summary + expectations + the prompt-mention check; pending-checkpoint UX) | medium | medium |
| 4 | Warm compile pool behind `compile()` | medium | low |
| 5 | Dead-code deletion (salvage, fixer remnants, draft_* wrappers) + evals in CI | medium | low |

### C.10 Cost model (two-sided — input dominates)
The turn cap multiplies **both** sides of the bill; only counting output was wrong. Honest numbers for a typical run (6–12 turns):

- **Input is the big line and grows every turn**: static prefix (~5k) + workspace snapshot + clipped tool results (~0.5–2k/turn) → cumulative **~60–150k input tokens/run**. Mitigations already in the design: the prefix never changes (cacheable — Converse/Mantle both honor prompt caching), tool results are tails-not-fires (compile stderr clipped), and tool calls never re-emit the whole design.
- **Output**: ~8–20k tokens/run (files + tool args; only `write_file` of a new circuit is large, and it happens once).
- **Worst case** is the turn cap: 24 turns ≈ ~250k input + ~40k output — a bounded, meterable number.

Per-run metering already exists in run records (prompt + completion per call) — token cost per simulation becomes a pricing-page number the moment it's measured, not estimated.

---

## Appendix — Branch state (Phase 0, already applied)

`backend/app/core/config.py` (providers: bedrock-only, `AGENT_BUILTIN=false`, `BEDROCK_MAX_RETRIES=3`) · `backend/app/agent/service.py` (fallback removal, memo order fix, Converse role-merge + wait_for bound + retry clamp, dead adapters deleted, fixer dispatch narrowed) · `backend/app/agent/models.py` (provider literal) · `backend/app/api/routes/agent.py` (bedrock default) · `backend/app/agent/runlog.py`, `.env.example`, `docs/agent-workspace.md`, `frontend/src/components/agent/AgentPanel.tsx` (docs/labels) · tests updated to the Bedrock-only contract + streaming-capable fake client.

**Status: implemented on this branch.** Phases 1–5 are written (`config.py`, `workspace.py`, `compile_service.py`, `toolspecs.py`, `service.py` rewrites; `tools.py`/`jsonrepair.py` deleted). The transport is a config flag (`BEDROCK_TRANSPORT`, probed once), so no model id is baked into code; the 8-tool-call ceiling ships and is watched against `eval/golden.yaml` (nightly, ≥10pt gate).

**Decision still open (runtime, not code):** confirm the production model id in `BEDROCK_MODEL_ID`, and watch the golden-prompt turn counts — if the hardest prompts brush the 24-turn cap, raise the cap, never reintroduce stacked governors.
