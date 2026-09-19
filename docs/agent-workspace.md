# Circuit agent workspace (phases 1 and 2)

The editor now has an OSS, VS Code-style **Chat / Checkpoints** sidebar. The agent
can create circuits and edit the current workspace through conversation. It is
**opt-in**; without model configuration the normal editor still works, and the
sidebar shows setup instructions. No canned circuit generator is used in production.

## Supported scope

- One **Arduino Uno**, Arduino C++, one `.ino` and optional flat `.h/.c/.cpp` files.
- LED, resistor, pushbutton, potentiometer, buzzer (up to 40 parts / 100 wires).
- Arduino core APIs only; no automatic third-party library installation.
- Automatic component placement, pin-level wiring, firmware generation, compilation,
  bounded validation/compiler repair, electrical pre-flight, and simulation launch.
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
2. Send the supported design plus recent conversation to the backend.
3. The model returns a short plan, summary, and **targeted patch** (upsert/remove by
   ID or filename). Unmentioned objects/files are retained deterministically.
4. Pydantic validates sizes, filenames, catalog capabilities, unique IDs, pin
   references, resistor values, rail shorts and LED series resistors.
5. Compile for `arduino:avr:uno`. Validation/compiler diagnostics can drive repairs,
   with **three proposals maximum**, 60-second provider requests, 100-second compiler
   limit, and a 240-second overall server limit. Every repair is against the original
   snapshot, not a partially applied failed proposal.
6. Stream NDJSON progress events (not private model reasoning) to the sidebar.
7. The browser runs existing SPICE pre-flight checks **on the candidate**, checks for
   concurrent edits again, and only then applies code + circuit as one synchronous
   stopped-workspace transaction. Loader/firmware-load errors restore the old snapshot.
8. Save a checkpoint, mount the parts, start AVR emulation, and observe startup for
   1.2 seconds. Report running state, serial output and runtime burnouts separately.

Compilation is NOT proof of correct behaviour. Success explicitly says
**“Behaviour is not automatically verified.”** Electrical warnings are surfaced.
An electrical pre-flight error blocks application; a runtime fault stops simulation
and leaves an undoable checkpoint. Browser-side electrical/runtime faults are **not
automatically fed into a second repair loop** in this release; ask for an edit or undo.

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
3. Manually add a comment in `sketch.ino`, then ask “Make the LED green and keep my comment.”
4. “Explain the wiring and how to test this.” (No project mutation.)
5. Undo/redo through Checkpoints. Move a part, then try Undo: it must refuse to discard
   the manual change. Explicit Restore should ask first.
6. Send another request and immediately edit the code: the stale result must be blocked.
7. Ask for ESP32 / an unsupported sensor: it should explain the scope, not fake a part.
8. Stop a request; verify no late edits arrive.

## Tests

```sh
PYTHONPATH=backend .venv/bin/pytest backend/tests/test_agent.py
cd frontend
npx vitest run src/__tests__/agent-workspace.test.ts
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

The implementation was tested without a live provider key. Arduino CLI/toolchain
downloads were blocked in the build sandbox, so a real provider → real compiler run
still needs testing in your configured environment. The existing repository-wide
`tsc -b` has unrelated baseline errors; this change's agent modules have no TypeScript
diagnostics. `vite build` and the targeted tests are the useful gates for this PR.
