"""Provider management and explicit Stash contribution endpoints."""
from typing import Literal
import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ..config import get_settings
from ..providers import configured_providers, save_provider, ProviderPatch
from ..sources.stash import StashSource
from ..stash_client import StashClient, StashError

router = APIRouter(tags=["providers"])

@router.get("/providers")
async def providers():
    configured = configured_providers(get_settings())
    return {"providers": [p.public() for p in configured],
            "bridge": {"configured": any(p.kind == "stash" and p.endpoint for p in configured)}}

@router.patch("/providers/{provider_id}")
async def update_provider(provider_id: str, patch: ProviderPatch):
    try:
        provider = save_provider(get_settings(), provider_id, patch)
    except ValueError:
        raise HTTPException(400, "Invalid provider configuration") from None
    result = provider.public()
    # Stash runs stash-box discovery, so it holds the same endpoint and key.
    if provider.kind == "stashbox" and provider.endpoint and provider.api_key and (patch.api_key or patch.endpoint):
        result["stash_synced"] = await sync_to_stash(provider)
    return result


async def sync_to_stash(provider) -> bool:
    bridge = next((p for p in configured_providers(get_settings()) if p.kind == "stash" and p.endpoint), None)
    if bridge is None:
        return False
    async with httpx.AsyncClient(timeout=get_settings().request_timeout_seconds) as client:
        try:
            await StashClient(bridge, client).upsert_stash_box(provider.endpoint, provider.name, provider.api_key)
            return True
        except (StashError, httpx.HTTPError):
            return False


def bridge():
    provider = next((p for p in configured_providers(get_settings()) if p.kind == "stash" and p.endpoint), None)
    if not provider:
        raise HTTPException(409, "Configure the Stash bridge first")
    return StashSource(provider)

@router.get("/stash/scrapers")
async def scrapers():
    async with httpx.AsyncClient(timeout=get_settings().request_timeout_seconds) as client:
        try:
            return await bridge().scrapers(client)
        except (httpx.HTTPError, RuntimeError):
            raise HTTPException(502, "Unable to query Stash scrapers") from None

class ContributionRequest(BaseModel):
    entity_type: Literal["creator", "scene"] = "creator"
    stash_id: str
    source: str
    confirm: bool = False


def target(source: str):
    provider = next((p for p in configured_providers(get_settings()) if p.id == source and p.kind == "stashbox"), None)
    if not provider or not provider.endpoint or not provider.api_key:
        raise HTTPException(409, "Configure the target metadata source first")
    return provider

@router.post("/stash/contributions/prepare")
async def prepare(request: ContributionRequest):
    target(request.source)
    async with httpx.AsyncClient(timeout=get_settings().request_timeout_seconds) as client:
        try:
            return await bridge().prepare(client, request.entity_type, request.stash_id, request.source)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from None
        except (httpx.HTTPError, RuntimeError):
            raise HTTPException(502, "Unable to prepare the Stash contribution") from None

@router.post("/stash/contributions/submit")
async def submit(request: ContributionRequest):
    if not request.confirm:
        raise HTTPException(400, "Explicit confirmation is required to submit a draft")
    provider = target(request.source)
    async with httpx.AsyncClient(timeout=get_settings().request_timeout_seconds) as client:
        try:
            preview = await bridge().prepare(client, request.entity_type, request.stash_id, request.source)
            if not preview["ready"]:
                raise HTTPException(409, "; ".join(preview["issues"]))
            draft = await bridge().submit(client, request.entity_type, request.stash_id, provider.endpoint)
            return {"draft_id": draft}
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from None
        except (httpx.HTTPError, RuntimeError):
            raise HTTPException(502, "Unable to submit the Stash draft") from None
