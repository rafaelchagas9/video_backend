"""Per-second audio features for reviewed recordings, the half of "worth" frames cannot see.

The reviewer puts audio at about 70% of what separates an okay clip from a nice one (talk,
reactions, moans, music). This extracts cheap per-second descriptors from every recording with a
review whose file still exists, so best parts, versus snippets and Stage 2 can use them:

* ``db``      — loudness (RMS, dBFS);
* ``voice``   — share of energy in the 300–3400 Hz voice band;
* ``flux``    — spectral flux, how much the sound changes (reactions, talk vs a steady hum);
* ``music``   — tonal steadiness (spectral flatness inverted), high for music and sustained tones;
* ``zcr``     — zero-crossing rate, noisy vs voiced.

Audio only: ffmpeg opens the file with ``-vn`` and decodes mono 16 kHz PCM into a pipe that is
read one second at a time, so memory stays flat whatever the container's interleaving (see the
ffmpeg interleaving memory note). Runs at low priority; each recording is cached once under
data/audio/<id>.npz and skipped afterwards.

  uv run python audio_features.py            # every reviewed recording still on disk
  uv run python audio_features.py 6004 6020  # just these
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

from label_server import DATA, PG

RATE = 16_000
OUT = DATA / "audio"
VOICE = (300, 3400)
EPS = 1e-10


def recordings(only: list[int]) -> list[tuple[int, str]]:
    import psycopg

    with psycopg.connect(PG) as pg:
        rows = pg.execute(
            """select v.id, v.file_path from recording_reviews r join videos v on v.id = r.video_id
               order by r.saved_at is null, v.id"""
        ).fetchall()
    return [(vid, path) for vid, path in rows if (not only or vid in only) and Path(path).exists()]


def features(path: str) -> dict[str, np.ndarray]:
    process = subprocess.Popen(
        ["ffmpeg", "-nostdin", "-v", "error", "-threads", "1", "-vn", "-i", path,
         "-map", "0:a:0", "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-"],
        stdout=subprocess.PIPE, preexec_fn=lambda: os.nice(15),
    )
    freqs = np.fft.rfftfreq(RATE // 4, 1 / RATE)
    voice = (freqs >= VOICE[0]) & (freqs <= VOICE[1])
    window = np.hanning(RATE // 4)
    out: dict[str, list[float]] = {key: [] for key in ("db", "voice", "flux", "music", "zcr")}
    previous = None
    assert process.stdout
    while True:
        raw = process.stdout.read(RATE * 2)
        if len(raw) < RATE:  # under half a second left
            break
        x = np.frombuffer(raw, np.int16).astype(np.float32) / 32768
        out["db"].append(float(10 * np.log10(np.mean(x * x) + EPS)))
        out["zcr"].append(float(np.mean(np.abs(np.diff(np.sign(x))) > 0)))
        # Four quarter-second spectra per second, averaged.
        frames = [x[i:i + RATE // 4] for i in range(0, len(x) - RATE // 4 + 1, RATE // 4)]
        spectra = np.array([np.abs(np.fft.rfft(f * window)) for f in frames])
        power = spectra ** 2
        out["voice"].append(float(power[:, voice].sum() / (power.sum() + EPS)))
        mean = spectra.mean(0)
        normed = mean / (mean.sum() + EPS)
        out["flux"].append(float(np.sqrt(((normed - previous) ** 2).sum())) if previous is not None else 0.0)
        previous = normed
        flatness = np.exp(np.mean(np.log(mean + EPS))) / (np.mean(mean) + EPS)
        out["music"].append(float(1 - flatness))
    process.stdout.close()
    process.wait()
    return {key: np.array(values, np.float32) for key, values in out.items()}


def main() -> None:
    os.nice(15)
    only = [int(arg) for arg in sys.argv[1:]]
    OUT.mkdir(parents=True, exist_ok=True)
    todo = [(vid, path) for vid, path in recordings(only) if not (OUT / f"{vid}.npz").exists()]
    print(f"{len(todo)} recordings to extract", flush=True)
    for n, (vid, path) in enumerate(todo, 1):
        started = time.time()
        found = features(path)
        if not len(found["db"]):
            print(f"{n}/{len(todo)} {vid}: no audio", flush=True)
            np.savez(OUT / f"{vid}.npz", empty=np.array(True))
            continue
        np.savez(OUT / f"{vid}.npz", **found)
        seconds = len(found["db"])
        print(f"{n}/{len(todo)} {vid}: {seconds / 60:.0f} min of audio in {time.time() - started:.0f} s", flush=True)


if __name__ == "__main__":
    main()
