"""Stash-routed discovery, ranking, merged performers and bridge operations."""
import json
import unittest

import httpx

from enrichment_service.matching import LocalFingerprints, confidence, rank_scenes
from enrichment_service.models import EnrichRequest, Fingerprint
from enrichment_service.providers import Provider
from enrichment_service.sources.stash import StashSource
from enrichment_service.sources.stashbox import StashBoxSource, normalize_scraped_performer
from enrichment_service.stash_client import StashClient

BRIDGE = Provider(id="stash", name="Stash", kind="stash", endpoint="http://stash.invalid/graphql", api_key="k")
BOX = "https://stashdb.invalid/graphql"
BOXES = {"configuration": {"general": {"stashBoxes": [{"endpoint": BOX, "name": "StashDB", "api_key": "x", "max_requests_per_minute": 0}]}}}


def fp(algorithm, hash_value, duration):
    return {"algorithm": algorithm, "hash": hash_value, "duration": duration}


class Ranking(unittest.TestCase):
    local = LocalFingerprints(phashes=["ffff0000ffff0000"], durations=[600.0])

    def test_phash_match_outranks_duration_only(self):
        duration_only = {"id": "a", "fingerprints": [fp("OSHASH", "1", 600), fp("OSHASH", "2", 601)]}
        phash = {"id": "b", "fingerprints": [fp("PHASH", "ffff0000ffff0003", 900)]}  # distance 2
        ranked = rank_scenes([duration_only, phash], self.local)
        self.assertEqual([s["id"] for s in ranked], ["b", "a"])
        self.assertEqual(ranked[0]["evidence"]["best_phash_distance"], 2)
        self.assertGreaterEqual(confidence(ranked[0]["evidence"], 0.6), 0.9)

    def test_durations_break_ties_when_no_phash_matches(self):
        # Stash's comparator stops here; we keep comparing durations.
        far = {"id": "far", "fingerprints": [fp("OSHASH", "1", 900)]}
        near = {"id": "near", "fingerprints": [fp("OSHASH", "2", 602)]}
        self.assertEqual([s["id"] for s in rank_scenes([far, near], self.local)], ["near", "far"])
        self.assertAlmostEqual(confidence(rank_scenes([near], self.local)[0]["evidence"], 0.6), 0.8)

    def test_distant_phash_and_no_fingerprints_rank_last(self):
        distant = {"id": "distant", "fingerprints": [fp("PHASH", "0000ffff0000ffff", 600)]}
        bare = {"id": "bare", "fingerprints": []}
        ranked = rank_scenes([bare, distant], self.local)
        self.assertEqual([s["id"] for s in ranked], ["distant", "bare"])
        self.assertEqual(ranked[0]["evidence"]["phash_matches"], 0)

    def test_exact_checksum_wins(self):
        local = LocalFingerprints(checksums={"abcdef0123456789"}, durations=[600])
        exact = {"id": "exact", "fingerprints": [fp("OSHASH", "ABCDEF0123456789", 10)]}
        other = {"id": "other", "fingerprints": [fp("OSHASH", "1", 600)]}
        ranked = rank_scenes([other, exact], local)
        self.assertEqual(ranked[0]["id"], "exact")
        self.assertEqual(confidence(ranked[0]["evidence"], 0.6), 1.0)


class ScrapedNormalization(unittest.TestCase):
    def test_measurements_breasts_aliases_and_urls(self):
        performer = normalize_scraped_performer({
            "name": "Mia", "remote_site_id": "p1", "measurements": "34DD-26-36", "fake_tits": "Fake",
            "aliases": "Mia M, Mia", "urls": ["https://www.twitter.com/mia"], "career_start": "2012", "height": "170",
        })
        self.assertEqual((performer["band_size"], performer["cup_size"], performer["waist_size"], performer["hip_size"]),
                         ("34", "DD", "26", "36"))
        self.assertEqual(performer["breast_type"], "AUGMENTED")
        self.assertEqual(performer["urls"][0]["site"]["name"], "twitter")
        self.assertEqual(performer["career_start_year"], 2012)

    def test_alias_equal_to_name_is_dropped(self):
        source = StashBoxSource(name="stashdb", endpoint=BOX, api_key="x")
        rows = source._map_performer({"id": "p", "name": "Mia", "aliases": ["mia", "Mia M", "Mia M"]}, 1.0)
        self.assertEqual([r.value for r in rows if r.type == "alias"], ["Mia M"])


class StashRoutedScenes(unittest.IsolatedAsyncioTestCase):
    async def test_stash_scene_fingerprints_rank_and_swap_inline_cover(self):
        calls = []

        def handle(request):
            payload = json.loads(request.content)
            calls.append((str(request.url), payload["query"].split("{")[1].split("(")[0].strip()))
            if str(request.url) == BOX:
                # Exact read for the cover URL; one per ranked result with an inline image.
                return httpx.Response(200, json={"data": {"findScene": {"id": payload["variables"]["id"], "images": [{"url": "https://cdn.invalid/cover.jpg"}]}}})
            query = payload["query"]
            if "stashBoxes" in query:
                return httpx.Response(200, json={"data": BOXES})
            if "findScene(" in query:
                return httpx.Response(200, json={"data": {"findScene": {"id": "7", "stash_ids": [], "files": [
                    {"id": "1", "path": "/v.mkv", "duration": 600.2, "fingerprints": [{"type": "phash", "value": "ffff0000ffff0000"}]}]}}})
            self.assertIn("scrapeMultiScenes", query)
            self.assertEqual(payload["variables"], {"endpoint": BOX, "ids": ["7"]})
            return httpx.Response(200, json={"data": {"scrapeMultiScenes": [[
                {"remote_site_id": "wrong", "title": "Other", "fingerprints": [fp("OSHASH", "1", 900)], "image": "data:image/png;base64,AAAA"},
                {"remote_site_id": "right", "title": "Right", "duration": 600, "fingerprints": [fp("PHASH", "ffff0000ffff0001", 600)],
                 "image": "data:image/png;base64,AAAA", "studio": {"name": "Label", "remote_site_id": "s1", "parent": {"name": "Network", "remote_site_id": "n1"}}},
            ]]}})

        source = StashBoxSource(name="stashdb", endpoint=BOX, api_key="x", dialect="stashbox", bridge=BRIDGE)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            rows = await source.search(EnrichRequest(name="v.mkv", entity_type="scene", stash_scene_id="7", limit=2), client)
        ids = [r for r in rows if r.type == "external_id"]
        self.assertEqual([r.value for r in ids], ["right", "wrong"])
        self.assertEqual(ids[0].raw["match"]["rank"], 0)
        self.assertEqual(ids[0].raw["match"]["evidence"]["phash_matches"], 1)
        self.assertGreater(ids[0].confidence, ids[1].confidence)
        covers = [r for r in rows if r.type == "image"]
        self.assertTrue(all(r.value == "https://cdn.invalid/cover.jpg" for r in covers))
        studio = next(r for r in rows if r.type == "studio")
        self.assertEqual(studio.raw["parents"], [{"name": "Network", "external_id": "n1"}])
        # Title search never runs when fingerprints matched.
        self.assertFalse(any(name == "scrapeSingleScene" for _, name in calls))

    async def test_pre_conversion_hash_is_looked_up_directly_and_merged(self):
        def handle(request):
            payload = json.loads(request.content)
            if str(request.url) == BOX:
                self.assertIn("findScenesBySceneFingerprints", payload["query"])
                self.assertEqual(payload["variables"]["fingerprints"], [[{"algorithm": "OSHASH", "hash": "0123456789abcdef"}]])
                return httpx.Response(200, json={"data": {"findScenesBySceneFingerprints": [[
                    {"id": "orig", "title": "Original", "fingerprints": [fp("OSHASH", "0123456789abcdef", 600)]}]]}})
            if "stashBoxes" in payload["query"]:
                return httpx.Response(200, json={"data": BOXES})
            if "findScene(" in payload["query"]:
                return httpx.Response(200, json={"data": {"findScene": {"id": "7", "stash_ids": [], "files": []}}})
            return httpx.Response(200, json={"data": {"scrapeMultiScenes": [[]]}})

        source = StashBoxSource(name="stashdb", endpoint=BOX, api_key="x", dialect="stashbox", bridge=BRIDGE)
        request = EnrichRequest(name="v", entity_type="scene", stash_scene_id="7", fingerprint_only=True,
                                fingerprints=[Fingerprint(algorithm="OSHASH", hash="0123456789ABCDEF")])
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            rows = await source.search(request, client)
        match = next(r for r in rows if r.type == "external_id")
        self.assertEqual((match.value, match.confidence), ("orig", 1.0))
        self.assertTrue(match.raw["match"]["evidence"]["exact_hash"])

    async def test_fingerprint_only_never_falls_back_to_title(self):
        def handle(request):
            payload = json.loads(request.content)
            self.assertNotIn("scrapeSingleScene", payload["query"])
            if "stashBoxes" in payload["query"]:
                return httpx.Response(200, json={"data": BOXES})
            if "findScene(" in payload["query"]:
                return httpx.Response(200, json={"data": {"findScene": None}})
            return httpx.Response(200, json={"data": {"scrapeMultiScenes": [[]]}})

        source = StashBoxSource(name="stashdb", endpoint=BOX, api_key="x", dialect="stashbox", bridge=BRIDGE)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            rows = await source.search(EnrichRequest(name="v", entity_type="scene", stash_scene_id="7", fingerprint_only=True), client)
        self.assertEqual(rows, [])

    async def test_missing_stash_box_in_stash_is_a_clear_error(self):
        def handle(request):
            return httpx.Response(200, json={"data": {"configuration": {"general": {"stashBoxes": []}}}})
        source = StashBoxSource(name="fansdb", endpoint=BOX, api_key="x", dialect="standard", bridge=BRIDGE)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            with self.assertRaisesRegex(RuntimeError, "add this source to Stash"):
                await source.search(EnrichRequest(name="Someone"), client)

    async def test_community_scraper_title_search(self):
        def handle(request):
            payload = json.loads(request.content)
            self.assertEqual(payload["variables"], {"id": "IAFD", "q": "Some Scene"})
            return httpx.Response(200, json={"data": {"scrapeSingleScene": [{"title": "Some Scene", "remote_site_id": "iafd-9", "performers": [{"name": "A"}]}]}})
        source = StashSource(BRIDGE)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            rows = await source.search(EnrichRequest(name="Some Scene", entity_type="scene", scraper_id="IAFD"), client)
        self.assertFalse(any(r.type == "external_id" for r in rows))
        self.assertTrue(all(r.raw["remote_site_id"] == "iafd-9" and r.raw["scraper_id"] == "IAFD" for r in rows))
        self.assertTrue(any(r.type == "performer" and r.value == "A" for r in rows))


class ExactLookups(unittest.IsolatedAsyncioTestCase):
    async def test_exact_scene_is_not_mistaken_for_its_performer_list(self):
        def handle(request):
            return httpx.Response(200, json={"data": {"findScene": {"id": "s1", "title": "Exact", "performers": [
                {"as": None, "performer": {"id": "p1", "name": "Mia"}}]}}})
        source = StashBoxSource(name="stashdb", endpoint=BOX, api_key="x", dialect="stashbox")
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            rows = await source.search(EnrichRequest(name="x", entity_type="scene", external_ids=[{"source": "stashdb", "external_id": "s1"}]), client)
        self.assertEqual([(r.type, r.value) for r in rows if r.type in {"external_id", "performer"}], [("external_id", "s1"), ("performer", "Mia")])


class MergedPerformers(unittest.IsolatedAsyncioTestCase):
    async def identity(self, response, dialect="stashbox"):
        def handle(request):
            return httpx.Response(200, json={"data": {"findPerformer": response}})
        source = StashBoxSource(name="stashdb", endpoint=BOX, api_key="x", dialect=dialect)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            return await source.performer_identity(client, "old")

    async def test_redirected_id_is_reported_as_merged(self):
        result = await self.identity({"id": "new", "name": "Mia", "deleted": False, "merged_into_id": None, "merged_ids": ["old"]})
        self.assertEqual((result["id"], result["merged"], result["deleted"]), ("new", True, False))

    async def test_merged_into_id_wins_over_deleted(self):
        result = await self.identity({"id": "old", "name": "Mia", "deleted": True, "merged_into_id": "new", "merged_ids": []})
        self.assertEqual((result["id"], result["merged"], result["deleted"]), ("new", True, False))

    async def test_deleted_and_missing(self):
        deleted = await self.identity({"id": "old", "name": "Mia", "deleted": True, "merged_into_id": None, "merged_ids": []})
        self.assertTrue(deleted["deleted"] and not deleted["merged"])
        self.assertFalse((await self.identity(None))["found"])

    async def test_theporndb_is_not_checked(self):
        self.assertFalse((await self.identity(None, dialect="tpdb"))["supported"])


class BridgeOperations(unittest.IsolatedAsyncioTestCase):
    async def test_upsert_stash_box_preserves_other_boxes_and_rate_limits(self):
        sent = []
        def handle(request):
            payload = json.loads(request.content)
            if "mutation" in payload["query"]:
                sent.append(payload["variables"]["boxes"])
                return httpx.Response(200, json={"data": {"configureGeneral": {"stashBoxes": []}}})
            return httpx.Response(200, json={"data": {"configuration": {"general": {"stashBoxes": [
                {"endpoint": BOX, "name": "StashDB", "api_key": "a", "max_requests_per_minute": 0},
                {"endpoint": "https://fansdb.cc/graphql", "name": "FansDB", "api_key": "old", "max_requests_per_minute": 30}]}}}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            await StashClient(BRIDGE, client).upsert_stash_box("https://fansdb.cc/graphql", "FansDB", "new")
        self.assertEqual(sent[0], [
            {"endpoint": BOX, "name": "StashDB", "api_key": "a", "max_requests_per_minute": 0},
            {"endpoint": "https://fansdb.cc/graphql", "name": "FansDB", "api_key": "new", "max_requests_per_minute": 30}])

    async def test_scenes_by_paths_keeps_only_the_exact_file(self):
        def handle(request):
            payload = json.loads(request.content)
            self.assertEqual(payload["variables"], {"p0": "/lib/a.mkv", "p1": "/lib/b.mkv"})
            return httpx.Response(200, json={"data": {
                "p0": {"scenes": [{"id": "1", "stash_ids": [], "files": [{"id": "10", "path": "/lib/a.mkv", "duration": 1, "fingerprints": []}]}]},
                "p1": {"scenes": [{"id": "2", "stash_ids": [], "files": [{"id": "20", "path": "/lib/b.mkv.part", "duration": 1, "fingerprints": []}]}]}}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result = await StashClient(BRIDGE, client).scenes_by_paths(["/lib/a.mkv", "/lib/b.mkv"])
        self.assertEqual(result["/lib/a.mkv"]["id"], "1")
        self.assertIsNone(result["/lib/b.mkv"])

    async def test_add_scene_stash_id_replaces_same_endpoint(self):
        sent = []
        def handle(request):
            payload = json.loads(request.content)
            if "sceneUpdate" in payload["query"]:
                sent.append(payload["variables"]["input"])
                return httpx.Response(200, json={"data": {"sceneUpdate": {"id": "7"}}})
            return httpx.Response(200, json={"data": {"findScene": {"id": "7", "files": [], "stash_ids": [
                {"endpoint": BOX, "stash_id": "stale"}, {"endpoint": "https://other.invalid/graphql", "stash_id": "keep"}]}}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            await StashClient(BRIDGE, client).add_scene_stash_id("7", BOX, "fresh")
        self.assertEqual(sent[0]["stash_ids"], [{"endpoint": "https://other.invalid/graphql", "stash_id": "keep"},
                                                {"endpoint": BOX, "stash_id": "fresh"}])

    async def test_scan_generates_only_phashes(self):
        def handle(request):
            scan = json.loads(request.content)["variables"]["input"]
            self.assertTrue(scan["scanGeneratePhashes"])
            self.assertFalse(any(v for k, v in scan.items() if k.startswith("scanGenerate") and k != "scanGeneratePhashes"))
            return httpx.Response(200, json={"data": {"metadataScan": "12"}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            self.assertEqual(await StashClient(BRIDGE, client).scan(["/lib"]), "12")

    async def test_refused_key_is_reported(self):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(401))) as client:
            with self.assertRaisesRegex(RuntimeError, "refused the API key"):
                await StashClient(BRIDGE, client).stash_boxes()


if __name__ == "__main__":
    unittest.main()
