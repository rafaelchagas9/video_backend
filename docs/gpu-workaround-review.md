# GPU workaround review (2026-10-21)

The PC's sync-flood crashes turned out to be power delivery: the RX 7800 XT ran
on one daisy-chained PCIe 8-pin cable. After recabling to two separate cables it
held a 2-hour Kura load at up to 272 W with no errors. Several workarounds were
added over the months on the assumption that the driver, MIGraphX or VCN was at
fault. This lists the ones still in place, in the order we plan to revisit them.

Rollback for any of these: re-enable `GPU_MODE_COORDINATION=true` in the backend
`.env` and restore the setting below. `crashlog.service` (user unit) writes
`~/crashlogs/live-*-{kmsg,sensors}.log` with fsync, so test with it running.

## 1. Face 640 detector on the CPU — done 2026-10-21

- Where: `vision-service/src/vision_service/face_engine.py` (hybrid dual detector).
- Since: first commit of the face service (2026-01-18). Original comment: "This
  avoids MIGraphX multi-session GPU crashes".
- Real cause found: MIGraphX names compiled programs by a hash of the model
  graph, not the input shape. The dynamic-shape `det_10g` model at 1280 and at
  640 shared one cache file. The 640 session loaded the 1280 program, wrote 4×
  larger outputs (51200 vs 12800 anchors) and the GPU page-faulted
  (`gfxhub PROTECTION_FAULT`, SIGABRT). Reproduced on 2026-10-21: process crash
  loop, the PC stayed up. The per-session `migraphx_model_cache_dir` option
  does not help, because `ORT_MIGRAPHX_MODEL_CACHE_PATH` overrides it.
- Fix: the 1280 GPU detector now loads a fixed-shape copy
  (`models/fixed-shape/det_10g_1280.onnx`, made by `fixed_shape_model`), so its
  program has a different cache name. The 640 detector keeps the original model
  (the recording visibility SHA check is unchanged) and runs as its own GPU
  session with `FACE_FALLBACK_ON_GPU=true` (vision `.env`).
- One-time step: the stale 1280 program cached under the dynamic model's name
  (`20f00-c31176685d65de5c-32d397e0186e258f-0.mxr`) was moved out of the cache.
  Any other cache directory written before the fix needs the same.
- Measured (HTTP round trip, CPU → GPU): small-image face detection
  102 → 14 ms; recording visibility on a 320 px image 68 → 10 ms, on a
  3088 px image 107 → 37 ms. Visibility scores moved ≤ 0.001.
- Rollback: `FACE_FALLBACK_ON_GPU=false` and restart the vision unit.

## 2. `MIGRAPHX_DISABLE_MLIR=1` — kept, 2026-10-21

- Where: `vision-service/run.sh`. Since 2026-01-18, comment "causes crashes on
  RDNA 3". The crash reason is moot now, but MLIR loses on its own merits.
- Benchmark on real library frames, isolated sessions, empty cache per mode:

  | Model | MLIR off | MLIR on |
  |---|---|---|
  | NudeNet 640m, batch 16 | 109 ms, compile seconds | 118 ms, compile 9 min |
  | SigLIP2 vision, batch 64 | 364 ms | still compiling at the 10 min cap |
  | Face det 1280 (exhaustive tune) | 7 ms, compile ~5 s | still compiling at 27 min |

  NudeNet outputs were identical between modes.
- Decision: keep MLIR disabled. Every cache change would cost hours of compile
  for no speedup.

### Related measurement: where face analysis time goes

Kura's face pass (VAAPI, keyframes only, one frame per 8 s at 960 px), cold
page cache, then batches of 10 to faces + NudeNet:

| Video | Extract HDD | Extract SSD | Inference |
|---|---|---|---|
| HEVC 1080p, 0.66 GB | 4.9 s | 4.4 s | 9.9 s |
| h264 1080x1920, 1.0 GB | 5.8 s | 2.2 s | 11.1 s |
| AV1 1080p, 1.3 GB | 7.6 s | 2.0 s | 14.1 s |
| h264 4K, 8.6 GB (video 6775) | 71.7 s | 12.0 s | 25.2 s |

On 1080p files inference dominates; on large 4K files the Seagate HDD
(/mnt/hd4tb) is the bottleneck, about 6× slower than the NVMe SSD.

## 3. Mesa / LLVM held back — done 2026-10-21

- `IgnorePkg` in `/etc/pacman.conf` held mesa 26.2.3, llvm 22 and dependants
  since 2026-10-17, a rollback that targeted Minecraft-only crashes that were
  the same power fault.
- Done: hold removed (backup `/etc/pacman.conf.bak-before-unhold-20261021`),
  full `pacman -Syu` (168 packages: mesa 26.2.5, llvm 23.1.3, linux-zen 7.2.11).
  ROCm/MIGraphX unchanged, so the compiled model cache stays valid.
- If crashes return after the reboot, suspect mesa/llvm first (roll back from
  the Arch Linux Archive as on 2026-10-17).

## 4. `pcie_aspm=off` (and `pcie_ports=native`) — not doing, for now

- Present before July 2026, likely from the first crash wave.
- Estimated saving: about 2–6 W at idle (NVMe, chipset, NIC and USB links; the
  GPU manages its own idle power). That is roughly R$10–45 a year depending on
  uptime. ASPM can also bring NVMe/NIC instability, so decided on 2026-10-21 to
  leave it off.
- `usbcore.autosuspend=-1` stays (USB mic / Quest).

## 5. Face extraction floods the vision service — done 2026-10-21

- `face-extraction-durable.service.ts` `processFrames` sends
  `FACE_DETECTION_BATCH_SIZE` (10) single-image requests in parallel. The service
  admits one inference per capability with a 0.1 s wait, so most get OVERLOADED
  (824 log lines on 2026-10-21). `face-recognition.client.ts` retries them with
  backoff, which is a patch.
- Plan: send each batch as one `/v1/analyze` request (the service accepts up to
  `max_batch_items` = 16).
- Not a crash workaround, but it compounds with them.
- Done: `processFrames` sends each batch (up to 16 frames) as one request via
  `FaceRecognitionClient.detectFacesFromFiles`; only items that come back
  OVERLOADED / CAPABILITY_NOT_READY are retried.

## Later cleanup

- Delete `src/utils/gpu-modes.ts` coordination (~500 lines + tests) after about
  two weeks without crashes, and the stale "sync-flood" comments in `.env`.
- Disable `crashlog.service` after a quiet week.
