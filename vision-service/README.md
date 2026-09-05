# Vision inference service

Stateless FastAPI inference for InsightFace faces and NudeNet findings. The Bun
backend owns video access, sampling, durable jobs, bookmarks, and authorization;
clients call the backend rather than Python directly.

## Install and run

Python 3.11+ and uv are required. The tracked lock selects
`onnxruntime-migraphx` for the native AMD deployment; installing a second ONNX
Runtime distribution over it can shadow the required provider.

From this directory:

```bash
uv sync --frozen
cp .env.example .env
# Review providers and model settings, then provision 640m below.
./run.sh
```

[run.sh](run.sh) contains host-specific Arch/RX 7800 XT workarounds: system zstd
preload, GPU selection, ROCm library path, disabled MLIR, and a compiled-cache
root. Inspect it before reusing on another host. To run without those overrides,
use `uv run python -m vision_service.main` in an environment with the required
runtime libraries available.

Inspect the installed provider list inside this virtual environment:

```bash
uv run python -c "import onnxruntime as ort; print(ort.get_available_providers())"
```

CPU-only inference requires both `ONNX_PROVIDERS=CPUExecutionProvider` and
`NUDITY_ONNX_PROVIDERS=CPUExecutionProvider`, plus `NUDITY_REQUIRE_GPU=false`.
Changing environment settings requires restarting the service. Provider settings
cannot enable a backend missing from the installed runtime.

### Provision the Default NudeNet Model

The service never downloads detector weights from an inference request. Before
using the default `640m` model, place the official release artifact at
`models/nudenet/640m.onnx` relative to the service root (or the equivalent path
under `MODEL_CACHE_DIR`). The GitHub release is age-restricted, so use an
authenticated GitHub CLI session:

```bash
mkdir -p models/nudenet
gh release download v3.4-weights \
  --repo notAI-tech/NudeNet \
  --pattern 640m.onnx \
  --dir models/nudenet \
  --clobber
sha256sum models/nudenet/640m.onnx
```

The required SHA-256 is:

```text
04fe3d77980780c1f8297dc6d7f942fd5b3abe6942a188f742a85241e4f634eb
```

The application warms the registered NudeNet detector in the background before
reporting it ready. Initialization fails for that capability when the file is
absent or its hash differs; it does not download a replacement. `NUDITY_MODEL=320n` selects the pinned model
bundled by NudeNet 3.4.2 and needs no separate provisioning.

## Configuration

Copy [.env.example](.env.example) for a starting configuration; defaults and
validation live in [config.py](src/vision_service/config.py). The example selects
MIGraphX and a face detection size of 640; class defaults are CPU and 1280.
Do not confuse an example profile with the fallback values.

The settings cover server address, separate face/nudity providers, model choice,
image byte/pixel limits, batch limits, inference concurrency, and admission
wait time. `INTERNAL_API_SECRET` optionally requires a Bearer token on inference
routes. Set backend `VISION_SERVICE_SECRET` to the same value when enabling it.

NudeNet keeps FP32 precision by default. `NUDITY_FP16_ENABLED=true` is an
optional performance experiment; detection scores can cross category thresholds.
The process-level `ORT_MIGRAPHX_FP16_ENABLE=0` or `1` takes precedence over this
setting, matching ONNX Runtime. FP16 reports a distinct `/fp16` model revision so
analysis results cannot silently reuse FP32 jobs.

Startup chooses a compiled-cache subdirectory using the model, precision, batch
size, runtime libraries, GPU identifiers, and MIGraphX environment. Configure the
parent with `MIGRAPHX_CACHE_ROOT`; do not copy old `.mxr` programs into a different
precision's directory. A new execution configuration compiles and warms up once.
Existing cache directories are retained. Changes take effect when the service
restarts. See [MIGraphX provider options](https://onnxruntime.ai/docs/execution-providers/MIGraphX-ExecutionProvider.html).

## API and readiness

The default address is `http://localhost:8100`. FastAPI `/docs` and
`/openapi.json` expose the request and response models from the
[versioned routes](src/vision_service/routes/v1.py).

| Endpoint | Purpose |
| --- | --- |
| `GET /livez` | Process liveness |
| `GET /readyz` | Face runtime readiness; 503 when unavailable |
| `GET /v1/capabilities` | Per-detector readiness, model/taxonomy revisions, providers, and limits |
| `POST /v1/analyze` | Versioned multipart batch inference |
| `GET /health`, `GET /capabilities` | Compatibility face health/capability views |
| `POST /detect`, `POST /extract-embedding` | Compatibility upload/base64 face adapters |

Use `/v1/capabilities` when diagnosing nudity readiness; face readiness alone
does not establish that the separate NudeNet detector is available. Operational
health/capability routes are public; inference routes honor the optional token.

`/v1/analyze` takes a JSON `manifest` field and the binary fields named by its
items. Each item carries an ID and timestamp. The response preserves that
correlation and returns an `ok` or `error` outcome for each requested capability;
one failed detector does not discard another detector's successful outcome.

Face embeddings remain 512-dimensional. Use the backend's matching policy rather
than treating an example similarity score as proof of identity. New integrations
should use the versioned endpoint; remove compatibility routes only after caller
migration and parity have been established.

## Troubleshooting

- Process responds but readiness is 503: inspect `/v1/capabilities` and logs for
  the failed detector and initialization error. Liveness is not model readiness.
- NudeNet fails initialization: verify model path/hash, active providers, and
  `NUDITY_REQUIRE_GPU`; failed lazy initialization has a configurable retry cooldown.
- Wrong ONNX provider: use the virtual environment inspection command above and
  check the service process's library path. Restore the pinned environment before
  trying another distribution.
- Compilation is slow after a configuration change: a new model/precision/batch/
  runtime combination gets its own cache namespace. Do not copy compiled programs
  between incompatible configurations.
- Out of memory or admission failures: reduce batch/concurrency or face input
  size as appropriate. Saturation returns 429 instead of admitting unlimited work.

See [backend performance notes](../docs/performance.md) for analysis profiles,
frame reuse, and measured limits. Those measurements are specific to the tested
hardware and samples, not inference accuracy guarantees.

## Verification

```bash
uv run python -m unittest discover -s tests -v
uvx ruff check src tests
uvx ruff format --check src tests
uv lock --check
```

Contract tests with mocked detectors do not establish live GPU readiness or model
accuracy. The remaining owner/browser and corpus acceptance is tracked in
[the vision acceptance note](../plans/007-vision-service-nudity-analysis-bookmarks.md).
