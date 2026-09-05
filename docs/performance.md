# Local media processing performance

The September 2026 implementation targets a single user on a LAN, tested on a
Ryzen 5 5600G, 32 GB RAM, and Radeon RX 7800 XT using VAAPI and MIGraphX.
No database migration is required.

## Storyboards

`STORYBOARD_SAMPLING=auto` tries keyframe decoding first. It checks source PTS
against each preview interval's sampling midpoint and falls back to full decoding
when the available keyframes exceed `STORYBOARD_MAX_KEYFRAME_DRIFT_SECONDS`
(default 5). This is a bound against the preview sampling point, not a promise
that the image depicts the exact cursor position. Adjacent previews can repeat.
The image format, quality, dimensions, and VTT interval stay configurable.

Use `STORYBOARD_SAMPLING=precise` to keep full decoding, or pass
`sampling: "precise"` to `POST /api/videos/:id/storyboard`. The per-request
`keyframes` option explicitly bypasses the automatic drift guard. This setting
only affects storyboards; editing and balanced/thorough analysis keep their
existing frame sampling.

The renderer fills short clips and the last partial interval, retries software
decoding when VAAPI cannot handle the source, and has a bounded timeout.
Regeneration publishes the new sprite/VTT before retiring the previous preview.
Duplicate generation requests share one job. `STORYBOARD_MAX_CONCURRENT` now
controls queued workers (1–8); the shared scheduler also bounds active work.

The obsolete `STORYBOARD_RAM_COPY_MAX_MB` and `STORYBOARD_READAHEAD_MAX_MB` settings
are ignored. FFmpeg reads directly through the filesystem cache, avoiding the
extra application-level copy/read. Keyframe decoding still reads compressed
packets and can remain limited by HDD bandwidth.

## Content analysis

Balanced and thorough profiles keep the original sampling intervals, model,
thresholds, PTS, refinement boundaries, and event condensation. The first decode
can also produce the refinement sampling grid. A run-local JPEG cache reuses
only matching windows; shifted origins, evicted windows, and resumed jobs use
normal extraction. Negative/empty windows are preserved.

`CONTENT_ANALYSIS_REFINEMENT_CACHE_MB` defaults to 256 MiB per active run; 0
turns off frame prefetch/reuse. The cache does not persist images or reference
another run's media. Prediction reuse is independently bounded to 16,384 entries
per run and requires identical PTS, image MIME type, and SHA-256 image bytes.
Successful negative predictions are reusable; errors are not.

The original overlap between decoding and inference remains. Cancellation stops
queued and active extraction, and temporary images are cleaned up. A run resumed
after a process restart reconstructs missing data through the ordinary extractor.
The benefit depends on how refinement windows align; videos with little or
misaligned refinement can gain little from frame prefetch.

FP32 stays the default. The vision service offers `NUDITY_FP16_ENABLED=true` as
an explicit precision tradeoff, reports a different model revision, and isolates
compiled programs by execution settings. See [vision service configuration](../vision-service/README.md).
Changing that Python configuration requires a vision-service restart and may
trigger model compilation/warmup.

## Scheduling and conversions

One backend process admits at most three heavy operations. At most two are long
conversion jobs. The remaining capacity admits previews or bounded analysis
work; queued previews precede analysis, which precedes queued conversions.
Running native processes are not preempted. This coordinates the conversion,
storyboard renderer, and nudity-analysis paths within one API process; it is not
an OS-wide GPU scheduler. Keep one API instance for the intended LAN setup.

Two conversion workers remain useful on the tested hardware. No change was made
to presets, output bitrate policy, encoder quality, `async_depth`, or hardware
surface allocation. The resized software-decode fallback now uploads frames and
uses `scale_vaapi` before hardware encoding; the full-software fallback remains
available.

`GET /api/videos/:id/conversion-estimate?preset=1080p_av1` is authenticated and
read-only. It uses the actual encoder plan and the existing conservative savings
estimator. Suggestions and manual estimates share a 60-second calibration cache
of up to 20,000 history records, invalidated after new conversion history is
recorded. Full-software CRF jobs are excluded from hardware VBR calibration.

The response includes estimated output size/savings, confidence, historical sample
count, prediction error, and a `recommended`, `marginal`, `unlikely`, or `unknown`
recommendation. Incomplete metadata returns an unknown estimate. Estimates do
not enqueue jobs, lock out compatibility conversions, or encode sample clips.
Kura's web and mobile conversion dialogs display these estimates before starting.

## Measurements and regression checks

The private audit folder is `data/performance-audit/2026-09-04/`. It contains the
original report, database-backup verification, source integrity checks, benchmark
scripts, JSON results, and the implementation report. Generated benchmark media,
copied model caches, and temporary UI fixtures were removed after verification;
the database backup and measurement evidence were retained. Keep the local media
mappings private.

With the local 320×240 WebP settings and warm filesystem cache, the completed
renderer took 1.37–2.87 seconds across five full files, compared with the original
11.06–73.17 seconds. Balanced analysis took 36.31, 45.46, and 78.47 seconds for
H.264, HEVC, and AV1 samples, against fresh baselines of 39.94, 63.91, and 78.02.
Every staged observation chunk and final event matched the baseline exactly on
those three files. These are sample measurements, not full-library guarantees.

Meaningful regression coverage includes real FFmpeg VFR frame/PTS equivalence,
short/final storyboard tiles, fallback decoding, cache eviction and resumption,
queued cancellation, regeneration failure, route authentication and demo parity,
and browser estimate interactions with synthetic media metadata. Tests use the
isolated test database contract; never run destructive fixtures against the
library database.
