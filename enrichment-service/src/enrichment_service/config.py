"""Configuration settings for the creator enrichment service."""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_SERVICE_DIR = Path(__file__).resolve().parents[2]
_REPO_ROOT = _SERVICE_DIR.parent

# Load the repo-root .env first, then the service-local .env (local wins for
# overlapping keys). Matches the exploration script's fallback behaviour.
_ENV_FILES = (_REPO_ROOT / ".env", _SERVICE_DIR / ".env")


class Settings(BaseSettings):
    """Application settings loaded from environment / .env."""

    model_config = SettingsConfigDict(
        env_file=_ENV_FILES,
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Server settings
    host: str = "0.0.0.0"
    port: int = 8200

    # --- Metadata databases (both implement the StashBox GraphQL schema) ---
    # ThePornDB name search uses its StashBox-compatible GraphQL endpoint, while
    # exact identifiers (slug, numeric id, or UUID) use the official REST API.
    theporndb_api_key: str = ""
    theporndb_base_url: str = "https://theporndb.net/graphql"
    theporndb_rest_url: str = "https://api.theporndb.net"
    # StashDB: GraphQL endpoint, authenticated with the `ApiKey` header.
    stashdb_api_key: str = ""
    stashdb_endpoint: str = "https://stashdb.org/graphql"

    # Per-source enable flags (a source also needs its API key to be active).
    enable_theporndb: bool = True
    enable_stashdb: bool = False

    # HTTP
    request_timeout_seconds: float = 30.0

    # Logging
    log_level: str = "INFO"


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
