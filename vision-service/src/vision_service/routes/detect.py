"""Face detection endpoints."""

from __future__ import annotations

import asyncio
import base64
import binascii
import logging
import secrets
import time

import cv2
import numpy as np
from fastapi import APIRouter, Depends, File, HTTPException, Request, Security, UploadFile
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field, FiniteFloat

from ..config import Settings, get_settings
from ..runtime import (
    InferenceFailedError,
    RuntimeBusyError,
    RuntimeNotReadyError,
    VisionRuntime,
)

router = APIRouter(tags=["detection"])
logger = logging.getLogger(__name__)
internal_bearer = HTTPBearer(
    auto_error=False,
    description="Optional internal service token configured by INTERNAL_API_SECRET",
)


class FaceResult(BaseModel):
    """Individual face detection result."""

    bbox: tuple[FiniteFloat, FiniteFloat, FiniteFloat, FiniteFloat]
    embedding: list[FiniteFloat] = Field(min_length=512, max_length=512)
    det_score: FiniteFloat = Field(ge=0, le=1)


class DetectResponse(BaseModel):
    """Response for face detection endpoints."""

    faces: list[FaceResult]
    processing_time_ms: FiniteFloat = Field(ge=0)
    image_width: int = Field(gt=0)
    image_height: int = Field(gt=0)


class ExtractRequest(BaseModel):
    """Request for embedding extraction from a base64 image."""

    image_base64: str


def get_runtime(request: Request) -> VisionRuntime:
    return request.app.state.vision_runtime


def _error(status_code: int, code: str, message: str, **kwargs: object) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"code": code, "message": message},
        **kwargs,
    )


def require_internal_auth(
    credentials: HTTPAuthorizationCredentials | None = Security(internal_bearer),
    settings: Settings = Depends(get_settings),
) -> None:
    """Require the configured internal token while preserving an opt-in rollout."""
    configured_secret = settings.internal_api_secret
    if configured_secret is None:
        return

    provided_secret = credentials.credentials if credentials is not None else ""
    has_bearer_scheme = credentials is not None and credentials.scheme.lower() == "bearer"
    secret_matches = secrets.compare_digest(
        provided_secret.encode("utf-8"),
        configured_secret.get_secret_value().encode("utf-8"),
    )
    if not has_bearer_scheme or not secret_matches:
        raise _error(
            401,
            "INTERNAL_AUTH_REQUIRED",
            "Valid internal service credentials are required",
            headers={"WWW-Authenticate": "Bearer"},
        )


def _decode_image(contents: bytes, settings: Settings) -> np.ndarray:
    nparr = np.frombuffer(contents, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if image is None:
        raise _error(400, "INVALID_IMAGE", "Image data could not be decoded")

    height, width = image.shape[:2]
    if height * width > settings.max_image_pixels:
        raise _error(
            413,
            "IMAGE_PIXELS_EXCEEDED",
            f"Decoded image exceeds the {settings.max_image_pixels} pixel limit",
        )
    return image


async def _run_detection(
    contents: bytes,
    runtime: VisionRuntime,
    settings: Settings,
    start: float,
) -> DetectResponse:
    image = await asyncio.to_thread(_decode_image, contents, settings)
    height, width = image.shape[:2]

    try:
        faces = await runtime.detect(image)
    except RuntimeNotReadyError as error:
        raise _error(503, "VISION_NOT_READY", "Vision engine is not ready") from error
    except RuntimeBusyError as error:
        retry_after = max(1, round(settings.inference_acquire_timeout_seconds))
        raise _error(
            429,
            "VISION_BUSY",
            "Vision engine capacity is exhausted",
            headers={"Retry-After": str(retry_after)},
        ) from error
    except InferenceFailedError as error:
        logger.exception("Face detection failed")
        raise _error(500, "INFERENCE_FAILED", "Face detection failed") from error

    processing_time = (time.perf_counter() - start) * 1000
    logger.debug(
        "Detected %d faces in %.2fms for a %dx%d image",
        len(faces),
        processing_time,
        width,
        height,
    )
    return DetectResponse(
        faces=[FaceResult(**face) for face in faces],
        processing_time_ms=round(processing_time, 2),
        image_width=width,
        image_height=height,
    )


@router.post("/detect", response_model=DetectResponse)
async def detect_faces(
    file: UploadFile = File(...),
    runtime: VisionRuntime = Depends(get_runtime),
    settings: Settings = Depends(get_settings),
    _authenticated: None = Depends(require_internal_auth),
) -> DetectResponse:
    """Detect faces in one uploaded image and extract embeddings."""
    start = time.perf_counter()
    contents = await file.read(settings.max_image_bytes + 1)
    if not contents:
        raise _error(400, "EMPTY_IMAGE", "Image file is empty")
    if len(contents) > settings.max_image_bytes:
        raise _error(
            413,
            "IMAGE_TOO_LARGE",
            f"Image exceeds the {settings.max_image_bytes} byte limit",
        )
    return await _run_detection(contents, runtime, settings, start)


@router.post("/extract-embedding", response_model=DetectResponse)
async def extract_embedding_base64(
    request: ExtractRequest,
    runtime: VisionRuntime = Depends(get_runtime),
    settings: Settings = Depends(get_settings),
    _authenticated: None = Depends(require_internal_auth),
) -> DetectResponse:
    """Detect faces in one base64-encoded image and extract embeddings."""
    start = time.perf_counter()
    maximum_encoded_length = ((settings.max_image_bytes + 2) // 3) * 4
    if len(request.image_base64) > maximum_encoded_length:
        raise _error(
            413,
            "IMAGE_TOO_LARGE",
            f"Image exceeds the {settings.max_image_bytes} byte limit",
        )

    try:
        contents = base64.b64decode(request.image_base64, validate=True)
    except (binascii.Error, ValueError) as error:
        raise _error(400, "INVALID_BASE64", "Image is not valid base64") from error

    if not contents:
        raise _error(400, "EMPTY_IMAGE", "Image data is empty")
    if len(contents) > settings.max_image_bytes:
        raise _error(
            413,
            "IMAGE_TOO_LARGE",
            f"Image exceeds the {settings.max_image_bytes} byte limit",
        )
    return await _run_detection(contents, runtime, settings, start)
