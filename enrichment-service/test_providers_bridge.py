"""Offline contracts: provider persistence, scrapers, fingerprints and explicit drafts."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import httpx
from enrichment_service.config import Settings
from enrichment_service.providers import Provider, ProviderPatch, configured_providers, save_provider
from enrichment_service.models import EnrichRequest, Fingerprint
from enrichment_service.sources import build_sources
from enrichment_service.sources.stash import StashSource
from enrichment_service.sources.stashbox import StashBoxSource
from enrichment_service.routes.providers import submit, ContributionRequest
from fastapi import HTTPException

class ProviderTests(unittest.TestCase):
    def test_secrets_are_write_only_and_custom_sources_persist(self):
        with tempfile.TemporaryDirectory() as folder:
            settings = Settings(_env_file=None, provider_config_path=str(Path(folder)/"providers.json"))
            provider = save_provider(settings, "custom", ProviderPatch(endpoint="https://metadata.example/graphql", api_key="private-key", enabled=True))
            self.assertNotIn("private-key", json.dumps(provider.public()))
            self.assertNotIn("api_key", provider.public())
            self.assertEqual(next(p for p in configured_providers(settings) if p.id == "custom").api_key, "private-key")
            self.assertEqual(Path(settings.provider_config_path).stat().st_mode & 0o777, 0o600)
            selected = build_sources(settings, {"custom"})
            self.assertEqual([p.name for p in selected], ["custom"])
            save_provider(settings, "custom", ProviderPatch(name="Renamed"))
            self.assertEqual(next(p for p in configured_providers(settings) if p.id == "custom").api_key, "private-key")

    def test_embedded_endpoint_secrets_rejected(self):
        for endpoint in ["https://key:secret@example.com/graphql", "https://example.com/graphql?token=secret"]:
            with self.assertRaises(ValueError):
                Provider(id="custom", name="Custom", endpoint=endpoint)

class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_creator_url_scrape_proposes_details_and_provenance(self):
        captured = []
        def handle(request):
            payload = json.loads(request.content); captured.append(payload)
            return httpx.Response(200, json={"data": {"scrapePerformerURL": {"name": "Creator", "aliases": "Alias, Another", "birthdate": "1990-01-01", "details": "Biography", "images": ["https://example.com/image.jpg"], "urls": ["https://example.com/profile"], "remote_site_id": "site-123"}}})
        bridge = StashSource(Provider(id="stash", name="Stash", kind="stash", endpoint="http://localhost/graphql"))
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            candidates = await bridge.search(EnrichRequest(name="Creator", scraper_url="https://example.com/profile"), client)
        self.assertIn("scrapePerformerURL", captured[0]["query"])
        self.assertEqual(captured[0]["variables"], {"url": "https://example.com/profile"})
        self.assertTrue(any(c.type == "bio" and c.value == "Biography" for c in candidates))
        self.assertTrue(any(c.field_key == "birth_date" for c in candidates))
        self.assertFalse(any(c.type == "external_id" for c in candidates))
        self.assertTrue(all(c.raw["remote_site_id"] == "site-123" for c in candidates))

    async def test_real_stash_fingerprint_is_used_without_generation(self):
        def handle(request):
            return httpx.Response(200, json={"data": {"findScene": {"id": "7", "files": [{"fingerprints": [{"type": "phash", "value": "0123456789abcdef"}]}]}}})
        bridge = StashSource(Provider(id="stash", name="Stash", kind="stash", endpoint="http://localhost/graphql"))
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            fingerprints = await bridge.fingerprints(client, "7")
        self.assertEqual(fingerprints[0].algorithm, "PHASH")
        self.assertEqual(fingerprints[0].hash, "0123456789abcdef")

    async def test_fingerprint_lookup_maps_scene_to_reviewable_candidates(self):
        captured = []
        def handle(request):
            captured.append(json.loads(request.content))
            return httpx.Response(200, json={"data": {"findScenesBySceneFingerprints": [[{"id": "match", "title": "Matched", "performers": [{"performer": {"id": "creator", "name": "Creator"}}]}]]}})
        source = StashBoxSource(name="fansdb", endpoint="https://example.com/graphql", api_key="secret", dialect="standard")
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            candidates = await source.search(EnrichRequest(name="File", entity_type="scene", fingerprint=Fingerprint(algorithm="PHASH", hash="0123456789abcdef")), client)
        self.assertEqual(captured[0]["variables"]["fingerprints"], [[{"algorithm": "PHASH", "hash": "0123456789abcdef"}]])
        self.assertTrue(any(c.type == "performer" and c.value == "Creator" for c in candidates))

    async def test_prepare_is_read_only_and_creator_submission_uses_official_mutation(self):
        captured = []
        def handle(request):
            payload = json.loads(request.content); captured.append(payload)
            if "mutation" in payload["query"]:
                return httpx.Response(200, json={"data": {"submitStashBoxPerformerDraft": "draft-1"}})
            return httpx.Response(200, json={"data": {"findPerformer": {"id": "42", "name": "Creator", "urls": ["https://example.com/creator"]}}})
        bridge = StashSource(Provider(id="stash", name="Stash", kind="stash", endpoint="http://localhost/graphql"))
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            preview = await bridge.prepare(client, "creator", "42", "fansdb")
            self.assertTrue(preview["ready"])
            self.assertEqual(len(captured), 1)
            self.assertTrue(captured[0]["query"].startswith("query"))
            self.assertEqual(await bridge.submit(client, "creator", "42", "https://fansdb.cc/graphql"), "draft-1")
        self.assertEqual(captured[1]["variables"]["input"], {"id": "42", "stash_box_endpoint": "https://fansdb.cc/graphql"})

    async def test_submission_refuses_missing_confirmation_before_network(self):
        with patch("enrichment_service.routes.providers.target", side_effect=AssertionError("Must not access target")):
            with self.assertRaises(HTTPException) as error:
                await submit(ContributionRequest(stash_id="42", source="fansdb"))
            self.assertEqual(error.exception.status_code, 400)

if __name__ == "__main__":
    unittest.main()
