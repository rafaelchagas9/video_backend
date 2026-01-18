"""API routes for face recognition service."""

from .detect import router as detect_router
from .health import router as health_router

__all__ = ["detect_router", "health_router"]
