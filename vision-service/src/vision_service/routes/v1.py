"""Versioned provider-neutral vision inference HTTP contract."""

from __future__ import annotations

import asyncio
import json
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, FiniteFloat, ValidationError, model_validator
from starlette.datastructures import UploadFile

from ..config import Settings, get_settings
from ..detectors import DecodedImage, DetectorItemError
from ..runtime import (
    InferenceFailedError,
    RuntimeBusyError,
    RuntimeNotReadyError,
    VisionRuntime,
)
from .detect import _decode_image, _error, get_runtime, require_internal_auth

MANIFEST_VERSION = "1"

router = APIRouter(prefix="/v1", tags=["vision"])


class CapabilityResponse(BaseModel):
    name: str
    ready: bool
    state: str
    providers: list[str]
    model_revision: str
    taxonomy_revision: str
    max_batch_items: int = Field(ge=1)
    max_batch_bytes: int = Field(ge=1)
    max_image_bytes: int = Field(ge=1)
    max_image_pixels: int = Field(ge=1)


class VisionCapabilitiesResponse(BaseModel):
    version: Literal["1"] = MANIFEST_VERSION
    capabilities: list[CapabilityResponse]


class ManifestItem(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    timestamp_seconds: FiniteFloat = Field(ge=0)
    file_field: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.-]+$")


class AnalyzeManifest(BaseModel):
    version: Literal["1"]
    capabilities: list[str] = Field(min_length=1)
    items: list[ManifestItem] = Field(min_length=1)

    @model_validator(mode="after")
    def identifiers_are_unique(self) -> AnalyzeManifest:
        if len(set(self.capabilities)) != len(self.capabilities):
            raise ValueError("Capabilities must be unique")
        if any(not capability for capability in self.capabilities):
            raise ValueError("Capability names must not be empty")
        if len({item.id for item in self.items}) != len(self.items):
            raise ValueError("Item IDs must be unique")
        if len({item.file_field for item in self.items}) != len(self.items):
            raise ValueError("File fields must be unique")
        if any(item.file_field == "manifest" for item in self.items):
            raise ValueError("The manifest field cannot contain an image")
        return self


class NormalizedBoxResponse(BaseModel):
    space: Literal["normalized"] = "normalized"
    x1: FiniteFloat = Field(ge=0, le=1)
    y1: FiniteFloat = Field(ge=0, le=1)
    x2: FiniteFloat = Field(ge=0, le=1)
    y2: FiniteFloat = Field(ge=0, le=1)

    @model_validator(mode="after")
    def corners_are_ordered(self) -> NormalizedBoxResponse:
        if self.x2 < self.x1 or self.y2 < self.y1:
            raise ValueError("Normalized box corners are inverted")
        return self


class FindingResponse(BaseModel):
    capability: str
    label: str
    score: FiniteFloat = Field(ge=0, le=1)
    box: NormalizedBoxResponse
    embedding: list[FiniteFloat] | None = None
    metadata: dict[str, object] = Field(default_factory=dict)

    @model_validator(mode="after")
    def face_findings_have_embeddings(self) -> FindingResponse:
        if self.capability == "faces" and (
            self.label != "face" or self.embedding is None or len(self.embedding) != 512
        ):
            raise ValueError("Face findings require the canonical label and embedding")
        return self


class OutcomeError(BaseModel):
    code: str
    message: str


class SuccessfulOutcome(BaseModel):
    capability: str
    status: Literal["ok"] = "ok"
    findings: list[FindingResponse]


class FailedOutcome(BaseModel):
    capability: str
    status: Literal["error"] = "error"
    error: OutcomeError


CapabilityOutcome = Annotated[SuccessfulOutcome | FailedOutcome, Field(discriminator="status")]


class AnalyzeItemResponse(BaseModel):
    id: str
    timestamp_seconds: FiniteFloat
    width: int | None = Field(default=None, gt=0)
    height: int | None = Field(default=None, gt=0)
    outcomes: list[CapabilityOutcome]


class AnalyzeResponse(BaseModel):
    version: Literal["1"] = MANIFEST_VERSION
    items: list[AnalyzeItemResponse]


class _BufferedItem:
    def __init__(self, item: ManifestItem, contents: bytes | None, error: OutcomeError | None):
        self.item = item
        self.contents = contents
        self.error = error


class _UploadItem:
    def __init__(self, item: ManifestItem, upload: UploadFile, size: int) -> None:
        self.item = item
        self.upload = upload
        self.size = size


class _PreparedItem:
    def __init__(
        self,
        item: ManifestItem,
        decoded: DecodedImage | None,
        error: OutcomeError | None,
    ) -> None:
        self.item = item
        self.decoded = decoded
        self.error = error


def _parse_manifest(raw_manifest: str) -> AnalyzeManifest:
    try:
        raw = json.loads(raw_manifest)
    except (json.JSONDecodeError, TypeError) as error:
        raise _error(400, "INVALID_MANIFEST", "Vision manifest is not valid JSON") from error

    if not isinstance(raw, dict):
        raise _error(400, "INVALID_MANIFEST", "Vision manifest must be a JSON object")
    if raw.get("version") != MANIFEST_VERSION:
        raise _error(
            400,
            "UNSUPPORTED_MANIFEST_VERSION",
            f"Vision manifest version must be {MANIFEST_VERSION}",
        )
    try:
        return AnalyzeManifest.model_validate(raw)
    except ValidationError as error:
        raise _error(
            400, "INVALID_MANIFEST", "Vision manifest does not match the contract"
        ) from error


def _failed_outcomes(capabilities: list[str], error: OutcomeError) -> list[FailedOutcome]:
    return [FailedOutcome(capability=capability, error=error) for capability in capabilities]


@router.get("/capabilities", response_model=VisionCapabilitiesResponse)
async def v1_capabilities(request: Request) -> VisionCapabilitiesResponse:
    runtime: VisionRuntime = request.app.state.vision_runtime
    settings = runtime.settings
    return VisionCapabilitiesResponse(
        capabilities=[
            CapabilityResponse(
                name=status.name,
                ready=status.ready,
                state=status.state.value,
                providers=list(status.providers),
                model_revision=status.model_revision,
                taxonomy_revision=status.taxonomy_revision,
                max_batch_items=settings.max_batch_items,
                max_batch_bytes=settings.max_batch_bytes,
                max_image_bytes=settings.max_image_bytes,
                max_image_pixels=settings.max_image_pixels,
            )
            for status in runtime.capability_statuses()
        ]
    )


@router.post(
    "/analyze",
    response_model=AnalyzeResponse,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "multipart/form-data": {
                    "schema": {
                        "type": "object",
                        "required": ["manifest"],
                        "properties": {
                            "manifest": {
                                "type": "string",
                                "description": "Versioned JSON manifest; file_field names each binary part",
                            }
                        },
                        "additionalProperties": {"type": "string", "format": "binary"},
                    }
                }
            },
        }
    },
)
async def analyze(
    request: Request,
    runtime: VisionRuntime = Depends(get_runtime),
    settings: Settings = Depends(get_settings),
    _authenticated: None = Depends(require_internal_auth),
) -> AnalyzeResponse:
    """Analyze a bounded multipart batch without retaining uploaded images."""
    form = await request.form()
    manifest_values = form.getlist("manifest")
    if len(manifest_values) != 1 or not isinstance(manifest_values[0], str):
        raise _error(400, "INVALID_MANIFEST", "Exactly one text manifest field is required")
    parsed = _parse_manifest(manifest_values[0])
    if len(parsed.items) > settings.max_batch_items:
        raise _error(
            413,
            "BATCH_TOO_LARGE",
            f"Batch exceeds the {settings.max_batch_items} item limit",
        )

    unknown = [name for name in parsed.capabilities if not runtime.has_capability(name)]
    if unknown:
        raise _error(400, "UNKNOWN_CAPABILITY", "Vision manifest requests an unknown capability")

    expected_fields = {"manifest", *(item.file_field for item in parsed.items)}
    if any(field not in expected_fields for field, _value in form.multi_items()):
        raise _error(
            400,
            "INVALID_MANIFEST",
            "Multipart request contains a part not referenced by the manifest",
        )

    upload_items: list[_UploadItem] = []
    total_bytes = 0
    for item in parsed.items:
        uploads = form.getlist(item.file_field)
        if len(uploads) != 1 or not isinstance(uploads[0], UploadFile):
            raise _error(
                400,
                "INVALID_MANIFEST",
                "Every manifest item must reference exactly one uploaded file",
            )

        upload = uploads[0]
        if upload.size is None or upload.size < 0:
            raise _error(
                400,
                "INVALID_MANIFEST",
                "Every uploaded file must have a known non-negative size",
            )
        total_bytes += upload.size
        upload_items.append(_UploadItem(item, upload, upload.size))

    if total_bytes > settings.max_batch_bytes:
        raise _error(
            413,
            "BATCH_TOO_LARGE",
            f"Batch exceeds the {settings.max_batch_bytes} byte limit",
        )

    buffered: list[_BufferedItem] = []
    for upload_item in upload_items:
        item = upload_item.item
        if upload_item.size == 0:
            buffered.append(
                _BufferedItem(
                    item,
                    None,
                    OutcomeError(code="EMPTY_IMAGE", message="Image file is empty"),
                )
            )
            continue
        if upload_item.size > settings.max_image_bytes:
            buffered.append(
                _BufferedItem(
                    item,
                    None,
                    OutcomeError(
                        code="IMAGE_TOO_LARGE",
                        message=f"Image exceeds the {settings.max_image_bytes} byte limit",
                    ),
                )
            )
            continue

        contents = await upload_item.upload.read(settings.max_image_bytes + 1)
        if len(contents) != upload_item.size:
            buffered.append(
                _BufferedItem(
                    item,
                    None,
                    OutcomeError(
                        code="INVALID_IMAGE",
                        message="Uploaded image size changed during processing",
                    ),
                )
            )
            continue
        buffered.append(_BufferedItem(item, contents, None))

    prepared: list[_PreparedItem] = []
    for buffered_item in buffered:
        item = buffered_item.item
        if buffered_item.error is not None:
            prepared.append(_PreparedItem(item, None, buffered_item.error))
            continue

        try:
            pixels = await asyncio.to_thread(_decode_image, buffered_item.contents, settings)
            decoded = DecodedImage(pixels)
        except HTTPException as error:
            detail = error.detail if isinstance(error.detail, dict) else {}
            item_error = OutcomeError(
                code=str(detail.get("code", "INVALID_IMAGE")),
                message=str(detail.get("message", "Image data could not be decoded")),
            )
            prepared.append(_PreparedItem(item, None, item_error))
            continue
        prepared.append(_PreparedItem(item, decoded, None))

    outcomes_by_item: list[list[SuccessfulOutcome | FailedOutcome]] = [
        (
            _failed_outcomes(parsed.capabilities, prepared_item.error)
            if prepared_item.error is not None
            else []
        )
        for prepared_item in prepared
    ]
    valid_indexes = [
        index for index, prepared_item in enumerate(prepared) if prepared_item.decoded is not None
    ]

    for capability in parsed.capabilities:
        if not valid_indexes:
            break
        images = [prepared[index].decoded for index in valid_indexes]
        try:
            detector_outcomes = await runtime.analyze_batch(capability, images)
        except RuntimeNotReadyError:
            capability_error = OutcomeError(
                code="CAPABILITY_NOT_READY",
                message="Vision capability is not ready",
            )
            for index in valid_indexes:
                outcomes_by_item[index].append(
                    FailedOutcome(capability=capability, error=capability_error)
                )
            continue
        except RuntimeBusyError:
            capability_error = OutcomeError(
                code="OVERLOADED",
                message="Vision capability capacity is exhausted",
            )
            for index in valid_indexes:
                outcomes_by_item[index].append(
                    FailedOutcome(capability=capability, error=capability_error)
                )
            continue
        except InferenceFailedError:
            capability_error = OutcomeError(
                code="INFERENCE_FAILED",
                message="Vision capability failed to analyze the image",
            )
            for index in valid_indexes:
                outcomes_by_item[index].append(
                    FailedOutcome(capability=capability, error=capability_error)
                )
            continue

        for index, detector_outcome in zip(valid_indexes, detector_outcomes, strict=True):
            if isinstance(detector_outcome, DetectorItemError):
                outcomes_by_item[index].append(
                    FailedOutcome(
                        capability=capability,
                        error=OutcomeError(
                            code=detector_outcome.code,
                            message=detector_outcome.message,
                        ),
                    )
                )
            else:
                outcomes_by_item[index].append(
                    SuccessfulOutcome(
                        capability=capability,
                        findings=[
                            FindingResponse(
                                capability=finding.capability,
                                label=finding.label,
                                score=finding.score,
                                box=NormalizedBoxResponse(
                                    x1=finding.box.x1,
                                    y1=finding.box.y1,
                                    x2=finding.box.x2,
                                    y2=finding.box.y2,
                                ),
                                embedding=(
                                    list(finding.embedding)
                                    if finding.embedding is not None
                                    else None
                                ),
                                metadata=finding.metadata,
                            )
                            for finding in detector_outcome.findings
                        ],
                    )
                )

    response_items: list[AnalyzeItemResponse] = []
    for index, prepared_item in enumerate(prepared):
        dimensions = (
            {"width": prepared_item.decoded.width, "height": prepared_item.decoded.height}
            if prepared_item.decoded is not None
            else {}
        )
        response_items.append(
            AnalyzeItemResponse(
                id=prepared_item.item.id,
                timestamp_seconds=prepared_item.item.timestamp_seconds,
                outcomes=outcomes_by_item[index],
                **dimensions,
            )
        )

    return AnalyzeResponse(items=response_items)
