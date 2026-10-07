"""Local labeling UI for recording frames.

A recording is a sequence of storyboard frames (one per 5 s), and streams sit in one state for
minutes at a time. So the UI does not ask about frames: it cuts each recording into *scenes* —
runs of consecutive frames whose SigLIP embeddings stay close — and asks for one label per
scene. A scene that turns out mixed is split by hand; labels are stored per frame, and label
changes become scene boundaries, so splits survive a reload.

Labels live in data/labels.sqlite keyed by (video_id, frame_index), independent of any model.

  uv run python label_server.py           # real recordings (Postgres + storyboard pages)
  uv run python label_server.py --demo    # stitched demo trailers, for UI work
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sqlite3
from contextlib import closing
from functools import lru_cache
from pathlib import Path

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, Response
from PIL import Image
from pydantic import BaseModel

from label_model import LabelModel, disagreements, suggestions

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT.parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)
PG = "host=localhost port=5432 dbname=video_streaming_db user=vueverse password=vueverse_dev_password"

LABELS = ("idle", "tease", "nude", "explicit", "unsure")
TILES_PER_PAGE = 25

# Long static stretches are still cut, so a slow change inside them gets looked at.
SCENE_MAX_FRAMES = 24


def channel_of(file_name: str) -> str:
    return re.sub(r"_\d{4}-\d\d-\d\d.*", "", file_name)


class RealSource:
    """Recordings with a highlight review, frames from paged storyboards, embeddings from Postgres."""

    labels_db = DATA / "labels.sqlite"
    # A frame joins the current scene while it stays this close (cosine) to the scene's mean.
    scene_similarity = 0.86

    @lru_cache(maxsize=1)
    def recordings(self) -> dict[int, dict]:
        import psycopg

        with psycopg.connect(PG) as pg:
            rows = pg.execute(
                """select v.id, v.file_name, v.duration_seconds, s.sprite_path, s.tile_width,
                          s.tile_height, s.tile_count, s.interval_seconds
                   from recording_reviews r
                   join videos v on v.id = r.video_id
                   join storyboards s on s.video_id = r.video_id
                   order by v.file_name"""
            ).fetchall()
        return {
            row[0]: {
                "id": row[0], "file_name": row[1], "channel": channel_of(row[1]),
                "duration": row[2], "sprite": row[3], "w": row[4], "h": row[5],
                "count": row[6], "interval": row[7],
            }
            for row in rows
        }

    def embeddings(self, video_id: int) -> np.ndarray:
        exported = DATA / "emb" / "siglip2-so400m-256" / f"{video_id}.npy"
        if exported.exists():
            return np.load(exported).astype(np.float32)
        return self._embeddings_from_db(video_id)

    @lru_cache(maxsize=8)
    def _embeddings_from_db(self, video_id: int) -> np.ndarray:
        import psycopg

        count = self.recordings()[video_id]["count"]
        out = np.zeros((count, 1152), dtype=np.float32)
        with psycopg.connect(PG) as pg:
            for index, text in pg.execute(
                "select frame_index, embedding::text from video_frame_embeddings where video_id = %s",
                (video_id,),
            ):
                if index < count:
                    out[index] = json.loads(text)
        return out

    @lru_cache(maxsize=48)
    def _page(self, video_id: int, page: int) -> Image.Image:
        sprite = BACKEND / self.recordings()[video_id]["sprite"]
        return Image.open(sprite.with_name(sprite.name.replace(".p0.webp", f".p{page}.webp"))).convert("RGB")

    def frame(self, video_id: int, index: int) -> Image.Image:
        rec = self.recordings()[video_id]
        page = self._page(video_id, index // TILES_PER_PAGE)
        pos = index % TILES_PER_PAGE
        columns = min(5, page.width // rec["w"])
        x, y = (pos % columns) * rec["w"], (pos // columns) * rec["h"]
        return page.crop((x, y, x + rec["w"], y + rec["h"]))


class DemoSource:
    """Fake multi-scene "recordings" stitched from the demo trailers, so the UI can be reviewed
    without real footage. Same shapes as RealSource."""

    labels_db = DATA / "labels.demo.sqlite"
    # Trailers cut every few seconds; a lower bar groups them into stream-like scenes.
    scene_similarity = 0.6
    demo = BACKEND / "demo_mode"

    @lru_cache(maxsize=1)
    def _clips(self) -> list[dict]:
        index = json.loads((self.demo / "visual" / "index.json").read_text())
        vectors = np.fromfile(self.demo / "visual" / "vectors.f16", dtype=np.float16)
        vectors = vectors.reshape(-1, index["dimension"]).astype(np.float32)
        names = {
            path.name[: -len("_sprite.jpg")]
            for path in (self.demo / "storyboard").iterdir()
            if path.name.endswith("_sprite.jpg")
        }

        def slug(text: str) -> str:
            return re.sub(r"_+", "_", re.sub(r"[^a-z0-9]+", "_", text.lower())).strip("_")

        clips = []
        for entry in index["entries"]:
            stem = entry["fileName"].rsplit(".", 1)[0]
            name = next((c for c in (stem.lower(), slug(stem)) if c in names), None)
            if not name:
                continue
            cues = re.findall(r"#xywh=(\d+),(\d+),(\d+),(\d+)", (self.demo / "storyboard" / f"{name}.vtt").read_text())
            count = min(len(cues), len(entry["timestamps"]))
            clips.append({
                "sprite": self.demo / "storyboard" / f"{name}_sprite.jpg",
                "cues": [tuple(map(int, cue)) for cue in cues[:count]],
                "vectors": vectors[entry["offset"] : entry["offset"] + count],
            })
        return clips

    @lru_cache(maxsize=1)
    def recordings(self) -> dict[int, dict]:
        clips = self._clips()
        rng = np.random.default_rng(7)
        channels = ["luna_live", "mira_cam", "ivy_stream", "nova_rooms"]
        out = {}
        for number in range(8):
            picks = rng.choice(len(clips), size=6, replace=False)
            frames = [(int(c), k) for c in picks for k in range(len(clips[c]["cues"]))]
            video_id = 900 + number
            out[video_id] = {
                "id": video_id,
                "file_name": f"{channels[number % 4]}_2026-10-0{number % 5 + 1}_2{number}-00-00.mp4",
                "channel": channels[number % 4],
                "duration": len(frames) * 5.0, "count": len(frames), "interval": 5.0,
                "frames": frames,
            }
        return out

    def embeddings(self, video_id: int) -> np.ndarray:
        clips = self._clips()
        return np.stack([clips[c]["vectors"][k] for c, k in self.recordings()[video_id]["frames"]])

    @lru_cache(maxsize=48)
    def _sprite(self, clip: int) -> Image.Image:
        return Image.open(self._clips()[clip]["sprite"]).convert("RGB")

    def frame(self, video_id: int, index: int) -> Image.Image:
        clip, k = self.recordings()[video_id]["frames"][index]
        x, y, w, h = self._clips()[clip]["cues"][k]
        return self._sprite(clip).crop((x, y, x + w, y + h))


source: RealSource | DemoSource = RealSource()
app = FastAPI()
model: LabelModel | None = None


def label_model() -> LabelModel:
    global model
    if model is None:
        model = LabelModel(source.recordings, source.embeddings, all_labels, labels_version)
    return model


def labels_db() -> sqlite3.Connection:
    db = sqlite3.connect(source.labels_db)
    db.execute(
        """create table if not exists frame_labels (
            video_id integer not null,
            frame_index integer not null,
            timestamp_seconds real not null,
            label text not null,
            updated_at text not null default (datetime('now')),
            primary key (video_id, frame_index))"""
    )
    # Frames whose label survived (or came out of) a Review — no longer shown as disagreements.
    columns = {row[1] for row in db.execute("pragma table_info(frame_labels)")}
    if "confirmed" not in columns:
        db.execute("alter table frame_labels add column confirmed integer not null default 0")
    return db


def all_labels() -> dict[int, dict[int, str]]:
    out: dict[int, dict[int, str]] = {}
    with closing(labels_db()) as db:
        for video_id, frame, label in db.execute("select video_id, frame_index, label from frame_labels"):
            out.setdefault(video_id, {})[frame] = label
    return out


def confirmed_frames() -> set[tuple[int, int]]:
    with closing(labels_db()) as db:
        return set(db.execute("select video_id, frame_index from frame_labels where confirmed = 1").fetchall())


def labels_version() -> tuple:
    with closing(labels_db()) as db:
        return tuple(db.execute("select count(*), max(updated_at) from frame_labels").fetchone())


def frame_labels(video_id: int) -> dict[int, str]:
    with closing(labels_db()) as db:
        return dict(db.execute(
            "select frame_index, label from frame_labels where video_id = ?", (video_id,)
        ).fetchall())


def scenes(embeddings: np.ndarray, labels: dict[int, str], similarity: float) -> list[list[int]]:
    """[start, end] inclusive frame ranges. Cut where a frame drifts from the running scene
    mean, where a scene grows too long, and wherever the stored label changes. A lone frame
    (a flash, a glitch) folds into the scene before it instead of costing a decision."""
    norms = np.linalg.norm(embeddings, axis=1)
    out: list[list[int]] = []
    total = np.zeros(embeddings.shape[1], dtype=np.float32)
    for index in range(len(embeddings)):
        cut = not out
        if out:
            length = index - out[-1][0]
            if labels.get(index) != labels.get(index - 1) or length >= SCENE_MAX_FRAMES:
                cut = True
            elif norms[index] > 0 and np.linalg.norm(total) > 0:
                mean = total / np.linalg.norm(total)
                cut = float(embeddings[index] @ mean) / norms[index] < similarity
        lone = len(out) > 1 and out[-1][0] == out[-1][1] and labels.get(out[-1][0]) == labels.get(out[-2][1])
        if cut and lone and out[-2][1] - out[-2][0] + 1 < SCENE_MAX_FRAMES:
            out.pop()
            out[-1][1] = index - 1
        if cut:
            out.append([index, index])
            total = np.zeros_like(total)
        else:
            out[-1][1] = index
        if norms[index] > 0:
            total += embeddings[index] / norms[index]
    if len(out) > 1 and out[0][0] == out[0][1] and labels.get(0) == labels.get(1):
        out[1][0] = 0
        out.pop(0)
    return out


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return (ROOT / "label_ui.html").read_text()


@app.get("/api/recordings")
def list_recordings() -> dict:
    with closing(labels_db()) as db:
        counts = dict(db.execute("select video_id, count(*) from frame_labels group by 1").fetchall())
        by_label = dict(db.execute("select label, count(*) from frame_labels group by 1").fetchall())
    items = [
        {key: rec[key] for key in ("id", "file_name", "channel", "duration", "count")}
        | {"labeled": counts.get(rec["id"], 0)}
        for rec in source.recordings().values()
    ]
    # Interleave channels so the first recordings labelled cover as many streams as possible.
    by_channel: dict[str, list[dict]] = {}
    for item in sorted(items, key=lambda entry: entry["file_name"]):
        by_channel.setdefault(item["channel"], []).append(item)
    ordered: list[dict] = []
    while any(by_channel.values()):
        for channel in sorted(by_channel, key=lambda name: -len(by_channel[name])):
            if by_channel[channel]:
                ordered.append(by_channel[channel].pop(0))
    return {"recordings": ordered, "by_label": by_label, "demo": isinstance(source, DemoSource)}


@app.get("/api/recordings/{video_id}")
def get_recording(video_id: int) -> dict:
    rec = source.recordings().get(video_id)
    if not rec:
        raise HTTPException(404, "Unknown recording")
    labels = frame_labels(video_id)
    return {
        **{key: rec[key] for key in ("id", "file_name", "channel", "duration", "count", "interval")},
        "labels": {str(k): v for k, v in labels.items()},
        "scenes": scenes(source.embeddings(video_id), labels, source.scene_similarity),
    }


@lru_cache(maxsize=4096)
def frame_jpeg(video_id: int, index: int) -> bytes:
    buffer = io.BytesIO()
    source.frame(video_id, index).save(buffer, "JPEG", quality=88)
    return buffer.getvalue()


@app.get("/frame/{video_id}/{index}.jpg")
def frame(video_id: int, index: int) -> Response:
    rec = source.recordings().get(video_id)
    if not rec or not 0 <= index < rec["count"]:
        raise HTTPException(404, "No such frame")
    return Response(frame_jpeg(video_id, index), media_type="image/jpeg",
                    headers={"Cache-Control": "max-age=86400"})


class LabelWrite(BaseModel):
    video_id: int
    frames: list[int]
    label: str | None
    # Set by Review: the label was looked at twice, so stop flagging it.
    confirmed: bool = False


@app.put("/api/labels")
def write_labels(body: LabelWrite) -> dict:
    if body.label is not None and body.label not in LABELS:
        raise HTTPException(400, "Unknown label")
    rec = source.recordings().get(body.video_id)
    if not rec:
        raise HTTPException(404, "Unknown recording")
    frames = [index for index in body.frames if 0 <= index < rec["count"]]
    with closing(labels_db()) as db, db:
        if body.label is None:
            db.executemany(
                "delete from frame_labels where video_id = ? and frame_index = ?",
                [(body.video_id, index) for index in frames],
            )
        else:
            db.executemany(
                """insert into frame_labels (video_id, frame_index, timestamp_seconds, label, confirmed)
                   values (?, ?, ?, ?, ?)
                   on conflict (video_id, frame_index)
                   do update set confirmed = excluded.confirmed,
                     updated_at = case when label = excluded.label then updated_at else datetime('now') end,
                     label = excluded.label""",
                [(body.video_id, index, index * rec["interval"], body.label, int(body.confirmed))
                 for index in frames],
            )
    return {"written": len(frames)}


@app.post("/api/export")
def export_model() -> dict:
    """Train on every label and hand the model to Kura's highlight detector."""
    if isinstance(source, DemoSource):
        raise HTTPException(400, "Demo labels are not exported")
    from export_probe import export

    return export()


@app.get("/api/export")
def exported_model() -> dict:
    from export_probe import DEFAULT_OUT

    if not DEFAULT_OUT.exists():
        return {"exported": None}
    data = json.loads(DEFAULT_OUT.read_text())
    return {"exported": {key: data[key] for key in ("version", "labelled_frames", "labelled_recordings")}}


def model_status(state, stale: bool) -> dict:
    return {
        "ready": state is not None,
        "training": stale,
        "labelled_frames": state.labelled_frames if state else 0,
        "channel_auroc": state.channel_auroc if state else {},
    }


@app.get("/api/review")
def review() -> dict:
    state, stale = label_model().state()
    if state is None:
        return {"items": [], "total": 0, "model": model_status(state, stale)}
    recordings = source.recordings()
    items = disagreements(state, all_labels(), confirmed_frames())
    for item in items:
        rec = recordings[item["video_id"]]
        item.update(channel=rec["channel"], file_name=rec["file_name"], interval=rec["interval"])
        item.pop("score")
    return {"items": items[:300], "total": len(items), "model": model_status(state, stale)}


@app.get("/api/suggestions")
def suggest() -> dict:
    state, stale = label_model().state()
    return {"items": suggestions(state, source.recordings(), all_labels())[:12],
            "model": model_status(state, stale)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--demo", action="store_true")
    parser.add_argument("--port", type=int, default=8790)
    args = parser.parse_args()
    if args.demo:
        source = DemoSource()
    uvicorn.run(app, host="127.0.0.1", port=args.port)
