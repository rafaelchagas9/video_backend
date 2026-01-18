"""Health check endpoint."""

import logging

import onnxruntime as ort
from fastapi import APIRouter
from pydantic import BaseModel

from ..config import get_settings

router = APIRouter(tags=["health"])
logger = logging.getLogger(__name__)


class HealthResponse(BaseModel):
    """Health check response model."""

    status: str
    version: str
    model: str
    onnx_providers: list[str]
    embedding_dimension: int


@router.get("/health", response_model=HealthResponse)
async def health_check() -> HealthResponse:
    """
    Check service health and return configuration info.

    Returns model name, available ONNX providers, and embedding dimension.
    """
    settings = get_settings()

    return HealthResponse(
        status="healthy",
        version="0.1.0",
        model=settings.insightface_model,
        onnx_providers=ort.get_available_providers(),
        embedding_dimension=512,
    )
