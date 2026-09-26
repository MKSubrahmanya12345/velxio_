from dataclasses import dataclass
from typing import Literal

from pydantic_settings import BaseSettings


@dataclass(frozen=True)
class ProviderSpec:
    """The one model endpoint the agent can route to.

    Amazon Bedrock only. Native Converse via boto3, except
    moonshotai.kimi-k2.5 which must use the Bedrock Mantle Chat Completions
    endpoint — signed with SigV4 (AWS creds) or, as a fallback,
    BEDROCK_API_KEY. Uses model/region.
    """

    id: str
    label: str
    model: str
    kind: str = "bedrock"
    base_url: str = ""
    api_key: str = ""
    region: str = ""

    @property
    def configured(self) -> bool:
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
    # Amazon Bedrock only — one provider, two transports (native Converse for
    # most models, the Mantle Chat Completions gateway for Kimi/Moonshot ids).
    # There is no second provider and no fallback path of any kind.
    BEDROCK_MODEL_ID: str = ""
    # Which Bedrock transport serves BEDROCK_MODEL_ID: "converse" (native
    # boto3 Converse) or "mantle" (the Bedrock Mantle Chat Completions
    # gateway, OpenAI-shaped). Configuration, NOT model-id substring
    # matching — a model rename can never silently reroute traffic. The
    # startup probe (service._ensure_transport) verifies the pair once per
    # process and fails fast with the hint above.
    BEDROCK_TRANSPORT: Literal["converse", "mantle"] = "converse"
    # Prompt caching: explicit config, never inferred from the model id. "on"
    # adds Converse cachePoint blocks (system + the history/state boundary)
    # and the startup probe MEASURES whether the model actually reports cache
    # usage: a tiny ping is below every model's minimum cacheable prefix, so
    # the probe pads its system prompt over the floor before asserting.
    # Converse: unsupported model => probe fails fast with the fix. Mantle:
    # no marker exists on that gateway, so the probe only records what the
    # usage payload reports (surfaced on /api/agent/status) — the flag can
    # never imply savings that were not measured. Default off: cache writes
    # bill at a premium, so flipping it on is a deliberate per-deployment act.
    BEDROCK_PROMPT_CACHE: Literal["off", "on"] = "off"
    AWS_REGION: str = ""
    BEDROCK_REGION: str = ""
    BEDROCK_API_KEY: str = ""
    AWS_ACCESS_KEY_ID: str = ""
    AWS_SECRET_ACCESS_KEY: str = ""
    AWS_SESSION_TOKEN: str = ""
    BEDROCK_MAX_TOKENS: int = 30000
    BEDROCK_TEMPERATURE: float = 0.2
    BEDROCK_TOP_P: float = 0.9
    # No BEDROCK_TIMEOUT_MS / BEDROCK_MAX_RETRIES: per-call timeouts derive
    # from AGENT_PROVIDER_TIMEOUT_S and botocore is pinned to max_attempts=1
    # in service.py — propose()'s loop is the ONE retry layer (the D3 rule).
    # Agent loop bounds — three protections for the USER, never governors for
    # the model: the wall clock, the turn cap, and the 2-slot semaphore in the
    # route. There are no attempt/round/draft/commit-reserve budgets: the loop
    # is plain tool use (write -> check/compile -> fix -> repeat -> done) and
    # an error is a tool result the model reads, not a failure class.
    # Wall-clock budget for ONE agent run. The route's deadline and the
    # per-call HTTP timeouts are both derived from this.
    AGENT_RUN_TIMEOUT_S: float = 300.0
    # Hard cap on provider round-trips per run (the turn cap). Generous on
    # purpose: a normal run needs 6-12.
    AGENT_MAX_TURNS: int = 24
    # Ceiling for a single provider call, clipped to the time LEFT in the run
    # (see service._http_timeout), so this is only an upper bound.
    AGENT_PROVIDER_TIMEOUT_S: float = 120.0
    # Liveness reporting while a provider call is in flight. Provider calls
    # are streamed, but a long prefill produces no tokens, so the UI still
    # needs a periodic "we are alive" tick between chunks.
    AGENT_HEARTBEAT_S: float = 5.0
    # Streaming liveness (Mantle transport): bail out when the provider is
    # silent rather than slow. TTFB covers "accepted the connection and never
    # answered"; STALL covers "started generating and then went quiet".
    AGENT_STREAM_TTFB_S: float = 45.0
    AGENT_STREAM_STALL_S: float = 20.0
    # The ONE retry layer in the system (D3 rule): propose()'s loop. botocore
    # is configured with max_attempts=1 so transport errors surface
    # immediately as tool data instead of stacking a second retry counter.
    AGENT_PROVIDER_RETRIES: int = 8
    # Total time ONE call may spend backing off and retrying.
    AGENT_RETRY_TIME_BUDGET_S: float = 30.0
    # Output ceiling per provider call. Tool calls are small; a whole new
    # sketch in write_file is the big one.
    AGENT_MAX_TOKENS: int = 16000
    # simulate() enforcement — exactly two mechanisms, nothing stacked:
    # one virtual-time cap passed per call (observe_ms, clamped 100..10000
    # in the tool), and this fixed wall-clock kill for the subprocess
    # (runaway firmware can avoid advancing virtual time; a constant, not a
    # multiplier — no instruction ceiling, that was insurance-on-insurance).
    AGENT_SIM_WALL_CLOCK_S: float = 10.0
    # Output budget per provider call type (a ceiling, not a target — the
    # model stops when its response is complete). Tool-round calls usually
    # answer with tool_calls only or a small patch, so they get the lower
    # ceiling; proposal/repair calls must fit the full patch + expectations.
    # Hitting the ceiling is not a failure: the salvage + repair pipeline
    # catches the truncation and asks the model to send only what it changes.
    # Set AGENT_MAX_TOKENS_TOOL_ROUNDS to the proposal value for the old
    # single-ceiling behavior.
    AGENT_MAX_TOKENS_PROPOSAL: int = 10000
    # The call after a tool round is often the commit. A 4k cap truncated the
    # patch and forced a repair. Same ceiling as a proposal.
    AGENT_MAX_TOKENS_TOOL_ROUNDS: int = 10000
    # How long the agent waits for the forge memory turn before starting the
    # first provider call (the turn itself keeps running in the background to
    # its 150 s bound). 0 = never wait: memory lands in the stable prefix only
    # if it is already done, otherwise it is folded in as a clarification
    # before the next round (a single-shot run then misses it — raise this to
    # trade serial wait for first-call memory inclusion).
    AGENT_FORGE_GRACE_S: float = 0.0
    # How long the agent waits for the JEV decision before designing without it.
    # This is one System One call, not a second chat. A timeout fails open.
    AGENT_FORGE_DECIDE_WAIT_S: float = 20.0
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
        """The provider list: Amazon Bedrock, full stop."""
        return [
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
