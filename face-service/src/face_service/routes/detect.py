"""Face detection endpoint."""

import logging
import time

import cv2
import numpy as np
from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

from ..face_engine import FaceEngine

router = APIRouter(tags=["detection"])
logger = logging.getLogger(__name__)


class FaceResult(BaseModel):
    """Individual face detection result."""

    bbox: list[float]
    embedding: list[float]
    det_score: float
    age: int | None = None
    gender: str | None = None


class DetectResponse(BaseModel):
    """Response for face detection endpoint."""

    faces: list[FaceResult]
    processing_time_ms: float
    image_width: int
    image_height: int


@router.post("/detect", response_model=DetectResponse)
async def detect_faces(file: UploadFile = File(...)) -> DetectResponse:
    """
    Detect faces in an uploaded image and extract embeddings.

    Accepts image files (JPEG, PNG, WebP, etc.) and returns:
    - Bounding boxes for each detected face
    - 512-dimensional embedding vectors
    - Detection confidence scores
    - Estimated age and gender (if available)
    """
    start = time.perf_counter()

    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Empty file")

    nparr = np.frombuffer(contents, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if image is None:
        raise HTTPException(
            status_code=400,
            detail="Invalid image format. Supported: JPEG, PNG, WebP, BMP, TIFF",
        )

    height, width = image.shape[:2]
    logger.debug(f"Processing image: {width}x{height}")

    try:
        engine = FaceEngine.get_instance()
        faces = engine.detect(image)
    except Exception as e:
        logger.error(f"Face detection failed: {e}")
        raise HTTPException(status_code=500, detail="Face detection failed") from e

    processing_time = (time.perf_counter() - start) * 1000

    logger.info(f"Detected {len(faces)} faces in {processing_time:.2f}ms")

    return DetectResponse(
        faces=[FaceResult(**f) for f in faces],
        processing_time_ms=round(processing_time, 2),
        image_width=width,
        image_height=height,
    )


class ExtractRequest(BaseModel):
    """Request for embedding extraction from base64 image."""

    image_base64: str


@router.post("/extract-embedding", response_model=DetectResponse)
async def extract_embedding_base64(request: ExtractRequest) -> DetectResponse:
    """
    Extract face embeddings from a base64-encoded image.

    Alternative to file upload for programmatic access.
    """
    import base64

    start = time.perf_counter()

    try:
        image_data = base64.b64decode(request.image_base64)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 encoding")

    nparr = np.frombuffer(image_data, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if image is None:
        raise HTTPException(status_code=400, detail="Invalid image data")

    height, width = image.shape[:2]

    try:
        engine = FaceEngine.get_instance()
        faces = engine.detect(image)
    except Exception as e:
        logger.error(f"Face detection failed: {e}")
        raise HTTPException(status_code=500, detail="Face detection failed") from e

    processing_time = (time.perf_counter() - start) * 1000

    return DetectResponse(
        faces=[FaceResult(**f) for f in faces],
        processing_time_ms=round(processing_time, 2),
        image_width=width,
        image_height=height,
    )
