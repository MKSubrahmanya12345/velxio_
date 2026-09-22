from dataclasses import dataclass

from pydantic_settings import BaseSettings


@dataclass(frozen=True)
class ProviderSpec:
    """One model endpoint the agent can route to.

    kind "openai": OpenAI-compatible chat completions (Groq default, Gemini's
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
    AGENT_API_KEY: str = ""
    AGENT_BASE_URL: str = "https://api.groq.com/openai/v1"
    AGENT_MODEL: str = "openai/gpt-oss-120b"
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
    AGENT_MAX_ATTEMPTS: int = 15
    # Research rounds are cheap (catalog lookups) and are what make the loop
    # agentic; draft rounds compile and may simulate, so they are separate.
    AGENT_MAX_TOOL_ROUNDS: int = 15
    AGENT_MAX_DRAFT_ROUNDS: int = 15
    AGENT_PROVIDER_TIMEOUT_S: float = 500.0
    AGENT_PROVIDER_RETRIES: int = 15
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
            ProviderSpec(id="groq", label="Groq", base_url=self.AGENT_BASE_URL,
                         model=self.AGENT_MODEL, api_key=self.AGENT_API_KEY),
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
