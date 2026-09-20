# Circuit agent workspace

The editor has an OSS, VS Code-style **Chat / Checkpoints** sidebar. The agent
can create circuits and edit the current workspace through conversation. It is
**opt-in**; without model configuration the normal editor still works, and the
sidebar shows setup instructions. No canned circuit generator is used in production.

## Supported scope

- One **Arduino Uno**, Arduino C++, one `.ino` and optional flat `.h/.c/.cpp` files.
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
- Automatic component placement, pin-level wiring, firmware generation, compilation,
  bounded validation/compiler repair, electrical pre-flight, simulation launch, and
  **live behavioural verification** of the agent's own declared expectations.
- Follow-up edits read **live code and wiring**, including manual edits.
- Explanations and clarification responses do not mutate the project.

Boards other than the Arduino Uno are still out of scope (the compiler, emulator and
pin analysis are AVR-Uno specific): a project already on another board is rejected
rather than silently converted. Start a new Uno project to use the agent with it.

## The agent loop

The loop is deliberately not "propose once, then repair". A model that can only
write a patch and wait for the compiler is guessing; this one works the problem:

1. **Research rounds** (`AGENT_MAX_TOOL_ROUNDS`, default 5) — read-only tools:
   `search_catalog` (find a part by description), `component_info` (exact pins,
   properties, wiring notes), `board_pinout`, `netlist` (what is connected to
   what right now), `read_file`/`list_files`, `check_design` (static analysis of
   the current project), `library_api`/`search_libraries`. Results are appended
   to the conversation and the model is asked again; nothing is applied.
2. **Draft rounds** (`AGENT_MAX_DRAFT_ROUNDS`, default 4) — the model passes a
   candidate patch *inline* to `draft_validate` (full schema + electrical +
   static analysis), `draft_compile` (the real `arduino-cli` build) and
   `draft_simulate` (the real AVR emulator, with the declared interactions
   translated into electrical stimuli, returning per-pin transitions with
   simulated timestamps, serial output and the stimulus actually delivered).
   Nothing is written to the workspace, and the model is expected to iterate
   until the observation matches its claim.
3. **Commit** — only then does it return the response: plan, summary, target
   patch and `expectations`. The server-side validator, the compiler and the
   browser verification act as the same deterministic gates as before.

Both budgets are separate because research is a catalog lookup and drafting is a
compile plus a simulation. A model that runs out simply gets one final "return the
response now" message instead of another loop.

## Setup

Use Python **3.11+** (the existing Docker backend uses 3.12), Node 20.19+ or 22.12+,
and a working Arduino CLI with the AVR core. You do not need ESP32/QEMU for this scope.

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
AGENT_API_KEY=your-groq-api-key
AGENT_BASE_URL=https://api.groq.com/openai/v1
AGENT_MODEL=openai/gpt-oss-120b
# Second provider (optional, via Google's OpenAI-compatible layer):
# AGENT_GEMINI_API_KEY=your-google-ai-studio-api-key
# AGENT_GEMINI_MODEL=gemini-2.5-flash
AGENT_ACCESS_TOKEN=choose-a-long-random-private-token
# Optional loop bounds / resilience:
# AGENT_MAX_ATTEMPTS=3            repair attempts (proposal -> validate/compile)
# AGENT_MAX_TOOL_ROUNDS=5        research rounds before a patch is required
# AGENT_MAX_DRAFT_ROUNDS=4       draft test rounds (compile/simulate a candidate)
# AGENT_PROVIDER_TIMEOUT_S=60    per provider call
# AGENT_PROVIDER_RETRIES=2       retries on 429/5xx/transport errors (backoff + jitter)
# AGENT_ALLOW_LIBRARY_SEARCH=false  live Arduino library search from the agent
```

The defaults point at **Groq** (`openai/gpt-oss-120b` supports JSON Object Mode).
Groq retired the older `llama-3.1-8b-instant` / `llama-3.3-70b-versatile` IDs on
2026-08-16 — those now return HTTP 404. Use `openai/gpt-oss-120b`, `openai/gpt-oss-20b`,
or another live model from Groq's Supported Models page.
`AGENT_MODEL` and `AGENT_BASE_URL` can target any **OpenAI-compatible chat
completions** provider that supports `response_format: {type: "json_object"}` and
`max_tokens` (e.g. `https://api.openai.com/v1` + `gpt-4.1`). Native
Anthropic APIs and providers requiring a different
request format are not adapters in this release. Configure those via a compatible
gateway, not by pointing this adapter at their native endpoint.

**Gemini is a first-class second provider.** Set `AGENT_GEMINI_API_KEY` (a Google
AI Studio key) and the agent can route requests to Gemini through Google's official
OpenAI-compatible layer. Both Groq and Gemini are OpenAI-compatible, so the adapter is
unchanged — Gemini just reads from its own base URL/model/key.

**Amazon Bedrock is a first-class third provider.** Set `BEDROCK_MODEL_ID` and
`AWS_REGION` (+ optional static `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN`;
otherwise the default credential chain/IAM role is used). Most Bedrock models run through
native Converse (boto3). `moonshotai.kimi-k2.5` is NOT served by native Converse on this
account ("Operation not allowed") — it is routed instead to the **Bedrock Mantle Chat
Completions** endpoint (`https://bedrock-mantle.<region>.api.aws/v1/chat/completions`) and
therefore needs `BEDROCK_API_KEY`. Tuning knobs: `BEDROCK_MAX_TOKENS`, `BEDROCK_TEMPERATURE`,
`BEDROCK_TOP_P`, `BEDROCK_TIMEOUT_MS`, `BEDROCK_MAX_RETRIES`.

Any provider with its key/config configured appears in the chat panel's **provider dropdown**
in the composer; the selection is per-session and sent as a provider id in each run (`groq`,
`gemini` or `bedrock`, default `groq`). Keys never reach the browser, and the browser cannot
change provider URLs/keys.

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
empty), open **Agent settings**, and enter the **workspace access token**, not the
provider key. The token is held in memory and must be re-entered after a reload.
Docker Compose already loads `backend/.env`; restart/rebuild after changing settings.

### Hosted deployment / privacy

- The agent is disabled by default. Enabling it requires a provider key and an access
  token, unless `AGENT_ALLOW_ANONYMOUS=true` is explicitly set for a trusted local host.
- Keep tokens private and use HTTPS. Add authenticated reverse-proxy access, rate
  limits, provider spending limits and per-user quotas before offering this publicly.
  The shared token is **not** a multi-user account/billing system.
- The backend allows at most two active agent requests **per worker process**. Use one
  API worker or an external distributed limiter for a global cap.
- Prompt, recent conversation, source files, and supported circuit data are sent to
  the configured model provider. Do not put secrets in your project source.
- Model output is typed data, not shell commands. Compilation runs using the existing
  Arduino service in a disposable child process; cancelling/timing out kills its
  process group on Linux/macOS (Windows uses `taskkill /T`). It is not a hardened OS
  sandbox. Run the backend in an unprivileged container with memory/CPU/filesystem
  limits if accepting untrusted users/code.

## How a request works

1. Capture the complete workspace and project identity; derive a canonical design
   fingerprint excluding runtime LED/serial values and DOM-computed pin coordinates.
2. Send the supported design plus recent conversation to the backend. Credential-shaped
   assignments (api key/password/token/bearer) are redacted from source, history and the
   prompt before anything leaves the server.
3. The model works in **tool rounds** (see *The agent loop* above): catalog and
   project research (`read_file`, `list_files`, `board_pinout`, `component_info`,
   `search_catalog`, `netlist`, `check_design`, `library_api`, `search_libraries`)
   and, once it has a draft, `draft_validate` / `draft_compile` / `draft_simulate`
   — which build the candidate inline, run the real validator, compiler and
   emulator on it and hand the observations back. Tool rounds never apply a
   patch; they are bounded by `AGENT_MAX_TOOL_ROUNDS` (default 5) and
   `AGENT_MAX_DRAFT_ROUNDS` (default 4).
4. The model returns a short plan, summary, **targeted patch** (upsert/remove by
   ID or filename), and **`expectations`** — falsifiable behaviour checks: pin
   transitions/levels with periods, serial regexes, and interactions. An
   interaction is one of `press` (a momentary switch), `pot` (a potentiometer or
   joystick axis), `switch` (a toggle), `rotary` (an encoder or dial) or
   `stimulus` (a sensor model value such as `temperature`, `lux`, `distance`,
   `lat`/`lng` — the same knobs the Sensor panel exposes). Unmentioned
   objects/files are retained deterministically.
5. Validation runs `apply_patch`: schema strictness, catalog pins (per-instance
   variants included: `digits=4`, `pins=i2c`), unique IDs, the **catalog-driven
   static analysis** — firmware pins vs wiring, analogWrite on PWM pins,
   analogRead on ADC pins, GPIO-to-rail shorts, bridged GPIOs, bridged switch
   contacts, a part shorted across its own terminals, a supply output wired to a
   GPIO, a required power/ground connection missing, a signal on a pin that
   cannot carry it, I2C/SPI bus pinout mismatches and address clashes, missing
   series resistors (LEDs, opto inputs, 7-segment/bar-graph channels), missing
   gate resistors (transistors, MOSFETs) and coils wired straight to a pin — then
   include allowlisting. Errors name the fix and drive a repair.
6. Compile for `arduino:avr:uno`. Validation/compiler diagnostics drive repairs,
   with **three proposals maximum** (`AGENT_MAX_ATTEMPTS`), transient provider
   failures retried with backoff (`AGENT_PROVIDER_RETRIES`, 429/5xx/timeouts),
   100-second compiler limit, and a 240-second overall server limit. Every repair is
   against the original snapshot, not a partially applied failed proposal.
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

Source and circuit upserts replace the named item only. Unrelated files/components
are preserved by the merger; preserving unrelated lines *inside an edited file*
is instructed to the model and protected by checkpoints, not a semantic code proof.

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
