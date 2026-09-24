from __future__ import annotations

import json
import unittest

from vision_service.video_copies import DEFAULT_FAILURE_CODE, FAILURE_CODES, failure_payload


class VideoCopyErrorTests(unittest.TestCase):
    def test_whitelisted_prefixes_are_preserved_without_exception_text(self):
        secret = "/private/library/source-name.mp4"
        for code in FAILURE_CODES:
            with self.subTest(code=code):
                payload = failure_payload(RuntimeError(f"{code}: failure while reading {secret}"))
                serialized = json.dumps(payload)

                self.assertEqual(payload, {"error": "RuntimeError", "code": code})
                self.assertNotIn(secret, serialized)
                self.assertNotIn("failure while reading", serialized)

    def test_exact_whitelisted_code_is_preserved(self):
        self.assertEqual(
            failure_payload(ValueError("COPY_MODEL_INVALID")),
            {"error": "ValueError", "code": "COPY_MODEL_INVALID"},
        )

    def test_unknown_and_prefix_lookalike_fall_back_to_generic_code(self):
        errors = (
            RuntimeError("decoder exposed /private/source.mp4"),
            RuntimeError("COPY_MODEL_INVALIDATED: not an approved code"),
            RuntimeError(" COPY_MODEL_INVALID: leading whitespace"),
        )
        for error in errors:
            with self.subTest(message=str(error)):
                payload = failure_payload(error)
                self.assertEqual(payload["code"], DEFAULT_FAILURE_CODE)
                self.assertNotIn(str(error), json.dumps(payload))


if __name__ == "__main__":
    unittest.main()
