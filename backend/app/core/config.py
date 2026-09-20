from dataclasses import dataclass

from pydantic_settings import BaseSettings


@dataclass(frozen=True)
class ProviderSpec:
    """One model endpoint the agent can route to.

    kind "openai": OpenAI-compatible chat completions (Groq default, Gemini's
                   OpenAI-compatible layer). Uses base_url/model/api_key.
    kind "bedrock": Amazon Bedrock. Native Converse via boto3, except
                   moonshotai.kimi-k2.5 which must use the Bedrock Mantle Chat
                   Completions endpoint (BEDROCK_API_KEY). Uses model/region.
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
        if self.kind == "bedrock":
            if not self.model:
                return False
            if self.model.strip().lower() == "moonshotai.kimi-k2.5":
                return bool(self.api_key)
            return bool(self.region)
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
    # Second provider: Google Gemini through its official OpenAI-compatible
    # layer (https://ai.google.dev/gemini-api/docs/openai). Only used when the
    # API key is set; AGENT_ENABLED gates both providers.
    AGENT_GEMINI_API_KEY: str = ""
    AGENT_GEMINI_BASE_URL: str = "https://generativelanguage.googleapis.com/v1beta/openai"
    AGENT_GEMINI_MODEL: str = "gemini-2.5-flash"
    AGENT_ACCESS_TOKEN: str = ""
    AGENT_ALLOW_ANONYMOUS: bool = False
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
    BEDROCK_MAX_TOKENS: int = 10000
    BEDROCK_TEMPERATURE: float = 0.2
    BEDROCK_TOP_P: float = 0.9
    BEDROCK_TIMEOUT_MS: int = 120000
    BEDROCK_MAX_RETRIES: int = 5
    # Agent loop bounds — repair attempts, tool rounds, provider resilience.
    AGENT_MAX_ATTEMPTS: int = 3
    AGENT_MAX_TOOL_ROUNDS: int = 3
    AGENT_PROVIDER_TIMEOUT_S: float = 60.0
    AGENT_PROVIDER_RETRIES: int = 2
    # Live Arduino library search from the agent's search_libraries tool.
    AGENT_ALLOW_LIBRARY_SEARCH: bool = False

    # CORS — used by main.py to whitelist the SPA origin during local dev
    # and to build redirect URLs from auth routes in the overlay.
    FRONTEND_URL: str = "http://localhost:5173"

    # extra="ignore": tolerate legacy keys (DATA_DIR, SECRET_KEY, DATABASE_URL, …)
    # left over from pre-split .env files or from the velxio-prod overlay so the
    # OSS image starts cleanly instead of crashing with extra_forbidden.
    def providers(self) -> list[ProviderSpec]:
        """Every provider the agent can route to, in dropdown order."""
        return [
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
