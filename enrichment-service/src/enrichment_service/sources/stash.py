"""Stash GraphQL bridge: URL scraping, genuine file fingerprints and explicit drafts."""
from __future__ import annotations
from typing import Any
import httpx
from ..models import Candidate, EnrichRequest, Fingerprint
from ..providers import Provider
from .base import Source
from ..stash_client import StashClient
from .stashbox import StashBoxSource, normalize_scraped_scene, scene_search_term

PERFORMER_FIELDS = """name aliases gender birthdate death_date ethnicity country eye_color hair_color height
career_start career_end details urls images remote_site_id"""
SCENE_FIELDS = """title details date code director urls image remote_site_id
studio { name remote_site_id } tags { name remote_site_id }
performers { name remote_site_id }"""
SCENE_PREVIEW = """id title details date urls performers { id name } files { fingerprints { type value } }"""
CREATOR_PREVIEW = """id name details urls alias_list gender birthdate country"""


class StashSource(Source):
    def __init__(self, provider: Provider):
        self.provider = provider
        self.name = provider.id

    async def query(self, client: httpx.AsyncClient, query: str, variables: dict) -> dict:
        response = await client.post(self.provider.endpoint, headers={"ApiKey": self.provider.api_key},
                                     json={"query": query, "variables": variables})
        response.raise_for_status()
        body = response.json()
        if body.get("errors"):
            raise RuntimeError("Stash rejected the GraphQL operation; check its version and configuration")
        if not isinstance(body.get("data"), dict):
            raise RuntimeError("Stash returned an invalid response")
        return body["data"]

    async def scrapers(self, client: httpx.AsyncClient) -> list[dict]:
        data = await self.query(client, """query { listScrapers(types:[PERFORMER,SCENE]) {
            id name performer { urls supported_scrapes } scene { urls supported_scrapes }
        } }""", {})
        return data["listScrapers"]

    async def search(self, request: EnrichRequest, client: httpx.AsyncClient) -> list[Candidate]:
        if request.scraper_id and not request.scraper_url:
            return await self.search_with_scraper(request, client)
        if not request.scraper_url:
            return []
        creator = request.entity_type == "creator"
        if not creator and request.entity_type != "scene":
            raise ValueError("URL scraping supports creators and scenes")
        root = "scrapePerformerURL" if creator else "scrapeSceneURL"
        fields = PERFORMER_FIELDS if creator else SCENE_FIELDS
        data = await self.query(client, f"query($url:String!) {{ {root}(url:$url) {{ {fields} }} }}",
                                {"url": request.scraper_url})
        entity = data.get(root)
        if not entity:
            return []
        # Scraped remote_site_id is specific to the original site, not a Stash ID.
        # Preserve it as provenance without creating a false source identifier.
        normalized: dict[str, Any] = {**entity, "id": None,
            "urls": [{"url": u, "site": {"name": "website"}} for u in entity.get("urls") or []]}
        mapper = StashBoxSource(name=self.name, endpoint=self.provider.endpoint, api_key="", dialect="stashbox")
        if creator:
            normalized.update({"aliases": [a.strip() for a in (entity.get("aliases") or "").split(",") if a.strip()],
                "images": [{"url": u} for u in entity.get("images") or []],
                "birth_date": entity.get("birthdate"), "career_start_year": entity.get("career_start"),
                "career_end_year": entity.get("career_end")})
            candidates = mapper._map_performer(normalized, 0.85)
            if entity.get("details"):
                candidates.append(Candidate(type="bio", value=entity["details"], source=self.name, confidence=0.85))
        else:
            normalized.update({"release_date": entity.get("date"),
                "images": [{"url": entity["image"]}] if entity.get("image") else [],
                "performers": [{"performer": {"name": p["name"]}} for p in entity.get("performers") or []]})
            candidates = mapper._map_scene(normalized, 0.85)
        for candidate in candidates:
            candidate.source_url = request.scraper_url
            candidate.raw = {**(candidate.raw or {}), "scraped_url": request.scraper_url,
                             "remote_site_id": entity.get("remote_site_id"),
                             "match": (candidate.raw or {}).get("match") or {
                                 "entity_type": request.entity_type, "source": self.name,
                                 "external_id": None, "name": entity.get("name" if creator else "title")}}
        return candidates

    async def search_with_scraper(self, request: EnrichRequest, client: httpx.AsyncClient) -> list[Candidate]:
        """Title search through one installed community scraper (IAFD, ...)."""
        if request.entity_type != "scene":
            raise ValueError("Scraper title search supports scenes")
        term = scene_search_term(request)
        found = await StashClient(self.provider, client).scrape_scene_with_scraper(request.scraper_id or "", term)
        mapper = StashBoxSource(name=self.name, endpoint=self.provider.endpoint, api_key="", dialect="stashbox")
        candidates: list[Candidate] = []
        for scene in found[: request.limit]:
            normalized = normalize_scraped_scene(scene)
            # A scraper's remote_site_id belongs to the scraped site, not to a stash-box.
            normalized["id"] = None
            for candidate in mapper._map_scene(normalized, 0.6 if (scene.get("title") or "").lower() != term.lower() else 0.85):
                candidate.raw = {**(candidate.raw or {}), "scraper_id": request.scraper_id,
                                 "remote_site_id": scene.get("remote_site_id"),
                                 "match": {**((candidate.raw or {}).get("match") or {}),
                                           "external_id": None, "name": scene.get("title"),
                                           "source": self.name, "entity_type": "scene"}}
                candidates.append(candidate)
        return candidates

    async def fingerprints(self, client: httpx.AsyncClient, scene_id: str) -> list[Fingerprint]:
        data = await self.query(client, f"query($id:ID!) {{ findScene(id:$id) {{ {SCENE_PREVIEW} }} }}", {"id": scene_id})
        scene = data.get("findScene")
        if not scene:
            raise ValueError("Stash scene was not found")
        result = []
        for file in scene.get("files") or []:
            for fp in file.get("fingerprints") or []:
                algorithm = fp["type"].upper()
                if algorithm in {"OSHASH", "PHASH"}:
                    result.append(Fingerprint(algorithm=algorithm, hash=fp["value"]))
        if not result:
            raise ValueError("Generate oshash or pHash in Stash before requesting identification")
        return result

    async def prepare(self, client: httpx.AsyncClient, entity_type: str, stash_id: str, source: str) -> dict:
        creator = entity_type == "creator"
        root = "findPerformer" if creator else "findScene"
        fields = CREATOR_PREVIEW if creator else SCENE_PREVIEW
        data = await self.query(client, f"query($id:ID!) {{ {root}(id:$id) {{ {fields} }} }}", {"id": stash_id})
        entity = data.get(root)
        if not entity:
            raise ValueError("Stash entity was not found")
        issues = []
        if not entity.get("name" if creator else "title"):
            issues.append("Missing name" if creator else "Missing title")
        if not entity.get("urls"):
            issues.append("Add the original publication or creator profile URL in Stash")
        if not creator and not any(fp["type"].upper() == "PHASH" for file in entity.get("files") or [] for fp in file.get("fingerprints") or []):
            issues.append("Generate a pHash in Stash before contributing this scene")
        return {"entity": entity, "source": source, "ready": not issues, "issues": issues}

    async def submit(self, client: httpx.AsyncClient, entity_type: str, stash_id: str, endpoint: str) -> str:
        root = "submitStashBoxPerformerDraft" if entity_type == "creator" else "submitStashBoxSceneDraft"
        data = await self.query(client, f"mutation($input:StashBoxDraftSubmissionInput!) {{ {root}(input:$input) }}",
                                {"input": {"id": stash_id, "stash_box_endpoint": endpoint}})
        draft_id = data.get(root)
        if not draft_id:
            raise ValueError("Stash did not return a draft ID; check the target credentials configured in Stash")
        return str(draft_id)
