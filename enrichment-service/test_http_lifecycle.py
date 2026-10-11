from __future__ import annotations

import asyncio
import unittest
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from pydantic import ValidationError

from enrichment_service.config import Settings
from enrichment_service.http_client import http_client, http_lifespan
from enrichment_service.models import EnrichRequest
from enrichment_service.routes.enrich import enrich


class HttpLifecycle(unittest.IsolatedAsyncioTestCase):
    async def test_reuses_pools_preserves_timeout_profiles_and_closes_at_shutdown(self):
        created = []
        sent_keys = []

        def handle(request):
            sent_keys.append(request.headers.get("ApiKey"))
            return httpx.Response(200, json={"ok": True})

        def factory(timeout):
            client = httpx.AsyncClient(timeout=timeout, transport=httpx.MockTransport(handle))
            created.append(client)
            return client

        settings = SimpleNamespace(request_timeout_seconds=30)
        with patch("enrichment_service.http_client.get_settings", return_value=settings), patch("enrichment_service.http_client._client", side_effect=factory):
            async with http_lifespan():
                async with http_client(timeout=30) as first:
                    await first.post("https://provider.invalid/graphql", headers={"ApiKey": "first-key"})
                self.assertFalse(first.is_closed)
                async with http_client(timeout=30) as second:
                    self.assertIs(first, second)
                    await second.post("https://provider.invalid/graphql", headers={"ApiKey": "second-key"})
                async with http_client(timeout=120) as long:
                    self.assertIsNot(first, long)
                    self.assertEqual(long.timeout.read, 120)
                self.assertEqual(len(created), 2)
            self.assertTrue(all(client.is_closed for client in created))
            async with http_lifespan():
                async with http_client(timeout=30) as restarted:
                    self.assertIsNot(first, restarted)
        self.assertEqual(sent_keys, ["first-key", "second-key"])

    async def test_cancelling_request_does_not_close_shared_pool(self):
        client = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200)))
        with patch("enrichment_service.http_client.get_settings", return_value=SimpleNamespace(request_timeout_seconds=120)), patch("enrichment_service.http_client._client", return_value=client):
            async with http_lifespan():
                with self.assertRaises(asyncio.CancelledError):
                    async with http_client(timeout=120):
                        raise asyncio.CancelledError()
                self.assertFalse(client.is_closed)
                async with http_client(timeout=120) as reused:
                    self.assertEqual((await reused.get("https://provider.invalid")).status_code, 200)
        self.assertTrue(client.is_closed)

    async def test_standalone_client_closes_without_lifespan(self):
        client = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200)))
        with patch("enrichment_service.http_client._client", return_value=client):
            async with http_client(timeout=30) as scoped:
                self.assertIs(scoped, client)
        self.assertTrue(client.is_closed)

    async def test_app_lifespan_wires_routes_to_shared_clients(self):
        settings = Settings(_env_file=None)
        created = []

        def factory(timeout):
            client = httpx.AsyncClient(timeout=timeout, transport=httpx.MockTransport(lambda _: httpx.Response(200)))
            created.append(client)
            return client

        source = SimpleNamespace(name="example", search=AsyncMock(return_value=[]))
        with patch("enrichment_service.config.get_settings", return_value=settings):
            from enrichment_service.main import create_app
            app = create_app()
        with patch("enrichment_service.http_client.get_settings", return_value=settings), patch("enrichment_service.http_client._client", side_effect=factory), patch("enrichment_service.routes.enrich.get_settings", return_value=settings), patch("enrichment_service.routes.enrich.build_sources", return_value=[source]):
            async with app.router.lifespan_context(app):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://service.invalid") as local:
                    for _ in range(2):
                        response = await local.post("/enrich", json={"name": "Synthetic"})
                        self.assertEqual(response.status_code, 200)
                    self.assertIs(source.search.await_args_list[0].args[1], source.search.await_args_list[1].args[1])
                    self.assertEqual(len(created), 2)
            self.assertTrue(all(client.is_closed for client in created))

    async def test_connect_and_pool_timeout_are_shorter_than_long_reads(self):
        with patch("enrichment_service.http_client.get_settings", return_value=SimpleNamespace(connect_timeout_seconds=5, pool_timeout_seconds=3)):
            async with http_client(timeout=120) as client:
                self.assertEqual(client.timeout.connect, 5)
                self.assertEqual(client.timeout.pool, 3)
                self.assertEqual(client.timeout.read, 120)
                self.assertEqual(client.timeout.write, 120)

    def test_invalid_timeout_configuration_is_refused(self):
        for field in ("request_timeout_seconds", "connect_timeout_seconds", "pool_timeout_seconds"):
            with self.assertRaises(ValidationError):
                Settings(_env_file=None, **{field: 0})

    async def test_success_is_debug_without_personal_query_and_errors_stay_visible(self):
        source = SimpleNamespace(name="example", search=AsyncMock(return_value=[]))

        @asynccontextmanager
        async def mocked_client(**_kwargs):
            yield object()

        with patch("enrichment_service.routes.enrich.get_settings", return_value=SimpleNamespace(request_timeout_seconds=30)), patch("enrichment_service.routes.enrich.build_sources", return_value=[source]), patch("enrichment_service.routes.enrich.http_client", mocked_client), patch("enrichment_service.routes.enrich.logger") as logger:
            result = await enrich(EnrichRequest(name="Private query"))
            self.assertEqual(result.sources_used, ["example"])
            logger.info.assert_not_called()
            logger.debug.assert_called_once_with("source=%s candidates=%d", "example", 0)
            source.search.side_effect = RuntimeError("https://provider.invalid/private-key")
            result = await enrich(EnrichRequest(name="Private query"))
            logger.warning.assert_called_once()
            self.assertNotIn("private-key", result.errors[0])


if __name__ == "__main__":
    unittest.main()
