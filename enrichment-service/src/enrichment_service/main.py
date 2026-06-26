"""FastAPI application entry point for the creator enrichment service."""

import logging

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .routes import enrich_router, health_router


def setup_logging() -> None:
    settings = get_settings()
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )


def create_app() -> FastAPI:
    setup_logging()

    app = FastAPI(
        title="Creator Enrichment Service",
        description=(
            "Discovers candidate metadata (images, socials, aliases, fields) for "
            "creators from external sources. Read-only — proposes, never writes."
        ),
        version="0.1.0",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health_router)
    app.include_router(enrich_router)

    return app


app = create_app()


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        "enrichment_service.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    main()
