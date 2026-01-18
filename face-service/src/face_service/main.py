"""FastAPI application entry point."""

import logging
import warnings
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .face_engine import FaceEngine
from .routes import detect_router, health_router


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

    # Startup: Initialize the face engine eagerly
    logger.info("Initializing Face Recognition Service...")
    try:
        FaceEngine.get_instance()
        logger.info("Face engine initialized successfully")
    except Exception as e:
        logger.error(f"Failed to initialize face engine: {e}")
        raise

    yield

    # Shutdown
    logger.info("Shutting down Face Recognition Service")


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    setup_logging()
    settings = get_settings()

    app = FastAPI(
        title="Face Recognition Service",
        description="Face detection and embedding extraction using InsightFace",
        version="0.1.0",
        lifespan=lifespan,
    )

    # CORS middleware for development
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Register routes
    app.include_router(health_router)
    app.include_router(detect_router)

    return app


app = create_app()


def main() -> None:
    """Run the application with uvicorn."""
    settings = get_settings()
    uvicorn.run(
        "face_service.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    main()
