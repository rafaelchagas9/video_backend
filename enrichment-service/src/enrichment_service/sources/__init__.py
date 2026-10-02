"""Source registry assembled from environment and private provider overrides."""
from ..config import Settings
from ..providers import configured_providers
from .base import Source
from .stashbox import StashBoxSource
from .stash import StashSource

def build_sources(settings: Settings, requested_names: set[str] | None = None) -> list[Source]:
    sources = []
    for provider in configured_providers(settings):
        if requested_names is not None and provider.id not in requested_names:
            continue
        if not provider.endpoint or (provider.kind == "stashbox" and not provider.api_key):
            continue
        # An explicit source selection can use a configured source disabled by default.
        if requested_names is None and not provider.enabled:
            continue
        if provider.kind == "stash":
            sources.append(StashSource(provider))
        else:
            sources.append(StashBoxSource(name=provider.id, endpoint=provider.endpoint, api_key=provider.api_key,
                auth_style=provider.auth_style, dialect=provider.dialect, exact_endpoint=provider.exact_endpoint))
    return sources
