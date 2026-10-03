"""Check that the running Stash still answers every call Kura depends on.

Run after bumping the Stash image tag (ops/stash/compose.yml):

    uv run python scripts/check_stash_contract.py "a scene title to search"

Read-only: queries configuration, the library and one stash-box search per
configured endpoint. Exits non-zero naming the first call whose shape changed.
"""
from __future__ import annotations

import asyncio
import sys

import httpx

from enrichment_service.config import get_settings
from enrichment_service.sources import stash_bridge
from enrichment_service.stash_client import StashClient

SCENE_KEYS = {"title", "date", "duration", "remote_site_id", "fingerprints", "studio", "tags", "performers", "urls", "image"}
PERFORMER_KEYS = {"name", "gender", "remote_site_id", "aliases", "measurements", "urls", "images"}


def require(label: str, value: object, keys: set[str] | None = None) -> None:
    if value is None:
        raise SystemExit(f"FAIL {label}: missing")
    if keys and isinstance(value, dict) and not keys <= set(value):
        raise SystemExit(f"FAIL {label}: missing fields {sorted(keys - set(value))}")
    print(f"ok   {label}")


async def main(term: str) -> None:
    bridge = stash_bridge(get_settings())
    if bridge is None:
        raise SystemExit("FAIL bridge: configure the Stash provider first")
    async with httpx.AsyncClient(timeout=120) as http:
        stash = StashClient(bridge, http)
        version = (await stash.query("{ version { version } }"))["version"]["version"]
        print(f"Stash {version}")
        boxes = await stash.stash_boxes()
        require("configuration.stashBoxes", boxes)
        libraries = await stash.library_paths()
        require("configuration.stashes", libraries)
        files = (await stash.query("{ findFiles(filter:{per_page:1}) { files { path } } }"))["findFiles"]["files"]
        if files:
            scene = (await stash.scenes_by_paths([files[0]["path"]]))[files[0]["path"]]
            require("findScenes(path EQUALS)", scene, {"id", "files", "stash_ids"})
        for box in boxes:
            scenes = await stash.scrape_scene_query(box["endpoint"], term)
            require(f"scrapeSingleScene[{box['name']}]", scenes[0] if scenes else {}, SCENE_KEYS)
            performers = await stash.scrape_performer_query(box["endpoint"], (scenes[0]["performers"] or [{}])[0].get("name") or term) if scenes else []
            if performers:
                require(f"scrapeSinglePerformer[{box['name']}]", performers[0], PERFORMER_KEYS)
        print("Contract holds.")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "Studio"))
