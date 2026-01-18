"""Configuration settings for the face recognition service."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    # Server settings
    host: str = "0.0.0.0"
    port: int = 8100

    # ONNX Runtime settings
    onnx_providers: str = "CPUExecutionProvider"

    # InsightFace settings
    insightface_model: str = "buffalo_l"
    det_size: int = 1280
    det_size_fallback: int = 640  # Smaller detection size for small images
    det_size_threshold: int = 900  # Use fallback detector if image max dim < this

    # Logging
    log_level: str = "INFO"

    # Model cache directory
    model_cache_dir: str = "./models"

    def get_onnx_providers(self) -> list[str]:
        """Parse ONNX providers from comma-separated string."""
        return [p.strip() for p in self.onnx_providers.split(",") if p.strip()]


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
