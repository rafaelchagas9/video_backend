"""API routes for face recognition service."""

from .detect import router as detect_router
from .embeddings import router as embeddings_router
from .health import router as health_router
from .v1 import router as v1_router

__all__ = ["detect_router", "embeddings_router", "health_router", "v1_router"]
