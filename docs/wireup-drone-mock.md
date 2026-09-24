# Wireup — Drone Mock Project & Site Mechanics

> **What this doc is:** a working mock of how the *Wireup* site behaves on a real request —
> *"I want to build a 5-inch FPV drone"* — plus the actual, buildable output you can take and
> assemble today. Simulator (Velxio) is **intentionally out of scope here** (Phase 2); this is the
> `research → gather → understand → data` pipeline only, end to end.

Two things happen at once in this doc:
1. **The site mechanics** — how a prompt becomes data through Jev decisions + parallel part-agents.
2. **The drone** — a real Bill of Materials, wiring, and firmware so you can *physically build it*.

---

## 0. TL;DR of the flow

```
PROMPT ─▶ JEV (initial runs / decision-maker) ─▶ DECOMPOSE into PARTS
                                                       │
                          ┌────────────────────────────┴───────────────────────────┐
                          │  each PART runs the pipeline IN PARALLEL                │
                          │  research → gather → understand → data                  │
                          └────────────────────────────┬───────────────────────────┘
                                                       ▼
                                          MERGE into PROJECT STATE
                                  (IDEA ⇄ CURRENT ⇄ VERIFIED per part)
                                                       ▼
                              HUMAN CHECKPOINTS (eyes/approval) ─▶ BUILD
```

---

## 1. Jev = the decision-maker (your point 4, fully resolved)

### What Jev actually is (from research)

**Jev** is TypeSafe AI's *System One Model* — a non-autoregressive, typed **decision model**, not a chatbot
[1](https://www.producthunt.com/products/jev-2) [2](https://kie.ai/blog/what-is-jev) [3](https://www.datacamp.com/blog/system-one-models-jev).

| Property | Value |
| --- | --- |
| Input | Unstructured **state** + **typed questions** |
| Output | **Choice** (≤255 options), **Score** (rubric), **Noul** (calibrated yes/no) — each with confidence |
| Latency | 70–500 ms per decision |
| Cost | $0.042 / 1M input tokens, **output free** (~20–200× faster, 40–400× cheaper than LLM workflows) |
| Hallucination | **Structurally impossible** — valid outputs are defined by the schema up front |
| Role | A **decision layer**, not an orchestrator. You drop it into software you already run [2](https://www.datacamp.com/blog/system-one-models-jev) [cobusgreyling](https://cobusgreyling.substack.com/p/jev-by-typesafe-ai-611) |
| Launched | Sept 15, 2026; already integrated into Vercel AI Gateway, Cloudflare, LangChain [forbes](https://www.forbes.com/sites/josipamajic/2026/09/19/jev-cuts-ai-decision-costs-100x-and-vercel-cloudflare-rushed-to-add-it/) |
| Wild detail | TypeSafe's own launch demos include a **simulated drone navigating an obstacle course** [mindstudio](https://www.mindstudio.ai/blog/jev-system-one-model-launch) — the decision layer literally flies. |

**The mental model:** the LLM (System 2) does the *open-ended research, writing, and reasoning*.
Jev (System 1) makes the *bounded decisions*: classify, route, gate, verify, escalate, stop.

### Why Jev answers your point 4 ("decision-maker for the initial runs")

Your point 4 worried about the loop never ending and burning tokens. That is **exactly** the problem Jev solves:

- **The "initial runs" = Jev, not the LLM.** The first thing that happens to a prompt is a batch of
  typed Jev questions — *what domain is this? how many parts? which part is highest risk? is the
  gathered data complete?* — answered in one ~200 ms call for near-zero cost. The expensive LLM only
  wakes up to *do* the research for parts that need it.
- **The "satisfaction checkpoint" / stop condition = a Jev Noul.** Instead of "the agent works until
  the user is satisfied" being an unbounded LLM loop, it becomes a typed question:
  *"Does CURRENT state == IDEA state for all VERIFIED parts?"* → Noul with confidence. Above threshold →
  stop and surface to human. Below → spawn the next agent run.
- **Cost ceiling is enforceable.** Jev scores confidence; low-confidence decisions escalate to a human or
  to the LLM, while high-confidence ones auto-execute. You cap LLM spend by routing most loop decisions
  through Jev.
- **Tiered verification = stacked Noul/Score calls.** sim-pass < test-pass < human-visual-confirm become
  explicit decision gates (sim tier added in Phase 2 on top of Velxio).

### The Jev decision set for the drone request

| # | Question type | Question (asked of project state) | Example answer |
| --- | --- | --- | --- |
| D1 | **Choice** | What project class is this? | `fpv-quadcopter` → routes to `embedded + mechanical` domains |
| D2 | **Choice** | Decompose into how many parts? | 9 parts (frame, motors, ESC, FC, props, RX, video, battery, firmware) |
| D3 | **Score** | Risk/priority of each part (1–5)? | firmware=5, FC=4, battery=3 … |
| D4 | **Noul** | Is each part's gathered data *complete & conflict-free*? | FC: 0.94 yes → proceed; battery: 0.61 no → gather more |
| D5 | **Noul** | Does any part **require human eyes** (solder/eyeball)? | yes → insert human checkpoint |
| D6 | **Noul** | Is CURRENT == IDEA for all VERIFIED parts? (stop gate) | 0.12 → keep running |

This is the whole "agent works until satisfied" mechanism, made cheap and bounded.

---

## 2. Site mechanics: the `research → gather → understand → data` pipeline

Every **part** is a unit of work that flows through four stages. The LLM does the creative labor;
Jev (D4/D6) decides when a stage's output is good enough to advance.

| Stage | What happens | Output |
| --- | --- | --- |
| **RESEARCH** | Web + LLM pull datasheets, guides, community builds, compat matrices | Raw sourced notes + citations |
| **GATHER** | Extract structured fields: part #, spec, price, source, constraints | Typed records per part |
| **UNDERSTAND** | Reconcile against project constraints (battery V vs motor KV, ESC A vs motor draw, mount patterns); resolve conflicts; flag unknowns | Validated spec + open questions |
| **DATA** | Emit the buildable artifact: BOM row, wiring, config snippet, verification checklist | Merge-ready project data |

**Project state (the 3-state model from earlier research):**

```
IDEA      = what the human wants (the prompt + clarifications)
CURRENT   = what has actually been built/gathered
VERIFIED  = what has been confirmed (sim / test / human eyes)
```

Each part carries its own `IDEA⇄CURRENT⇄VERIFIED` flags. The agent's only job is to push every part
from IDEA toward VERIFIED, and it can resume that job days later because the state is durable.

---

## 3. LINEAR walkthrough — one part, fully traced

**Part: Flight Controller + Firmware** (the part the user flagged as "fragmentation we solve").

**RESEARCH** — sources pulled:
- Firmware guide (Betaflight / iNav / ArduPilot) [blackbastion](https://www.blackbastionsystems.com/articles/best-flight-controllers) [oscarliang](https://oscarliang.com/fc-firmware/)
- MCU breakdown (STM32 F4/F7/H7 dominate; ESP32-S for video-to-phone) [ampheo](https://www.ampheo.com/blog/which-microcontrollers-are-used-in-drones)
- Component compatibility (mount 30.5×30.5, gyro ICM-42688-P) [thedroneflight](https://thedroneflight.com/blogs/news/fpv-drone-component-compatibility-guide-motors-escs-flight-controllers-more)

**GATHER** — typed records:
```
fc.processor      = STM32F745 (F7)        source: ampheo
fc.gyro           = ICM-42688-P           source: blackbastion
fc.mount          = 30.5 x 30.5 mm        source: thedroneflight
fc.firmware       = Betaflight 2025.12.2  source: blackbastion
fc.voltage_in     = 2–6S (covers our 4S)  source: thedroneflight
fc.price          = ~$55 (F7 AIO stack)   source: dronesgator
```

**UNDERSTAND** — reconciliation:
- Frame is 5″ with 30.5 mount → FC mount **matches** ✅
- Battery is 4S (14.8V) → within FC `2–6S` range ✅
- F7 recommended for 2026 builds (headroom over F4) ✅
- Open question: do we want GPS/RTH later? If yes, iNav/ArduPilot; for freestyle Betaflight wins → **ask human** (Jev D5 = yes, human checkpoint)
- Fragmentation insight: *firmware is its own part* — the FC hardware and the firmware flashed on it are
  decoupled decisions. We keep them as separate parts so the human can swap Betaflight↔ArduPilot without
  re-researching the board.

**DATA** — buildable artifact emitted to project state:
```
BOM row : FC  = Holybro Kakute F7 / Matek F405-STD, 30.5 mount, ICM-42688-P, ~$55
Flash   : Betaflight Configurator → flash target → calibrate accelerometer + gyro
Verify  : [ ] USB connects  [ ] gyro live  [ ] motors spin in correct order in Betaflight
Human   : solder stack to ESC + confirm no short with multimeter before power
```

That is one part, fully closed. Now multiply it.

---

## 4. PARALLEL walkthrough — all parts fan out

Jev D2 decomposed the request into **9 parts**. The site spawns 9 part-agents that each run the
pipeline **concurrently**, then merge into one project state.

```
                         JEV D1/D2 (classify + decompose)
                                    │
        ┌──────────────┬────────────┬────────────┬────────────┬────────────┐
        ▼              ▼            ▼            ▼            ▼            ▼
   [Frame]        [Motors]      [ESC]       [FC+FW]      [Props]      [RX/Radio]
        ▼              ▼            ▼            ▼            ▼            ▼
   [Video]        [Battery]    [Firmware]   (all run research→gather→understand→data)
        └──────────────┴────────────┴────────────┴────────────┴────────────┘
                                    │
                                    ▼
                       MERGE → PROJECT STATE (IDEA/CURRENT/VERIFIED)
                                    │
                         JEV D4 (complete?) → D5 (human eyes?) → D6 (done?)
```

| Part | Key gathered data | Human-eyes? |
| --- | --- | --- |
| Frame | 5″ carbon, 210–230 mm, 30.5 stack mount, <80 g, ~$15–60 [dronesgator](https://dronesgator.com/how-to-build-a-drone) | No |
| Motors ×4 | 2207 size; **KV matched to battery**: 4S→2400–2700 kV, 6S→1700–2200 kV [dronesgator](https://dronesgator.com/how-to-build-a-drone) | No |
| ESC (4-in-1) | 35–55 A per motor, BLHeli_32/S, amp-rating > motor draw +20% [thedroneflight](https://thedroneflight.com/blogs/news/fpv-drone-component-compatibility-guide-motors-escs-flight-controllers-more) | Solder |
| FC + FW | F7, ICM-42688-P, Betaflight (see §3) | Solder + USB |
| Props | 5″ (5040–5149), 3-blade; pitch = speed [thedroneflight](https://thedroneflight.com/blogs/news/fpv-drone-component-compatibility-guide-motors-escs-flight-controllers-more) | No |
| RX / Radio | ExpressLRS 2.4 GHz (matches Radiomaster TX) [dronesgator](https://dronesgator.com/how-to-build-a-drone) | Bind |
| Video | Analog: Foxeer/Caddx cam + 200–400 mW VTX; Digital: DJI O3/O4 [dronesgator](https://dronesgator.com/how-to-build-a-drone) | Solder |
| Battery | 4S 1300–1800 mAh LiPo, ≥75C, XT60 [dronesgator](https://dronesgator.com/how-to-build-a-drone) | Handle (LiPo safety) |
| Firmware | **Betaflight** freestyle/racing · **iNav** GPS nav · **ArduPilot** autonomy [oscarliang](https://oscarliang.com/fc-firmware/) · **ESP32 custom** MCU angle ↓ | Flash + tune |

The "fragmentation" problem is solved by this very structure: a single drone idea is **one project
state**, but it's composed of **9 independently researchable, gatherable, understandable, verifiable
parts** — each can be revised, swapped, or human-approved without disturbing the others.

---

## 5. THE DRONE — buildable deliverable

### 5.1 Bill of Materials (5″ freestyle quad, 4S)

| # | Component | Spec | ≈ Price | Source |
| --- | --- | --- | --- | --- |
| 1 | Frame | 5″ carbon, 30.5×30.5 stack, ~210 mm | $19–60 | [dronesgator](https://dronesgator.com/how-to-build-a-drone) |
| 2 | Motors ×4 | 2207, **2500 kV** (4S) | ~$40–80/set | [dronesgator](https://dronesgator.com/how-to-build-a-drone) |
| 3 | 4-in-1 ESC | 45 A, BLHeli_32, F4/F7 | $50–120 | [thedroneflight](https://thedroneflight.com/blogs/news/fpv-drone-component-compatibility-guide-motors-escs-flight-controllers-more) |
| 4 | Flight Controller | F7 (STM32F745), ICM-42688-P, 30.5 | ~$55 | [blackbastion](https://www.blackbastionsystems.com/articles/best-flight-controllers) |
| 5 | Props | 5″ 3-blade (5040–5149) | $5–15/pack | [thedroneflight](https://thedroneflight.com/blogs/news/fpv-drone-component-compatibility-guide-motors-escs-flight-controllers-more) |
| 6 | Receiver | ExpressLRS 2.4 GHz (EP1/EP2) | $15–30 | [dronesgator](https://dronesgator.com/how-to-build-a-drone) |
| 7 | FPV Camera | Foxeer/Caddx analog, 2.8 mm | $20–40 | [dronesgator](https://dronesgator.com/how-to-build-a-drone) |
| 8 | VTX | 200–400 mW analog | $20–40 | [dronesgator](https://dronesgator.com/how-to-build-a-drone) |
| 9 | Battery ×2 | **4S 1500 mAh LiPo, 100C, XT60** | ~$22–40 ea | [dronesgator](https://dronesgator.com/how-to-build-a-drone) |
| 10 | Charger | ToolkitRC / ISDT balance charger | $20–60 | [dronesgator](https://dronesgator.com/how-to-build-a-drone) |
| — | Firmware | **Betaflight 2025.12.2** | free | [blackbastion](https://www.blackbastionsystems.com/articles/best-flight-controllers) |

> Prices are indicative from the cited 2026 build guides; verify live before ordering.

### 5.2 Tools
Solder (63/37 rosin-core, 0.8 mm), M2/M3 hex drivers, wire cutters/strippers, **multimeter** (continuity
+ short check before power), zip ties. [dronesgator](https://dronesgator.com/how-to-build-a-drone)

### 5.3 Assembly sequence (linear)
1. Frame: standoffs + arms + top plate; don't over-torque carbon.
2. Motors: mount ×4, route wires through arms; note rotation direction.
3. ESC: solder motor wires (order fixable in software) + battery lead to ESC power pads.
4. FC: mount on anti-vibration standoffs; connect to ESC via ribbon/direct solder.
5. RX: wire to FC UART; route antenna clear of motor noise.
6. Camera + VTX: mount cam at 30–45°, solder VTX to power rail.
7. **Multimeter: confirm no short between battery pads before first plug-in.** [uavdroneacademy](https://www.uavdroneacademy.com/en/blog/fpv-drone-anatomy-understanding-every-component)

### 5.4 Firmware (the part you called out)
- **Betaflight** = freestyle/racing standard, largest community, widest HW support, lowest latency
  [oscarliang](https://oscarliang.com/fc-firmware/). Flash via Betaflight Configurator → select target →
  calibrate accel/gyro → set motor order → tune filters.
- **iNav** = GPS position-hold / RTH in an accessible package; **ArduPilot 4.6.3** = full autonomy/VTOL
  (overkill for freestyle) [blackbastion](https://www.blackbastionsystems.com/articles/best-flight-controllers).
- **ESP32 custom angle (why this matters for *us*):** the repo (Velxio) emulates ESP32. A custom
  ESP32-S/ESP32-C3 firmware lets a builder skip Betaflight and run their *own* stabilization loop —
  exactly the "fragmentation solved" win: the FC board is one part, the firmware running on it is
  another, and the human can swap them independently. ESP32-S is already used in FPV video-to-phone
  links [ampheo](https://www.ampheo.com/blog/which-microcontrollers-are-used-in-drones).

Minimal ESP32 stabilization sketch (Arduino/C++, illustrative):
```cpp
// ESP32 custom flight loop — reads gyro, mixes to 4 motors (pseudo-code)
void loop() {
  Imu::read(ax, ay, az, gx, gy, gz);          // ICM-42688 over I2C/SPI
  pid_roll.update(gx); pid_pitch.update(gy);  // simple PIDs
  mix(throttle, pid_roll.out, pid_pitch.out, pid_yaw.out, m1..m4);
  esc.set(m1, m2, m3, m4);                    // BLHeli_32 via DSHOT
  delay(2);                                   // ~500 Hz loop
}
```
This is the *alternative firmware path* the site would research/gather/understand/verify as its own part.

---

## 6. Fragmentation, solved

The site's core value is the **glue**, not any single answer:

```
ONE IDEA ("build a drone")
   │  Jev decomposes
   ▼
N PARTS (frame, motors, ESC, FC, firmware, …)   ← each independently:
   research → gather → understand → data
   │
   ├─ can be revised without breaking siblings
   ├─ carries its own IDEA/CURRENT/VERIFIED flags
   ├─ inserts a human checkpoint only where eyes are required
   ▼
MERGED PROJECT STATE  →  you walk away with a BOM + wiring + firmware you can build
```

That is the "mock AGI" in practice: not one model that knows everything, but a **durable orchestration**
where a cheap decision layer (Jev) keeps a persistent, resumable project state honest while specialist
agents (LLMs) do the deep work — across days, with human eyes at exactly the right gates.

---

## 7. What's next (proposed)
- **A)** Promote this into `docs/wireup/architecture.md` with the Jev API contract (state schema + question types).
- **B)** Prototype the **Project State service** (3-state model) + a Jev decision client (the D1–D6 calls).
- **C)** Wire the **Velxio simulator** in as verification tier 1 (Phase 2) so firmware parts get a sim-pass Noul.

Pick a letter and I'll build it.

---

## 9. Two things the mock was missing (now built)

### The debugger — the run explains itself

The first version of this doc described the flow but not what happens when it breaks. A real run now
emits, for every event: `seq`, `ts`, elapsed `t`, `runId`, `level`, `type`, `stage`, a guaranteed
non-empty `message`, and any payload (part, provider, status, latency, phase timing). On top of that:

- **provider attempts are attempts, not failures** — a 429 on one key is `provider.fail` with its status
  and latency, and the run continues down the failover list. That single distinction is what removed
  `ERROR undefined` from the UI for good.
- a terminal failure is one `{ type:'error', fatal:true, error:{ name, message, where, status, provider,
  stack, attempts[] } }` — and the UI renders the attempt table, so "which key failed, with what status,
  in how long" is a table, not a hunt.
- each project persists `state.runs` (one record per run: kind, status, ms, event count), `state.errors`
  and `state.runLog` (a bounded copy of every event), readable in the UI's **Flow** and **Debug** tabs or
  as one exported JSON file.
- the project is saved **before** the first LLM call, so a run that dies inside decomposition is still
  inspectable (this is exactly the failure the first live run produced: nothing was stored at all).
- `POST /api/debug/llm-test` runs one real generation and reports every credential it tried; `/api/debug/env`
  reports which `.env` files were loaded, which keys are present, and where each one came from.

### The human checkpoint — `awaiting_human` is not a dead end

`awaiting_human` is the *correct* terminal state (the ladder's top rung is human), but it had no chat
interface: the project said “needs you”, and the only exit was a free-text message whose intent an LLM had
to classify. That is slow, and it is broken exactly when it matters most — when no provider is reachable.

`POST /api/projects/:id/human { partId?, decision, text }` with `decision ∈ {approve, provide, rerun,
reject}` is **deterministic**: no Jev, no LLM, no tokens. `approve` appends a `human-eyes` rung to the
part's evidence trail with who approved and what they said; `provide` stores the answer on the part;
`rerun`/`reject` re-research that part with the human's words injected into the prompt as authoritative
(`HUMAN INPUT … do not contradict it`). In the UI it is a card in the chat listing each waiting part, its
open questions and the BOM/wiring it wants confirmed, with buttons for all four actions.
