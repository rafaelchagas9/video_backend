"""StashBox GraphQL source — serves both ThePornDB and StashDB.

Both endpoints descend from the StashBox schema and share the same object *types*
(`Performer`, `Studio`, `Scene`, `Tag`, `Image`, `URL`, …), but their root *search
queries* differ in non-trivial ways (verified live against both endpoints):

                | ThePornDB                    | StashDB
    performer   | searchPerformer(term) -> []  | searchPerformers(term){performers}
    studio      | findStudio(name) -> obj      | searchStudio(term) -> []
    scene       | searchScene(term) -> []      | queryScenes(input:{text}){scenes}
    tag         | findTag(name) -> obj         | searchTag(term) -> []

So a single plugin handles both, parameterised by ``dialect`` ("tpdb" | "stashbox")
which selects the query + result extraction. The field selections and the mappers
below are shared, since the returned object types are identical.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from ..models import Candidate, EnrichRequest
from .base import Source

logger = logging.getLogger(__name__)

# Scalar Performer fields → our `creators` column names.
FIELD_MAP: dict[str, str] = {
    "gender": "gender",
    "birth_date": "birth_date",
    "death_date": "death_date",
    "ethnicity": "ethnicity",
    "country": "country",
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

# Shared field selections (the object types are identical across both endpoints).
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
  studio { id name }
  tags { id name }
  images { id url }
  performers { as performer { id name } }
"""

TAG_FIELDS = """
  id
  name
  description
  aliases
  category { id name group }
"""

# Per-dialect root queries. All take a single `$term: String!` variable.
QUERIES: dict[str, dict[str, str]] = {
    "tpdb": {
        "performer": f"query($term:String!){{ searchPerformer(term:$term){{ {PERFORMER_FIELDS} }} }}",
        "studio": f"query($term:String!){{ findStudio(name:$term){{ {STUDIO_FIELDS} }} }}",
        "scene": f"query($term:String!){{ searchScene(term:$term){{ {SCENE_FIELDS} }} }}",
        "tag": f"query($term:String!){{ findTag(name:$term){{ {TAG_FIELDS} }} }}",
    },
    "stashbox": {
        "performer": f"query($term:String!){{ searchPerformers(term:$term){{ performers {{ {PERFORMER_FIELDS} }} }} }}",
        "studio": f"query($term:String!){{ searchStudio(term:$term){{ {STUDIO_FIELDS} }} }}",
        "scene": f"query($term:String!){{ queryScenes(input:{{ text:$term, page:1, per_page:5 }}){{ scenes {{ {SCENE_FIELDS} }} }} }}",
        "tag": f"query($term:String!){{ searchTag(term:$term){{ {TAG_FIELDS} }} }}",
    },
}

ID_QUERIES: dict[str, str] = {
    "performer": f"query($id:ID!){{ findPerformer(id:$id){{ {PERFORMER_FIELDS} }} }}",
    "studio": f"query($id:ID!){{ findStudio(id:$id){{ {STUDIO_FIELDS} }} }}",
    "scene": f"query($id:ID!){{ findScene(id:$id){{ {SCENE_FIELDS} }} }}",
    "tag": f"query($id:ID!){{ findTag(id:$id){{ {TAG_FIELDS} }} }}",
}


def _name_confidence(candidate_name: str, term: str) -> float:
    """High confidence on an exact (case-insensitive) name match, else moderate."""
    if candidate_name.strip().lower() == term.strip().lower():
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
        for key in ("performers", "scenes", "studios", "tags"):
            if isinstance(value.get(key), list):
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


class StashBoxSource(Source):
    def __init__(
        self,
        *,
        name: str,
        endpoint: str,
        api_key: str,
        auth_style: str = "bearer",  # "bearer" (TPDB) | "apikey" (StashDB)
        dialect: str = "tpdb",  # "tpdb" | "stashbox"
    ) -> None:
        self.name = name
        self.endpoint = endpoint
        self.api_key = api_key
        self.auth_style = auth_style
        self.dialect = dialect if dialect in QUERIES else "tpdb"

    def _headers(self) -> dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "enrichment-service/0.1",
        }
        if self.auth_style == "apikey":
            headers["ApiKey"] = self.api_key
        else:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    async def _query(
        self, client: httpx.AsyncClient, entity: str, term: str
    ) -> list[dict[str, Any]]:
        """Run the dialect-appropriate query for `entity` and return result rows."""
        query = QUERIES[self.dialect][entity]
        resp = await client.post(
            self.endpoint,
            headers=self._headers(),
            json={"query": query, "variables": {"term": term}},
        )
        resp.raise_for_status()
        body = resp.json()
        if body.get("errors"):
            raise RuntimeError(f"{self.name} GraphQL errors: {body['errors']}")
        data = body.get("data") or {}
        # The single root field's value (searchPerformer / findStudio / queryScenes...).
        root_value = next(iter(data.values()), None) if data else None
        return _as_list(root_value)

    async def _query_by_id(
        self, client: httpx.AsyncClient, entity: str, external_id: str
    ) -> list[dict[str, Any]]:
        """Fetch one exact upstream object by ID when a related candidate provides it."""
        resp = await client.post(
            self.endpoint,
            headers=self._headers(),
            json={
                "query": ID_QUERIES[entity],
                "variables": {"id": external_id},
            },
        )
        resp.raise_for_status()
        body = resp.json()
        if body.get("errors"):
            raise RuntimeError(f"{self.name} GraphQL errors: {body['errors']}")
        data = body.get("data") or {}
        root_value = next(iter(data.values()), None) if data else None
        return _as_list(root_value)

    def _external_id_for_request(self, request: EnrichRequest) -> str | None:
        for entry in request.external_ids:
            if entry.get("source") == self.name and entry.get("external_id"):
                return str(entry["external_id"])
        return None

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

    # --- Performer (creator) ------------------------------------------------

    async def _search_performer(
        self, request: EnrichRequest, client: httpx.AsyncClient
    ) -> list[Candidate]:
        external_id = self._external_id_for_request(request)
        results = (
            await self._query_by_id(client, "performer", external_id)
            if external_id
            else await self._query(client, "performer", request.name)
        )
        if not results:
            return []
        candidates: list[Candidate] = []
        for performer in results[: request.limit]:
            confidence = (
                1.0
                if external_id
                else _name_confidence(performer.get("name", ""), request.name)
            )
            candidates.extend(self._map_performer(performer, confidence))
        return candidates

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
                    raw={"id": performer_id, "name": performer.get("name"), "match": match_raw},
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

        for alias in performer.get("aliases") or []:
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

    # --- Studio -------------------------------------------------------------

    async def _search_studio(
        self, request: EnrichRequest, client: httpx.AsyncClient
    ) -> list[Candidate]:
        external_id = self._external_id_for_request(request)
        results = (
            await self._query_by_id(client, "studio", external_id)
            if external_id
            else await self._query(client, "studio", request.name)
        )
        if not results:
            return []
        candidates: list[Candidate] = []
        for studio in results[: request.limit]:
            confidence = (
                1.0
                if external_id
                else _name_confidence(studio.get("name", ""), request.name)
            )
            candidates.extend(self._map_studio(studio, confidence))
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

    # --- Scene (video) ------------------------------------------------------

    async def _search_scene(
        self, request: EnrichRequest, client: httpx.AsyncClient
    ) -> list[Candidate]:
        external_id = self._external_id_for_request(request)
        if external_id:
            results = await self._query_by_id(client, "scene", external_id)
            if not results:
                return []
            return self._map_scene(results[0], 1.0)

        term = request.title or request.name or request.file_name or ""
        if not term:
            return []
        results = await self._query(client, "scene", term)
        if not results:
            return []
        candidates: list[Candidate] = []
        for scene in results[: request.limit]:
            confidence = _name_confidence(scene.get("title", ""), term)
            candidates.extend(self._map_scene(scene, confidence))
        return candidates

    def _map_scene(
        self, scene: dict[str, Any], confidence: float
    ) -> list[Candidate]:
        candidates: list[Candidate] = []

        scene_id = scene.get("id")
        match_raw = {
            "entity_type": "scene",
            "source": self.name,
            "external_id": str(scene_id) if scene_id else None,
            "name": scene.get("title"),
        }
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
        scene_fields = {
            "title": scene.get("title"),
            "description": scene.get("details"),
            "release_date": scene.get("release_date"),
            "code": scene.get("code"),
            "director": scene.get("director"),
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
                        source_url=url,
                        confidence=confidence,
                        raw=_with_match(
                            image,
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

    # --- Tag ----------------------------------------------------------------

    async def _search_tag(
        self, request: EnrichRequest, client: httpx.AsyncClient
    ) -> list[Candidate]:
        external_id = self._external_id_for_request(request)
        results = (
            await self._query_by_id(client, "tag", external_id)
            if external_id
            else await self._query(client, "tag", request.name)
        )
        if not results:
            return []
        candidates: list[Candidate] = []
        for tag in results[: request.limit]:
            confidence = (
                1.0 if external_id else _name_confidence(tag.get("name", ""), request.name)
            )
            candidates.extend(self._map_tag(tag, confidence))
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
