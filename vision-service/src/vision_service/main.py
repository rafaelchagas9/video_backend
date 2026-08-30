"""FastAPI application entry point."""

import logging
import warnings
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI

from .body_limit import VisionAnalyzeBodyLimitMiddleware
from .config import get_settings
from .routes import detect_router, health_router, v1_router
from .runtime import VisionRuntime


def setup_logging() -> None:
    """Configure logging based on settings."""
    settings = get_settings()
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper()),
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # Suppress InsightFace's FutureWarning about skimage.transform.SimilarityTransform
    warnings.filterwarnings(
        "ignore", category=FutureWarning, message="`estimate` is deprecated since version 0.26"
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler for startup/shutdown."""
    logger = logging.getLogger(__name__)
    runtime: VisionRuntime = app.state.vision_runtime

    logger.info("Initializing Vision Inference Service...")
    await runtime.start()
    if runtime.is_ready:
        logger.info("Face engine initialized successfully")
    else:
        logger.error("Face engine is unavailable: %s", runtime.failure_code)

    # Lazily loaded detectors compile on their first inference, which is far
    # slower than any caller's timeout. Warm them in the background so they only
    # report ready once they are actually fast.
    runtime.warm_lazy_capabilities()

    try:
        yield
    finally:
        logger.info("Shutting down Vision Inference Service")
        await runtime.stop()


def create_app(runtime: VisionRuntime | None = None) -> FastAPI:
    """Create and configure the FastAPI application."""
    setup_logging()
    settings = runtime.settings if runtime is not None else get_settings()

    app = FastAPI(
        title="Vision Inference Service",
        description="Versioned visual inference with pluggable detector capabilities",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.state.vision_runtime = runtime or VisionRuntime(settings)
    app.add_middleware(
        VisionAnalyzeBodyLimitMiddleware,
        max_batch_bytes=settings.max_batch_bytes,
    )

    # Register routes
    app.include_router(health_router)
    app.include_router(detect_router)
    app.include_router(v1_router)

    return app


app = create_app()


def main() -> None:
    """Run the application with uvicorn."""
    settings = get_settings()
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        reload=False,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    main()
