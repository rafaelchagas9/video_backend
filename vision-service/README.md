# Vision Inference Service

A stateless visual-inference microservice with versioned contracts and pluggable
detector capabilities. InsightFace provides faces and the pinned NudeNet 3.4.2
adapter provides selected nudity findings without exposing raw provider objects
to the backend. The official 640m artifact is the default; bundled 320n remains
available as an explicit lower-resolution option.

## Overview

The Vision Inference Service:

- Exposes capability discovery and versioned multipart batch analysis
- Isolates initialization and inference failures by detector capability
- Uses bounded concurrency and explicit byte/pixel/batch limits
- Detects faces in images using InsightFace
- Extracts 512-dimensional face embeddings for similarity matching
- Detects the selected eleven NudeNet categories behind the `nudity` capability
- Loads the provisioned NudeNet model lazily with an independent
  MIGraphX-required session by default
- Supports GPU acceleration via ONNX Runtime (ROCm for AMD, CUDA for NVIDIA)

**Technology Stack:**

- FastAPI for high-performance async HTTP
- InsightFace (buffalo_l) for face detection and recognition
- ONNX Runtime for cross-platform ML inference
- OpenCV for image processing
- UV for fast Python dependency management

## Architecture

The Vision Inference Service operates as part of a three-tier architecture:

```
┌──────────────────────────────────────┐
│         Frontend Application         │
│    (React/Vue/etc - separate repo)   │
└─────────────┬────────────────────────┘
              │
              │ HTTP /api/*
              │ (session cookies)
              ▼
┌──────────────────────────────────────────────────────┐
│       Bun/Fastify Backend (port 3000)                │
│                                                       │
│  ┌────────────────────────────────────────────────┐  │
│  │     Face Recognition Orchestration Service     │  │
│  │  - Frame extraction from videos (FFmpeg)       │  │
│  │  - HTTP client for Python service              │  │
│  │  - pgvector similarity searches                │  │
│  │  - Auto-tagging based on confidence            │  │
│  │  - RESTful API exposure to frontend            │  │
│  └──────────────────┬─────────────────────────────┘  │
│                     │                                 │
│  ┌──────────────────▼─────────────────────────────┐  │
│  │   PostgreSQL + pgvector Extension              │  │
│  │  - creator_face_embeddings (vector storage)    │  │
│  │  - video_face_detections (detection metadata)  │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────┬───────────────────────────────────┘
                   │
                   │ HTTP POST /v1/analyze
                   │ (versioned multipart/form-data)
                   ▼
┌──────────────────────────────────────────────────────┐
│     Python Vision Service (port 8100) - THIS SERVICE  │
│                                                       │
│  ┌────────────────────────────────────────────────┐  │
│  │       InsightFace + ONNX Runtime               │  │
│  │  - Face detection (RetinaFace)                 │  │
│  │  - Face recognition (ArcFace)                  │  │
│  │  - 512-dimensional embedding extraction        │  │
│  └────────────────────────────────────────────────┘  │
│                                                       │
│  Stateless: NO database, NO ORM, pure ML inference   │
└──────────────────────────────────────────────────────┘
```

**Key Design Principles:**

1. **Frontend Never Calls Python Service**
   - Frontend only communicates with the Bun backend via `/api/*` routes
   - All requests use session-based authentication
   - Backend handles orchestration and data management

2. **Python Service is Stateless**
   - No database connections or ORM
   - No session management
   - Pure inference: receives images → returns embeddings
   - Can be scaled horizontally without coordination

3. **Backend as Orchestrator**
   - Extracts video frames using FFmpeg
   - Calls Python service for ML inference
   - Stores embeddings in PostgreSQL with pgvector
   - Performs similarity searches
   - Implements business logic (auto-tagging, confidence thresholds)

## Features

- **Face Detection**: Detect multiple faces per image with bounding boxes
- **Embedding Extraction**: Generate 512-dimensional feature vectors for similarity matching
- **High Performance**: Optimized ONNX Runtime with GPU acceleration support
- **Versioned batches**: Multiple images and requested capabilities per request
- **Stable findings**: Normalized coordinates and provider-independent results
- **Legacy compatibility**: Existing face upload/base64 endpoints remain adapters
- **Health Monitoring**: Separate liveness, readiness, and capability manifests

## API Endpoints

### `GET /v1/capabilities`

Returns every registered detector independently, including readiness, active
providers, model/taxonomy revisions, and admission limits.

### `POST /v1/analyze`

Accepts multipart data with a JSON `manifest` field and one binary field per
item. The response echoes each item ID and timestamp and returns one `ok` or
`error` outcome per requested capability. A failed detector or invalid item does
not discard successful outcomes from other capabilities or items.

The manifest shape is:

```json
{
  "version": "1",
  "capabilities": ["faces", "nudity"],
  "items": [
    {
      "id": "frame-0",
      "timestamp_seconds": 12.5,
      "file_field": "image_0"
    }
  ]
}
```

`nudity` uses taxonomy revision `nudenet-selected-11-v1` and returns only:
`BUTTOCKS_EXPOSED`, `FEMALE_BREAST_EXPOSED`,
`FEMALE_GENITALIA_EXPOSED`, `MALE_BREAST_EXPOSED`, `ANUS_EXPOSED`,
`FEET_EXPOSED`, `ARMPITS_EXPOSED`, `BELLY_EXPOSED`,
`MALE_GENITALIA_EXPOSED`, `ANUS_COVERED`, and
`FEMALE_GENITALIA_COVERED`. The capability starts in `created` state and reports
the providers active in its own ONNX session after the first analysis. By
default, initialization succeeds only when `MIGraphXExecutionProvider` is
active. A transient initialization failure is retried after the configured
cooldown without changing face readiness or process liveness.

The default model revision is
`nudenet-3.4.2/640m@sha256:04fe3d77980780c1f8297dc6d7f942fd5b3abe6942a188f742a85241e4f634eb`
with inference resolution 640. Set `NUDITY_MODEL=320n` to use the bundled pinned
320-resolution model instead.

`POST /detect` and `POST /extract-embedding` below are compatibility endpoints;
new backend integrations should use `/v1/analyze`.

### `GET /health`

Check service status and configuration.

`/health` is kept for compatibility and returns `503` while the model is not
ready. Use `/livez` for process liveness, `/readyz` for inference readiness,
and `/capabilities` to inspect the currently loaded capabilities and providers.
These operational routes are public. The inference routes can optionally require
an internal Bearer token and do not expose browser CORS because only the backend
is expected to call this service.

**Response:**

```json
{
  "status": "healthy",
  "version": "0.1.0",
  "model": "buffalo_l",
  "onnx_providers": ["CPUExecutionProvider"],
  "embedding_dimension": 512
}
```

### `POST /detect`

Detect faces in an uploaded image file.

**Request:**

```bash
curl -X POST http://localhost:8100/detect \
  -H "Authorization: Bearer ${INTERNAL_API_SECRET}" \
  -F "file=@image.jpg"
```

**Response:**

```json
{
  "faces": [
    {
      "bbox": [123.4, 56.7, 234.5, 167.8],
      "embedding": [0.123, -0.456, ...],  // 512 floats
      "det_score": 0.9987
    }
  ],
  "processing_time_ms": 45.23,
  "image_width": 1920,
  "image_height": 1080
}
```

**Fields:**

- `bbox`: `[x1, y1, x2, y2]` bounding box coordinates
- `embedding`: 512-dimensional face feature vector
- `det_score`: Detection confidence (0.0-1.0)

### `POST /extract-embedding`

Extract face embeddings from a base64-encoded image.

**Request:**

```json
{
  "image_base64": "/9j/4AAQSkZJRgABAQEAYABgAAD..."
}
```

**Response:** Same format as `/detect`

**Use Case:** Programmatic integration where image is already in memory (e.g., video frame extraction)

## Installation

### Prerequisites

- Python 3.11 or higher
- UV package manager (recommended) or pip
- For GPU support:
  - **AMD (ROCm 7.1+)**: ROCm 7.1.1+, MIGraphX, and `rocm-smi` working
    - Note: ROCMExecutionProvider was deprecated in ROCm 7.1+
    - MIGraphXExecutionProvider is now the recommended provider
    - Package: `onnxruntime-migraphx` (NOT `onnxruntime-rocm`)
  - **AMD (ROCm 6.x-7.0)**: ROCm 6.2-7.0 and `rocm-smi` working
  - **NVIDIA**: CUDA 11.x/12.x and `nvidia-smi` working

### Install UV (Recommended)

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### Install Dependencies

```bash
cd vision-service

# Create the locked virtual environment and install the project
uv sync --frozen
```

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

Startup remains lazy, but the first `nudity` analysis fails that capability with
a stable initialization error when the file is absent or its hash differs. It
does not perform a network request. `NUDITY_MODEL=320n` selects the pinned model
bundled by NudeNet 3.4.2 and needs no separate provisioning.

### Verify Installation

```bash
python -c "import onnxruntime; print(onnxruntime.get_available_providers())"
```

Expected output (CPU):

```
['CPUExecutionProvider']
```

Expected output (AMD GPU with ROCm 7.1+):

```
['MIGraphXExecutionProvider', 'CPUExecutionProvider']
```

Expected output (AMD GPU with ROCm 6.x-7.0):

```
['ROCMExecutionProvider', 'CPUExecutionProvider']
```

Expected output (NVIDIA GPU):

```
['CUDAExecutionProvider', 'CPUExecutionProvider']
```

## Configuration

Create a `.env` file (or copy from `.env.example`):

```bash
# Server settings
HOST=0.0.0.0
PORT=8100

# ONNX Runtime execution providers (comma-separated)
# For AMD GPU (ROCm 7.1+): MIGraphXExecutionProvider
# For AMD GPU (ROCm 6.x-7.0): ROCMExecutionProvider,CPUExecutionProvider
# For NVIDIA GPU: CUDAExecutionProvider,CPUExecutionProvider
# For CPU only: CPUExecutionProvider
ONNX_PROVIDERS=MIGraphXExecutionProvider

# InsightFace model (buffalo_l recommended for best accuracy)
INSIGHTFACE_MODEL=buffalo_l

# Detection input size (higher = slower but more accurate)
DET_SIZE=640

# Independent lazy NudeNet session: require AMD GPU by default. CPU remains in
# the provider list for ONNX node fallback; opt in to CPU-only with false.
NUDITY_ENABLED=true
NUDITY_MODEL=640m
NUDITY_ONNX_PROVIDERS=MIGraphXExecutionProvider,CPUExecutionProvider
NUDITY_REQUIRE_GPU=true
NUDITY_INITIALIZATION_RETRY_SECONDS=60

# Request and inference admission limits
MAX_IMAGE_BYTES=10485760
MAX_IMAGE_PIXELS=40000000
MAX_BATCH_ITEMS=16
MAX_BATCH_BYTES=33554432
MAX_CONCURRENT_INFERENCES=1
INFERENCE_ACQUIRE_TIMEOUT_SECONDS=0.1

# Optional. When set, /detect and /extract-embedding require this Bearer token.
INTERNAL_API_SECRET=replace-with-a-long-random-secret

# Logging level
LOG_LEVEL=INFO

# Model cache directory
MODEL_CACHE_DIR=./models
```

**Configuration Options:**

| Variable                            | Default                | Description                                                    |
| ----------------------------------- | ---------------------- | -------------------------------------------------------------- |
| `HOST`                              | `0.0.0.0`              | Bind address                                                   |
| `PORT`                              | `8100`                 | HTTP port                                                      |
| `ONNX_PROVIDERS`                    | `CPUExecutionProvider` | Execution backends (comma-separated)                           |
| `INSIGHTFACE_MODEL`                 | `buffalo_l`            | Model variant (`buffalo_l` or `buffalo_s`)                     |
| `DET_SIZE`                          | `1280`                 | Detection resolution (higher = slower)                         |
| `NUDITY_ENABLED`                    | `true`                 | Register the lazy NudeNet capability                           |
| `NUDITY_MODEL`                      | `640m`                 | Pinned model: `640m` or bundled `320n`                         |
| `NUDITY_ONNX_PROVIDERS`             | `MIGraphXExecutionProvider,CPUExecutionProvider` | Independent NudeNet provider preference |
| `NUDITY_REQUIRE_GPU`                 | `true`                 | Require MIGraphX to be active; `false` permits CPU-only fallback |
| `NUDITY_INITIALIZATION_RETRY_SECONDS` | `60`                  | Cooldown before retrying failed lazy initialization            |
| `MAX_IMAGE_BYTES`                   | `10485760`             | Maximum decoded image payload                                  |
| `MAX_IMAGE_PIXELS`                  | `40000000`             | Maximum decoded image pixels                                   |
| `MAX_BATCH_ITEMS`                   | `16`                   | Maximum images in one versioned analysis request               |
| `MAX_BATCH_BYTES`                   | `33554432`             | Maximum aggregate uploaded image bytes per batch               |
| `MAX_CONCURRENT_INFERENCES`         | `1`                    | Native inferences admitted concurrently                        |
| `INFERENCE_ACQUIRE_TIMEOUT_SECONDS` | `0.1`                  | Wait before returning `429` under saturation                   |
| `INTERNAL_API_SECRET`               | unset                  | Bearer token required only by inference routes when configured |
| `LOG_LEVEL`                         | `INFO`                 | Logging verbosity                                              |
| `MODEL_CACHE_DIR`                   | `./models`             | Root for InsightFace and explicitly provisioned models         |

**Model Selection:**

- `buffalo_l`: Large model, 512-dim embeddings, best accuracy (recommended)
- `buffalo_s`: Small model, faster inference, reduced accuracy

## Running the Service

### Development Mode

**For AMD GPU (ROCm 7.1+):**

```bash
# Use the provided run script (sets LD_LIBRARY_PATH for ROCm)
./run.sh

# Or manually set the library path
export LD_LIBRARY_PATH=/opt/rocm/lib:$LD_LIBRARY_PATH
python -m vision_service.main
```

**For other platforms:**

```bash
# With UV
uv run python -m vision_service.main

# Or with activated venv
source .venv/bin/activate
python -m vision_service.main
```

The service will:

1. Download InsightFace models on first run (~300MB for buffalo_l)
2. Initialize ONNX Runtime with configured providers
3. Register the selected NudeNet model without opening it until first use
4. Start HTTP server on `http://localhost:8100`

### Verify Service is Running

```bash
curl http://localhost:8100/health
```

Expected output:

```json
{
  "status": "healthy",
  "version": "0.1.0",
  "model": "buffalo_l",
  "onnx_providers": ["CPUExecutionProvider"],
  "embedding_dimension": 512
}
```

### Test Face Detection

```bash
# Download a test image
curl -o test.jpg https://picsum.photos/800/600

# Detect faces
curl -X POST http://localhost:8100/detect \
  -F "file=@test.jpg" \
  | jq
```

## Integration with Backend

The Bun/Fastify backend will integrate with this service to provide face recognition features.

### Expected Integration Flow

1. **User Uploads Video/Image to Backend**
   - Frontend sends video to Bun backend via `/api/videos`
   - Backend stores file and metadata in PostgreSQL

2. **Backend Extracts Frames**
   - Use FFmpeg to extract frames at intervals (e.g., 1 frame/second)
   - Save frames as temporary JPEG files

3. **Backend Calls Face Service**

   ```typescript
   // Example integration (to be implemented in backend)
   const formData = new FormData();
   formData.append("file", frameBlob, "frame.jpg");

   const response = await fetch("http://localhost:8100/detect", {
     method: "POST",
     // Omit this header when INTERNAL_API_SECRET is not configured.
     headers: { Authorization: `Bearer ${internalApiSecret}` },
     body: formData,
   });

   const { faces } = await response.json();
   ```

4. **Backend Stores Embeddings**
   - Save `faces[].embedding` to PostgreSQL with pgvector
   - Store in `creator_face_embeddings` table with creator association

5. **Backend Performs Similarity Search**

   ```sql
   SELECT creator_id, 1 - (embedding <=> $1::vector) as similarity
   FROM creator_face_embeddings
   WHERE 1 - (embedding <=> $1::vector) > 0.6
   ORDER BY similarity DESC
   LIMIT 5;
   ```

6. **Backend Auto-Tags Videos**
   - If similarity > threshold (e.g., 0.7), auto-tag video with creator
   - Store detection metadata in `video_face_detections` table

### Request/Response Format

**Successful Detection:**

```json
{
  "faces": [
    {
      "bbox": [100, 50, 300, 250],
      "embedding": [
        /* 512 floats */
      ],
      "det_score": 0.998
    }
  ],
  "processing_time_ms": 42.15,
  "image_width": 1920,
  "image_height": 1080
}
```

**No Faces Detected:**

```json
{
  "faces": [],
  "processing_time_ms": 18.32,
  "image_width": 1920,
  "image_height": 1080
}
```

**Error Response:**

```json
{
  "detail": {
    "code": "INVALID_IMAGE",
    "message": "Image data could not be decoded"
  }
}
```

### Performance Considerations

- **Model Loading**: First request after startup takes ~2-5s (model initialization)
- **Inference Time**:
  - CPU: 50-200ms per image (depending on resolution)
  - AMD GPU (ROCm): 15-50ms per image
  - NVIDIA GPU (CUDA): 10-40ms per image
- **Concurrent Requests**: decode and inference run outside the event loop with bounded admission
- **Scaling**: Stateless design allows horizontal scaling with load balancer

### Error Handling

The Python service returns standard HTTP status codes:

- `200 OK`: Successful detection (even if no faces found)
- `400 Bad Request`: Invalid image format or empty file
- `401 Unauthorized`: Configured internal Bearer token is missing or invalid
- `413 Content Too Large`: Byte or decoded-pixel limit exceeded
- `429 Too Many Requests`: Inference capacity exhausted
- `503 Service Unavailable`: Model is not ready
- `500 Internal Server Error`: Model inference failure

The backend should:

- Retry on `500` errors with exponential backoff
- Log `400` errors and skip frame
- Continue processing remaining frames on individual failures

## Model Information

### InsightFace Buffalo L

The service uses the **buffalo_l** model pack from InsightFace:

**Components:**

- **Detection**: RetinaFace-based detector (640x640 input)
- **Recognition**: ArcFace with ResNet backbone

**Embedding Characteristics:**

- **Dimension**: 512 floats
- **Normalization**: Raw ArcFace output; cosine distance normalizes during comparison
- **Distance Metric**: Cosine similarity via dot product
- **Threshold**: Typically 0.6-0.7 for same-person matching

**Similarity Interpretation:**

- `>= 0.7`: Very likely same person
- `0.6 - 0.7`: Likely same person (manual review recommended)
- `0.4 - 0.6`: Uncertain
- `< 0.4`: Different people

**Model Files** (auto-downloaded on first run):

```
models/
└── buffalo_l/
    ├── det_10g.onnx       # Face detection
    ├── w600k_r50.onnx     # Face recognition
```

**Storage**: ~300MB total

### GPU Acceleration

**AMD GPUs (ROCm):**

- Supported: RX 6000/7000 series, MI series
- Requires: ROCm 6.2+ (`rocm-smi` working)
- Provider: `ROCMExecutionProvider`
- Speed: ~3-5x faster than CPU

**NVIDIA GPUs (CUDA):**

- Supported: GTX 1000+, RTX series, Tesla
- Requires: CUDA 11.x or 12.x (`nvidia-smi` working)
- Provider: `CUDAExecutionProvider`
- Speed: ~4-6x faster than CPU
- Note: Install `onnxruntime-gpu` instead of `onnxruntime`

**CPU Fallback:**

- Always available as fallback
- Sufficient for development and low-volume production
- Intel/AMD CPUs with AVX2 recommended

## Development

### Project Structure

```
vision-service/
├── src/
│   └── vision_service/
│       ├── __init__.py
│       ├── main.py              # FastAPI app entry point
│       ├── config.py            # Environment configuration
│       ├── detectors.py         # Detector protocol and concrete adapters
│       ├── face_engine.py       # InsightFace engine implementation
│       ├── runtime.py           # Lifecycle and bounded inference admission
│       └── routes/
│           ├── __init__.py
│           ├── health.py        # Operational and legacy health endpoints
│           ├── v1.py            # /v1/capabilities and /v1/analyze
│           └── detect.py        # Legacy face adapters
├── pyproject.toml               # Project metadata and dependencies
├── tests/                       # Contract and runtime tests
├── .env.example                 # Configuration template
└── README.md                    # This file
```

### Adding New Endpoints

1. Create route file in `src/vision_service/routes/`:

```python
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(tags=["my_feature"])

@router.post("/my-endpoint")
async def my_handler():
    return {"status": "ok"}
```

2. Register in `src/vision_service/main.py`:

```python
from .routes import my_router

app.include_router(my_router)
```

### Code Quality

```bash
# Format with ruff (configured in pyproject.toml)
uv run python -m unittest discover -s tests -v
uvx ruff check src tests
uvx ruff format --check src tests
uv lock --check --offline
```

### Logging

The service uses Python's standard logging with structured output:

```
2024-01-15 10:30:45 - vision_service.face_engine - INFO - Available ONNX providers: ['CPUExecutionProvider']
2024-01-15 10:30:47 - vision_service.face_engine - INFO - FaceEngine initialized with model: buffalo_l
2024-01-15 10:31:02 - vision_service.routes.detect - INFO - Detected 2 faces in 45.23ms
```

Adjust verbosity via `LOG_LEVEL` environment variable (DEBUG, INFO, WARNING, ERROR).

## Troubleshooting

### Model Download Fails

**Symptom:** Service fails to start with "Failed to download model"

**Solution:**

```bash
# Manually download models
mkdir -p models
python -c "
from insightface.app import FaceAnalysis
app = FaceAnalysis(name='buffalo_l', root='./models')
app.prepare(ctx_id=0)
"
```

### ONNX Provider Not Available

**Symptom:** Logs show "No configured providers available, falling back to CPU"

**AMD GPU Solution:**

```bash
# Verify ROCm installation
rocm-smi

# Verify the locked runtime instead of installing a second ONNX package
uv sync --frozen
uv run python -c "import onnxruntime as ort; print(ort.get_available_providers())"

# The expected AMD provider is MIGraphX on this installation
export ONNX_PROVIDERS=MIGraphXExecutionProvider,CPUExecutionProvider
export NUDITY_ONNX_PROVIDERS=MIGraphXExecutionProvider,CPUExecutionProvider
```

**NVIDIA GPU Solution:**

```bash
# Verify CUDA installation
nvidia-smi

# Install GPU-enabled onnxruntime
uv pip uninstall onnxruntime
uv pip install onnxruntime-gpu

# Set environment
export ONNX_PROVIDERS=CUDAExecutionProvider,CPUExecutionProvider
```

### Out of Memory (GPU)

**Symptom:** `RuntimeError: HIP error: out of memory`

**Solution:**

- Reduce `DET_SIZE` from 640 to 320
- Reduce `MAX_BATCH_ITEMS` while keeping bounded batching enabled
- Set `NUDITY_MODEL=320n` only when the measured accuracy tradeoff is acceptable
- Restart service to clear GPU memory

### Slow Inference

**Symptom:** Detection takes >500ms per image

**Solutions:**

1. Enable GPU acceleration (see above)
2. Reduce `DET_SIZE` (trades accuracy for speed)
3. Use `buffalo_s` model (smaller, faster)
4. Downscale input images before sending
5. Verify no other GPU processes running (`rocm-smi` or `nvidia-smi`)

### Health Check Fails

**Symptom:** `/health` returns `503` while the process is running

**Solution:**

```bash
# Test health endpoint directly
curl http://localhost:8100/health

# Inspect model readiness and configured capabilities
curl http://localhost:8100/readyz
curl http://localhost:8100/capabilities
```

## License

This service is part of the video management system and follows the same license as the main project.

## Support

For issues specific to this service:

1. Check logs for error messages
2. Verify ONNX providers are available
3. Test with CPU-only mode first
4. Ensure models are downloaded (check `models/` directory)

For backend integration questions, refer to the main project documentation.
