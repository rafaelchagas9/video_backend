"""Configuration settings for the visual inference service."""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

VISION_SERVICE_ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = VISION_SERVICE_ROOT / ".env"


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Server settings
    host: str = "0.0.0.0"
    port: int = Field(default=8100, ge=1, le=65535)

    # ONNX Runtime settings
    onnx_providers: str = "CPUExecutionProvider"

    # InsightFace settings
    insightface_model: str = "buffalo_l"
    det_size: int = Field(default=1280, ge=1)
    det_size_fallback: int = Field(default=640, ge=1)
    det_size_threshold: int = Field(default=900, ge=1)

    # NudeNet settings. The model remains lazy until the first nudity request.
    nudity_enabled: bool = True
    nudity_model: Literal["640m", "320n"] = "640m"
    nudity_onnx_providers: str = "MIGraphXExecutionProvider,CPUExecutionProvider"
    nudity_require_gpu: bool = True
    nudity_initialization_retry_seconds: float = Field(default=60, ge=0)

    # Request and admission limits
    max_image_bytes: int = Field(default=10 * 1024 * 1024, ge=1)
    max_image_pixels: int = Field(default=40_000_000, ge=1)
    max_batch_items: int = Field(default=16, ge=1)
    max_batch_bytes: int = Field(default=32 * 1024 * 1024, ge=1)
    max_concurrent_inferences: int = Field(default=1, ge=1)
    inference_acquire_timeout_seconds: float = Field(default=0.1, gt=0)

    # Optional backend-to-service authentication. Disabled when unset.
    internal_api_secret: SecretStr | None = None

    # Logging
    log_level: str = "INFO"

    # Model cache directory
    model_cache_dir: Path = VISION_SERVICE_ROOT / "models"

    @field_validator("model_cache_dir")
    @classmethod
    def resolve_model_cache_dir(cls, value: Path) -> Path:
        if value.is_absolute():
            return value
        return VISION_SERVICE_ROOT / value

    @field_validator("internal_api_secret", mode="before")
    @classmethod
    def empty_internal_api_secret_is_disabled(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return None
        return value

    def get_onnx_providers(self) -> list[str]:
        """Parse ONNX providers from comma-separated string."""
        return [p.strip() for p in self.onnx_providers.split(",") if p.strip()]

    def get_nudity_onnx_providers(self) -> list[str]:
        """Parse the independent NudeNet provider preference."""
        providers = [p.strip() for p in self.nudity_onnx_providers.split(",") if p.strip()]
        if "CPUExecutionProvider" not in providers:
            providers.append("CPUExecutionProvider")
        return providers


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
