"""Source registry, assembled from configuration."""

from __future__ import annotations

from ..config import Settings
from .base import Source
from .stashbox import StashBoxSource

__all__ = ["Source", "StashBoxSource", "build_sources"]


def build_sources(
    settings: Settings, requested_names: set[str] | None = None
) -> list[Source]:
    """Instantiate the enabled, credentialed sources."""
    sources: list[Source] = []

    use_default_sources = requested_names is None
    wanted = requested_names or {"theporndb"}

    if (
        "theporndb" in wanted
        and settings.theporndb_api_key
        and (not use_default_sources or settings.enable_theporndb)
    ):
        sources.append(
            StashBoxSource(
                name="theporndb",
                endpoint=settings.theporndb_base_url,
                api_key=settings.theporndb_api_key,
                auth_style="bearer",
                dialect="tpdb",
            )
        )

    if (
        "stashdb" in wanted
        and settings.stashdb_api_key
        and (not use_default_sources or settings.enable_stashdb)
    ):
        sources.append(
            StashBoxSource(
                name="stashdb",
                endpoint=settings.stashdb_endpoint,
                api_key=settings.stashdb_api_key,
                auth_style="apikey",
                dialect="stashbox",
            )
        )

    return sources
