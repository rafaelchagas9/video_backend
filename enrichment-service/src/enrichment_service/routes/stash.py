"""Stash bridge operations Kura drives: library sync, fingerprints, contributions."""
from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..config import get_settings
from ..providers import Provider, configured_providers
from ..sources import stash_bridge
from ..sources.stashbox import StashBoxSource
from ..stash_client import StashClient, StashError

router = APIRouter(tags=["stash"])

PATHS = Field(min_length=1, max_length=500)


class PathsRequest(BaseModel):
    paths: list[str] = PATHS


class SceneIdsRequest(BaseModel):
    scene_ids: list[str] = Field(min_length=1, max_length=500)


class StashIdRequest(BaseModel):
    source: str
    stash_id: str = Field(min_length=1, max_length=255)


class FingerprintSubmission(BaseModel):
    source: str
    scene_ids: list[str] = Field(min_length=1, max_length=500)
    confirm: bool = False


class IdentityRequest(BaseModel):
    source: str
    ids: list[str] = Field(min_length=1, max_length=200)


@asynccontextmanager
async def stash() -> AsyncIterator[StashClient]:
    bridge = stash_bridge(get_settings())
    if bridge is None:
        raise HTTPException(409, "Configure the Stash bridge first")
    async with httpx.AsyncClient(timeout=max(get_settings().request_timeout_seconds, 120)) as client:
        try:
            yield StashClient(bridge, client)
        except StashError as exc:
            raise HTTPException(502, str(exc)) from None
        except httpx.HTTPError:
            raise HTTPException(502, "Stash request failed") from None


def stashbox_provider(source: str) -> Provider:
    provider = next((p for p in configured_providers(get_settings()) if p.id == source and p.kind == "stashbox"), None)
    if not provider or not provider.endpoint or not provider.api_key:
        raise HTTPException(409, "Configure the target metadata source first")
    return provider


@router.get("/stash/status")
async def status():
    bridge = stash_bridge(get_settings())
    if bridge is None:
        return {"configured": False, "reachable": False}
    providers = {p.endpoint.rstrip("/"): p.id for p in configured_providers(get_settings()) if p.kind == "stashbox" and p.endpoint}
    try:
        async with stash() as client:
            version = (await client.query("{ version { version } }"))["version"]["version"]
            boxes = await client.stash_boxes()
            libraries = await client.library_paths()
    except HTTPException as exc:
        return {"configured": True, "reachable": False, "error": exc.detail}
    return {
        "configured": True,
        "reachable": True,
        "version": version,
        "stash_boxes": [{"endpoint": b["endpoint"], "name": b["name"],
                         "provider_id": providers.get(b["endpoint"].rstrip("/"))} for b in boxes],
        "library_paths": [s["path"] for s in libraries if not s["excludeVideo"]],
    }


@router.post("/stash/library/ensure")
async def ensure_library(request: PathsRequest):
    async with stash() as client:
        return {"added": await client.ensure_library_paths(request.paths)}


@router.post("/stash/scan")
async def scan(request: PathsRequest):
    async with stash() as client:
        return {"job_id": await client.scan(request.paths)}


@router.post("/stash/phash")
async def phash(request: SceneIdsRequest):
    async with stash() as client:
        return {"job_id": await client.generate_phashes(request.scene_ids)}


@router.post("/stash/clean")
async def clean(request: PathsRequest):
    async with stash() as client:
        return {"job_id": await client.clean(request.paths)}


@router.get("/stash/jobs/{job_id}")
async def job(job_id: str):
    async with stash() as client:
        found = await client.job(job_id)
    # Stash forgets finished jobs after a while; absence means it is no longer running.
    return found or {"id": job_id, "status": "FINISHED", "progress": 1, "forgotten": True}


@router.post("/stash/scenes/lookup")
async def lookup(request: PathsRequest):
    async with stash() as client:
        scenes = await client.scenes_by_paths(request.paths)
    result = {}
    for path, scene in scenes.items():
        if not scene:
            result[path] = None
            continue
        file = next(f for f in scene["files"] if f["path"] == path)
        result[path] = {
            "scene_id": scene["id"],
            "file_id": file["id"],
            "duration": file.get("duration"),
            "fingerprints": {fp["type"].lower(): fp["value"] for fp in file.get("fingerprints") or []},
            "stash_ids": scene.get("stash_ids") or [],
        }
    return result


@router.post("/stash/scenes/{scene_id}/stash-ids")
async def add_stash_id(scene_id: str, request: StashIdRequest):
    provider = stashbox_provider(request.source)
    async with stash() as client:
        await client.add_scene_stash_id(scene_id, provider.endpoint, request.stash_id)
    return {"scene_id": scene_id, "endpoint": provider.endpoint, "stash_id": request.stash_id}


@router.post("/stash/fingerprints/submit")
async def submit_fingerprints(request: FingerprintSubmission):
    if not request.confirm:
        raise HTTPException(400, "Explicit confirmation is required to submit fingerprints")
    provider = stashbox_provider(request.source)
    async with stash() as client:
        endpoint = next((b["endpoint"] for b in await client.stash_boxes()
                         if b["endpoint"].rstrip("/") == provider.endpoint.rstrip("/")), None)
        if endpoint is None:
            raise HTTPException(409, f"{provider.name} is not configured in Stash; save its key in Kura's providers")
        submitted = await client.submit_fingerprints(endpoint, request.scene_ids)
    return {"submitted": submitted, "scene_ids": request.scene_ids, "endpoint": endpoint}


@router.post("/stashbox/performers/identity")
async def performer_identity(request: IdentityRequest):
    """Merged/deleted check for stored performer IDs. Direct: Stash's scraped
    performer type has no `merged_into_id`."""
    provider = stashbox_provider(request.source)
    source = StashBoxSource(name=provider.id, endpoint=provider.endpoint, api_key=provider.api_key,
                            auth_style=provider.auth_style, dialect=provider.dialect, exact_endpoint=provider.exact_endpoint)
    results = []
    async with httpx.AsyncClient(timeout=get_settings().request_timeout_seconds) as client:
        for external_id in dict.fromkeys(request.ids):
            try:
                results.append(await source.performer_identity(client, external_id))
            except (httpx.HTTPError, RuntimeError) as exc:
                results.append({"requested_id": external_id, "error": type(exc).__name__})
    return {"source": provider.id, "results": results}
