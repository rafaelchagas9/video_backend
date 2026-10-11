"""FastAPI application entry point for the creator enrichment service."""

import logging

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .http_client import http_lifespan
from .config import get_settings
from .routes import enrich_router, health_router
from .routes.providers import router as providers_router
from .routes.stash import router as stash_router


def setup_logging() -> None:
    settings = get_settings()
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # HTTPX logs every successful request at INFO (including provider URLs).
    # Retain warnings/errors while leaving detailed wire diagnostics opt-in.
    transport_level = logging.DEBUG if settings.log_level.upper() == "DEBUG" else logging.WARNING
    logging.getLogger("httpx").setLevel(transport_level)
    logging.getLogger("httpcore").setLevel(transport_level)


def create_app() -> FastAPI:
    setup_logging()

    app = FastAPI(
        lifespan=http_lifespan,
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
    app.include_router(providers_router)
    app.include_router(stash_router)

    return app


app = create_app()


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        "enrichment_service.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
        access_log=settings.access_log,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    main()
