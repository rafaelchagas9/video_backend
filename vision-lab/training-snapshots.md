# Reviewed recording snapshots

Saving a review confirms all current keep/skip choices, whether or not clips are rendered. The backend preserves those choices, reasons, detected and trimmed ranges, output job/video IDs, the review curve, original catalog metadata, detector revision and exact stored frame timestamps/embeddings under `data/recording-training-snapshots/<videoId>/`.

Features are immutable binary files shared by repeated saves and analyses using the same source/index identity. Each analysis has an atomically replaced JSON review manifest. Files and directory entries are flushed before Save succeeds. A missing/incompatible index or storage failure produces a visible Save error; no inference, FFmpeg, media reread, historical backfill, database migration or cleanup is involved. Existing deletion paths require a snapshot and verify its checksum before removing a reviewed original. A changed source/index cannot silently replace features for the same saved analysis; its earlier snapshot is preserved. Originals are not deleted merely by saving a snapshot.

The source duration/hash/size are stored catalog values, not a new measurement of the media. Index model, storyboard generation, index timestamp, cadence and count identify the archived features. Changing these identities creates another immutable feature blob; corrupt data fails checksum validation. The archive is private local training data and needs to be included in ordinary backups.

Raw storage estimate from the schema, not a benchmark: 1,152 values at float32 plus a float64 timestamp per 5-second frame is 3.17 MiB/hour, about 15.85 MiB for 5 hours or 0.93 GiB for 60 such recordings. Only small manifests are rewritten for repeated Save. The per-recording feature payload is bounded at 64 MiB; oversized recordings fail clearly rather than silently dropping frames. No GPU allocation occurs. The archive preserves existing fp16 embedding values exactly in a portable float32 representation.

Offline use:

```python
from training_snapshots import manifests, frames
for review in manifests(video_id):
    timestamps, embeddings = frames(review)
    decisions = review["clips"]
```

This reader works after catalog/source deletion, verifies content hashes, and has no PostgreSQL or media dependency. Older ad hoc `.npy` feedback caches do not become complete archives automatically; no historical data is backfilled by this change. No model is trained by Save or by this reader.
