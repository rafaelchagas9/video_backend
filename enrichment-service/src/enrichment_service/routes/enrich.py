"""Enrichment endpoint — runs the enabled sources for a single creator."""

import logging

import httpx
from fastapi import APIRouter

from ..config import get_settings
from ..models import Candidate, EnrichRequest, EnrichResponse
from ..sources import build_sources
from ..sources.stash import StashSource
from ..providers import configured_providers

router = APIRouter(tags=["enrich"])
logger = logging.getLogger(__name__)


@router.post("/enrich", response_model=EnrichResponse)
async def enrich(request: EnrichRequest) -> EnrichResponse:
    """Discover candidate metadata for a creator. Read-only — never writes."""
    settings = get_settings()
    sources = build_sources(
        settings,
        requested_names=set(request.sources) if request.sources is not None else None,
    )

    candidates: list[Candidate] = []
    sources_used: list[str] = []
    errors: list[str] = []

    async with httpx.AsyncClient(timeout=settings.request_timeout_seconds) as client:
        if request.stash_scene_id:
            bridge = next((p for p in configured_providers(settings) if p.kind == "stash" and p.endpoint), None)
            if bridge is None:
                return EnrichResponse(errors=["Configure a local Stash bridge before using its fingerprints"])
            try:
                fingerprints = await StashSource(bridge).fingerprints(client, request.stash_scene_id)
                request = request.model_copy(update={"fingerprint": next((f for f in fingerprints if f.algorithm == "PHASH"), fingerprints[0])})
            except Exception:
                return EnrichResponse(errors=["Stash fingerprint lookup failed; check the scene and generated hashes"])
        if request.scraper_url:
            sources = [s for s in sources if isinstance(s, StashSource)]
        if request.sources is not None:
            available = {s.name for s in sources}
            errors.extend(f"{name}: source is unavailable or incompatible with this operation" for name in request.sources if name not in available)
        for source in sources:
            try:
                found = await source.search(request, client)
                candidates.extend(found)
                sources_used.append(source.name)
                logger.info(
                    "source=%s name=%r candidates=%d",
                    source.name,
                    request.name,
                    len(found),
                )
            except Exception as exc:  # noqa: BLE001 - report, don't abort the run
                msg = f"{source.name}: lookup failed ({type(exc).__name__}); check provider configuration"
                errors.append(msg)
                logger.warning("source failed: %s", msg)

    return EnrichResponse(
        candidates=candidates, sources_used=sources_used, errors=errors
    )
