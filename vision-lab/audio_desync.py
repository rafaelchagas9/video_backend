"""Which reviewed recordings may have audio out of sync with the picture, kept beside the data.

Until 2026-10-22 03:26 UTC GoondVR zeroed the audio and video tracks of a live capture separately,
so every capture it made before then plays its sound a constant 0.2–3 s off (never drifting); the
true offset is lost. Captures started after the fixed container went live are in sync. Library
downloads (non-GoondVR files) were never affected.

What this means for training (see audio-desync.md):

* frame embeddings and hand labels are unaffected — the picture is fine;
* clip-level sound summaries (minutes long) are barely moved;
* anything pairing a sound with the exact frame on screen is wrong by up to 3 s on suspects;
* a reviewer may have skipped a good moment only because the desync was unbearable. Those skips
  were not marked before the `skip_desync` reason existed, so on suspect recordings a skip is a
  weaker "not worth it" than on in-sync ones. Clips with `skip_desync`, and recordings deleted as
  `discard_desync`, are not content judgements at all.

  uv run python audio_desync.py    # rewrite audio-desync-recordings.csv from the DB + snapshots
"""

from __future__ import annotations

import csv
import json
import re
from datetime import datetime, timezone
from pathlib import Path

# The fixed GoondVR container went live then (shared-clock Timeline); captures started earlier are suspect.
FIX_DEPLOYED = datetime(2026, 10, 22, 3, 26, tzinfo=timezone.utc)
# GoondVR names files <channel>_<YYYY-MM-DD>_<HH-MM-SS>[_<part>].<ext>, in UTC.
CAPTURE_NAME = re.compile(r"^(?P<channel>.+)_(?P<day>\d{4}-\d{2}-\d{2})_(?P<time>\d{2}-\d{2}-\d{2})(?:_\d+)?\.\w+$")
DESYNC_REASONS = {"skip_desync", "discard_desync"}
CSV = Path(__file__).resolve().parent / "audio-desync-recordings.csv"


def captured_at(file_name: str | None) -> datetime | None:
    """When GoondVR started this capture, None for a file it did not name."""
    match = CAPTURE_NAME.match(file_name or "")
    if not match:
        return None
    return datetime.strptime(f"{match['day']} {match['time']}", "%Y-%m-%d %H-%M-%S").replace(tzinfo=timezone.utc)


def desync_suspect(file_name: str | None) -> bool:
    """A GoondVR capture from before the fix: its audio may be up to 3 s off the picture."""
    at = captured_at(file_name)
    return at is not None and at < FIX_DEPLOYED


def desync_marked(reasons: list[str] | None) -> bool:
    """The reviewer said this decision was about the desync, not the content."""
    return bool(DESYNC_REASONS.intersection(reasons or []))


def _names() -> dict[int, str]:
    import psycopg

    from label_server import PG
    from training_snapshots import ROOT

    names: dict[int, str] = {}
    # Deleted recordings keep their name in snapshots and the recorder's outcome log.
    for manifest in sorted(ROOT.glob("*/review-*.json")):
        try:
            source = json.loads(manifest.read_text()).get("source") or {}
        except ValueError:
            continue
        if isinstance(source.get("videoId"), int) and source.get("fileName"):
            names[source["videoId"]] = source["fileName"]
    with psycopg.connect(PG) as pg:
        rows = pg.execute("select distinct video_id, file_name from recorder_autopilot_outcomes where video_id is not null").fetchall()
        rows += pg.execute("select id, file_name from videos").fetchall()
    names.update({vid: name for vid, name in rows if name})
    return names


def write_csv(path: Path = CSV) -> int:
    """One row per recording that has review decisions or a training snapshot."""
    import psycopg

    from label_server import PG
    from training_snapshots import ROOT

    with psycopg.connect(PG) as pg:
        decided = {
            row[0]: row[1:]
            for row in pg.execute(
                """select f.video_id, count(*) filter (where f.verdict = 'keep'), count(*) filter (where f.verdict = 'skip'),
                          count(*) filter (where f.reasons ?| array['skip_desync', 'discard_desync']), bool_or(f.recording_discarded)
                   from recording_clip_feedback f
                   join (select video_id, max(analyzed_at) a from recording_clip_feedback group by video_id) l
                     on l.video_id = f.video_id and l.a = f.analyzed_at
                   where f.merged_into is null group by f.video_id"""
            ).fetchall()
        }
        on_disk = {row[0] for row in pg.execute("select id from videos").fetchall()}
    snapshotted = {int(d.name) for d in ROOT.iterdir() if d.is_dir() and d.name.isdigit()} if ROOT.exists() else set()
    names = _names()
    rows = []
    for vid in sorted(set(decided) | snapshotted):
        name = names.get(vid)
        at = captured_at(name)
        keeps, skips, marked, discarded = decided.get(vid, (0, 0, 0, False))
        rows.append({
            "video_id": vid,
            "file_name": name or "",
            "captured_at_utc": at.isoformat() if at else "",
            "desync_suspect": "yes" if desync_suspect(name) else ("no" if at else "not-goondvr" if name else "unknown"),
            "keeps": keeps,
            "skips": skips,
            "desync_marked": marked,
            "has_decisions": "yes" if vid in decided else "no",
            "deleted": "no" if vid in on_disk else "yes",
            "discarded_from_review": "yes" if discarded else "no",
        })
    with path.open("w", newline="") as out:
        writer = csv.DictWriter(out, fieldnames=list(rows[0]) if rows else ["video_id"])
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)


if __name__ == "__main__":
    count = write_csv()
    print(f"{count} recordings → {CSV.name}")
