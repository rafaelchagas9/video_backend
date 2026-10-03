"""Typed access to the local Stash GraphQL API.

Kura delegates fingerprinting, stash-box discovery and contributions to Stash.
Every call here is one Stash operation; mapping into Kura candidates lives in
the sources, and policy lives in the Bun backend.
"""
from __future__ import annotations

from typing import Any

import httpx

from .providers import Provider

STASH_FILE_FIELDS = "id path duration fingerprints { type value }"
STASH_SCENE_FIELDS = f"id files {{ {STASH_FILE_FIELDS} }} stash_ids {{ endpoint stash_id }}"

SCRAPED_TAG_FIELDS = "name remote_site_id description alias_list parent { name remote_site_id }"
SCRAPED_STUDIO_FIELDS = (
    "name remote_site_id urls image details aliases "
    "parent { name remote_site_id urls image parent { name remote_site_id } }"
)
SCRAPED_PERFORMER_FIELDS = (
    "name disambiguation gender aliases remote_site_id urls images birthdate death_date "
    "country ethnicity eye_color hair_color height measurements fake_tits career_start career_end details"
)
SCRAPED_SCENE_FIELDS = (
    "title code details director urls date image duration remote_site_id "
    "fingerprints { algorithm hash duration } "
    f"studio {{ {SCRAPED_STUDIO_FIELDS} }} tags {{ {SCRAPED_TAG_FIELDS} }} "
    f"performers {{ {SCRAPED_PERFORMER_FIELDS} }}"
)

# Scans only fingerprint. Kura renders its own previews, sprites and covers.
FINGERPRINT_ONLY_SCAN = {
    "scanGenerateCovers": False,
    "scanGeneratePreviews": False,
    "scanGenerateImagePreviews": False,
    "scanGenerateSprites": False,
    "scanGeneratePhashes": True,
    "scanGenerateImagePhashes": False,
    "scanGenerateThumbnails": False,
    "scanGenerateClipPreviews": False,
}


class StashError(RuntimeError):
    """Stash rejected or failed an operation; the message is safe to show."""


class StashClient:
    def __init__(self, provider: Provider, client: httpx.AsyncClient):
        self.provider = provider
        self.client = client

    async def query(self, query: str, variables: dict | None = None) -> dict:
        try:
            response = await self.client.post(
                self.provider.endpoint,
                headers={"ApiKey": self.provider.api_key},
                json={"query": query, "variables": variables or {}},
            )
        except httpx.HTTPError as exc:
            raise StashError("Stash is unavailable; check the kura-stash container") from exc
        if response.status_code in (401, 403):
            raise StashError("Stash refused the API key; update the Stash provider key")
        response.raise_for_status()
        body = response.json()
        if body.get("errors"):
            message = "; ".join(str(e.get("message", "")) for e in body["errors"])[:500]
            raise StashError(f"Stash rejected the operation: {message}")
        if not isinstance(body.get("data"), dict):
            raise StashError("Stash returned an invalid response")
        return body["data"]

    # --- Configuration --------------------------------------------------------

    async def stash_boxes(self) -> list[dict[str, Any]]:
        data = await self.query("{ configuration { general { stashBoxes { endpoint name api_key max_requests_per_minute } } } }")
        return data["configuration"]["general"]["stashBoxes"] or []

    async def upsert_stash_box(self, endpoint: str, name: str, api_key: str) -> None:
        """Add or update one stash-box in Stash, preserving every other entry."""
        boxes = await self.stash_boxes()
        kept = [b for b in boxes if b["endpoint"].rstrip("/") != endpoint.rstrip("/")]
        current = next((b for b in boxes if b["endpoint"].rstrip("/") == endpoint.rstrip("/")), None)
        entry = {"endpoint": endpoint, "name": name, "api_key": api_key,
                 "max_requests_per_minute": (current or {}).get("max_requests_per_minute") or 0}
        await self.query("mutation($boxes:[StashBoxInput!]) { configureGeneral(input:{stashBoxes:$boxes}) { stashBoxes { endpoint } } }",
                         {"boxes": kept + [entry]})

    async def library_paths(self) -> list[dict[str, Any]]:
        data = await self.query("{ configuration { general { stashes { path excludeVideo excludeImage } } } }")
        return data["configuration"]["general"]["stashes"] or []

    async def ensure_library_paths(self, paths: list[str]) -> list[str]:
        """Register missing roots as video-only libraries; returns the added paths."""
        stashes = await self.library_paths()
        known = {s["path"].rstrip("/") for s in stashes}
        added = [p.rstrip("/") for p in paths if p.rstrip("/") not in known]
        if added:
            await self.query("mutation($stashes:[StashConfigInput!]) { configureGeneral(input:{stashes:$stashes}) { stashes { path } } }",
                             {"stashes": stashes + [{"path": p, "excludeVideo": False, "excludeImage": True} for p in added]})
        return added

    # --- Jobs -----------------------------------------------------------------

    async def scan(self, paths: list[str]) -> str:
        data = await self.query("mutation($input:ScanMetadataInput!) { metadataScan(input:$input) }",
                                {"input": {"paths": paths, **FINGERPRINT_ONLY_SCAN}})
        return str(data["metadataScan"])

    async def generate_phashes(self, scene_ids: list[str]) -> str:
        data = await self.query("mutation($input:GenerateMetadataInput!) { metadataGenerate(input:$input) }",
                                {"input": {"phashes": True, "sceneIDs": scene_ids, "overwrite": False}})
        return str(data["metadataGenerate"])

    async def clean(self, paths: list[str]) -> str:
        data = await self.query("mutation($input:CleanMetadataInput!) { metadataClean(input:$input) }",
                                {"input": {"paths": paths, "dryRun": False}})
        return str(data["metadataClean"])

    async def job(self, job_id: str) -> dict[str, Any] | None:
        data = await self.query("query($id:ID!) { findJob(input:{id:$id}) { id status progress description error } }",
                                {"id": job_id})
        return data.get("findJob")

    # --- Library lookups ------------------------------------------------------

    async def scenes_by_paths(self, paths: list[str]) -> dict[str, dict[str, Any] | None]:
        """Exact path → Stash scene (with files, fingerprints and stash IDs)."""
        result: dict[str, dict[str, Any] | None] = {}
        for start in range(0, len(paths), 50):
            chunk = paths[start:start + 50]
            fields = " ".join(
                f"p{i}: findScenes(scene_filter:{{path:{{value:$p{i}, modifier:EQUALS}}}}, filter:{{per_page:2}}) {{ scenes {{ {STASH_SCENE_FIELDS} }} }}"
                for i in range(len(chunk)))
            params = ", ".join(f"$p{i}:String!" for i in range(len(chunk)))
            data = await self.query(f"query({params}) {{ {fields} }}", {f"p{i}": p for i, p in enumerate(chunk)})
            for i, path in enumerate(chunk):
                scenes = data[f"p{i}"]["scenes"] or []
                # EQUALS matches the folder path as a prefix in some versions; keep the exact file.
                exact = [s for s in scenes if any(f["path"] == path for f in s["files"] or [])]
                result[path] = exact[0] if exact else None
        return result

    async def scene(self, scene_id: str) -> dict[str, Any] | None:
        data = await self.query(f"query($id:ID!) {{ findScene(id:$id) {{ {STASH_SCENE_FIELDS} }} }}", {"id": scene_id})
        return data.get("findScene")

    async def add_scene_stash_id(self, scene_id: str, endpoint: str, stash_id: str) -> None:
        scene = await self.scene(scene_id)
        if not scene:
            raise StashError("Stash scene was not found")
        ids = [{"endpoint": s["endpoint"], "stash_id": s["stash_id"]} for s in scene.get("stash_ids") or []
               if s["endpoint"].rstrip("/") != endpoint.rstrip("/")]
        await self.query("mutation($input:SceneUpdateInput!) { sceneUpdate(input:$input) { id } }",
                         {"input": {"id": scene_id, "stash_ids": ids + [{"endpoint": endpoint, "stash_id": stash_id}]}})

    # --- Stash-box discovery through Stash -----------------------------------

    async def scrape_scenes_by_fingerprints(self, endpoint: str, scene_ids: list[str]) -> list[list[dict[str, Any]]]:
        """Every fingerprint of each scene's files, sent in Stash's batches of 40."""
        data = await self.query(
            f"query($endpoint:String!, $ids:[ID!]!) {{ scrapeMultiScenes(source:{{stash_box_endpoint:$endpoint}}, input:{{scene_ids:$ids}}) {{ {SCRAPED_SCENE_FIELDS} }} }}",
            {"endpoint": endpoint, "ids": scene_ids})
        return data["scrapeMultiScenes"] or []

    async def scrape_scene_query(self, endpoint: str, query: str) -> list[dict[str, Any]]:
        data = await self.query(
            f"query($endpoint:String!, $q:String!) {{ scrapeSingleScene(source:{{stash_box_endpoint:$endpoint}}, input:{{query:$q}}) {{ {SCRAPED_SCENE_FIELDS} }} }}",
            {"endpoint": endpoint, "q": query})
        return data["scrapeSingleScene"] or []

    async def scrape_performer_query(self, endpoint: str, query: str) -> list[dict[str, Any]]:
        data = await self.query(
            f"query($endpoint:String!, $q:String!) {{ scrapeSinglePerformer(source:{{stash_box_endpoint:$endpoint}}, input:{{query:$q}}) {{ {SCRAPED_PERFORMER_FIELDS} }} }}",
            {"endpoint": endpoint, "q": query})
        return data["scrapeSinglePerformer"] or []

    async def scrape_studio_query(self, endpoint: str, query: str) -> list[dict[str, Any]]:
        data = await self.query(
            f"query($endpoint:String!, $q:String!) {{ scrapeSingleStudio(source:{{stash_box_endpoint:$endpoint}}, input:{{query:$q}}) {{ {SCRAPED_STUDIO_FIELDS} }} }}",
            {"endpoint": endpoint, "q": query})
        return data["scrapeSingleStudio"] or []

    async def scrape_tag_query(self, endpoint: str, query: str) -> list[dict[str, Any]]:
        data = await self.query(
            f"query($endpoint:String!, $q:String!) {{ scrapeSingleTag(source:{{stash_box_endpoint:$endpoint}}, input:{{query:$q}}) {{ {SCRAPED_TAG_FIELDS} }} }}",
            {"endpoint": endpoint, "q": query})
        return data["scrapeSingleTag"] or []

    async def scrape_scene_with_scraper(self, scraper_id: str, query: str) -> list[dict[str, Any]]:
        data = await self.query(
            f"query($id:ID!, $q:String!) {{ scrapeSingleScene(source:{{scraper_id:$id}}, input:{{query:$q}}) {{ {SCRAPED_SCENE_FIELDS} }} }}",
            {"id": scraper_id, "q": query})
        return data["scrapeSingleScene"] or []

    # --- Contributions --------------------------------------------------------

    async def submit_fingerprints(self, endpoint: str, scene_ids: list[str]) -> bool:
        data = await self.query(
            "mutation($input:StashBoxFingerprintSubmissionInput!) { submitStashBoxFingerprints(input:$input) }",
            {"input": {"scene_ids": scene_ids, "stash_box_endpoint": endpoint}})
        return bool(data["submitStashBoxFingerprints"])
