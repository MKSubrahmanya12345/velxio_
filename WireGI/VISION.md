# Wireup / WireGI — Vision

> A system that produces the **behavior** of an AGI on long build projects —
> persistent, general, self-directed, accountable — without requiring the
> **capability** of one.

---

## 1. The thesis, in one line

```
agent → interface (human ↔ AI) → IDEA state (continuously edited)
      → CURRENT state → work until they match
```

That is the whole product. Everything else exists to keep that loop alive across
**days and weeks** instead of one chat turn.

## 2. What "mock an AGI" actually means

There are two very different things, and conflating them is the main risk:

| | What it is | Buildable? |
| --- | --- | --- |
| **Capability-AGI** | a model that can do anything | No |
| **Behavior-AGI** | a system whose *observable signature* is indistinguishable from a persistent working intelligence | **Yes, today** |

The signature has five parts:

1. **Remembers** — project state survives sessions, restarts, weeks.
2. **Persists** — takes the next step without being re-prompted.
3. **Asks** — raises doubts in both directions, at the right moment.
4. **Verifies** — distinguishes "built" from "confirmed working".
5. **Finishes** — knows when the job is done, and refuses to pretend.

None of these need a better model. They need **state, protocol, and discipline**.
That is why "mock" is the correct word: we mock the *experience* of working with
an intelligence, not the intelligence itself.

## 3. The third state

The original sketch named two states (IDEA, CURRENT). Note 3 requires three: if a
test can pass while the feature is incomplete, then CURRENT ≠ VERIFIED.

| State | Meaning | Falsifiable? |
| --- | --- | --- |
| **IDEA** | what the human wants | per-requirement |
| **CURRENT** | what exists | yes |
| **VERIFIED** | what is *confirmed* working | only with evidence |

**Verification is a ladder, not a checkbox.** Each rung converts a different kind
of uncertainty into confidence:

```
research  →  simulation  →  automated test  →  bench test  →  human eyes
 (knows)      (models)        (checks)           (measures)     (confirms)
```

That is the real answer to "tests aren't foolproof": never rely on one rung. A
green test on the wrong assumption is worse than no test, because it *feels* like
evidence.

## 4. The uncomfortable consequence

The top rung is human. Anything a simulator cannot model — does the solder joint
hold, does it fly in wind, does the finish look right — has no machine check.
So **the loop cannot be fully autonomous, by design.**

Therefore this is a **symbiosis product, not an automation product**. The design
goal is not "remove the human", it is:

> **maximize value per interruption.**

Interrupt only when:
- the ladder cannot decide,
- the decision is irreversible or expensive,
- it is a **preference**, not a fact.

Everything else: decide, record why, move on.

## 5. It is not a loop, it is a durable process

Days/weeks breaks the chat-agent model. The unit of work is a **job living on
disk**, not a turn:

- checkpoints after every step (atomic writes)
- resume from a crash without redoing work
- idempotent steps (re-running a finished step is a no-op)
- scheduled re-checks (things go stale)
- a **declared budget** — because "never stop" is otherwise an unbounded bill

Cost control is not an optimization here; it is what makes a never-ending loop
affordable at all.

**Time is a real axis.** Parts go out of stock, libraries break, the IDEA itself
changes. "Some ideas go off, some get added" is **state drift**, and drift must
be *detectable*: TTL on research, re-verify stale parts, rather than silently
trusting a three-week-old answer.

## 6. The four hard problems

| Problem | Why it is hard | Status |
| --- | --- | --- |
| **Generality** | "anything buildable" has no single schema | domain profiles |
| **Reassembly** | parts researched alone ≠ a coherent build | reconciliation |
| **Satisfaction** | cannot be measured, only reported | human gate |
| **Cost** | "never stop" is unbounded | Jev gating |

### Generality
The bottleneck was never the agent loop — it is that "buildable" means different
*shapes*. Hardware needs battery/wiring/config. Software needs deps/tests/deploy.
Mechanical needs dimensions/material/joinery. So: **one domain-agnostic engine +
a profile** that declares the schema, the verification ladder, and the guards.

### Reassembly
The most underrated part, and the literal answer to "fragmentation". The value is
not researching nine drone parts — it is that the nine results **agree**. Battery
capacity ↔ motor KV ↔ ESC current ↔ prop size is a coupled system; researched
independently, every part is locally right and the build is globally wrong.

*(Forge already solves this shape of problem in `memory/decisions.js`: reconcile
new claims against established state, hunt contradictions, resolve them. Reuse
that primitive rather than reinventing it.)*

### Satisfaction
Only the human can report it. So make the report cheap and make the agent's
*reasoning* auditable — see §7.

### Cost
Route with the cheap decision layer, compute in code, and only write with the
LLM when it is genuinely needed.

## 7. State must store more than "what"

| Field | Why it matters at week six |
| --- | --- |
| **what** | the finding |
| **why** | which IDEA requirement it serves |
| **how** | the rungs it passed, with evidence |
| **when** | staleness / TTL |
| **who** | agent / decision-model / human |

`verified: true` is worthless in week six.
*"sim pass + human eyeball, 12 days ago"* is usable.

## 8. The interface is a negotiation surface

Chat cannot carry weeks of state. The UI must show the three states, the ladder,
the evidence, and the open questions — because **the interface is where trust is
built**. The human needs to audit *why* the agent believes something, not just
read its conclusions.

## 9. Phase 2 is not a feature — it is the rung that makes Phase 1 scale

Simulation converts "ask the human" into "check the machine". **The more rungs
below the human, the fewer interruptions.** Per domain:

| Domain | First simulator |
| --- | --- |
| Electronics | **Velxio — already in this repo** |
| Mechanics / physics | rigid-body + load |
| Robotics | control loops, kinematics |
| Websites | headless browser + test runner |

Phase 2 does not replace Phase 1. It is what makes generality affordable instead
of interrupt-driven.

## 10. Forge is the mind; WireGI is the hands

- **Forge** — ideas, notes, reconciling memory, human-as-tool decisions.
- **WireGI** — parts, builds, verification, durable project state.

They already share provider, failover and decision plumbing. Forge's decision
catalog states it plainly: *"Human is a tool: JEV decides when to call human,
what to ask, and whether human's report counts."* That **is** the interruption
economics engine this project needs. End state: **one memory, two surfaces.**

## 11. The risk, stated plainly

**Generality is where this dies.** Every "build anything" agent fails by
spreading thin. Nine mediocre profiles lose to one great one.

The credible path:

1. **Win one domain completely** — embedded/MCU, because the simulator already
   exists here.
2. Prove the weeks-long loop and the human ladder actually work.
3. *Then* add profiles.

"Any project" is the destination, not the first release.

## 12. Naming

Internally, "mock AGI" is a sharp thesis. Externally it is expectation debt. The
product is **an agent that works like a colleague on a long project** — which is
exactly what is described above, minus the promise.

## 13. Build order

| # | Change | Unlocks |
| --- | --- | --- |
| 1 | **Domain profiles** — schema, ladder, guards per domain | generality |
| 2 | **Reconciliation pass** — cross-part consistency + patches | a coherent build |
| 3 | **Evidence trail** — rungs, not booleans | trustworthy VERIFIED |
| 4 | **IDEA revisions** — the living document | drift visible |
| 5 | **Wire the human gate** — the ladder's top rung | "approved with my own eyes" |
| 6 | **Index reuse** — real prior-context retrieval | speed, cost |
| 7 | **Simulation** (Phase 2) — Velxio as rung 2 | fewer interruptions |

Items 1–6 are the Phase 1 engine. Item 7 is what makes it scale.
