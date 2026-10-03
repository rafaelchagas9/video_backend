import json
import unittest

import httpx

from enrichment_service.models import EnrichRequest
from enrichment_service.providers import Provider
from enrichment_service.sources.stashbox import StashBoxSource, scene_search_term


class SceneSearchTerms(unittest.IsolatedAsyncioTestCase):
    def test_download_filename(self):
        filename = "(2024.09.27)+Artist+Visits+The+Studio+[2K]_1080p_av1_1786494936909.mkv"
        self.assertEqual(scene_search_term(EnrichRequest(name=filename, file_name=filename)), "Artist Visits The Studio")

    def test_explicit_title_and_manual_search_are_preserved(self):
        self.assertEqual(scene_search_term(EnrichRequest(name="file.mkv", file_name="file.mkv", title="Studio 54 + 2K")), "Studio 54 + 2K")
        self.assertEqual(scene_search_term(EnrichRequest(name="Manual query", file_name="file.mkv")), "Manual query")

    def test_meaningful_numbers_and_unicode_survive(self):
        for filename, expected in [("Álbum_Studio_54.mp4", "Álbum Studio 54"), ("Artist_2024.mkv", "Artist 2024"), ("Title.mkv", "Title")]:
            self.assertEqual(scene_search_term(EnrichRequest(name=filename, file_name=filename)), expected)

    async def test_title_search_runs_through_stash_with_clean_query(self):
        filename = "(2024.09.27)+Artist+Visits+The+Studio+[2K]_1080p_av1_1786494936909.mkv"
        bridge = Provider(id="stash", name="Stash", kind="stash", endpoint="http://stash.invalid/graphql", api_key="k")
        box = "https://box.invalid/graphql"

        def handle(request):
            payload = json.loads(request.content)
            self.assertEqual(str(request.url), bridge.endpoint)
            if "stashBoxes" in payload["query"]:
                return httpx.Response(200, json={"data": {"configuration": {"general": {"stashBoxes": [{"endpoint": box, "name": "Box", "api_key": "x", "max_requests_per_minute": 0}]}}}})
            self.assertIn("scrapeSingleScene", payload["query"])
            self.assertEqual(payload["variables"], {"endpoint": box, "q": "Artist Visits The Studio"})
            rows = [{"remote_site_id": "scene-id", "title": "Artist Visits The Studio", "fingerprints": [], "tags": [],
                     "performers": [{"name": "Artist", "remote_site_id": "artist-id", "gender": "FEMALE"}]}]
            return httpx.Response(200, json={"data": {"scrapeSingleScene": rows}})

        source = StashBoxSource(name="stashdb", endpoint=box, api_key="fixture", dialect="stashbox", bridge=bridge)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            rows = await source.search(EnrichRequest(entity_type="scene", name=filename, file_name=filename), client)
        self.assertTrue(any(row.type == "external_id" and row.value == "scene-id" for row in rows))
        performer = next(row for row in rows if row.type == "performer")
        self.assertEqual((performer.value, performer.raw["external_id"], performer.raw["gender"]), ("Artist", "artist-id", "FEMALE"))
        self.assertEqual(performer.raw["match"]["matched_by"], "title")
