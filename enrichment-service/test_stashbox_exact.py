from __future__ import annotations

import unittest

import httpx

from enrichment_service.models import EnrichRequest
from enrichment_service.sources.stashbox import StashBoxSource


class ThePornDBExactLookupTests(unittest.IsolatedAsyncioTestCase):
    async def test_scene_uuid_uses_rest_and_maps_review_candidates(self) -> None:
        requested_urls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requested_urls.append(str(request.url))
            self.assertEqual(request.method, "GET")
            self.assertEqual(request.headers["authorization"], "Bearer test-key")
            return httpx.Response(
                200,
                json={
                    "data": {
                        "id": "06d2a8c7-b643-4b35-8043-5d37632cbfa9",
                        "_id": 2836147,
                        "slug": "sexymodernbull-pov-anally-hoff-the-charts",
                        "title": "Pov: Anally Hoff the Charts",
                        "description": "",
                        "date": "2023-04-14",
                        "poster": "https://cdn.example/poster.jpg",
                        "background": {
                            "full": "https://cdn.example/background.jpg"
                        },
                        "site": {
                            "uuid": "ee6cfcbb-36b5-48c9-8bd9-b6028d3d4e61",
                            "id": 10543,
                            "name": "Sexy Modern Bull",
                        },
                        "performers": [
                            {
                                "id": "site-performer-id",
                                "name": "Jackie Hoff",
                                "parent": {
                                    "id": "6f481350-36ec-4131-bd02-0cac91b2882a",
                                    "name": "Jackie Hoff",
                                },
                            }
                        ],
                        "tags": [
                            {
                                "id": 11891,
                                "uuid": "db7f40fd-8e3f-466a-9e6d-fdb3745fd3fe",
                                "name": "BBC",
                            }
                        ],
                        "directors": [],
                    }
                },
            )

        source = StashBoxSource(
            name="theporndb",
            endpoint="https://theporndb.net/graphql",
            exact_endpoint="https://api.theporndb.net",
            api_key="test-key",
            auth_style="bearer",
            dialect="tpdb",
        )
        request = EnrichRequest(
            name="Generic video title",
            entity_type="scene",
            external_ids=[
                {
                    "source": "theporndb",
                    "external_id": "06d2a8c7-b643-4b35-8043-5d37632cbfa9",
                }
            ],
        )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            candidates = await source.search(request, client)

        self.assertEqual(
            requested_urls,
            [
                "https://api.theporndb.net/scenes/"
                "06d2a8c7-b643-4b35-8043-5d37632cbfa9"
            ],
        )
        by_type = {candidate.type: candidate for candidate in candidates}
        self.assertEqual(
            by_type["external_id"].value,
            "06d2a8c7-b643-4b35-8043-5d37632cbfa9",
        )
        self.assertEqual(
            next(
                candidate.value
                for candidate in candidates
                if candidate.type == "field" and candidate.field_key == "title"
            ),
            "Pov: Anally Hoff the Charts",
        )
        self.assertEqual(
            next(
                candidate.value
                for candidate in candidates
                if candidate.type == "field"
                and candidate.field_key == "release_date"
            ),
            "2023-04-14",
        )
        self.assertEqual(by_type["studio"].value, "Sexy Modern Bull")
        self.assertEqual(by_type["performer"].value, "Jackie Hoff")
        self.assertEqual(by_type["tag"].value, "BBC")
        self.assertEqual(
            {candidate.value for candidate in candidates if candidate.type == "image"},
            {
                "https://cdn.example/poster.jpg",
                "https://cdn.example/background.jpg",
            },
        )

    async def test_scene_slug_and_numeric_id_are_forwarded_as_rest_identifiers(
        self,
    ) -> None:
        for identifier in (
            "sexymodernbull-pov-anally-hoff-the-charts",
            "2836147",
        ):
            with self.subTest(identifier=identifier):
                requested_path = ""

                def handler(request: httpx.Request) -> httpx.Response:
                    nonlocal requested_path
                    requested_path = request.url.path
                    return httpx.Response(404, json={"message": "Not found"})

                source = StashBoxSource(
                    name="theporndb",
                    endpoint="https://theporndb.net/graphql",
                    exact_endpoint="https://api.theporndb.net",
                    api_key="test-key",
                    dialect="tpdb",
                )
                request = EnrichRequest(
                    name="Generic video title",
                    entity_type="scene",
                    external_ids=[
                        {
                            "source": "theporndb",
                            "external_id": identifier,
                        }
                    ],
                )

                async with httpx.AsyncClient(
                    transport=httpx.MockTransport(handler)
                ) as client:
                    candidates = await source.search(request, client)

                self.assertEqual(requested_path, f"/scenes/{identifier}")
                self.assertEqual(candidates, [])


if __name__ == "__main__":
    unittest.main()
