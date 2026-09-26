# Circuit agent workspace

The editor has an OSS, VS Code-style **Chat / Checkpoints** sidebar. The agent
can create circuits and edit the current workspace through conversation. It is
**opt-in**; without model configuration the normal editor still works, and the
sidebar shows setup instructions. No canned circuit generator is used in production.

## Supported scope

- Catalog boards are build targets: Arduino, ESP32, RP2040, STM32, and Raspberry Pi. One entry file (`.ino` or `.py`) plus optional flat headers.
- **The whole canvas catalog**: every one of the 157 components in
  `frontend/public/components-metadata.json` (148 of them placeable — boards,
  breadboards and junctions are the board/wiring layer, not parts) up to 40 parts
  and 100 wires per project. A part the canvas can draw is a part the agent can
  place, wire, set properties on and reason about: pins, power rails, buses,
  series/gate resistors, required drivers and addressable-bus clashes all come
  from the catalog.
- **The catalog is generated, not hand-written.** `scripts/generate-agent-catalog.mjs`
  merges three sources — the component metadata (ids, tags, properties, defaults),
  `scripts/agent-pins.json` (pin names measured from the live custom elements) and
  `scripts/agent-part-rules.json` (the per-family wiring rules) — into one file
  copied verbatim to `backend/app/agent/catalog.json` and `frontend/src/agent/catalog.json`.
  Adding a component to the canvas and re-running the generator adds it to the
  agent, the validator, the MCP surface and the browser schema at once; the
  frontend tests re-measure the live elements and fail if a pin name drifts.
- Arduino core APIs and the libraries the catalog's own parts need (for example
  `Servo.h`, `Wire.h`, `LiquidCrystal_I2C.h`, `Adafruit_NeoPixel.h`); no automatic
  third-party library installation.
- Automatic component placement, pin-level wiring, firmware generation, compilation
  when that board's core is installed, bounded validation/compiler repair, and
  electrical pre-flight.
- **Live headless simulation is AVR only** (Uno, Nano, Mega, ATtiny). Raspberry Pi
  boards take a `.py` file and do not produce hex. Other boards compile only if
  that core is installed; a missing toolchain is reported, not papered over with
  a fake hex file.
- Follow-up edits read **live code and wiring**, including manual edits.
- Explanations and a JEV clarify-first decision do not mutate the project.

## The agent loop

The path is a JEV decision, then one plain tool-use loop over a run-scoped
workspace. It is not a Forge essay turn. See `docs/agent-architecture-v2.md`
for the full design.

1. **Decision** — one System One call (`POST /api/chat/:id/decide`). Code applies
   the answers. If the trusted mode is clarify-first, the run stops and asks a
   question the code wrote. Otherwise the accepted rules are injected and the
   coding model starts. A decision that does not return in time is cancelled;
   the run designs without memory.
2. **The workspace** — the run materialises the project as real files
   (`sketch.ino`, `diagram.json`, optional flat headers; `main.py` for Pi) and
   gives the model nine native tools: `write_file`, `read_file`, `edit_file`,
   `list_files`, `remove_file`, `catalog`, `check`, `compile`, `simulate`
   (≤8 tool calls per turn, `AGENT_MAX_TURNS` = 24 turns per run).
   `check()` runs the catalog-driven electrical lint; `compile()` runs the real
   toolchain through the pooled compile service; `simulate()` runs the headless
   AVR emulator with stimuli. Every result is a small `{ok, data|error}` JSON
   envelope the model reads and fixes from.
3. **done()** — the model ends the run itself with
   `done(summary, plan?, expectations?)`. An untouched workspace means the run
   was a question: the summary becomes the answer, nothing else runs. A touched
   workspace starts the final gates in order: rebuild → phone-page contract →
   electrical lint → real compile. A gate failure is fed back to the model as
   data and the loop continues — there is no attempt counter, only the turn
   cap and the run wall clock. The intent check is a bare fact
   ("prompt names a servo; no servo in the circuit"), never an invitation to
   explain a shortfall.
4. **Result** — workspace diff + summary + expectations land as a pending
   checkpoint. The browser applies it, runs the electrical pre-flight and
   live-checks the declared expectations (AVR hex only).

## Setup

Use Python **3.11+** (the existing Docker backend uses 3.12), Node 20.19+ or 22.12+,
and a working Arduino CLI. Install the core for the board you want to compile. AVR is enough for live simulation. Pi does not need a core.

```sh
# From the repository root
python3 -m venv .venv
. .venv/bin/activate
pip install -r backend/requirements.txt
arduino-cli core update-index
arduino-cli core install arduino:avr
cp backend/.env.example backend/.env
```

Edit `backend/.env` locally (do not commit it):

```dotenv
AGENT_ENABLED=true
# Amazon Bedrock (the ONLY provider):
BEDROCK_MODEL_ID=your-bedrock-model-id
AWS_REGION=us-east-1
# Optional loop bounds — three protections for the user, nothing else:
# AGENT_RUN_TIMEOUT_S=300        whole-run wall clock (the UI waits this long)
# AGENT_MAX_TURNS=24             hard cap on provider round-trips per run
# AGENT_PROVIDER_RETRIES=8       the ONE retry layer (botocore never stacks under it)
# AGENT_SIM_WALL_CLOCK_S=10      simulate() subprocess kill (fixed constant)
# Which Bedrock transport serves the model: "converse" (default) or "mantle"
# (required for moonshotai.kimi-k2.5). Verified once at startup.
# BEDROCK_TRANSPORT=converse
```

The default provider is **Amazon Bedrock**. Set `BEDROCK_MODEL_ID` and
`AWS_REGION` (+ optional static `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/
`AWS_SESSION_TOKEN`; otherwise the default credential chain/IAM role is used).
Most Bedrock models run through native Converse (boto3). `moonshotai.kimi-k2.5`
is NOT served by native Converse on this account ("Operation not allowed") — set
`BEDROCK_TRANSPORT=mantle` for it and the run goes to the **Bedrock Mantle Chat
Completions** endpoint
(`https://bedrock-mantle.<region>.api.aws/v1/chat/completions`) instead; that
transport falls back to `BEDROCK_API_KEY` bearer auth when no static AWS
credentials are set. The transport is chosen by this flag, probed once at
startup — never guessed from the model id. Both transports stream: Converse
tokens arrive as they are generated (heartbeats show the live tail), and the
one bound on a provider call is the read timeout. While the model writes a
file, the in-progress `write_file` content rides the same heartbeats and
**types live into the editor pane** — you watch the sketch being written, not
a character counter. The post-result playback then replays only what you
have not already watched (new parts, new wires, files that were not
live-typed), and the one bound on a provider call is the read timeout — a cancelled run stops
listening, and the abandoned socket read dies within that same timeout. No
stacked timers. Tuning knobs: `BEDROCK_MAX_TOKENS`, `BEDROCK_TEMPERATURE`,
`BEDROCK_TOP_P`, `BEDROCK_PROMPT_CACHE`. There is deliberately no
`BEDROCK_MAX_RETRIES`: botocore runs at `max_attempts=1` and `propose()`'s
bounded loop is the one retry layer.

**Prompt caching** (`BEDROCK_PROMPT_CACHE`, default `off`): cachePoints go at
the system prompt and the conversation-history boundary — the two prefixes
that are byte-stable across turns — never around the per-run workspace state.
The startup probe measures whether the model actually reports cache usage
before the flag does anything, and run records carry the measured
`cache_read`/`cache_write` split (`GET /api/agent/runs/records`), so the cost
model always prices real spend, never an assumption.

**Bedrock is the only model provider.** OpenCode and Gemini were removed, and
with them every automatic "pick another provider" path: an unconfigured or
failing Bedrock is reported as a hard error and the run ends — the agent is
never silently downgraded to something else mid-request.

The provider id sent with each run is `bedrock`. Keys never reach the browser,
and the browser cannot change provider URLs/keys.

```sh
# Terminal 1, from repo root. Start in backend so .env and Python modules resolve.
cd backend
../.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8001

# Terminal 2, from repo root
cd frontend
npm install --legacy-peer-deps
npx vite --host 0.0.0.0 --port 5173
```

The direct Vite command uses the committed component metadata. Existing `npm run dev`
also regenerates metadata/SVGs. Vite proxies `/api` to the backend, so the browser does
not need a localhost backend URL. Arena `*.e2b.app` preview hosts are allowed.

Open `/editor`. Choose a Uno starter (or cancel the starter dialog to build from
empty), and open **Agent settings** to check the connection, pick a provider and
toggle forge project memory (JEV). Docker Compose already loads `backend/.env`;
restart/rebuild after changing settings.

### Hosted deployment / privacy

- The agent is disabled by default. Enabling it requires `AGENT_ENABLED=true` and a
  configured provider key. The agent endpoints have no per-user authentication, so
  run the backend on a trusted network or behind your own authenticated reverse proxy.
- Use HTTPS. Add authenticated reverse-proxy access, rate limits, provider spending
  limits and per-user quotas before offering this publicly — there is no account
  or billing system behind the agent.
- The backend allows at most two active agent requests **per worker process**. Use one
  API worker or an external distributed limiter for a global cap.
- Prompt, recent conversation, source files, and supported circuit data are sent to
  the configured model provider. Do not put secrets in your project source.
- Model output is typed data, not shell commands. Compilation runs using the existing
  Arduino service in a disposable child process; cancelling/timing out kills its
  process group on Linux/macOS (Windows uses `taskkill /T`). It is not a hardened OS
  sandbox. Run the backend in an unprivileged container with memory/CPU/filesystem
  limits if accepting untrusted users/code.

## Forge project memory (JEV) — optional, opt-out

The agent asks [Velxio Forge](../forge/README.md) for one JEV decision before it
designs. JEV (TypeSafe's System One) does not write firmware and is not the
chat. Code applies the decision: a trusted clarify-first mode stops the run
with a question the code wrote; otherwise accepted rules are injected as
binding project memory and the coding model runs one loop. The Forge UI can
still run a full `/messages` turn. The agent does not. `GET /agent/forge`
reports the state.

- **Direct connection, no copies.** `app/agent/forge.py` speaks the live Forge
  HTTP API (`FORGE_BASE_URL`, default `http://127.0.0.1:4321`). Nothing from
  `forge/` is vendored into the agent, so **any change to forge is instantly
  the behavior the agent sees**. With `FORGE_AUTOSTART=true` (default) the
  backend starts the service itself as `node --watch src/index.js`, so forge
  *code edits* hot-reload too. If you prefer to manage it yourself, run
  `npm --prefix forge/server run dev` and set `FORGE_AUTOSTART=false`.
- **Toggle.** `FORGE_ENABLED` is the server default; the agent panel's
  **FORGE · PROJECT MEMORY** checkbox flips it at runtime
  (`POST /agent/forge/toggle`, persisted to `backend/data/forge_state.json`,
  wins over the env). One session key per browser workspace
  (`forge_session` in the run body) maps to one Forge conversation, so memory
  persists across runs and reloads.
- **Fail-open, by contract.** Forge down, unconfigured or mid-repair ⇒
  the agent runs exactly as before with no memory block; the panel shows why.
  Real JEV decisions need `forge/server/.env` (`TYPESAFE_API_KEY` + a
  generation provider key — see [forge/README.md](../forge/README.md));
  without credentials Forge reports the exact missing key and the agent
  simply proceeds without memory.

## How a request works

1. Capture the complete workspace and project identity; derive a canonical design
   fingerprint excluding runtime LED/serial values and DOM-computed pin coordinates.
2. Send the supported design plus recent conversation to the backend. Credential-shaped
   assignments (api key/password/token/bearer) are redacted from source, history and the
   prompt before anything leaves the server.
3. The model works **in the workspace** (see *The agent loop* above): it edits
   `sketch.ino` / `diagram.json` with `write_file` / `edit_file` / `remove_file`,
   looks things up with `list_files` / `read_file` / `catalog`, and verifies with
   `check` (electrical lint), `compile` (real toolchain, pooled + cached) and
   `simulate` (headless AVR with stimuli). Every tool result is a small
   `{ok, data|error}` JSON envelope — diagnostics are data the model fixes from.
4. The model ends with `done(summary, plan?, expectations?)`. **`expectations`**
   are falsifiable behaviour checks: pin transitions/levels with periods, serial
   regexes, and interactions. An interaction is one of `press` (a momentary
   switch), `pot` (a potentiometer or joystick axis), `switch` (a toggle),
   `rotary` (an encoder or dial) or `stimulus` (a sensor model value such as
   `temperature`, `lux`, `distance`, `lat`/`lng` — the same knobs the Sensor
   panel exposes).
5. The final gates run in order behind done(): workspace rebuild (schema
   strictness, catalog pins per-instance variants included: `digits=4`,
   `pins=i2c`, unique IDs), the phone-page contract for board-native UI, the
   **catalog-driven static analysis** — firmware pins vs wiring, analogWrite on
   PWM pins, analogRead on ADC pins, GPIO-to-rail shorts, bridged GPIOs,
   bridged switch contacts, a part shorted across its own terminals, a supply
   output wired to a GPIO, a required power/ground connection missing, a signal
   on a pin that cannot carry it, I2C/SPI bus pinout mismatches and address
   clashes, missing series resistors (LEDs, opto inputs, 7-segment/bar-graph
   channels), missing gate resistors (transistors, MOSFETs) and coils wired
   straight to a pin — then include allowlisting. The intent check refuses a
   done() whose circuit is missing a part the prompt named. Errors name the fix.
6. Compile through the pooled compile service (per-family ceiling enforced by
   the pool; identical projects are cached). A gate failure is fed back to the
   model and the loop continues — bounded only by `AGENT_MAX_TURNS` (24) and
   the run wall clock (`AGENT_RUN_TIMEOUT_S` + compile headroom). Transient
   provider failures retry inside the one retry layer
   (`AGENT_PROVIDER_RETRIES`, 429/5xx/timeouts).
7. Stream NDJSON progress events (not private model reasoning) to the sidebar. Every
   event carries a `run_id`; the last 100 runs are queryable at
   `GET /api/agent/runs/records` (same bearer token): outcome, attempts, provider
   calls, prompt/completion tokens and stage timings, per worker, in memory only.
8. The browser runs existing SPICE pre-flight checks **on the candidate**, checks for
   concurrent edits again, and only then applies code + circuit as one synchronous
   stopped-workspace transaction. Loader/firmware-load errors restore the old snapshot.
9. Save a checkpoint, mount the parts, start AVR emulation.
10. **Behavioural verification**: if the proposal declared expectations, the browser
    runs them against the live AVR runtime for `observe_ms` — watching pin transitions
    with simulated time, driving the declared interactions at their declared moments,
    and matching serial regexes. A failure **reverts the workspace and sends ONE
    repair round** with the failure report (same original-snapshot rule as compile
    repairs). A second failure returns an honest failure report with an undoable
    checkpoint instead of looping. Proposals without expectations are marked
    **“Behaviour is not automatically verified”** in the reply.

Electrical warnings are surfaced. An electrical pre-flight error blocks application;
a runtime fault stops simulation and leaves an undoable checkpoint.

The workspace is real files: a `write_file` replaces one file; an `edit_file`
replaces one exact old_string with a new one, so unrelated lines inside an
edited file are never touched by construction (a missed match is an error the
model reads). `diagram.json` fixes go through targeted edits, not whole-file
rewrites. Checkpoints + undo remain the user's safety net.

## Changes, undo and persistence

- Keep editing while a request runs. Any concurrent design/source edit or named
  project switch blocks the stale result. Retry reads the latest workspace.
- **Stop** aborts the request and prevents later application. If application already
  happened, the checkpoint remains; cancelling during startup stops that agent run.
- **Checkpoints → Undo edit** restores both previous firmware source and wiring and
  stops simulation. It refuses to overwrite subsequent manual changes.
- Undoing an undo provides redo. **Restore** requires explicit confirmation and also
  creates an undo point for the workspace it replaces.
- The last 10 checkpoints and 60 messages (across project scopes) are kept in tab-local
  `sessionStorage`, capped at 2.5 MB. Storage failures degrade to memory only. They
  survive reload in the same tab but are not cloud persistence; closing the tab can
  lose them. Reload does **not** automatically replace the workspace: use Restore.
- New conversation clears the current scope's chat, not code or checkpoints.
- Download the project as `.vlx` from Checkpoints or the existing File menu for durable
  storage. Existing project save integrations continue to work.
- `Ctrl/Cmd+Shift+L` toggles the agent panel. Enter sends, Shift+Enter inserts a line.
  On mobile the panel overlays the workspace and can be collapsed to the agent rail.

## Try it

1. “Build an Uno LED that blinks every 500 milliseconds.”
2. “Add a button that pauses blinking while held. Keep the existing layout.”
3. “Sweep a servo from 0 to 180 degrees.” — it must pick a PWM pin, wire power,
   and declare expectations the live simulation can check.
3b. “Show the temperature from a DHT22 and turn on an LED above 30 °C.” — it must
   look the part up in the catalog, wire the sensor, and declare a `stimulus`
   interaction (`temperature`) that the browser can drive.
3c. “Drive a relay from pin 8.” — the analysis must refuse a coil on a GPIO and
   the loop must add a transistor (or driver) with a base/gate resistor.
4. Manually add a comment in `sketch.ino`, then ask “Make the LED green and keep my comment.”
5. “Explain the wiring and how to test this.” (No project mutation.)
6. Undo/redo through Checkpoints. Move a part, then try Undo: it must refuse to discard
   the manual change. Explicit Restore should ask first.
7. Send another request and immediately edit the code: the stale result must be blocked.
8. Ask for ESP32 / another board: it should explain the scope, not fake a part.
9. Stop a request; verify no late edits arrive.
10. Ask for something that cannot work (servo on pin 2): validation must reject it and
    the repair loop must fix it to a PWM pin, not report success.

## Tests

```sh
PYTHONPATH=backend .venv/bin/pytest backend/tests
cd frontend
npx vitest run src/__tests__/agent-workspace.test.ts src/__tests__/agent-expectations.test.ts \
  src/__tests__/agent-runtime-repair.test.ts src/__tests__/agent-catalog.test.ts \
  src/__tests__/agent-pins.test.ts
npx eslint src/agent src/components/agent src/__tests__/agent-workspace.test.ts
npx vite build
```

Optional browser smoke test (with Vite running):

```sh
cd frontend
npm install --no-save --legacy-peer-deps playwright
npx playwright install chromium
node scripts/agent-browser-smoke.mjs
```

The browser test intercepts **model/compiler HTTP results** with fixture data but uses
**real SPICE validation, AVR firmware emulation, and LED transitions**. It exercises
contextual editing, manual-comment preservation, undo/redo, conflict protection and
mobile layout. `CHROMIUM_PATH`, `AGENT_TEST_URL`, and `AGENT_SCREENSHOT_DIR` are optional.
It requires Vite's source modules, not a production-only server.

`agent-catalog.test.ts` is the arbiter of the generator's claims (every catalog
entry has a live element, the simulation coverage matches the live registries, a
runtime property is never editable, a stimulus key exists in the Sensor panel),
and `agent-pins.test.ts` re-measures every custom element's `pinInfo` against the
frozen pin map so a renamed pin cannot silently break the wire format.

The agent contract tests now run in CI (`.github/workflows/backend-unit-tests.yml`
runs `pytest test/backend/unit/ backend/tests/`). The implementation was tested
without a live provider key. Arduino CLI/toolchain
downloads were blocked in the build sandbox, so a real provider → real compiler run
still needs testing in your configured environment. The existing repository-wide
`tsc -b` has unrelated baseline errors; this change's agent modules have no TypeScript
diagnostics. `vite build` and the targeted tests are the useful gates for this PR.
