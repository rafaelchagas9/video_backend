"""SigLIP2 embeddings: storyboard pages in, one vector per tile out; text queries in, vectors out.

Image vectors are returned as base64 little-endian float16 (the precision they are stored at),
which keeps a 1024-tile response near 2.4 MB instead of ~20 MB of JSON floats.
"""

from __future__ import annotations

import asyncio
import base64
import json

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field, ValidationError, model_validator
from starlette.datastructures import UploadFile

from ..clip_engine import TileGrid
from ..clip_runtime import ClipRuntime
from ..config import Settings, get_settings
from .detect import _decode_image, _error, require_internal_auth

router = APIRouter(prefix="/v1/embeddings", tags=["embeddings"])

IMAGE_SLOT_TIMEOUT_SECONDS = 300


class PageManifestItem(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    file_field: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.-]+$")
    tile_width: int = Field(ge=8, le=4096)
    tile_height: int = Field(ge=8, le=4096)
    # 0 = derive from the image width (legacy single-sheet storyboards).
    columns: int = Field(ge=0, le=256)
    count: int = Field(ge=1, le=4096)


class PagesManifest(BaseModel):
    version: str = Field(pattern=r"^1$")
    pages: list[PageManifestItem] = Field(min_length=1)

    @model_validator(mode="after")
    def unique_fields(self) -> PagesManifest:
        if len({page.file_field for page in self.pages}) != len(self.pages):
            raise ValueError("File fields must be unique")
        return self


class PageEmbeddings(BaseModel):
    id: str
    count: int
    embeddings: str


class PageError(BaseModel):
    id: str
    code: str
    message: str


class PagesResponse(BaseModel):
    model_revision: str
    dimension: int
    dtype: str = "float16"
    pages: list[PageEmbeddings]
    errors: list[PageError]


class TextRequest(BaseModel):
    texts: list[str] = Field(min_length=1)


class TextResponse(BaseModel):
    model_revision: str
    dimension: int
    embeddings: list[list[float]]


def get_clip(request: Request) -> ClipRuntime:
    return request.app.state.clip_runtime


def _require_ready(clip: ClipRuntime) -> None:
    if not clip.enabled:
        raise _error(404, "CAPABILITY_DISABLED", "The clip capability is disabled")
    if not clip.ready:
        raise _error(503, "CAPABILITY_NOT_READY", "The clip capability is still initialising")


@router.post("/pages", response_model=PagesResponse)
async def embed_pages(
    request: Request,
    clip: ClipRuntime = Depends(get_clip),
    settings: Settings = Depends(get_settings),
    _authenticated: None = Depends(require_internal_auth),
) -> PagesResponse:
    _require_ready(clip)
    form = await request.form()
    raw = form.get("manifest")
    if not isinstance(raw, str):
        raise _error(400, "INVALID_MANIFEST", "A text manifest field is required")
    try:
        manifest = PagesManifest.model_validate(json.loads(raw))
    except (json.JSONDecodeError, ValidationError) as error:
        raise _error(400, "INVALID_MANIFEST", "Manifest does not match the contract") from error
    if sum(page.count for page in manifest.pages) > settings.clip_max_tiles:
        raise _error(413, "BATCH_TOO_LARGE", f"More than {settings.clip_max_tiles} tiles")

    engine = clip.require_engine()
    prepared: list = []
    spans: list[tuple[PageManifestItem, int, int]] = []
    errors: list[PageError] = []
    for page in manifest.pages:
        upload = form.get(page.file_field)
        if not isinstance(upload, UploadFile):
            errors.append(PageError(id=page.id, code="MISSING_FILE", message="No file part"))
            continue
        contents = await upload.read(settings.max_image_bytes + 1)
        if len(contents) > settings.max_image_bytes:
            errors.append(PageError(id=page.id, code="IMAGE_TOO_LARGE", message="Page too large"))
            continue
        try:
            image = await asyncio.to_thread(_decode_image, contents, settings)
            grid = TileGrid(page.tile_width, page.tile_height, page.columns, page.count)
            tiles = await asyncio.to_thread(engine.slice_tiles, image, grid)
        except Exception as error:  # noqa: BLE001 - one bad page must not fail the batch
            detail = getattr(error, "detail", None)
            code = detail.get("code") if isinstance(detail, dict) else "INVALID_PAGE"
            errors.append(PageError(id=page.id, code=str(code), message=type(error).__name__))
            continue
        spans.append((page, len(prepared), len(tiles)))
        prepared.extend(tiles)

    try:
        await asyncio.wait_for(clip.image_slot.acquire(), timeout=IMAGE_SLOT_TIMEOUT_SECONDS)
    except TimeoutError as error:
        raise _error(429, "VISION_BUSY", "The clip capability is busy") from error
    try:
        vectors = await asyncio.to_thread(engine.embed_images, prepared)
    finally:
        clip.image_slot.release()

    halves = vectors.astype("<f2")
    pages = [
        PageEmbeddings(
            id=page.id,
            count=count,
            embeddings=base64.b64encode(halves[start : start + count].tobytes()).decode("ascii"),
        )
        for page, start, count in spans
    ]
    return PagesResponse(
        model_revision=engine.model_revision,
        dimension=engine.dimension,
        pages=pages,
        errors=errors,
    )


@router.post("/text", response_model=TextResponse)
async def embed_text(
    body: TextRequest,
    clip: ClipRuntime = Depends(get_clip),
    settings: Settings = Depends(get_settings),
    _authenticated: None = Depends(require_internal_auth),
) -> TextResponse:
    _require_ready(clip)
    if len(body.texts) > settings.clip_max_texts:
        raise _error(413, "BATCH_TOO_LARGE", f"More than {settings.clip_max_texts} texts")
    if any(not text.strip() or len(text) > 1000 for text in body.texts):
        raise _error(400, "INVALID_TEXT", "Texts must be non-empty and at most 1000 characters")
    engine = clip.require_engine()
    vectors = await asyncio.to_thread(engine.embed_texts, body.texts)
    return TextResponse(
        model_revision=engine.model_revision,
        dimension=engine.dimension,
        embeddings=[[round(float(value), 6) for value in row] for row in vectors],
    )
