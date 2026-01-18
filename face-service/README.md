# Face Recognition Service

A high-performance microservice for face detection and embedding extraction using InsightFace. This service provides stateless ML inference capabilities for the video management backend, enabling automatic creator tagging and face-based video organization.

## Overview

The Face Recognition Service is a specialized Python microservice that:
- Detects faces in images using InsightFace's state-of-the-art models
- Extracts 512-dimensional face embeddings for similarity matching
- Supports GPU acceleration via ONNX Runtime (ROCm for AMD, CUDA for NVIDIA)
- Provides a simple HTTP API for programmatic access

**Technology Stack:**
- FastAPI for high-performance async HTTP
- InsightFace (buffalo_l) for face detection and recognition
- ONNX Runtime for cross-platform ML inference
- OpenCV for image processing
- UV for fast Python dependency management

## Architecture

The Face Recognition Service operates as part of a three-tier architecture:

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
                   │ HTTP POST /detect
                   │ (multipart/form-data or JSON)
                   ▼
┌──────────────────────────────────────────────────────┐
│     Python Face Service (port 8100) - THIS SERVICE  │
│                                                       │
│  ┌────────────────────────────────────────────────┐  │
│  │       InsightFace + ONNX Runtime               │  │
│  │  - Face detection (RetinaFace)                 │  │
│  │  - Face recognition (ArcFace)                  │  │
│  │  - 512-dimensional embedding extraction        │  │
│  │  - Optional age/gender estimation              │  │
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
- **Dual Input Methods**: File upload or base64-encoded images
- **Metadata**: Optional age and gender estimation
- **Health Monitoring**: Built-in health check endpoint with model info
- **Docker Ready**: CPU and ROCm (AMD GPU) container images

## API Endpoints

### `GET /health`

Check service status and configuration.

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
  -F "file=@image.jpg"
```

**Response:**
```json
{
  "faces": [
    {
      "bbox": [123.4, 56.7, 234.5, 167.8],
      "embedding": [0.123, -0.456, ...],  // 512 floats
      "det_score": 0.9987,
      "age": 28,
      "gender": "M"
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
- `age`: Estimated age (nullable)
- `gender`: "M" or "F" (nullable)

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
cd face-service

# Create virtual environment and install
uv venv
source .venv/bin/activate  # or `.venv\Scripts\activate` on Windows

# For CPU or NVIDIA GPU
uv pip install -e .

# For AMD GPU with ROCm 7.1+
uv pip uninstall onnxruntime
uv pip install onnxruntime-migraphx -f https://repo.radeon.com/rocm/manylinux/rocm-rel-7.1.1/
uv pip install -e .
```

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

# Detection input size (640 default, higher = slower but more accurate)
DET_SIZE=640

# Logging level
LOG_LEVEL=INFO

# Model cache directory
MODEL_CACHE_DIR=./models
```

**Configuration Options:**

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `8100` | HTTP port |
| `ONNX_PROVIDERS` | `CPUExecutionProvider` | Execution backends (comma-separated) |
| `INSIGHTFACE_MODEL` | `buffalo_l` | Model variant (`buffalo_l` or `buffalo_s`) |
| `DET_SIZE` | `640` | Detection resolution (higher = slower) |
| `LOG_LEVEL` | `INFO` | Logging verbosity |
| `MODEL_CACHE_DIR` | `./models` | Where InsightFace downloads models |

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
python -m face_service.main
```

**For other platforms:**
```bash
# With UV
uv run python -m face_service.main

# Or with activated venv
source .venv/bin/activate
python -m face_service.main
```

The service will:
1. Download InsightFace models on first run (~300MB for buffalo_l)
2. Initialize ONNX Runtime with configured providers
3. Start HTTP server on `http://localhost:8100`

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

## Docker Deployment

### CPU-Only Container

```bash
# Build
docker build -t face-service:cpu -f Dockerfile .

# Run
docker run -d \
  --name face-service \
  -p 8100:8100 \
  -v $(pwd)/models:/app/models \
  face-service:cpu
```

**Features:**
- Multi-stage build for minimal image size
- Python 3.12 slim base
- Persistent model cache via volume mount
- Health check every 30s

### AMD GPU (ROCm) Container

```bash
# Build
docker build -t face-service:rocm -f Dockerfile.rocm .

# Run with GPU access
docker run -d \
  --name face-service \
  --device=/dev/kfd \
  --device=/dev/dri \
  --group-add video \
  -p 8100:8100 \
  -v $(pwd)/models:/app/models \
  -e ONNX_PROVIDERS=ROCMExecutionProvider,CPUExecutionProvider \
  face-service:rocm
```

**Requirements:**
- ROCm 6.2+ installed on host
- AMD GPU compatible with ROCm (RX 6000/7000 series, etc.)
- Docker with `--device` access configured

**Verify GPU Usage:**
```bash
docker logs face-service | grep "Using ONNX providers"
# Should show: ['ROCMExecutionProvider', 'CPUExecutionProvider']
```

### Docker Compose

```yaml
version: '3.8'

services:
  face-service:
    build:
      context: ./face-service
      dockerfile: Dockerfile
    ports:
      - "8100:8100"
    volumes:
      - ./face-service/models:/app/models
    environment:
      - ONNX_PROVIDERS=CPUExecutionProvider
      - LOG_LEVEL=INFO
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8100/health"]
      interval: 30s
      timeout: 10s
      retries: 3
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
   formData.append('file', frameBlob, 'frame.jpg');

   const response = await fetch('http://localhost:8100/detect', {
     method: 'POST',
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
      "embedding": [/* 512 floats */],
      "det_score": 0.998,
      "age": 32,
      "gender": "F"
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
  "detail": "Invalid image format. Supported: JPEG, PNG, WebP, BMP, TIFF"
}
```

### Performance Considerations

- **Model Loading**: First request after startup takes ~2-5s (model initialization)
- **Inference Time**:
  - CPU: 50-200ms per image (depending on resolution)
  - AMD GPU (ROCm): 15-50ms per image
  - NVIDIA GPU (CUDA): 10-40ms per image
- **Concurrent Requests**: FastAPI handles async requests efficiently
- **Scaling**: Stateless design allows horizontal scaling with load balancer

### Error Handling

The Python service returns standard HTTP status codes:

- `200 OK`: Successful detection (even if no faces found)
- `400 Bad Request`: Invalid image format or empty file
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
- **Attributes**: Age and gender estimation (optional)

**Embedding Characteristics:**
- **Dimension**: 512 floats
- **Normalization**: L2-normalized (unit vectors)
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
    └── genderage.onnx     # Age/gender estimation
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
face-service/
├── src/
│   └── face_service/
│       ├── __init__.py
│       ├── main.py              # FastAPI app entry point
│       ├── config.py            # Environment configuration
│       ├── face_engine.py       # InsightFace wrapper (singleton)
│       └── routes/
│           ├── __init__.py
│           ├── health.py        # /health endpoint
│           └── detect.py        # /detect and /extract-embedding
├── pyproject.toml               # Project metadata and dependencies
├── Dockerfile                   # CPU container
├── Dockerfile.rocm              # AMD GPU container
├── .env.example                 # Configuration template
└── README.md                    # This file
```

### Adding New Endpoints

1. Create route file in `src/face_service/routes/`:
```python
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(tags=["my_feature"])

@router.post("/my-endpoint")
async def my_handler():
    return {"status": "ok"}
```

2. Register in `src/face_service/main.py`:
```python
from .routes import my_router

app.include_router(my_router)
```

### Testing

```bash
# Install dev dependencies (optional)
uv pip install pytest httpx

# Run tests (if test suite exists)
pytest tests/

# Manual testing with curl
curl -X POST http://localhost:8100/detect \
  -F "file=@test_image.jpg" \
  | jq '.faces | length'
```

### Code Quality

```bash
# Format with ruff (configured in pyproject.toml)
uvx ruff check src/
uvx ruff format src/
```

### Logging

The service uses Python's standard logging with structured output:

```
2024-01-15 10:30:45 - face_service.face_engine - INFO - Available ONNX providers: ['CPUExecutionProvider']
2024-01-15 10:30:47 - face_service.face_engine - INFO - FaceEngine initialized with model: buffalo_l
2024-01-15 10:31:02 - face_service.routes.detect - INFO - Detected 2 faces in 45.23ms
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

# Install onnxruntime-rocm
uv pip install onnxruntime-rocm

# Set environment
export ONNX_PROVIDERS=ROCMExecutionProvider,CPUExecutionProvider
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
- Process images sequentially (avoid batching)
- Restart service to clear GPU memory

### Slow Inference

**Symptom:** Detection takes >500ms per image

**Solutions:**
1. Enable GPU acceleration (see above)
2. Reduce `DET_SIZE` (trades accuracy for speed)
3. Use `buffalo_s` model (smaller, faster)
4. Downscale input images before sending
5. Verify no other GPU processes running (`rocm-smi` or `nvidia-smi`)

### Docker Container Won't Start

**Symptom:** Container exits immediately

**Debug:**
```bash
# Check logs
docker logs face-service

# Run interactively
docker run -it --rm face-service:cpu /bin/bash

# Inside container, test manually
python -m face_service.main
```

### Health Check Fails

**Symptom:** Docker health check fails despite service running

**Solution:**
```bash
# Test health endpoint directly
curl http://localhost:8100/health

# Check if port is exposed
docker port face-service
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
