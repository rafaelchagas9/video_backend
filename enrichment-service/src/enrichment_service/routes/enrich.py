"""Enrichment endpoints — run the enabled sources for one entity, or a batch of scenes."""

import logging

import httpx
from fastapi import APIRouter

from ..config import get_settings
from ..models import BatchEnrichRequest, Candidate, EnrichRequest, EnrichResponse
from ..sources import build_sources, stash_bridge
from ..sources.stash import StashSource
from ..sources.stashbox import StashBoxSource, local_fingerprints
from ..stash_client import StashClient

router = APIRouter(tags=["enrich"])
logger = logging.getLogger(__name__)


def _error(source: str, exc: Exception) -> str:
    detail = str(exc) if exc.__class__.__name__ == "StashError" else f"lookup failed ({type(exc).__name__}); check provider configuration"
    return detail if detail.startswith(source) else f"{source}: {detail}"


@router.post("/enrich", response_model=EnrichResponse)
async def enrich(request: EnrichRequest) -> EnrichResponse:
    """Discover candidate metadata for one entity. Read-only — never writes."""
    settings = get_settings()
    sources = build_sources(
        settings,
        requested_names=set(request.sources) if request.sources is not None else None,
    )

    candidates: list[Candidate] = []
    sources_used: list[str] = []
    errors: list[str] = []

    if request.stash_scene_id and stash_bridge(settings) is None:
        return EnrichResponse(errors=["Configure a local Stash bridge before using its fingerprints"])
    if request.scraper_url or request.scraper_id:
        sources = [s for s in sources if isinstance(s, StashSource)]
    else:
        sources = [s for s in sources if not isinstance(s, StashSource)]
    if request.sources is not None:
        available = {s.name for s in sources}
        errors.extend(f"{name}: source is unavailable or incompatible with this operation" for name in request.sources if name not in available)

    async with httpx.AsyncClient(timeout=settings.request_timeout_seconds) as client:
        for source in sources:
            try:
                found = await source.search(request, client)
                candidates.extend(found)
                sources_used.append(source.name)
                logger.info("source=%s name=%r candidates=%d", source.name, request.name, len(found))
            except Exception as exc:  # noqa: BLE001 - report, don't abort the run
                errors.append(_error(source.name, exc))
                logger.warning("source failed: %s", errors[-1])

    return EnrichResponse(candidates=candidates, sources_used=sources_used, errors=errors)


@router.post("/enrich/batch", response_model=list[EnrichResponse])
async def enrich_batch(batch: BatchEnrichRequest) -> list[EnrichResponse]:
    """Fingerprint-identify many Stash scenes with one Stash call per source.

    Every request must carry `stash_scene_id`; sources are tried in the order
    given by the first request (Kura's identify priority). Read-only.
    """
    settings = get_settings()
    bridge = stash_bridge(settings)
    responses = [EnrichResponse() for _ in batch.requests]
    if bridge is None:
        for response in responses:
            response.errors.append("Configure a local Stash bridge before identifying scenes")
        return responses
    order = batch.requests[0].sources
    sources = [s for s in build_sources(settings, set(order) if order is not None else None) if isinstance(s, StashBoxSource)]
    if order is not None:
        sources.sort(key=lambda s: order.index(s.name))
    scene_ids = [r.stash_scene_id or "" for r in batch.requests]
    limit = max(r.limit for r in batch.requests)

    async with httpx.AsyncClient(timeout=max(settings.request_timeout_seconds, 120)) as client:
        locals_by_scene = {}
        for request in batch.requests:
            if request.stash_scene_id:
                locals_by_scene[request.stash_scene_id] = await local_fingerprints(request, StashClient(bridge, client))
        for source in sources:
            try:
                found = await source.search_scenes_batch(client, [s for s in scene_ids if s], locals_by_scene, limit)
            except Exception as exc:  # noqa: BLE001
                for response in responses:
                    response.errors.append(_error(source.name, exc))
                continue
            for response, scene_id in zip(responses, scene_ids):
                response.sources_used.append(source.name)
                response.candidates.extend(found.get(scene_id, []))
    return responses
