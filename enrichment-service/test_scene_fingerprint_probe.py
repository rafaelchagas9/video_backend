from __future__ import annotations

import tempfile
import unittest
from argparse import Namespace
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

import httpx

from scripts.probe_scene_fingerprints import (
    OSHASH_MINIMUM_SIZE,
    compute_oshash,
    lookup_scenes,
    run,
)


def synthetic_file(directory: str) -> Path:
    path = Path(directory) / "fixture.bin"
    path.write_bytes(bytes(index % 251 for index in range(OSHASH_MINIMUM_SIZE + 4096)))
    return path


class SceneFingerprintProbeTests(unittest.IsolatedAsyncioTestCase):
    def test_oshash_is_deterministic_and_sensitive_to_boundary_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            original = synthetic_file(directory)
            first = compute_oshash(original)
            self.assertEqual(first, compute_oshash(original))
            self.assertRegex(first, r"^[0-9a-f]{16}$")

            changed_path = Path(directory) / "changed.bin"
            data = bytearray(original.read_bytes())
            data[-1] ^= 0xFF
            changed_path.write_bytes(data)
            self.assertNotEqual(first, compute_oshash(changed_path))

    def test_oshash_rejects_too_small_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "small.bin"
            path.write_bytes(b"x" * (OSHASH_MINIMUM_SIZE - 1))
            with self.assertRaisesRegex(ValueError, "requires at least"):
                compute_oshash(path)

    async def test_lookup_uses_exact_graphql_shape_and_returns_first_batch(self) -> None:
        seen: dict[str, object] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["authorization"] = request.headers.get("authorization")
            seen["body"] = request.content.decode()
            return httpx.Response(
                200,
                json={
                    "data": {
                        "findScenesBySceneFingerprints": [
                            [{"id": "scene-1", "title": "Synthetic", "duration": 12}]
                        ]
                    }
                },
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            matches = await lookup_scenes(
                client=client,
                endpoint="https://provider.invalid/graphql",
                headers={"Authorization": "Bearer test-key"},
                algorithm="oshash",
                fingerprint="0123456789abcdef",
            )

        self.assertEqual(seen["authorization"], "Bearer test-key")
        self.assertIn('"algorithm":"OSHASH"', str(seen["body"]).replace(" ", ""))
        self.assertEqual(
            matches,
            [{"id": "scene-1", "title": "Synthetic", "duration": 12}],
        )

    async def test_lookup_handles_unknown_hash_and_graphql_errors(self) -> None:
        async def request_with(body: dict[str, object]) -> list[dict[str, object]]:
            transport = httpx.MockTransport(lambda _request: httpx.Response(200, json=body))
            async with httpx.AsyncClient(transport=transport) as client:
                return await lookup_scenes(
                    client=client,
                    endpoint="https://provider.invalid/graphql",
                    headers={},
                    algorithm="oshash",
                    fingerprint="0123456789abcdef",
                )

        self.assertEqual(
            await request_with({"data": {"findScenesBySceneFingerprints": [[]]}}),
            [],
        )
        with self.assertRaisesRegex(RuntimeError, "GraphQL errors"):
            await request_with({"errors": [{"message": "not authorized"}]})

    async def test_lookup_surfaces_auth_and_rate_limit_http_errors(self) -> None:
        for status in (401, 429):
            with self.subTest(status=status):
                transport = httpx.MockTransport(
                    lambda _request, response_status=status: httpx.Response(
                        response_status
                    )
                )
                async with httpx.AsyncClient(transport=transport) as client:
                    with self.assertRaises(httpx.HTTPStatusError):
                        await lookup_scenes(
                            client=client,
                            endpoint="https://provider.invalid/graphql",
                            headers={},
                            algorithm="oshash",
                            fingerprint="0123456789abcdef",
                        )

    async def test_lookup_rejects_malformed_graphql_response(self) -> None:
        transport = httpx.MockTransport(
            lambda _request: httpx.Response(200, json={"data": {}})
        )
        async with httpx.AsyncClient(transport=transport) as client:
            with self.assertRaisesRegex(RuntimeError, "malformed fingerprint result"):
                await lookup_scenes(
                    client=client,
                    endpoint="https://provider.invalid/graphql",
                    headers={},
                    algorithm="oshash",
                    fingerprint="0123456789abcdef",
                )

    async def test_local_mode_prints_no_input_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = synthetic_file(directory)
            output = StringIO()
            with redirect_stdout(output):
                result = await run(
                    Namespace(
                        input=path,
                        algorithm="oshash",
                        duration_seconds=10.0,
                        lookup=False,
                        source=None,
                    )
                )
            self.assertEqual(result, 0)
            self.assertNotIn(str(path), output.getvalue())
            self.assertIn("algorithm=oshash", output.getvalue())


if __name__ == "__main__":
    unittest.main()
