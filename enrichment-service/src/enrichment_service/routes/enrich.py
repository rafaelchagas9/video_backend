"""Enrichment endpoint — runs the enabled sources for a single creator."""

import logging

import httpx
from fastapi import APIRouter

from ..config import get_settings
from ..models import Candidate, EnrichRequest, EnrichResponse
from ..sources import build_sources

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
                msg = f"{source.name}: {exc}"
                errors.append(msg)
                logger.warning("source failed: %s", msg)

    return EnrichResponse(
        candidates=candidates, sources_used=sources_used, errors=errors
    )
