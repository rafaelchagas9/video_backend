"""Private persisted provider configuration; public descriptors never expose secrets."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, field_validator
from .config import Settings


class Provider(BaseModel):
    id: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    name: str = Field(min_length=1, max_length=100)
    kind: Literal["stashbox", "stash"] = "stashbox"
    endpoint: str = ""
    enabled: bool = False
    api_key: str = ""
    dialect: Literal["stashbox", "tpdb", "standard"] = "stashbox"
    auth_style: Literal["apikey", "bearer"] = "apikey"
    exact_endpoint: str | None = None

    @field_validator("endpoint")
    @classmethod
    def validate_endpoint(cls, value: str) -> str:
        if not value:
            return value
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("Use an HTTP GraphQL endpoint without credentials or query parameters")
        return value.rstrip("/")

    def public(self) -> dict:
        return {"id": self.id, "name": self.name, "kind": self.kind,
                "endpoint": self.endpoint, "enabled": self.enabled,
                "configured": bool(self.endpoint and (self.api_key or self.kind == "stash")),
                "dialect": self.dialect, "auth_style": self.auth_style,
                "capabilities": (["creator_url", "scene_url", "scrapers", "fingerprints", "contribution_drafts"]
                                 if self.kind == "stash" else ["creator", "scene", "fingerprints"])}


class ProviderPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    kind: Literal["stashbox", "stash"] | None = None
    endpoint: str | None = None
    enabled: bool | None = None
    api_key: str | None = None
    dialect: Literal["stashbox", "tpdb", "standard"] | None = None
    auth_style: Literal["apikey", "bearer"] | None = None


def configured_providers(settings: Settings) -> list[Provider]:
    defaults = [
        Provider(id="theporndb", name="ThePornDB", endpoint=settings.theporndb_base_url,
                 api_key=settings.theporndb_api_key, enabled=settings.enable_theporndb,
                 dialect="tpdb", auth_style="bearer", exact_endpoint=settings.theporndb_rest_url),
        Provider(id="stashdb", name="StashDB", endpoint=settings.stashdb_endpoint,
                 api_key=settings.stashdb_api_key, enabled=settings.enable_stashdb),
        Provider(id="fansdb", name="FansDB", endpoint=settings.fansdb_endpoint,
                 api_key=settings.fansdb_api_key, enabled=settings.enable_fansdb, dialect="standard"),
        Provider(id="stash", name="Stash local", kind="stash", endpoint=settings.stash_endpoint,
                 api_key=settings.stash_api_key, enabled=settings.enable_stash),
    ]
    path = Path(settings.provider_config_path)
    if path.exists():
        stored = json.loads(path.read_text())
        by_id = {p.id: p for p in defaults}
        for record in stored:
            provider = Provider.model_validate(record)
            by_id[provider.id] = provider
        return list(by_id.values())
    return defaults


def save_provider(settings: Settings, provider_id: str, patch: ProviderPatch) -> Provider:
    providers = configured_providers(settings)
    existing = next((p for p in providers if p.id == provider_id), None)
    base = existing.model_dump() if existing else {"id": provider_id, "name": provider_id}
    # Null means unchanged; empty string explicitly removes a credential.
    provider = Provider.model_validate({**base, **patch.model_dump(exclude_none=True)})
    providers = [p for p in providers if p.id != provider_id] + [provider]
    path = Path(settings.provider_config_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".providers-")
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump([p.model_dump() for p in providers], stream, indent=2)
        os.replace(temporary, path)  # mkstemp creates a private 0600 file
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return provider
