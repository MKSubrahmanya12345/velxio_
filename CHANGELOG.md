# Changelog

All notable changes to Velxio will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added
- Velxio Create (`CREATE` tab in the agent sidebar, `docs/creative-chat.md`):
  chat-only content workspace backed by Forge memory. **Learn**: ingest
  YouTube links (Gemini watches natively first, then keyless caption fallback
  through the 10-round provider failover), articles, or pasted text into
  collections; transcripts are stored and distilled into JEV-governed nodes.
  **Create**: prompts generate grounded ideas that JEV cross-compares against
  stored nodes (support/conflict badges, advisory-ranked), expanding into a
  full pack (script + hooks + titles + thumbnails + sources + needs-check).
  Nodes are manually editable/deletable with no review interruptions. Python
  `/api/creative/*` thin-proxies Forge `/api/creative/*` (`CREATIVE_JOB_TIMEOUT_S`)
- Forge **Providers** page (`forge/client/src/components/ProvidersView.tsx`): add API keys for
  Gemini, OpenRouter, AWS Bedrock, Ollama, OpenCode Zen, Groq and any OpenAI-compatible endpoint,
  each with a model, base URL and a free-text note. Keys are entered and shown in plain text
  (never masked); any one key can be selected, tested, disabled or deleted. Keys are stored in
  `forge/server/data/providers.json` (`PROVIDERS_FILE`), and existing `.env` credentials appear as
  read-only entries that stay in the loop
- Forge **automatic provider switching**: every generation call walks the selected key, that
  provider's other keys, then every other provider/key, switching on any error (HTTP status,
  timeout, unreachable host, malformed answer) and looping 10 rounds before it stops and reports
  every attempt (`FAILOVER_ENABLED`, `FAILOVER_MAX_ROUNDS`, `FAILOVER_RETRY_REJECTED`). Switches
  are visible as key stats, a loop-order preview, an attempt log and `provider` events in the turn
  trace. A request may also name a key or provider (`provider` in the chat body) to choose where
  the loop starts — it never disables switching
- Browser flashing seam (`lib/proWebFlash.ts`): the board context menu's
  "Flash to real board" and the FlashModal can now be backed by a Web Serial
  flasher installed at runtime (used by velxio.dev for ESP32-family boards);
  without one, web builds keep the desktop-only behavior (#248)
- Hardware serial seams: `appendHardwareSerial` feeds real-UART bytes through
  the serial batcher, and `lib/proHardwareSerial.ts` lets an installed monitor
  intercept a board's serial input while attached

### Changed
- **Live typing in the editor while the agent generates**: in-progress
  `write_file` content is extracted from the model's tool-call deltas
  server-side and shipped on every heartbeat; the editor pane types it live
  (the same curtain the post-result reveal uses, fed by the real stream) —
  no more "generating · N characters" as the primary signal. The sidebar
  says "typing sketch.ino", the post-result playback skips files that were
  already live-typed, and ticks speed up (0.15s) while code is arriving
- **Agent streaming + measured prompt caching**: the Converse transport now
  streams (`converse_stream`) — heartbeats carry the live text tail on both
  transports. One bound per transport: botocore `read_timeout` for Converse,
  the asyncio stall guard for Mantle; the run deadline only stops reading,
  it is never a second kill timer. `BEDROCK_PROMPT_CACHE` (default off) adds
  cachePoints at the stable prefix boundaries; the startup probe measures
  cache usage before honoring the flag (unsupported model => fail fast with
  the fix; Mantle => measured state on `/api/agent/status`), and run records
  price input tokens on the true full basis (input + cacheRead + cacheWrite)
  with the measured split kept alongside
- **Golden eval harness** (`eval/golden.yaml`, `backend/eval_runner.py`,
  `eval/nightly.yml`): nightly outcome eval through the real run loop —
  compiled result + behavioral expectations in the headless sim (pin
  transition rates, serial regexes, serial distinct-value minimums), with
  part-presence demoted to a diagnostic. First run records the baseline;
  a ≥10pt success-rate drop exits 1 (the release gate)
- **Agent v2** (`docs/agent-architecture-v2.md`): the draft-patch pipeline is replaced by a plain
  tool-use loop over a run-scoped workspace (`sketch.ino` + `diagram.json`). Nine native tools
  (`write_file`/`read_file`/`edit_file`/`list_files`/`remove_file`/`catalog`/`check`/`compile`/
  `simulate`), `{ok, data|error}` envelopes, and a model-called `done()` whose gates feed failures
  back as data — no attempt counters, only `AGENT_MAX_TURNS` and the run wall clock. The compiler
  moved behind a pooled, cached, family-bounded compile service shared by the tool and the final
  gate. Amazon Bedrock remains the only provider; the transport (`converse`/`mantle`) is a config
  flag probed once at startup
- `/api/agent/status` reports the one Bedrock transport path and its configuration state; there are no local-server providers to probe
- The agent no longer uses a workspace access token. `AGENT_ACCESS_TOKEN` /
  `AGENT_ALLOW_ANONYMOUS` are gone: with `AGENT_ENABLED=true` and a configured
  provider the agent endpoints (`/api/agent/runs`, `records`, `forge/*`,
  `feedback`) are open, and the agent settings panel no longer asks for a
  token. Run the backend on a trusted network or behind an authenticated
  reverse proxy when exposing it

### Fixed
- Agent analysis (`firmware_pin_usage`) re-read the **first** `pinMode(` in a source file for every
  later `pinMode` call, so any sketch that set one pin `OUTPUT` and another `INPUT` — a TRIG/ECHO
  ultrasonic, a button with an LED — was reported as "Pin 3 is driven by the firmware and also driven
  by HC-SR04 ECHO" and the repair attempts were spent on a design that was correct
- Forge/WireGI: AWS Bedrock with `BEDROCK_MODEL=moonshotai.kimi-k2.5` failed every
  call with HTTP 400 `{"message":"Operation not allowed"}` — native Converse does not
  serve Kimi/Moonshot ids. Those ids now go to the Bedrock Mantle chat-completions
  gateway (`bedrock-mantle.<region>.api.aws/v1`, SigV4 service `bedrock-mantle`, same
  AWS keys) on the registry and legacy `.env` paths alike. A Bedrock 400 "Operation not
  allowed" now counts as a rejected credential, so failover stops re-paying it for all
  10 rounds
- The agent's repair loop converges instead of repeating one diagnostic until the
  attempt budget runs out ("Repairing from diagnostics · attempt 4" with nothing
  applied). A patch rejected by the static analysis was never put back into the
  conversation, so the model saw only the unchanged project plus one generic
  line and re-derived the same draft every attempt; the repair turn now carries
  the rejected proposal, `assert_clean` reports every error instead of only the
  first, and a diagnostic that comes back three times in a row ends the run with
  an honest message. A pushbutton miswire (GPIO on `1.l` with GND on `1.r` — both
  legs of ONE contact, a dead short rather than a switch) is now named with the
  part and the exact wire to move, and the pushbutton catalog note plus the agent
  system prompt say "contact 1 vs contact 2" instead of "one side / the opposite
  side", which is what produced that miswire
- An unreachable forge no longer disappears silently from an agent run: the
  stream reports `forge` / `unavailable` (an event the frontend schema always
  accepted) instead of continuing as if no project memory were configured
- The forge project memory (JEV) toggle in agent settings now actually sticks.
  It was unreachable two ways: the toggle POST shared the agent's token
  authorization, so without a valid workspace token the server answered 401
  and the checkbox snapped back, and the box was disabled until the forge
  status poll had succeeded, leaving it permanently unclickable on any failed
  or slow status fetch. The toggle is now always clickable (busy during the
  POST) and the backend no longer requires a token
- Agent responses are now parsed identically on every provider. The Bedrock adapters
  (native Converse and the Kimi K2.5 Mantle gateway) called `Proposal.model_validate_json()`
  directly, skipping the JSON salvage, shape coercion and model-side repair the
  OpenAI-compatible path already had — so one unescaped quote in embedded firmware
  (`Serial.println("reading")`) ended a run with `Invalid JSON: expected ',' or '}' at
  line 1 column 7270` on Bedrock while the same response was silently repaired on Groq.
  Stray quotes, raw newlines, dropped commas and trailing commas are repaired locally
  (`app/agent/jsonrepair.py`), the repair call goes back to the provider that failed
  instead of the default endpoint (it was pinned to `AGENT_BASE_URL`/`AGENT_API_KEY`, so
  on a Bedrock deployment it never ran), truncation is reported as truncation with the
  place it stopped, and the repair prompt quotes the region around the failure rather
  than the first 2 KB of a much longer response
- Amazon Bedrock lists as configured for SigV4-only deployments: the Kimi K2.5 Mantle
  route demanded `BEDROCK_API_KEY` even though it signs with
  `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, hiding a provider the adapter documents
  as the preferred setup
- Agent requests to the Mantle gateway ask for `response_format: json_object` (dropped
  automatically, once, if a gateway rejects the parameter), and Bedrock proposals emit
  the same `propose … ok http=… tokens=…` trace line as the other providers
- Agent patches survive an obvious pin-name misspelling (`pin1` → `1`, `D13` → `13`):
  wire endpoints are resolved against the part's real pins before validation, and a
  pin that still names nothing is reported with the part's pin list instead of dumping
  the whole project through `str(ValidationError)`, which left the repair loop with
  nothing to act on

## [2.0.1] - 2026-04-22

### Added
- Enhanced electrical simulation with ngspice-WASM engine for accurate analog circuit analysis
- Expanded component catalog with 44 SPICE-compatible parts including logic gates, transistors, op-amps, regulators, and electromechanical components
- Added 40 new circuit examples demonstrating analog, digital, and electromechanical concepts
- Introduced custom web components for electronic elements (relays, resistors, capacitors, inductors, transistors)
- Implemented ESP32 ADC waveform simulation with periodic 12-bit waveform look-up tables and interpolation
- Added voltmeter and ammeter instrument components for real-time circuit measurements
- Created comprehensive end-to-end tests for electrical simulation including capacitor charging, rectifier behavior, and waveform analysis
- Added GitHub Actions workflow for circuit simulation testing on every push and PR

### Changed
- Renamed all components to use 'velxio-' prefix for consistency
- Enabled electrical simulation by default (always-on SPICE mode) instead of requiring manual activation
- Enhanced LED brightness simulation to reflect actual current flow from SPICE calculations
- Updated backend to handle unhandled asyncio exceptions and prevent process crashes
- Improved component metadata generation to prevent CI drift and enforce up-to-date metadata
- Refactored property synchronization in simulation parts to use event-based system
- Expanded ADC pin mapping to support all 18 board types for full microcontroller integration

### Fixed
- Fixed sitemap generation to include all circuit examples for better SEO visibility
- Resolved floating input node issues in RC low-pass filter circuits that caused SPICE singular matrix errors
- Updated proxy configuration to use 127.0.0.1 for improved compatibility
- Fixed metadata regeneration to properly include custom components in the component picker
- Improved backend entrypoint script to ensure clean container restarts when processes die

## [2.0.1] - 2026-04-17

### Added
- Added ATtiny85 support with examples and simulation tests
- Added BMP280 sensor component with circuit preview and SVG representation
- Added example detail pages with improved SEO and sitemap generation
- Added MicroPython support for RP2040 (Pico), ESP32, ESP32-S3, and ESP32-C3 boards
- Added ability to upload precompiled firmware files (.hex, .bin, .elf) directly into the emulator
- Added ability to remove boards from workspace with confirmation dialog
- Added I2C sensor support with slave emulation for MPU6050, BMP280, DS1307, and DS3231 sensors
- Added ESP32 WiFi/BLE emulation with ESP-IDF compilation pipeline
- Added VS Code extension skeleton for local simulation
- Added comprehensive documentation for ESP32 GPIO sensor simulation, Docker infrastructure, and MicroPython implementation
- Added auto-compile feature that triggers compilation when pressing Play if code changed or no firmware loaded
- Added share functionality for projects and examples with visibility toggle
- Added component metadata overrides and enhanced property controls
- Added new CI/CD workflows for backend unit tests, end-to-end tests, and automated Discord release notifications
- Added Docker multi-architecture support (amd64 + arm64) and pre-built ESP-IDF toolchain image

### Changed
- Enhanced auto-compile to use board's file group for WiFi detection instead of legacy global files
- Updated CircuitPreview component and implemented ShareModal using createPortal
- Enhanced Arduino pin tracing in DynamicComponent and updated LittleFS WASM initialization
- Enhanced ESP-IDF compiler library resolution logic and added support for dynamic library detection
- Enhanced wire connection handling and GND checks for components
- Enhanced logging for library loading and WiFi progress
- Updated Docker build processes with optimized build contexts and multi-architecture support
- Changed WiFi SSID normalization to match QEMU access points for reliable ESP32 WiFi connection
- Refactored I2C slave tests for ESP32 with improved event handling and ACK/NACK responses

### Fixed
- Fixed container restart issue by monitoring both backend and nginx processes
- Fixed project saving to use active board files/kind and improved error messages
- Fixed ESP32 boot stability with deterministic instruction counting
- Fixed ESP32 Run button to auto-compile and recover firmware after page refresh
- Fixed LED ground check to require cathode wired to GND (or LOW GPIO) to light up
- Fixed MPU6050Slave I2C handling with improved WHO_AM_I read tracking
- Fixed ESP32 WiFi SSID/channel alignment with QEMU access_points array
- Fixed RISC-V toolchain paths for ESP32-C3 compilation
- Fixed ESP-IDF Python requirements installation in Docker
- Fixed SaveProjectModal to prevent saving to `/api/projects/none` when project ID is invalid
- Fixed ESP32 compilation by adding missing dependencies (cmake, ninja-build, git, packaging, libusb)

[2.0.1]: https://github.com/davidmonterocrespo24/velxio/releases/tag/v2.0.1
