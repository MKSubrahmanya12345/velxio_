from dataclasses import dataclass

from pydantic_settings import BaseSettings


@dataclass(frozen=True)
class ProviderSpec:
    """One model endpoint the agent can route to.

    kind "openai": OpenAI-compatible chat completions (any endpoint, Gemini's
                   OpenAI-compatible layer). Uses base_url/model/api_key.
    kind "bedrock": Amazon Bedrock. Native Converse via boto3, except
                   moonshotai.kimi-k2.5 which must use the Bedrock Mantle Chat
                   Completions endpoint — signed with SigV4 (AWS creds) or, as a
                   fallback, BEDROCK_API_KEY. Uses model/region.
    """

    id: str
    label: str
    model: str
    kind: str = "openai"
    base_url: str = ""
    api_key: str = ""
    region: str = ""

    @property
    def configured(self) -> bool:
        if self.kind == "opencode":
            # Local server talks to the model for us; credentials live in
            # opencode, not here. Ready whenever a base URL is wired up.
            return bool(self.base_url and self.model)
        if self.kind == "bedrock":
            # Converse needs a region; Mantle needs a region to build its
            # endpoint URL and then signs with SigV4 (AWS_ACCESS_KEY_ID /
            # AWS_SECRET_ACCESS_KEY), falling back to BEDROCK_API_KEY. Which
            # credential exists is checked where the call is made, so the error
            # names the missing variable instead of the provider silently
            # disappearing from the list for a SigV4-only deployment.
            return bool(self.model and (self.region or self.api_key))
        return bool(self.base_url and self.model and self.api_key)


class Settings(BaseSettings):
    """OSS settings — stateless deployment.

    Auth, DB, OAuth, billing, mail relay etc. moved to the velxio-prod
    private overlay during the Phase 1-4 OSS/pro split. The overlay
    physically replaces this file at Docker build time with a richer
    Settings class that ADDS those fields on top of FRONTEND_URL (see
    pro/backend/app/core/config.py).

    Adding a setting here means the stateless OSS image will read it.
    If the new setting only makes sense with an auth/DB stack (e.g.
    SMTP creds, third-party API keys for analytics), add it to the
    overlay's config.py instead so the OSS image stays minimal.
    """

    # Explicitly opt-in: shared provider credits must not be exposed anonymously.
    AGENT_ENABLED: bool = False
    # Providers: OpenCode (local), Gemini and Amazon Bedrock. There is no
    # generic OpenAI-compatible provider — every endpoint this ships with is
    # one we actually run. Groq was removed (its free tier 429'd mid-run and
    # it rotated model ids without notice); Bedrock is the default.
    # OpenCode provider: talks to a local `opencode serve` instance (the same
    # one the TUI uses), routing to the free big-pickle Zen model through the
    # server's OpenAI-style message API. No API key is stored here — opencode
    # holds the credentials. Point AGENT_OPENCODE_BASE_URL at the server.
    AGENT_OPENCODE_BASE_URL: str = "http://127.0.0.1:4096"
    AGENT_OPENCODE_MODEL: str = "big-pickle"
    # Second provider: Google Gemini through its official OpenAI-compatible
    # layer (https://ai.google.dev/gemini-api/docs/openai). Only used when the
    # API key is set; AGENT_ENABLED gates both providers.
    AGENT_GEMINI_API_KEY: str = ""
    AGENT_GEMINI_BASE_URL: str = "https://generativelanguage.googleapis.com/v1beta/openai"
    AGENT_GEMINI_MODEL: str = "gemini-2.5-flash"
    # Third provider: Amazon Bedrock. Model id + region enable native Converse
    # (boto3); moonshotai.kimi-k2.5 is served through the Bedrock Mantle Chat
    # Completions endpoint instead, which needs BEDROCK_API_KEY. Static AWS
    # creds are optional — boto3 falls back to the default credential chain.
    BEDROCK_MODEL_ID: str = ""
    AWS_REGION: str = ""
    BEDROCK_REGION: str = ""
    BEDROCK_API_KEY: str = ""
    AWS_ACCESS_KEY_ID: str = ""
    AWS_SECRET_ACCESS_KEY: str = ""
    AWS_SESSION_TOKEN: str = ""
    BEDROCK_MAX_TOKENS: int = 30000
    BEDROCK_TEMPERATURE: float = 0.2
    BEDROCK_TOP_P: float = 0.9
    BEDROCK_TIMEOUT_MS: int = 120000
    BEDROCK_MAX_RETRIES: int = 50
    # Agent loop bounds — repair attempts, tool rounds, provider resilience.
    #
    # Speed: these used to be 15/15/15, which allowed a single run to make a
    # dozen-plus SEQUENTIAL provider calls (each re-emitting a full proposal)
    # before answering — the "the agent is taking too much time" experience.
    # A good run needs 1-3; the defaults now cut it off early and honestly.
    # All are env-overridable for hard problems.
    AGENT_MAX_ATTEMPTS: int = 6
    # Research rounds are cheap (catalog lookups) and are what make the loop
    # agentic; draft rounds compile and may simulate, so they are separate.
    AGENT_MAX_TOOL_ROUNDS: int = 8
    AGENT_MAX_DRAFT_ROUNDS: int = 4
<<<<<<< HEAD
    AGENT_PROVIDER_TIMEOUT_S: float = 600.0
=======
    # Wall-clock budget for ONE agent run. The route's deadline and the
    # per-call HTTP timeouts are both derived from this, so raising it is a
    # one-line change that nothing else has to be told about.
    AGENT_RUN_TIMEOUT_S: float = 240.0
    # Ceiling for a single provider call. It used to be 500s — larger than the
    # whole run budget, so it could never fire and every slow call was instead
    # killed by the run deadline with a generic "time limit reached". Every
    # call is additionally clipped to the time LEFT in the run (see
    # service._http_timeout), so this is only an upper bound.
    AGENT_PROVIDER_TIMEOUT_S: float = 120.0
    # Liveness reporting while a provider call is in flight. Provider calls
    # are streamed, but a long prefill produces no tokens, so the UI still
    # needs a periodic "we are alive" tick between chunks.
    AGENT_HEARTBEAT_S: float = 5.0
    # Streaming liveness: bail out when the provider is silent rather than
    # slow. TTFB covers "accepted the connection and never answered" (long
    # prompts legitimately take a while to prefill); STALL covers "started
    # generating and then went quiet" mid-reply.
    AGENT_STREAM_TTFB_S: float = 45.0
    AGENT_STREAM_STALL_S: float = 20.0
    # Graceful degradation: once less than this much of the run budget is
    # left, tool rounds stop and the model is told to commit its best answer
    # now, so the deadline cannot kill a run that had a usable design.
    AGENT_COMMIT_RESERVE_S: float = 45.0
>>>>>>> 16aa5a44b9943b92eea5296ae72e560e66c9cfd0
    AGENT_PROVIDER_RETRIES: int = 15
    # Total time ONE call may spend backing off and retrying. 15 retries of
    # capped backoff is over a minute of the run asleep with nothing to show
    # for it, so the retry COUNT is also bounded by a retry BUDGET.
    AGENT_RETRY_TIME_BUDGET_S: float = 30.0
    # Output budget per provider call type (a ceiling, not a target — the
    # model stops when its response is complete). Tool-round calls usually
    # answer with tool_calls only or a small patch, so they get the lower
    # ceiling; proposal/repair calls must fit the full patch + expectations.
    # Hitting the ceiling is not a failure: the salvage + repair pipeline
    # catches the truncation and asks the model to send only what it changes.
    # Set AGENT_MAX_TOKENS_TOOL_ROUNDS to the proposal value for the old
    # single-ceiling behavior.
    AGENT_MAX_TOKENS_PROPOSAL: int = 10000
    AGENT_MAX_TOKENS_TOOL_ROUNDS: int = 4000
    # Optional small/fast model dedicated to the JSON repair sub-call. The
    # fixer only repairs JSON syntax — it never designs — so it should never
    # pay frontier-model latency in the user's critical path (Cursor routes
    # exactly this kind of call to a fast model). Set all three, e.g. a fast
    # model on an OpenAI-compatible endpoint; on any fixer failure the run's
    # own provider handles the repair, exactly as before. Empty = unchanged.
    AGENT_FIXER_BASE_URL: str = ""
    AGENT_FIXER_MODEL: str = ""
    AGENT_FIXER_API_KEY: str = ""
    # How long the agent waits for the forge memory turn before starting the
    # first provider call (the turn itself keeps running in the background to
    # its 150 s bound). 0 = never wait: memory lands in the stable prefix only
    # if it is already done, otherwise it is folded in as a clarification
    # before the next round (a single-shot run then misses it — raise this to
    # trade serial wait for first-call memory inclusion).
    AGENT_FORGE_GRACE_S: float = 0.0
    # Live Arduino library search from the agent's search_libraries tool.
    AGENT_ALLOW_LIBRARY_SEARCH: bool = True
    # Forge project memory (JEV-governed) for the agent — a direct connection to
    # the standalone <repo>/forge service over its own HTTP API. Fail-open: when
    # forge is unreachable the agent simply runs without memory context. Nothing
    # is copied from forge, so forge changes take effect live; FORGE_AUTOSTART
    # spawns `node --watch` on forge/server so its own code edits hot-reload too.
    # The browser toggle (agent settings) overrides FORGE_ENABLED at runtime.
    FORGE_ENABLED: bool = True
    FORGE_BASE_URL: str = "http://127.0.0.1:4321"
    FORGE_AUTOSTART: bool = True
    FORGE_SPAWN_WAIT_S: float = 8.0
    FORGE_TURN_TIMEOUT_S: float = 130.0
    # Where the forge server code lives. Empty = derive from the repo layout
    # (<repo>/forge/server, works in dev checkouts). The standalone Docker
    # image keeps the backend at /app/app — no repo root to derive from — and
    # ships forge at /forge-server, so it sets this explicitly. Without it
    # autostart silently no-ops and the Create tab reports forge offline.
    FORGE_SERVER_DIR: str = ""
    # Where the bridge persists its state (toggle override, session →
    # conversation ids, spawned pid). Empty = <repo>/backend/data/. The image
    # points it at /app/data (the mounted persistence volume).
    FORGE_STATE_PATH: str = ""

    # Velxio Create (creative tab) talks to Forge, same as the circuit agent's
    # memory layer — no separate keys. Long jobs (YouTube transcription,
    # ingest, idea/script generation) get their own timeout.
    CREATIVE_JOB_TIMEOUT_S: float = 300.0

    # CORS — used by main.py to whitelist the SPA origin during local dev
    # and to build redirect URLs from auth routes in the overlay.
    FRONTEND_URL: str = "http://localhost:5173"

    # extra="ignore": tolerate legacy keys (DATA_DIR, SECRET_KEY, DATABASE_URL, …)
    # left over from pre-split .env files or from the velxio-prod overlay so the
    # OSS image starts cleanly instead of crashing with extra_forbidden.
    def providers(self) -> list[ProviderSpec]:
        """Every provider the agent can route to, in dropdown order."""
        return [
            ProviderSpec(id="opencode", label="OpenCode", kind="opencode",
                         base_url=self.AGENT_OPENCODE_BASE_URL,
                         model=self.AGENT_OPENCODE_MODEL),
            ProviderSpec(id="gemini", label="Gemini", base_url=self.AGENT_GEMINI_BASE_URL,
                         model=self.AGENT_GEMINI_MODEL, api_key=self.AGENT_GEMINI_API_KEY),
            ProviderSpec(id="bedrock", label="Amazon Bedrock", kind="bedrock",
                         model=self.BEDROCK_MODEL_ID, api_key=self.BEDROCK_API_KEY,
                         region=self.AWS_REGION or self.BEDROCK_REGION),
        ]

    def provider(self, provider_id: str) -> ProviderSpec | None:
        """The requested provider if configured, else None."""
        for spec in self.providers():
            if spec.id == provider_id:
                return spec if spec.configured else None
        return None

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }


settings = Settings()
