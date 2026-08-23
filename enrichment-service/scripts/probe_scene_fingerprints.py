"""Non-production probe for StashBox scene fingerprint lookup.

Hashes only the explicit file passed with ``--input`` and performs network
lookup only when ``--lookup`` is also present. It never prints the input path,
credentials, request headers, or raw provider responses.
"""

from __future__ import annotations

import argparse
import asyncio
import struct
from pathlib import Path
from typing import Any

import httpx

from enrichment_service.config import get_settings

OSHASH_BLOCK_SIZE = 64 * 1024
OSHASH_MINIMUM_SIZE = OSHASH_BLOCK_SIZE * 2
UINT64_MASK = (1 << 64) - 1

FINGERPRINT_LOOKUP_QUERY = """
query FindScenesBySceneFingerprints($fingerprints: [[FingerprintQueryInput!]!]!) {
  findScenesBySceneFingerprints(fingerprints: $fingerprints) {
    id
    title
    duration
  }
}
"""


def compute_oshash(input_path: Path) -> str:
    """Compute the OpenSubtitles 64-bit hash used by Stash as ``oshash``."""
    size = input_path.stat().st_size
    if size < OSHASH_MINIMUM_SIZE:
        raise ValueError(f"oshash requires at least {OSHASH_MINIMUM_SIZE} bytes")

    checksum = size
    with input_path.open("rb") as stream:
        first = stream.read(OSHASH_BLOCK_SIZE)
        stream.seek(-OSHASH_BLOCK_SIZE, 2)
        last = stream.read(OSHASH_BLOCK_SIZE)

    for block in (first, last):
        if len(block) != OSHASH_BLOCK_SIZE:
            raise ValueError("could not read complete oshash boundary blocks")
        for (word,) in struct.iter_unpack("<Q", block):
            checksum = (checksum + word) & UINT64_MASK

    return f"{checksum:016x}"


async def lookup_scenes(
    *,
    client: httpx.AsyncClient,
    endpoint: str,
    headers: dict[str, str],
    algorithm: str,
    fingerprint: str,
) -> list[dict[str, Any]]:
    """Call the documented StashBox fingerprint query and flatten one input."""
    response = await client.post(
        endpoint,
        headers={
            **headers,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "enrichment-service-fingerprint-spike/0.1",
        },
        json={
            "query": FINGERPRINT_LOOKUP_QUERY,
            "variables": {
                "fingerprints": [
                    [{"algorithm": algorithm.upper(), "hash": fingerprint}]
                ]
            },
        },
    )
    response.raise_for_status()
    body = response.json()
    if body.get("errors"):
        raise RuntimeError("provider returned GraphQL errors")
    data = body.get("data")
    if not isinstance(data, dict):
        raise RuntimeError("provider returned a malformed GraphQL response")
    batches = data.get("findScenesBySceneFingerprints")
    if not isinstance(batches, list):
        raise RuntimeError("provider returned a malformed fingerprint result")
    if not batches:
        return []
    matches = batches[0]
    if not isinstance(matches, list):
        return []
    return [item for item in matches if isinstance(item, dict)]


def provider_config(source: str) -> tuple[str, dict[str, str]]:
    settings = get_settings()
    if source == "stashdb":
        if not settings.stashdb_api_key:
            raise ValueError("StashDB credentials are not configured")
        return settings.stashdb_endpoint, {"ApiKey": settings.stashdb_api_key}
    if not settings.theporndb_api_key:
        raise ValueError("ThePornDB credentials are not configured")
    return settings.theporndb_base_url, {
        "Authorization": f"Bearer {settings.theporndb_api_key}"
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Compute an explicit file's oshash and optionally probe scene lookup."
    )
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--algorithm", required=True, choices=("oshash",))
    parser.add_argument("--duration-seconds", type=float)
    parser.add_argument("--lookup", action="store_true")
    parser.add_argument("--source", choices=("stashdb", "theporndb"))
    return parser


async def run(args: argparse.Namespace) -> int:
    if args.duration_seconds is not None and args.duration_seconds <= 0:
        raise ValueError("duration must be positive")
    fingerprint = compute_oshash(args.input)
    duration = (
        f"{args.duration_seconds:g}" if args.duration_seconds is not None else "unknown"
    )
    print(f"algorithm=oshash fingerprint={fingerprint} duration_seconds={duration}")

    if not args.lookup:
        return 0
    if not args.source:
        raise ValueError("--source is required with --lookup")

    endpoint, headers = provider_config(args.source)
    settings = get_settings()
    async with httpx.AsyncClient(timeout=settings.request_timeout_seconds) as client:
        matches = await lookup_scenes(
            client=client,
            endpoint=endpoint,
            headers=headers,
            algorithm="oshash",
            fingerprint=fingerprint,
        )
    print(f"source={args.source} candidate_count={len(matches)}")
    return 0


def main() -> int:
    args = build_parser().parse_args()
    try:
        return asyncio.run(run(args))
    except (OSError, ValueError, httpx.HTTPError, RuntimeError) as error:
        print(f"probe_failed={type(error).__name__}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
