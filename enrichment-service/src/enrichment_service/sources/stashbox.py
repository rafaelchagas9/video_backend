"""Stash-box sources: StashDB, FansDB, ThePornDB and custom instances.

Discovery goes through the local Stash, the reference stash-box client: Stash
sends every fingerprint of a file, knows each server's search queries, and
follows their schema changes when its image is upgraded. Kura talks to a
stash-box directly only where Stash's API cannot:

- exact lookups of a pasted ID or URL (`findPerformer(id)` / ThePornDB REST);
- fingerprints of files Stash never saw (an original replaced by a conversion);
- the merged-performer check (Stash's scraped types omit `merged_into_id`).
"""

from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import quote, urlsplit

import httpx

from ..matching import LocalFingerprints, confidence as evidence_confidence, rank_scenes
from ..models import Candidate, EnrichRequest
from ..providers import Provider
from ..stash_client import StashClient, StashError
from .base import Source

logger = logging.getLogger(__name__)


def scene_search_term(request: EnrichRequest) -> str:
    """Keep explicit titles intact; strip download/encoding noise from filenames."""
    if request.title and request.title.strip():
        return request.title.strip()
    if not request.file_name or request.name != request.file_name:
        return request.name.strip() or (request.file_name or "").strip()
    term = request.file_name
    term = re.sub(r"\.(?:mp4|mkv|avi|mov|wmv|webm|m4v|ts)$", "", term, flags=re.I)
    term = re.sub(r"^\(?\d{4}[.\-_]\d{2}[.\-_]\d{2}\)?[+._\s-]*", "", term)
    term = re.sub(r"\[(?:\d{3,4}p|[248]k|uhd|hd|sd)\]", " ", term, flags=re.I)
    term = re.sub(r"[+._\s-]+\d{10,16}$", "", term)
    term = re.sub(r"(?:[+._\s-]+(?:\d{3,4}p|[248]k|av1|h[ .]?26[45]|x26[45]|hevc))+$", "", term, flags=re.I)
    term = re.sub(r"[+_]+", " ", term)
    return re.sub(r"\s+", " ", term).strip() or request.file_name

# Scalar Performer fields → our `creators` column names.
FIELD_MAP: dict[str, str] = {
    "gender": "gender",
    "birth_date": "birth_date",
    "death_date": "death_date",
    "ethnicity": "ethnicity",
    "country": "country",
    "birthplace": "birthplace",
    "eye_color": "eye_color",
    "hair_color": "hair_color",
    "height": "height_cm",
    "cup_size": "cup_size",
    "band_size": "band_size",
    "waist_size": "waist_size",
    "hip_size": "hip_size",
    "breast_type": "breast_type",
    "career_start_year": "career_start_year",
    "career_end_year": "career_end_year",
}

# Exact-ID selections. `findX(id)` is the same on every stash-box server.
PERFORMER_FIELDS = """
  id
  name
  disambiguation
  aliases
  gender
  birth_date
  death_date
  ethnicity
  country
  eye_color
  hair_color
  height
  cup_size
  band_size
  waist_size
  hip_size
  breast_type
  career_start_year
  career_end_year
  urls { url site { name } }
  images { id url }
"""

STUDIO_FIELDS = """
  id
  name
  aliases
  urls { url site { name } }
  parent { id name }
  images { id url }
"""

SCENE_FIELDS = """
  id
  title
  details
  director
  release_date
  code
  duration
  urls { url }
  fingerprints { algorithm hash duration }
  studio { id name parent { id name } }
  tags { id name }
  images { id url }
  performers { as performer { id name gender disambiguation } }
"""

TAG_FIELDS = """
  id
  name
  description
  aliases
  category { id name group }
"""

ID_QUERIES: dict[str, str] = {
    "performer": f"query($id:ID!){{ findPerformer(id:$id){{ {PERFORMER_FIELDS} }} }}",
    "studio": f"query($id:ID!){{ findStudio(id:$id){{ {STUDIO_FIELDS} }} }}",
    "scene": f"query($id:ID!){{ findScene(id:$id){{ {SCENE_FIELDS} }} }}",
    "tag": f"query($id:ID!){{ findTag(id:$id){{ {TAG_FIELDS} }} }}",
}

# Current upstream stash-box (FansDB, custom servers) has no Performer.death_date.
STANDARD_PERFORMER_FIELDS = PERFORMER_FIELDS.replace("  death_date\n", "")

IDENTITY_QUERY = "query($id:ID!){ findPerformer(id:$id){ id name deleted merged_into_id merged_ids } }"

TPDB_REST_PATHS: dict[str, str] = {
    "performer": "performers",
    "studio": "sites",
    "scene": "scenes",
    "tag": "tags",
}

MEASUREMENTS = re.compile(r"^\s*(\d{2,3})?\s*([A-Za-z]{1,4})?\s*-\s*(\d{2,3})?\s*-\s*(\d{2,3})?\s*$")

def _name_confidence(candidate_name: str | None, term: str) -> float:
    """High confidence on an exact (case-insensitive) name match, else moderate."""
    if (candidate_name or "").strip().lower() == term.strip().lower():
        return 0.95
    return 0.6


def _as_list(value: Any) -> list[dict[str, Any]]:
    """Normalize a query result (single object | list | wrapper) into a list."""
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        # Result-wrapper types: {count, performers|scenes|studios|tags}.
        # Only a pure wrapper unwraps: a Scene object also has a `performers` list.
        for key in ("performers", "scenes", "studios", "tags"):
            if isinstance(value.get(key), list) and set(value) <= {key, "count"}:
                return value[key]
        return [value]  # single object (findStudio / findTag)
    return []


def _with_match(
    raw: dict[str, Any] | None,
    *,
    entity_type: str,
    source: str,
    external_id: Any,
    name: Any,
) -> dict[str, Any]:
    """Attach upstream match metadata so clients can review one result at a time."""
    base = raw.copy() if isinstance(raw, dict) else {}
    base["match"] = {
        "entity_type": entity_type,
        "source": source,
        "external_id": str(external_id) if external_id else None,
        "name": str(name) if name else None,
    }
    return base


def _unique_images(*values: Any) -> list[dict[str, Any]]:
    """Normalize REST image fields to the GraphQL-style `{id, url}` list."""
    images: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(value: Any) -> None:
        if isinstance(value, str):
            item = {"url": value}
        elif isinstance(value, dict) and isinstance(value.get("url"), str):
            item = value
        else:
            return
        url = item["url"]
        if not url or url in seen:
            return
        seen.add(url)
        images.append({"id": item.get("id"), "url": url})

    for value in values:
        if isinstance(value, list):
            for item in value:
                add(item)
        elif isinstance(value, dict) and "url" not in value:
            for item in value.values():
                add(item)
        else:
            add(value)
    return images


def _tpdb_rest_identifier(value: dict[str, Any]) -> Any:
    """Prefer the stable UUID; fall back to the numeric TPDB database id."""
    return value.get("uuid") or value.get("id") or value.get("_id")


def _normalize_tpdb_rest_performer(performer: dict[str, Any]) -> dict[str, Any]:
    """Convert a ThePornDB REST performer to the shared mapper shape."""
    canonical = performer.get("parent") or performer
    extras = canonical.get("extras") or canonical.get("extra") or {}
    links = extras.get("links") or {}
    urls = [
        {"url": url, "site": {"name": label}}
        for label, url in links.items()
        if isinstance(url, str) and url
    ]
    return {
        "id": _tpdb_rest_identifier(canonical),
        "name": canonical.get("name"),
        "disambiguation": canonical.get("disambiguation"),
        "aliases": canonical.get("aliases") or [],
        "gender": extras.get("gender"),
        "birth_date": extras.get("birthday"),
        "death_date": extras.get("deathday"),
        "ethnicity": extras.get("ethnicity"),
        "country": extras.get("nationality"),
        "birthplace": extras.get("birthplace"),
        "eye_color": extras.get("eye_colour") or extras.get("eye_color"),
        "hair_color": extras.get("hair_colour") or extras.get("haircolor"),
        "height": extras.get("height"),
        "cup_size": extras.get("cupsize"),
        "waist_size": extras.get("waist"),
        "hip_size": extras.get("hips"),
        "career_start_year": extras.get("career_start_year"),
        "career_end_year": extras.get("career_end_year"),
        "urls": urls,
        "images": _unique_images(
            canonical.get("posters"),
            canonical.get("image"),
            canonical.get("thumbnail"),
            canonical.get("face"),
        ),
    }


def _normalize_tpdb_rest_scene(scene: dict[str, Any]) -> dict[str, Any]:
    """Convert a ThePornDB REST scene to the shared mapper shape."""
    site = scene.get("site") or {}
    directors = scene.get("directors") or []
    performers = []
    for appearance in scene.get("performers") or []:
        canonical = appearance.get("parent") or appearance
        if not canonical.get("name"):
            continue
        performers.append(
            {
                "as": (
                    appearance.get("name")
                    if appearance.get("name") != canonical.get("name")
                    else None
                ),
                "performer": {
                    "id": _tpdb_rest_identifier(canonical),
                    "name": canonical.get("name"),
                },
            }
        )

    tags = [
        {"id": _tpdb_rest_identifier(tag), "name": tag.get("name")}
        for tag in scene.get("tags") or []
        if tag.get("name")
    ]
    return {
        "id": _tpdb_rest_identifier(scene),
        "title": scene.get("title"),
        "details": scene.get("description"),
        "director": ", ".join(
            str(director.get("name"))
            for director in directors
            if director.get("name")
        ),
        "release_date": scene.get("date"),
        "code": scene.get("sku"),
        "studio": (
            {"id": _tpdb_rest_identifier(site), "name": site.get("name")}
            if site.get("name")
            else None
        ),
        "performers": performers,
        "tags": tags,
        "images": _unique_images(
            scene.get("media"),
            scene.get("posters"),
            scene.get("background"),
            scene.get("poster"),
            scene.get("image"),
        ),
    }


def _normalize_tpdb_rest_studio(site: dict[str, Any]) -> dict[str, Any]:
    """Convert a ThePornDB REST site to the shared studio mapper shape."""
    parent = site.get("parent") or site.get("network")
    return {
        "id": _tpdb_rest_identifier(site),
        "name": site.get("name"),
        "aliases": [site["short_name"]] if site.get("short_name") else [],
        "urls": (
            [{"url": site["url"], "site": {"name": "website"}}]
            if site.get("url")
            else []
        ),
        "images": _unique_images(site.get("logo"), site.get("poster")),
        "parent": (
            {"id": _tpdb_rest_identifier(parent), "name": parent.get("name")}
            if isinstance(parent, dict) and parent.get("name")
            else None
        ),
    }


def _normalize_tpdb_rest_tag(tag: dict[str, Any]) -> dict[str, Any]:
    """Convert a ThePornDB REST tag to the shared tag mapper shape."""
    return {
        "id": _tpdb_rest_identifier(tag),
        "name": tag.get("name"),
        "description": tag.get("description"),
        "aliases": tag.get("aliases") or [],
    }


TPDB_REST_NORMALIZERS = {
    "performer": _normalize_tpdb_rest_performer,
    "studio": _normalize_tpdb_rest_studio,
    "scene": _normalize_tpdb_rest_scene,
    "tag": _normalize_tpdb_rest_tag,
}




def _site_name(url: str) -> str:
    """Label for a bare URL from Stash (stash-box site names are not exposed)."""
    host = (urlsplit(url).hostname or "").lower().removeprefix("www.")
    return host.split(".")[0] if host else "website"


def _split_aliases(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    return [a.strip() for a in str(value or "").split(",") if a.strip()]


def _year(value: Any) -> int | None:
    match = re.search(r"\d{4}", str(value or ""))
    return int(match.group()) if match else None


def normalize_scraped_performer(performer: dict[str, Any]) -> dict[str, Any]:
    """Stash `ScrapedPerformer` → the stash-box Performer shape the mappers use."""
    band = cup = waist = hip = None
    match = MEASUREMENTS.match(performer.get("measurements") or "")
    if match:
        band, cup, waist, hip = match.groups()
    breast = (performer.get("fake_tits") or "").strip().upper() or None
    return {
        "id": performer.get("remote_site_id"),
        "name": performer.get("name"),
        "disambiguation": performer.get("disambiguation"),
        "aliases": _split_aliases(performer.get("aliases")),
        "gender": performer.get("gender"),
        "birth_date": performer.get("birthdate"),
        "death_date": performer.get("death_date"),
        "ethnicity": performer.get("ethnicity"),
        "country": performer.get("country"),
        "eye_color": performer.get("eye_color"),
        "hair_color": performer.get("hair_color"),
        "height": performer.get("height"),
        "cup_size": cup,
        "band_size": band,
        "waist_size": waist,
        "hip_size": hip,
        "breast_type": {"FAKE": "AUGMENTED"}.get(breast, breast),
        "career_start_year": _year(performer.get("career_start")),
        "career_end_year": _year(performer.get("career_end")),
        "urls": [{"url": u, "site": {"name": _site_name(u)}} for u in performer.get("urls") or []],
        "images": [{"url": u} for u in performer.get("images") or []],
    }


def normalize_scraped_studio(studio: dict[str, Any] | None) -> dict[str, Any] | None:
    if not studio or not studio.get("name"):
        return None
    parent = normalize_scraped_studio(studio.get("parent"))
    return {
        "id": studio.get("remote_site_id"),
        "name": studio["name"],
        "aliases": _split_aliases(studio.get("aliases")),
        "urls": [{"url": u, "site": {"name": _site_name(u)}} for u in studio.get("urls") or []],
        "images": [{"url": studio["image"]}] if studio.get("image") else [],
        "parent": parent,
    }


def normalize_scraped_tag(tag: dict[str, Any]) -> dict[str, Any]:
    # Stash reports a stash-box tag's category as its parent.
    parent = tag.get("parent") or None
    return {
        "id": tag.get("remote_site_id"),
        "name": tag.get("name"),
        "description": tag.get("description"),
        "aliases": tag.get("alias_list") or [],
        "category": {"id": parent.get("remote_site_id"), "name": parent["name"], "group": None}
        if parent and parent.get("name") else None,
    }


def normalize_scraped_scene(scene: dict[str, Any]) -> dict[str, Any]:
    """Stash `ScrapedScene` → the stash-box Scene shape the mappers use."""
    return {
        "id": scene.get("remote_site_id"),
        "title": scene.get("title"),
        "details": scene.get("details"),
        "director": scene.get("director"),
        "release_date": scene.get("date"),
        "code": scene.get("code"),
        "duration": scene.get("duration"),
        "urls": [{"url": u} for u in scene.get("urls") or []],
        "fingerprints": scene.get("fingerprints") or [],
        "studio": normalize_scraped_studio(scene.get("studio")),
        "tags": [{"id": t.get("remote_site_id"), "name": t.get("name")} for t in scene.get("tags") or []],
        "images": [{"url": scene["image"]}] if scene.get("image") else [],
        "performers": [
            {"as": None, "performer": {
                "id": p.get("remote_site_id"), "name": p.get("name"), "gender": p.get("gender"),
                "disambiguation": p.get("disambiguation"), "aliases": _split_aliases(p.get("aliases")),
            }}
            for p in scene.get("performers") or [] if p.get("name")
        ],
        **({"evidence": scene["evidence"]} if "evidence" in scene else {}),
    }


def _studio_chain(studio: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Parents of a studio, nearest first, as `{name, external_id}`."""
    chain = []
    parent = (studio or {}).get("parent")
    while parent and parent.get("name") and len(chain) < 5:
        chain.append({"name": parent["name"], "external_id": parent.get("id")})
        parent = parent.get("parent")
    return chain


async def local_fingerprints(request: EnrichRequest, stash: StashClient | None) -> LocalFingerprints:
    """The local file's hashes and durations: Kura's, plus its Stash scene's."""
    local = LocalFingerprints()
    if request.duration_seconds:
        local.durations.append(float(request.duration_seconds))
    for fp in [request.fingerprint, *request.fingerprints]:
        if fp is None:
            continue
        if fp.algorithm == "PHASH":
            local.phashes.append(fp.hash.lower())
        else:
            local.checksums.add(fp.hash.lower())
        if fp.duration:
            local.durations.append(float(fp.duration))
    if stash is not None and request.stash_scene_id:
        scene = await stash.scene(request.stash_scene_id)
        for file in (scene or {}).get("files") or []:
            if file.get("duration"):
                local.durations.append(float(file["duration"]))
            for fp in file.get("fingerprints") or []:
                kind = (fp.get("type") or "").lower()
                if kind == "phash":
                    local.phashes.append(fp["value"].lower())
                elif kind in {"oshash", "md5"}:
                    local.checksums.add(fp["value"].lower())
    return local



class StashBoxSource(Source):
    def __init__(
        self,
        *,
        name: str,
        endpoint: str,
        api_key: str,
        auth_style: str = "bearer",  # "bearer" (TPDB) | "apikey" (stash-box)
        dialect: str = "tpdb",  # "tpdb" | "stashbox" | "standard"; exact lookups only
        exact_endpoint: str | None = None,
        bridge: Provider | None = None,
    ) -> None:
        self.name = name
        self.endpoint = endpoint
        self.api_key = api_key
        self.auth_style = auth_style
        self.dialect = dialect if dialect in {"tpdb", "stashbox", "standard"} else "tpdb"
        self.exact_endpoint = exact_endpoint.rstrip("/") if exact_endpoint else None
        self.bridge = bridge

    def _headers(self) -> dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "enrichment-service/0.2",
        }
        if self.auth_style == "apikey":
            headers["ApiKey"] = self.api_key
        else:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _stash(self, client: httpx.AsyncClient) -> StashClient:
        if self.bridge is None or not self.bridge.endpoint:
            raise StashError(f"{self.name}: configure the local Stash bridge; searches run through Stash")
        return StashClient(self.bridge, client)

    async def _graphql(self, client: httpx.AsyncClient, query: str, variables: dict) -> dict:
        resp = await client.post(self.endpoint, headers=self._headers(), json={"query": query, "variables": variables})
        resp.raise_for_status()
        body = resp.json()
        if body.get("errors"):
            raise RuntimeError(f"{self.name} GraphQL errors: {body['errors']}")
        return body.get("data") or {}

    async def _query_by_id(
        self, client: httpx.AsyncClient, entity: str, external_id: str
    ) -> list[dict[str, Any]]:
        """Fetch one exact upstream object by its source-specific identifier."""
        if self.dialect == "tpdb" and self.exact_endpoint:
            identifier = quote(external_id, safe="")
            resp = await client.get(
                f"{self.exact_endpoint}/{TPDB_REST_PATHS[entity]}/{identifier}",
                headers=self._headers(),
            )
            if resp.status_code == 404:
                return []
            resp.raise_for_status()
            body = resp.json()
            value = body.get("data") if isinstance(body, dict) else None
            if not isinstance(value, dict):
                return []
            return [TPDB_REST_NORMALIZERS[entity](value)]

        query = ID_QUERIES[entity]
        if self.dialect == "standard":
            query = query.replace(PERFORMER_FIELDS, STANDARD_PERFORMER_FIELDS)
        data = await self._graphql(client, query, {"id": external_id})
        root_value = next(iter(data.values()), None) if data else None
        return _as_list(root_value)

    def _external_id_for_request(self, request: EnrichRequest) -> str | None:
        for entry in request.external_ids:
            if entry.get("source") == self.name and entry.get("external_id"):
                return str(entry["external_id"])
        return None

    async def _stash_endpoint(self, stash: StashClient) -> str:
        """This provider's endpoint as Stash knows it; Stash must hold its key."""
        for box in await stash.stash_boxes():
            if box["endpoint"].rstrip("/") == self.endpoint.rstrip("/"):
                return box["endpoint"]
        raise StashError(f"{self.name}: add this source to Stash's stash-box list (save its key in Kura's providers)")

    async def search(
        self, request: EnrichRequest, client: httpx.AsyncClient
    ) -> list[Candidate]:
        if request.entity_type == "studio":
            return await self._search_studio(request, client)
        if request.entity_type == "scene":
            return await self._search_scene(request, client)
        if request.entity_type == "tag":
            return await self._search_tag(request, client)
        return await self._search_performer(request, client)

    # --- Merged / deleted performers -----------------------------------------

    async def performer_identity(self, client: httpx.AsyncClient, external_id: str) -> dict[str, Any]:
        """Where a stored performer ID points now. Stash-box keeps merged IDs as
        redirects, so the returned `id` may differ from the requested one."""
        if self.dialect == "tpdb":
            return {"requested_id": external_id, "supported": False}
        data = await self._graphql(client, IDENTITY_QUERY, {"id": external_id})
        performer = data.get("findPerformer")
        if not performer:
            return {"requested_id": external_id, "supported": True, "found": False}
        current = performer.get("merged_into_id") or performer["id"]
        return {
            "requested_id": external_id,
            "supported": True,
            "found": True,
            "id": current,
            "name": performer.get("name"),
            "deleted": bool(performer.get("deleted")) and not performer.get("merged_into_id"),
            "merged": current != external_id,
            "merged_ids": performer.get("merged_ids") or [],
        }

    # --- Performer (creator) ------------------------------------------------

    async def _search_performer(
        self, request: EnrichRequest, client: httpx.AsyncClient
    ) -> list[Candidate]:
        external_id = self._external_id_for_request(request)
        if external_id:
            return [c for performer in await self._query_by_id(client, "performer", external_id)
                    for c in self._map_performer(performer, 1.0)]

        stash = self._stash(client)
        endpoint = await self._stash_endpoint(stash)
        found = await stash.scrape_performer_query(endpoint, request.name)
        candidates: list[Candidate] = []
        for scraped in found[: request.limit]:
            performer = normalize_scraped_performer(scraped)
            # Stash's scraped performer drops partial measurements, birthplace and
            # URL site names; the exact record has them.
            if performer.get("id"):
                try:
                    exact = await self._query_by_id(client, "performer", performer["id"])
                    performer = exact[0] if exact else performer
                except (httpx.HTTPError, RuntimeError) as exc:
                    logger.warning("%s: exact performer fetch failed (%s); using Stash's copy", self.name, type(exc).__name__)
            candidates.extend(self._map_performer(performer, _name_confidence(performer.get("name"), request.name)))
        return candidates

    # --- Studio -------------------------------------------------------------

    async def _search_studio(
        self, request: EnrichRequest, client: httpx.AsyncClient
    ) -> list[Candidate]:
        external_id = self._external_id_for_request(request)
        if external_id:
            return [c for studio in await self._query_by_id(client, "studio", external_id)
                    for c in self._map_studio(studio, 1.0)]
        stash = self._stash(client)
        endpoint = await self._stash_endpoint(stash)
        studios = [s for s in (normalize_scraped_studio(x) for x in await stash.scrape_studio_query(endpoint, request.name)) if s]
        return [c for studio in studios[: request.limit]
                for c in self._map_studio(studio, _name_confidence(studio.get("name"), request.name))]

    # --- Tag ----------------------------------------------------------------

    async def _search_tag(
        self, request: EnrichRequest, client: httpx.AsyncClient
    ) -> list[Candidate]:
        external_id = self._external_id_for_request(request)
        if external_id:
            return [c for tag in await self._query_by_id(client, "tag", external_id)
                    for c in self._map_tag(tag, 1.0)]
        stash = self._stash(client)
        endpoint = await self._stash_endpoint(stash)
        tags = [normalize_scraped_tag(t) for t in await stash.scrape_tag_query(endpoint, request.name)]
        return [c for tag in tags[: request.limit]
                for c in self._map_tag(tag, _name_confidence(tag.get("name"), request.name))]

    # --- Scene (video) ------------------------------------------------------

    async def _direct_fingerprints(self, client: httpx.AsyncClient, request: EnrichRequest) -> list[dict[str, Any]]:
        """Hashes Stash cannot send: files it never scanned (pre-conversion originals)."""
        hashes = [fp for fp in [request.fingerprint, *request.fingerprints] if fp is not None]
        if not hashes:
            return []
        data = await self._graphql(
            client,
            "query($fingerprints:[[FingerprintQueryInput!]!]!) { findScenesBySceneFingerprints(fingerprints:$fingerprints) { " + SCENE_FIELDS + " } }",
            {"fingerprints": [[{"algorithm": fp.algorithm, "hash": fp.hash.lower()} for fp in hashes]]},
        )
        batches = data.get("findScenesBySceneFingerprints") or []
        return batches[0] if batches else []

    async def _with_image_urls(self, client: httpx.AsyncClient, scenes: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Swap Stash's inline cover (a ~100 KB data URL) for the server's image URL."""
        for scene in scenes:
            if not scene.get("id") or not any((i.get("url") or "").startswith("data:") for i in scene.get("images") or []):
                continue
            try:
                exact = await self._query_by_id(client, "scene", str(scene["id"]))
            except (httpx.HTTPError, RuntimeError):
                continue
            urls = [i for i in (exact[0].get("images") if exact else None) or [] if i.get("url")]
            if urls:
                scene["images"] = urls[:1]
        return scenes

    async def _search_scene(
        self, request: EnrichRequest, client: httpx.AsyncClient
    ) -> list[Candidate]:
        external_id = self._external_id_for_request(request)
        if external_id:
            results = await self._query_by_id(client, "scene", external_id)
            return self._map_scene(results[0], 1.0) if results else []

        # Direct hash lookups work without Stash; Stash's fingerprints and title
        # search need the bridge.
        needs_stash = bool(request.stash_scene_id) or not (request.fingerprint_only or request.fingerprint or request.fingerprints)
        stash = self._stash(client) if needs_stash else (
            StashClient(self.bridge, client) if self.bridge and self.bridge.endpoint else None)
        local = await local_fingerprints(request, stash)
        scenes: list[dict[str, Any]] = []
        if request.stash_scene_id and stash is not None:
            endpoint = await self._stash_endpoint(stash)
            batches = await stash.scrape_scenes_by_fingerprints(endpoint, [request.stash_scene_id])
            scenes.extend(normalize_scraped_scene(s) for s in (batches[0] if batches else []))
        seen = {s.get("id") for s in scenes}
        scenes.extend(s for s in await self._direct_fingerprints(client, request) if s.get("id") not in seen)

        term = ""
        if not scenes and not request.fingerprint_only:
            term = scene_search_term(request)
            if term:
                stash = stash or self._stash(client)
                endpoint = await self._stash_endpoint(stash)
                scenes = [normalize_scraped_scene(s) for s in await stash.scrape_scene_query(endpoint, term)]

        candidates: list[Candidate] = []
        ranked = await self._with_image_urls(client, rank_scenes(scenes, local)[: request.limit])
        for rank, scene in enumerate(ranked):
            fallback = _name_confidence(scene.get("title"), term) if term else 0.6
            candidates.extend(self._map_scene(scene, evidence_confidence(scene["evidence"], fallback), rank=rank,
                                              matched_by="title" if term else "fingerprint"))
        return candidates

    async def search_scenes_batch(
        self, client: httpx.AsyncClient, stash_scene_ids: list[str], locals_by_scene: dict[str, LocalFingerprints], limit: int
    ) -> dict[str, list[Candidate]]:
        """Fingerprint-identify many Stash scenes in one Stash call (batch identify)."""
        stash = self._stash(client)
        endpoint = await self._stash_endpoint(stash)
        batches = await stash.scrape_scenes_by_fingerprints(endpoint, stash_scene_ids)
        result: dict[str, list[Candidate]] = {}
        for scene_id, found in zip(stash_scene_ids, batches + [[]] * (len(stash_scene_ids) - len(batches))):
            ranked = rank_scenes([normalize_scraped_scene(s) for s in found or []], locals_by_scene.get(scene_id, LocalFingerprints()))
            ranked = await self._with_image_urls(client, ranked[:limit])
            result[scene_id] = [c for rank, scene in enumerate(ranked)
                                for c in self._map_scene(scene, evidence_confidence(scene["evidence"], 0.6), rank=rank, matched_by="fingerprint")]
        return result

    # --- Mappers --------------------------------------------------------------

    def _map_performer(
        self, performer: dict[str, Any], confidence: float
    ) -> list[Candidate]:
        candidates: list[Candidate] = []

        performer_id = performer.get("id")
        match_raw = {
            "entity_type": "creator",
            "source": self.name,
            "external_id": str(performer_id) if performer_id else None,
            "name": performer.get("name"),
        }
        if performer_id:
            candidates.append(
                Candidate(
                    type="external_id",
                    value=str(performer_id),
                    source=self.name,
                    confidence=confidence,
                    raw={"id": performer_id, "name": performer.get("name"),
                         "disambiguation": performer.get("disambiguation"), "match": match_raw},
                )
            )

        for image in performer.get("images") or []:
            url = image.get("url")
            if url:
                candidates.append(
                    Candidate(
                        type="image",
                        value=url,
                        source=self.name,
                        source_url=url,
                        confidence=confidence,
                        raw=_with_match(
                            image,
                            entity_type="creator",
                            source=self.name,
                            external_id=performer_id,
                            name=performer.get("name"),
                        ),
                    )
                )

        for entry in performer.get("urls") or []:
            url = entry.get("url")
            if not url:
                continue
            site = (entry.get("site") or {}).get("name") or "website"
            candidates.append(
                Candidate(
                    type="social",
                    value=url,
                    source=self.name,
                    source_url=url,
                    field_key=site,
                    confidence=confidence,
                    raw=_with_match(
                        entry,
                        entity_type="creator",
                        source=self.name,
                        external_id=performer_id,
                        name=performer.get("name"),
                    ),
                )
            )

        name = (performer.get("name") or "").strip().lower()
        for alias in dict.fromkeys(a for a in performer.get("aliases") or [] if a):
            # stash-box can list the name itself or duplicates as aliases (Stash #4437, #4596).
            if str(alias).strip().lower() == name:
                continue
            candidates.append(
                Candidate(
                    type="alias",
                    value=str(alias),
                    source=self.name,
                    confidence=confidence,
                    raw={"match": match_raw},
                )
            )

        for field, column in FIELD_MAP.items():
            value = performer.get(field)
            if value is None or value == "":
                continue
            candidates.append(
                Candidate(
                    type="field",
                    field_key=column,
                    value=str(value),
                    source=self.name,
                    confidence=confidence,
                    raw={"match": match_raw},
                )
            )

        return candidates

    def _map_studio(
        self, studio: dict[str, Any], confidence: float
    ) -> list[Candidate]:
        candidates: list[Candidate] = []

        studio_id = studio.get("id")
        match_raw = {
            "entity_type": "studio",
            "source": self.name,
            "external_id": str(studio_id) if studio_id else None,
            "name": studio.get("name"),
        }
        if studio_id:
            candidates.append(
                Candidate(
                    type="external_id",
                    value=str(studio_id),
                    source=self.name,
                    confidence=confidence,
                    raw={"id": studio_id, "name": studio.get("name"), "match": match_raw},
                )
            )

        for image in studio.get("images") or []:
            url = image.get("url")
            if url:
                candidates.append(
                    Candidate(
                        type="image",
                        value=url,
                        source=self.name,
                        source_url=url,
                        confidence=confidence,
                        raw=_with_match(
                            image,
                            entity_type="studio",
                            source=self.name,
                            external_id=studio_id,
                            name=studio.get("name"),
                        ),
                    )
                )

        for entry in studio.get("urls") or []:
            url = entry.get("url")
            if not url:
                continue
            site = (entry.get("site") or {}).get("name") or "website"
            candidates.append(
                Candidate(
                    type="social",
                    value=url,
                    source=self.name,
                    source_url=url,
                    field_key=site,
                    confidence=confidence,
                    raw=_with_match(
                        entry,
                        entity_type="studio",
                        source=self.name,
                        external_id=studio_id,
                        name=studio.get("name"),
                    ),
                )
            )

        for alias in studio.get("aliases") or []:
            if alias:
                candidates.append(
                    Candidate(
                        type="alias",
                        value=str(alias),
                        source=self.name,
                        confidence=confidence,
                        raw={"match": match_raw},
                    )
                )

        parent = studio.get("parent")
        if parent and parent.get("name"):
            candidates.append(
                Candidate(
                    type="parent",
                    value=str(parent["name"]),
                    source=self.name,
                    confidence=confidence,
                    raw={
                        "external_id": parent.get("id"),
                        "source": self.name,
                        "match": match_raw,
                    },
                )
            )

        return candidates

    def _map_scene(
        self, scene: dict[str, Any], confidence: float, *, rank: int = 0, matched_by: str | None = None
    ) -> list[Candidate]:
        candidates: list[Candidate] = []

        scene_id = scene.get("id")
        match_raw: dict[str, Any] = {
            "entity_type": "scene",
            "source": self.name,
            "external_id": str(scene_id) if scene_id else None,
            "name": scene.get("title"),
        }
        if "evidence" in scene:
            match_raw.update({"rank": rank, "matched_by": matched_by, "evidence": scene["evidence"],
                              "duration": scene.get("duration")})
        if scene_id:
            candidates.append(
                Candidate(
                    type="external_id",
                    value=str(scene_id),
                    source=self.name,
                    confidence=confidence,
                    raw={"id": scene_id, "title": scene.get("title"), "match": match_raw},
                )
            )

        # Scalar fields → video columns / video_metadata (resolved on the Node side).
        urls = [u.get("url") for u in scene.get("urls") or [] if u.get("url")]
        scene_fields = {
            "title": scene.get("title"),
            "description": scene.get("details"),
            "release_date": scene.get("release_date"),
            "code": scene.get("code"),
            "director": scene.get("director"),
            "url": urls[0] if urls else None,
        }
        for column, value in scene_fields.items():
            if value is None or value == "":
                continue
            candidates.append(
                Candidate(
                    type="field",
                    field_key=column,
                    value=str(value),
                    source=self.name,
                    confidence=confidence,
                    raw={"match": match_raw},
                )
            )

        for image in scene.get("images") or []:
            url = image.get("url")
            if url:
                candidates.append(
                    Candidate(
                        type="image",
                        value=url,
                        source=self.name,
                        source_url=None if url.startswith("data:") else url,
                        confidence=confidence,
                        raw=_with_match(
                            {k: v for k, v in image.items() if k != "url"},
                            entity_type="scene",
                            source=self.name,
                            external_id=scene_id,
                            name=scene.get("title"),
                        ),
                    )
                )

        studio = scene.get("studio")
        if studio and studio.get("name"):
            candidates.append(
                Candidate(
                    type="studio",
                    value=str(studio["name"]),
                    source=self.name,
                    confidence=confidence,
                    raw={
                        "external_id": studio.get("id"),
                        "source": self.name,
                        "parents": _studio_chain(studio),
                        "match": match_raw,
                    },
                )
            )

        for appearance in scene.get("performers") or []:
            performer = appearance.get("performer") or {}
            if not performer.get("name"):
                continue
            candidates.append(
                Candidate(
                    type="performer",
                    value=str(performer["name"]),
                    source=self.name,
                    confidence=confidence,
                    raw={
                        "external_id": performer.get("id"),
                        "source": self.name,
                        "as": appearance.get("as"),
                        "gender": performer.get("gender"),
                        "disambiguation": performer.get("disambiguation"),
                        "aliases": performer.get("aliases") or [],
                        "match": match_raw,
                    },
                )
            )

        for tag in scene.get("tags") or []:
            if not tag.get("name"):
                continue
            candidates.append(
                Candidate(
                    type="tag",
                    value=str(tag["name"]),
                    source=self.name,
                    confidence=confidence,
                    raw={
                        "external_id": tag.get("id"),
                        "source": self.name,
                        "match": match_raw,
                    },
                )
            )

        return candidates

    def _map_tag(self, tag: dict[str, Any], confidence: float) -> list[Candidate]:
        candidates: list[Candidate] = []

        tag_id = tag.get("id")
        match_raw = {
            "entity_type": "tag",
            "source": self.name,
            "external_id": str(tag_id) if tag_id else None,
            "name": tag.get("name"),
        }
        if tag_id:
            candidates.append(
                Candidate(
                    type="external_id",
                    value=str(tag_id),
                    source=self.name,
                    confidence=confidence,
                    raw={"id": tag_id, "name": tag.get("name"), "match": match_raw},
                )
            )

        description = tag.get("description")
        if description:
            candidates.append(
                Candidate(
                    type="field",
                    field_key="description",
                    value=str(description),
                    source=self.name,
                    confidence=confidence,
                    raw={"match": match_raw},
                )
            )

        for alias in tag.get("aliases") or []:
            if alias:
                candidates.append(
                    Candidate(
                        type="alias",
                        value=str(alias),
                        source=self.name,
                        confidence=confidence,
                        raw={"match": match_raw},
                    )
                )

        category = tag.get("category")
        if category and category.get("name"):
            candidates.append(
                Candidate(
                    type="category",
                    value=str(category["name"]),
                    source=self.name,
                    confidence=confidence,
                    raw={
                        "external_id": category.get("id"),
                        "group": category.get("group"),
                        "source": self.name,
                        "match": match_raw,
                    },
                )
            )

        return candidates
