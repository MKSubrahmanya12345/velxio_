# Circuit agent workspace (phases 1 and 2)

The editor now has an OSS, VS Code-style **Chat / Checkpoints** sidebar. The agent
can create circuits and edit the current workspace through conversation. It is
**opt-in**; without model configuration the normal editor still works, and the
sidebar shows setup instructions. No canned circuit generator is used in production.

## Supported scope

- One **Arduino Uno**, Arduino C++, one `.ino` and optional flat `.h/.c/.cpp` files.
- LED, resistor, pushbutton, potentiometer, buzzer, servo (up to 40 parts / 100 wires).
  Servos must signal on a PWM pin (3, 5, 6, 9, 10, 11); `Servo.h` ships with the
  arduino:avr core and is allowlisted.
- Arduino core APIs only; no automatic third-party library installation.
- Automatic component placement, pin-level wiring, firmware generation, compilation,
  bounded validation/compiler repair, electrical pre-flight, simulation launch, and
  **live behavioural verification** of the agent's own declared expectations.
- Follow-up edits read **live code and wiring**, including manual edits.
- Explanations and clarification responses do not mutate the project.

Unsupported boards/components already in a project are rejected rather than removed
or silently converted. Start a new Uno project to use the agent with those projects.

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
AGENT_API_KEY=your-provider-key
AGENT_BASE_URL=https://api.openai.com/v1
AGENT_MODEL=gpt-4.1
AGENT_ACCESS_TOKEN=choose-a-long-random-private-token
# Optional loop bounds / resilience:
# AGENT_MAX_ATTEMPTS=3            repair attempts (proposal -> validate/compile)
# AGENT_MAX_TOOL_ROUNDS=3        read-only tool rounds before a patch is required
# AGENT_PROVIDER_TIMEOUT_S=60    per provider call
# AGENT_PROVIDER_RETRIES=2       retries on 429/5xx/transport errors (backoff + jitter)
# AGENT_ALLOW_LIBRARY_SEARCH=false  live Arduino library search from the agent
```

`AGENT_MODEL` and `AGENT_BASE_URL` can target another **OpenAI-compatible chat
completions** provider that supports `response_format: {type: "json_object"}` and
`max_tokens`. Native Anthropic/Gemini APIs and providers requiring a different
request format are not adapters in this release. Configure those via a compatible
gateway, not by pointing this adapter at their native endpoint.

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
3. The model may first request **read-only tools** (`read_file`, `list_files`,
   `board_pinout`, `component_info`, `check_design`, `library_api`,
   `search_libraries` — the last two optional/off by default). Tool rounds never apply
   a patch and are bounded by `AGENT_MAX_TOOL_ROUNDS` (default 3).
4. The model returns a short plan, summary, **targeted patch** (upsert/remove by
   ID or filename), and **`expectations`** — falsifiable behaviour checks: pin
   transitions/levels with periods, serial regexes, and interactions (press a button
   at t, set a potentiometer value). Unmentioned objects/files are retained deterministically.
5. Validation runs `apply_patch`: schema strictness, catalog pins, unique IDs, the
   **static firmware/circuit analysis** (firmware pins vs wiring, analogWrite on PWM
   pins, analogRead on ADC pins, GPIO-to-rail shorts, bridged GPIOs, bridged button
   contacts, shorted LEDs/resistors), then rail shorts and LED series resistors, then
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
4. Manually add a comment in `sketch.ino`, then ask “Make the LED green and keep my comment.”
5. “Explain the wiring and how to test this.” (No project mutation.)
6. Undo/redo through Checkpoints. Move a part, then try Undo: it must refuse to discard
   the manual change. Explicit Restore should ask first.
7. Send another request and immediately edit the code: the stale result must be blocked.
8. Ask for ESP32 / an unsupported sensor: it should explain the scope, not fake a part.
9. Stop a request; verify no late edits arrive.
10. Ask for something that cannot work (servo on pin 2): validation must reject it and
    the repair loop must fix it to a PWM pin, not report success.

## Tests

```sh
PYTHONPATH=backend .venv/bin/pytest backend/tests
cd frontend
npx vitest run src/__tests__/agent-workspace.test.ts src/__tests__/agent-expectations.test.ts src/__tests__/agent-runtime-repair.test.ts
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

The agent contract tests now run in CI (`.github/workflows/backend-unit-tests.yml`
runs `pytest test/backend/unit/ backend/tests/`). The implementation was tested
without a live provider key. Arduino CLI/toolchain
downloads were blocked in the build sandbox, so a real provider → real compiler run
still needs testing in your configured environment. The existing repository-wide
`tsc -b` has unrelated baseline errors; this change's agent modules have no TypeScript
diagnostics. `vite build` and the targeted tests are the useful gates for this PR.
