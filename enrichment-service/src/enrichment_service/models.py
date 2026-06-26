"""Shared request / response models for the enrichment service."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

CandidateType = Literal[
    "image",
    "platform",
    "social",
    "bio",
    "alias",
    "field",
    "external_id",
    # Relational / taxonomy candidates (studio / scene / tag enrichment).
    # `value` holds the display name; `raw` carries {external_id, source, as?}.
    "performer",
    "studio",
    "tag",
    "category",
    "parent",
]

EntityType = Literal["creator", "studio", "scene", "tag"]


class Candidate(BaseModel):
    """A single normalized suggestion returned by a source plugin."""

    type: CandidateType
    value: str
    source: str
    source_url: str | None = None
    # For `field` candidates this is the target creator column (e.g. "gender").
    field_key: str | None = None
    confidence: float | None = None
    raw: dict[str, Any] | None = None


class EnrichRequest(BaseModel):
    """Discovery input for a single entity (creator / studio / scene / tag)."""

    name: str
    entity_type: EntityType = "creator"
    aliases: list[str] = Field(default_factory=list)
    handles: list[str] = Field(default_factory=list)
    # Exact external IDs to fetch, scoped by source name.
    external_ids: list[dict[str, str]] = Field(default_factory=list)
    # Scene (video) matching hints.
    title: str | None = None
    file_name: str | None = None
    duration_seconds: float | None = None
    # Optional explicit subset of source names; defaults to all enabled sources.
    sources: list[str] | None = None
    # Number of search matches to map per source. Exact external-id lookups ignore it.
    limit: int = Field(default=1, ge=1, le=25)


class EnrichResponse(BaseModel):
    """Aggregated candidates plus per-run diagnostics."""

    candidates: list[Candidate] = Field(default_factory=list)
    sources_used: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
