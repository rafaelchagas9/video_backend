import json
import unittest
from collections import deque

from vision_service.config import Settings
from vision_service.main import create_app

MULTIPART_OVERHEAD_BYTES = 1024 * 1024


class FakeRuntime:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings


async def invoke_asgi(
    app,
    *,
    headers: list[tuple[bytes, bytes]],
    request_messages: list[dict[str, object]],
) -> tuple[list[dict[str, object]], int]:
    pending = deque(request_messages)
    receive_calls = 0

    async def receive() -> dict[str, object]:
        nonlocal receive_calls
        receive_calls += 1
        if pending:
            return pending.popleft()
        return {"type": "http.disconnect"}

    sent: list[dict[str, object]] = []

    async def send(message: dict[str, object]) -> None:
        sent.append(message)

    await app(
        {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/v1/analyze",
            "raw_path": b"/v1/analyze",
            "query_string": b"",
            "root_path": "",
            "headers": headers,
            "client": ("127.0.0.1", 12345),
            "server": ("127.0.0.1", 8100),
        },
        receive,
        send,
    )
    return sent, receive_calls


def response_status(messages: list[dict[str, object]]) -> int:
    start = next(message for message in messages if message["type"] == "http.response.start")
    return int(start["status"])


def response_json(messages: list[dict[str, object]]) -> dict[str, object]:
    body = b"".join(
        bytes(message.get("body", b""))
        for message in messages
        if message["type"] == "http.response.body"
    )
    return json.loads(body)


class AnalyzeBodyLimitTests(unittest.IsolatedAsyncioTestCase):
    def make_app(self, *, max_batch_bytes: int = 32):
        settings = Settings(
            _env_file=None,
            max_batch_bytes=max_batch_bytes,
        )
        return create_app(runtime=FakeRuntime(settings))

    async def test_rejects_oversized_content_length_without_consuming_the_body(self) -> None:
        app = self.make_app()
        hard_limit = 32 + MULTIPART_OVERHEAD_BYTES
        multipart_prefix = b'--test\r\nContent-Disposition: form-data; name="padding"\r\n\r\n'
        multipart_suffix = b"\r\n--test--\r\n"
        padding_size = hard_limit + 1 - len(multipart_prefix) - len(multipart_suffix)
        oversized_multipart = multipart_prefix + (b"x" * padding_size) + multipart_suffix

        messages, receive_calls = await invoke_asgi(
            app,
            headers=[
                (b"content-type", b"multipart/form-data; boundary=test"),
                (b"content-length", str(len(oversized_multipart)).encode("ascii")),
            ],
            request_messages=[
                {
                    "type": "http.request",
                    "body": oversized_multipart,
                    "more_body": False,
                }
            ],
        )

        self.assertEqual(response_status(messages), 413)
        self.assertEqual(
            response_json(messages)["detail"]["code"],
            "VISION_REQUEST_BODY_TOO_LARGE",
        )
        self.assertEqual(receive_calls, 0)

    async def test_rejects_a_chunked_stream_as_soon_as_it_crosses_the_same_limit(self) -> None:
        app = self.make_app()
        hard_limit = 32 + MULTIPART_OVERHEAD_BYTES
        multipart_prefix = b'--test\r\nContent-Disposition: form-data; name="padding"\r\n\r\n'
        multipart_suffix = b"\r\n--test--\r\n"
        padding_size = hard_limit + 1 - len(multipart_prefix) - len(multipart_suffix)
        oversized_multipart = multipart_prefix + (b"x" * padding_size) + multipart_suffix
        split_at = hard_limit // 2

        messages, receive_calls = await invoke_asgi(
            app,
            headers=[
                (b"content-type", b"multipart/form-data; boundary=test"),
                (b"transfer-encoding", b"chunked"),
            ],
            request_messages=[
                {
                    "type": "http.request",
                    "body": oversized_multipart[:split_at],
                    "more_body": True,
                },
                {
                    "type": "http.request",
                    "body": oversized_multipart[split_at:],
                    "more_body": False,
                },
            ],
        )

        self.assertEqual(response_status(messages), 413)
        self.assertEqual(
            response_json(messages)["detail"]["code"],
            "VISION_REQUEST_BODY_TOO_LARGE",
        )
        self.assertEqual(receive_calls, 2)


if __name__ == "__main__":
    unittest.main()
