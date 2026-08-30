"""Bound the versioned multipart request before Starlette parses or spools it."""

from __future__ import annotations

from collections import deque

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

VISION_MULTIPART_OVERHEAD_BYTES = 1024 * 1024


class VisionAnalyzeBodyLimitMiddleware:
    """Apply one stable hard body limit to POST /v1/analyze."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        max_batch_bytes: int,
        multipart_overhead_bytes: int = VISION_MULTIPART_OVERHEAD_BYTES,
    ) -> None:
        self.app = app
        self.max_body_bytes = max_batch_bytes + multipart_overhead_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope.get("method") != "POST"
            or scope.get("path") != "/v1/analyze"
        ):
            await self.app(scope, receive, send)
            return

        content_length = self._content_length(scope)
        if content_length is not None and content_length > self.max_body_bytes:
            await self._send_too_large(send)
            return

        buffered_messages: deque[Message] = deque()
        consumed_bytes = 0
        while True:
            message = await receive()
            buffered_messages.append(message)
            if message["type"] == "http.disconnect":
                break
            if message["type"] != "http.request":
                continue
            consumed_bytes += len(message.get("body", b""))
            if consumed_bytes > self.max_body_bytes:
                await self._send_too_large(send)
                return
            if not message.get("more_body", False):
                break

        async def receive_buffered() -> Message:
            if buffered_messages:
                return buffered_messages.popleft()
            return await receive()

        await self.app(scope, receive_buffered, send)

    @staticmethod
    def _content_length(scope: Scope) -> int | None:
        values = [
            value for name, value in scope.get("headers", []) if name.lower() == b"content-length"
        ]
        if not values:
            return None
        try:
            parsed = [int(value) for value in values]
        except ValueError:
            return None
        if len(set(parsed)) != 1 or parsed[0] < 0:
            return None
        return parsed[0]

    async def _send_too_large(self, send: Send) -> None:
        response = JSONResponse(
            status_code=413,
            content={
                "detail": {
                    "code": "VISION_REQUEST_BODY_TOO_LARGE",
                    "message": ("Vision multipart request exceeds the configured body limit"),
                }
            },
        )
        await response({"type": "http"}, receive=None, send=send)
