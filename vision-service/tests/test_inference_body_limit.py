"""Pure ASGI checks: no app startup, model loading, media or network access."""
import unittest

from vision_service.body_limit import VisionAnalyzeBodyLimitMiddleware


class InferenceBodyLimitTests(unittest.IsolatedAsyncioTestCase):
    async def invoke(self, path, *, declared=None, chunks=()):
        called = False
        reads = 0
        messages = []
        pending = iter(chunks)

        async def app(scope, receive, send):
            nonlocal called
            called = True
            while True:
                message = await receive()
                if not message.get("more_body", False):
                    break
            await send({"type": "http.response.start", "status": 204, "headers": []})
            await send({"type": "http.response.body", "body": b""})

        async def receive():
            nonlocal reads
            reads += 1
            return next(pending, {"type": "http.disconnect"})

        async def send(message):
            messages.append(message)

        middleware = VisionAnalyzeBodyLimitMiddleware(app, max_batch_bytes=8, multipart_overhead_bytes=2)
        await middleware({"type": "http", "method": "POST", "path": path,
                          "headers": [] if declared is None else [(b"content-length", str(declared).encode())]}, receive, send)
        status = next(message["status"] for message in messages if message["type"] == "http.response.start")
        return status, called, reads

    async def test_every_inference_route_rejects_declared_oversize_before_reading(self):
        for path in VisionAnalyzeBodyLimitMiddleware.inference_paths:
            for route in (path, path + "/"):
                with self.subTest(route=route):
                    self.assertEqual(await self.invoke(route, declared=11), (413, False, 0))

    async def test_every_inference_route_rejects_chunked_overflow_before_parser(self):
        for path in VisionAnalyzeBodyLimitMiddleware.inference_paths:
            with self.subTest(path=path):
                chunks = ({"type": "http.request", "body": b"123456", "more_body": True},
                          {"type": "http.request", "body": b"78901", "more_body": True})
                self.assertEqual(await self.invoke(path, chunks=chunks), (413, False, 2))

    async def test_exact_limit_replays_chunks_and_unrelated_routes_are_unchanged(self):
        chunks = ({"type": "http.request", "body": b"12345", "more_body": True},
                  {"type": "http.request", "body": b"67890", "more_body": False})
        for path in VisionAnalyzeBodyLimitMiddleware.inference_paths:
            with self.subTest(path=path):
                self.assertEqual(await self.invoke(path, declared=10, chunks=chunks), (204, True, 2))
        self.assertEqual(await self.invoke("/health", declared=999, chunks=chunks), (204, True, 2))


if __name__ == "__main__":
    unittest.main()
