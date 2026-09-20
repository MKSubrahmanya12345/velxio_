from pydantic_settings import BaseSettings


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
    AGENT_BASE_URL: str = "https://api.openai.com/v1"
    AGENT_MODEL: str = "gpt-4.1"
    AGENT_ACCESS_TOKEN: str = ""
    AGENT_ALLOW_ANONYMOUS: bool = False
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
    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }


settings = Settings()
