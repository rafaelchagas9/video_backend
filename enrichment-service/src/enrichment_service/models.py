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


class Fingerprint(BaseModel):
    algorithm: Literal["OSHASH", "PHASH", "MD5"]
    hash: str = Field(pattern=r"^(?:[0-9a-fA-F]{16}|[0-9a-fA-F]{32})$")
    duration: float | None = Field(default=None, ge=0)


class EnrichRequest(BaseModel):
    """Discovery input for a single entity (creator / studio / scene / tag)."""

    name: str
    entity_type: EntityType = "creator"
    aliases: list[str] = Field(default_factory=list)
    handles: list[str] = Field(default_factory=list)
    # Exact external IDs to fetch, scoped by source name.
    external_ids: list[dict[str, str]] = Field(default_factory=list)
    # Scene (video) matching hints.
    scraper_url: str | None = None
    fingerprint: Fingerprint | None = None
    # Extra hashes of this video, e.g. the original file's OSHASH captured before
    # a conversion replaced it. Looked up directly: Stash never saw that file.
    fingerprints: list[Fingerprint] = Field(default_factory=list)
    stash_scene_id: str | None = None
    # Scene: only fingerprint matches, never a title search (batch identify).
    fingerprint_only: bool = False
    # Community scraper (Stash scraper id) for a name/title search.
    scraper_id: str | None = None
    title: str | None = None
    file_name: str | None = None
    duration_seconds: float | None = None
    # Optional explicit subset of source names; defaults to all enabled sources.
    sources: list[str] | None = None
    # Number of search matches to map per source. Exact external-id lookups ignore it.
    limit: int = Field(default=1, ge=1, le=25)


class BatchEnrichRequest(BaseModel):
    requests: list[EnrichRequest] = Field(min_length=1, max_length=200)


class EnrichResponse(BaseModel):
    """Aggregated candidates plus per-run diagnostics."""

    candidates: list[Candidate] = Field(default_factory=list)
    sources_used: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
