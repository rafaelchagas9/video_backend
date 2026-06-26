"""Health check endpoint."""

from fastapi import APIRouter
from pydantic import BaseModel

from ..config import get_settings
from ..sources import build_sources

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    status: str
    version: str
    sources: list[str]


@router.get("/health", response_model=HealthResponse)
async def health_check() -> HealthResponse:
    """Report service health and which sources are active."""
    settings = get_settings()
    sources = [s.name for s in build_sources(settings)]
    return HealthResponse(status="healthy", version="0.1.0", sources=sources)
