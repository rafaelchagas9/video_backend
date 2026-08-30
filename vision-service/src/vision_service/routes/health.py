"""Liveness, readiness, compatibility health, and capability endpoints."""

from fastapi import APIRouter, Request, Response, status
from pydantic import BaseModel

from ..runtime import VisionRuntime

SERVICE_VERSION = "0.1.0"

router = APIRouter(tags=["health"])


class LiveResponse(BaseModel):
    status: str
    version: str


class ReadyResponse(BaseModel):
    status: str
    runtime_state: str
    error_code: str | None = None


class HealthResponse(BaseModel):
    """Backward-compatible health response with truthful readiness."""

    status: str
    version: str
    model: str
    onnx_providers: list[str]
    embedding_dimension: int


class CapabilitiesResponse(BaseModel):
    ready: bool
    runtime_state: str
    model: str
    capabilities: list[str]
    onnx_providers: list[str]
    embedding_dimension: int


def _runtime(request: Request) -> VisionRuntime:
    return request.app.state.vision_runtime


@router.get("/livez", response_model=LiveResponse)
async def livez() -> LiveResponse:
    return LiveResponse(status="alive", version=SERVICE_VERSION)


@router.get("/readyz", response_model=ReadyResponse)
async def readyz(request: Request, response: Response) -> ReadyResponse:
    runtime = _runtime(request)
    if not runtime.is_ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return ReadyResponse(
        status="ready" if runtime.is_ready else "not_ready",
        runtime_state=runtime.state.value,
        error_code=runtime.failure_code,
    )


@router.get("/health", response_model=HealthResponse)
async def health_check(request: Request, response: Response) -> HealthResponse:
    """Preserve the legacy route while making it readiness-aware."""
    runtime = _runtime(request)
    if not runtime.is_ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return HealthResponse(
        status="healthy" if runtime.is_ready else "unhealthy",
        version=SERVICE_VERSION,
        model=runtime.settings.insightface_model,
        onnx_providers=runtime.active_providers,
        embedding_dimension=runtime.embedding_dimension,
    )


@router.get("/capabilities", response_model=CapabilitiesResponse)
async def capabilities(request: Request) -> CapabilitiesResponse:
    runtime = _runtime(request)
    return CapabilitiesResponse(
        ready=runtime.is_ready,
        runtime_state=runtime.state.value,
        model=runtime.settings.insightface_model,
        capabilities=["face_detection", "face_embedding"],
        onnx_providers=runtime.active_providers,
        embedding_dimension=runtime.embedding_dimension,
    )
