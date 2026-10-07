"""Embed every recording frame with one candidate model.

Frames are the storyboard tiles (456x256, one per 5 s) — the same pixels production indexes.
Output: data/emb/<model>/<video_id>.npy (float16, L2-normalised, one row per frame index)
and data/emb/<model>/text.json (prompt → vector) for zero-shot scoring.

  uv run python embed.py <model> [--limit N]

The production baseline (`siglip2-so400m-256`) is read straight from Postgres and the
vision-service text endpoint, so it is exactly what the detector sees today.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import psycopg
from PIL import Image

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT.parent
DATA = ROOT / "data"
PG = "host=localhost port=5432 dbname=video_streaming_db user=vueverse password=vueverse_dev_password"
TILES_PER_PAGE = 25

# Production prompts plus a few more per class, so zero-shot scoring has the same footing for
# every model.
PROMPTS = {
    "idle": [
        "woman talking to the camera, fully clothed",
        "empty room",
        "black screen",
        "stream offline placeholder",
        "woman looking at her phone",
    ],
    "tease": ["woman in lingerie posing", "woman undressing", "woman dancing in underwear"],
    "nude": ["nude woman", "topless woman"],
    "explicit": ["sex scene", "close-up of genitals", "masturbation", "using a sex toy"],
}


def recordings() -> list[dict]:
    with psycopg.connect(PG) as pg:
        rows = pg.execute(
            """select s.video_id, s.sprite_path, s.tile_width, s.tile_height, s.tile_count
               from recording_reviews r join storyboards s using (video_id) order by 1"""
        ).fetchall()
    return [dict(zip(("id", "sprite", "w", "h", "count"), row)) for row in rows]


def tiles(rec: dict):
    sprite = BACKEND / rec["sprite"]
    for page in range(-(-rec["count"] // TILES_PER_PAGE)):
        path = sprite.with_name(sprite.name.replace(".p0.webp", f".p{page}.webp"))
        image = Image.open(path).convert("RGB")
        columns = min(5, image.width // rec["w"])
        for pos in range(min(TILES_PER_PAGE, rec["count"] - page * TILES_PER_PAGE)):
            x, y = (pos % columns) * rec["w"], (pos // columns) * rec["h"]
            yield image.crop((x, y, x + rec["w"], y + rec["h"]))


def normalize(matrix: np.ndarray) -> np.ndarray:
    matrix = matrix.astype(np.float32)
    return matrix / np.maximum(np.linalg.norm(matrix, axis=1, keepdims=True), 1e-12)


# --- adapters: each exposes images(list[PIL]) -> ndarray and texts(list[str]) -> ndarray ---


class Production:
    """SigLIP2 so400m/16 @256 as indexed today (Postgres halfvec + vision-service text tower)."""

    batch = 0

    def frames(self, video_id: int, count: int) -> np.ndarray:
        with psycopg.connect(PG) as pg:
            rows = pg.execute(
                "select frame_index, embedding::text from video_frame_embeddings where video_id = %s",
                (video_id,),
            ).fetchall()
        out = np.zeros((count, 1152), dtype=np.float32)
        for index, text in rows:
            if index < count:
                out[index] = np.array(json.loads(text), dtype=np.float32)
        return out

    def texts(self, texts: list[str]) -> np.ndarray:
        import urllib.request

        request = urllib.request.Request(
            "http://localhost:8100/v1/embeddings/text",
            data=json.dumps({"texts": texts}).encode(),
            headers={"content-type": "application/json"},
        )
        return np.array(json.load(urllib.request.urlopen(request))["embeddings"], dtype=np.float32)


class HFSiglip:
    def __init__(self, name: str, batch: int = 32):
        import torch
        from transformers import AutoModel, AutoProcessor

        self.torch = torch
        self.batch = batch
        self.model = AutoModel.from_pretrained(name, torch_dtype=torch.bfloat16).cuda().eval()
        self.processor = AutoProcessor.from_pretrained(name)

    def images(self, images):
        with self.torch.inference_mode():
            inputs = self.processor(images=images, return_tensors="pt").to("cuda")
            out = self.model.get_image_features(pixel_values=inputs["pixel_values"].bfloat16())
        return _pooled(out)

    def texts(self, texts):
        with self.torch.inference_mode():
            inputs = self.processor(
                text=[t.lower() for t in texts], padding="max_length", max_length=64,
                truncation=True, return_tensors="pt",
            ).to("cuda")
            out = self.model.get_text_features(input_ids=inputs["input_ids"])
        return _pooled(out)


def _pooled(out) -> np.ndarray:
    """Newer transformers return a model output from get_*_features, older ones a tensor."""
    tensor = getattr(out, "pooler_output", out)
    return tensor.float().cpu().numpy()


class OpenClip:
    def __init__(self, name: str, batch: int = 32):
        import open_clip
        import torch

        self.torch = torch
        self.batch = batch
        self.model, self.preprocess = open_clip.create_model_from_pretrained(name)
        self.model = self.model.to("cuda", torch.bfloat16).eval()
        self.tokenizer = open_clip.get_tokenizer(name)

    def images(self, images):
        pixels = self.torch.stack([self.preprocess(image) for image in images]).to("cuda", self.torch.bfloat16)
        with self.torch.inference_mode():
            return self.model.encode_image(pixels).float().cpu().numpy()

    def texts(self, texts):
        with self.torch.inference_mode():
            return self.model.encode_text(self.tokenizer(texts).to("cuda")).float().cpu().numpy()


class SentenceTransformerModel:
    def __init__(self, name: str, batch: int, query_prompt: str | None = None, **kwargs):
        import torch
        from sentence_transformers import SentenceTransformer

        self.batch = batch
        self.query_prompt = query_prompt
        self.model = SentenceTransformer(
            name, device="cuda", model_kwargs={"torch_dtype": torch.bfloat16}, **kwargs
        )

    def images(self, images):
        return self.model.encode([{"image": image} for image in images], batch_size=self.batch)

    def texts(self, texts):
        if self.query_prompt:
            return self.model.encode(texts, prompt=self.query_prompt)
        return self.model.encode(texts)


MODELS = {
    "siglip2-so400m-256": lambda: Production(),
    "siglip2-giant-384": lambda: HFSiglip("google/siglip2-giant-opt-patch16-384", batch=16),
    "pe-core-l14-336": lambda: OpenClip("hf-hub:timm/PE-Core-L-14-336"),
    "pe-core-g14-448": lambda: OpenClip("hf-hub:timm/PE-Core-bigG-14-448", batch=8),
    "embeddinggemma-2": lambda: SentenceTransformerModel(
        "google/embeddinggemma-2", batch=16, query_prompt="task: search result | query: "
    ),
    "qwen3-vl-emb-2b": lambda: SentenceTransformerModel(
        "Qwen/Qwen3-VL-Embedding-2B", batch=8,
        query_prompt="Retrieve video frames that match the description.",
    ),
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("model", choices=MODELS)
    parser.add_argument("--limit", type=int, default=0, help="only the first N recordings")
    parser.add_argument("--videos", type=str, default="", help="comma-separated video ids")
    args = parser.parse_args()

    out = DATA / "emb" / args.model
    out.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    adapter = MODELS[args.model]()
    print(f"loaded {args.model} in {time.monotonic() - started:.0f}s", flush=True)

    prompts = [prompt for group in PROMPTS.values() for prompt in group]
    vectors = normalize(adapter.texts(prompts))
    (out / "text.json").write_text(
        json.dumps({"prompts": PROMPTS, "vectors": dict(zip(prompts, vectors.round(6).tolist()))})
    )

    recs = recordings()
    if args.videos:
        wanted = {int(v) for v in args.videos.split(",")}
        recs = [rec for rec in recs if rec["id"] in wanted]
    if args.limit:
        recs = recs[: args.limit]
    frames_done = 0
    timed = time.monotonic()
    for number, rec in enumerate(recs, 1):
        target = out / f"{rec['id']}.npy"
        if target.exists():
            continue
        if isinstance(adapter, Production):
            matrix = adapter.frames(rec["id"], rec["count"])
        else:
            chunks, batch = [], []
            for image in tiles(rec):
                batch.append(image)
                if len(batch) == adapter.batch:
                    chunks.append(adapter.images(batch))
                    batch = []
            if batch:
                chunks.append(adapter.images(batch))
            matrix = np.concatenate(chunks)
        np.save(target, normalize(matrix).astype(np.float16))
        frames_done += rec["count"]
        rate = frames_done / max(1e-6, time.monotonic() - timed)
        print(f"[{number}/{len(recs)}] video {rec['id']} {rec['count']} frames · {rate:.1f} frames/s", flush=True)
    print("done", flush=True)


if __name__ == "__main__":
    sys.exit(main())
