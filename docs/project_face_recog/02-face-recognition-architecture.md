# Face Recognition Architecture

This document details the face recognition system architecture, including the Python microservice and Bun backend integration.

## Table of Contents

- [System Overview](#system-overview)
- [Python Service Implementation](#python-service-implementation)
- [Bun Backend Integration](#bun-backend-integration)

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Bun/Fastify Backend                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │   Watcher    │  │   Videos     │  │  Face Recognition    │  │
│  │   Service    │──│   Service    │──│      Service         │  │
│  └──────────────┘  └──────────────┘  └──────────┬───────────┘  │
│                                                  │               │
│         ┌────────────────────────────────────────┘               │
│         │ HTTP                                                   │
│         ▼                                                        │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              PostgreSQL + pgvector                        │   │
│  │  ┌─────────────┐  ┌──────────────────────────────────┐   │   │
│  │  │   videos    │  │  creator_face_embeddings         │   │   │
│  │  │   creators  │  │    - embedding vector(512)       │   │   │
│  │  │   tags      │  │    - HNSW index                  │   │   │
│  │  └─────────────┘  │  video_face_detections           │   │   │
│  │                   │    - embedding vector(512)       │   │   │
│  │                   └──────────────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                               │
                               │ HTTP/REST
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│              Python Face Recognition Service                     │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  InsightFace + ONNX Runtime                            │     │
│  │    - buffalo_l model (512-dim embeddings)              │     │
│  │    - ROCm/MIGraphX for AMD GPU                         │     │
│  │    - FastAPI server                                    │     │
│  └────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Python Service Implementation

### Project Structure

```
face-service/
├── pyproject.toml
├── Dockerfile
├── src/
│   ├── main.py           # FastAPI entry
│   ├── config.py         # Settings
│   ├── face_engine.py    # InsightFace wrapper
│   └── routes/
│       ├── detect.py     # POST /detect
│       ├── extract.py    # POST /extract-embedding
│       └── health.py     # GET /health
└── models/               # ONNX model cache
```

### Dependencies (pyproject.toml)

```toml
[project]
name = "face-service"
version = "0.1.0"
dependencies = [
    "fastapi>=0.109.0",
    "uvicorn[standard]>=0.27.0",
    "python-multipart>=0.0.9",
    "insightface>=0.7.3",
    "onnxruntime>=1.17.0",  # or onnxruntime-rocm for AMD GPU
    "opencv-python-headless>=4.9.0",
    "numpy>=1.26.0",
]
```

### Core Engine (face_engine.py)

```python
from insightface.app import FaceAnalysis
import numpy as np
import onnxruntime as ort
from typing import List, Optional
import logging

logger = logging.getLogger(__name__)

class FaceEngine:
    _instance: Optional['FaceEngine'] = None

    def __init__(self):
        # Auto-detect best execution provider
        available = ort.get_available_providers()
        logger.info(f"Available ONNX providers: {available}")

        if 'ROCMExecutionProvider' in available:
            providers = ['ROCMExecutionProvider', 'CPUExecutionProvider']
        elif 'MIGraphXExecutionProvider' in available:
            providers = ['MIGraphXExecutionProvider', 'CPUExecutionProvider']
        elif 'CUDAExecutionProvider' in available:
            providers = ['CUDAExecutionProvider', 'CPUExecutionProvider']
        else:
            providers = ['CPUExecutionProvider']

        logger.info(f"Using providers: {providers}")

        self.app = FaceAnalysis(
            name='buffalo_l',
            providers=providers,
            allowed_modules=['detection', 'recognition']
        )
        self.app.prepare(ctx_id=0, det_size=(640, 640))

    @classmethod
    def get_instance(cls) -> 'FaceEngine':
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def detect(self, image: np.ndarray) -> List[dict]:
        """Detect faces and extract embeddings."""
        faces = self.app.get(image)
        return [
            {
                'bbox': [float(x) for x in face.bbox],
                'embedding': face.embedding.tolist(),  # 512-dim vector
                'det_score': float(face.det_score),
                'age': int(face.age) if hasattr(face, 'age') else None,
                'gender': face.gender if hasattr(face, 'gender') else None,
            }
            for face in faces
        ]
```

### API Endpoint (routes/detect.py)

```python
from fastapi import APIRouter, File, UploadFile, HTTPException
from pydantic import BaseModel
import cv2
import numpy as np

router = APIRouter()

class FaceResult(BaseModel):
    bbox: list[float]
    embedding: list[float]
    det_score: float
    age: int | None = None
    gender: str | None = None

class DetectResponse(BaseModel):
    faces: list[FaceResult]
    processing_time_ms: float

@router.post("/detect", response_model=DetectResponse)
async def detect_faces(file: UploadFile = File(...)):
    import time
    start = time.time()

    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if image is None:
        raise HTTPException(400, "Invalid image")

    from ..face_engine import FaceEngine
    engine = FaceEngine.get_instance()
    faces = engine.detect(image)

    return DetectResponse(
        faces=[FaceResult(**f) for f in faces],
        processing_time_ms=(time.time() - start) * 1000
    )
```

---

## Bun Backend Integration

### Updated Service with pgvector

```typescript
// src/modules/face-recognition/face-recognition.service.ts
import { query, getDatabase } from "@/config/database";
import { faceRecognitionClient } from "./face-recognition.client";
import { logger } from "@/utils/logger";

interface FaceMatch {
  creatorId: number;
  creatorName: string;
  similarity: number;
}

class FaceRecognitionService {
  /**
   * Find matching creator using pgvector similarity search
   */
  async findMatchingCreator(embedding: number[]): Promise<FaceMatch | null> {
    const config = await this.getConfig();
    const threshold = parseFloat(config.match_threshold);

    // Convert embedding array to pgvector format
    const vectorStr = `[${embedding.join(",")}]`;

    const results = await query<FaceMatch>(
      `
      SELECT 
        cfe.creator_id as "creatorId",
        c.name as "creatorName",
        1 - (cfe.embedding <=> $1::vector) as similarity
      FROM creator_face_embeddings cfe
      JOIN creators c ON c.id = cfe.creator_id
      WHERE 1 - (cfe.embedding <=> $1::vector) > $2
      ORDER BY cfe.embedding <=> $1::vector
      LIMIT 1
    `,
      [vectorStr, threshold],
    );

    return results[0] || null;
  }

  /**
   * Process video: extract frames, detect faces, match and store
   */
  async processVideo(videoId: number): Promise<void> {
    const videos = await query<any>("SELECT * FROM videos WHERE id = $1", [
      videoId,
    ]);
    const video = videos[0];
    if (!video) throw new Error("Video not found");

    const config = await this.getConfig();
    const frameCount = parseInt(config.frames_per_video);
    const autoTagThreshold = parseFloat(config.auto_tag_threshold);

    // Extract frames
    const frames = await this.extractFrames(video, frameCount);

    for (const frame of frames) {
      try {
        // Call Python service for face detection
        const result = await faceRecognitionClient.detectFaces(frame.path);

        for (const face of result.faces) {
          // Store detection in database
          const vectorStr = `[${face.embedding.join(",")}]`;

          await query(
            `
            INSERT INTO video_face_detections 
            (video_id, frame_timestamp, embedding, bbox_x, bbox_y, bbox_width, bbox_height, quality_score)
            VALUES ($1, $2, $3::vector, $4, $5, $6, $7, $8)
          `,
            [
              videoId,
              frame.timestamp,
              vectorStr,
              face.bbox[0],
              face.bbox[1],
              face.bbox[2] - face.bbox[0],
              face.bbox[3] - face.bbox[1],
              face.det_score,
            ],
          );

          // Try to find matching creator
          const match = await this.findMatchingCreator(face.embedding);

          if (match) {
            // Update face detection with match
            await query(
              `
              UPDATE video_face_detections 
              SET matched_creator_id = $1, 
                  match_confidence = $2,
                  match_status = $3
              WHERE video_id = $4 
                AND frame_timestamp = $5
                AND bbox_x = $6
            `,
              [
                match.creatorId,
                match.similarity,
                match.similarity >= autoTagThreshold ? "matched" : "pending",
                videoId,
                frame.timestamp,
                face.bbox[0],
              ],
            );

            // Auto-tag if high confidence
            if (match.similarity >= autoTagThreshold) {
              await this.tagVideoWithCreator(videoId, match.creatorId);
              logger.info(
                {
                  videoId,
                  creatorId: match.creatorId,
                  similarity: match.similarity,
                },
                "Auto-tagged video with creator",
              );
            }
          }
        }
      } catch (error) {
        logger.error({ error, videoId, frame }, "Face detection failed");
      }
    }
  }

  /**
   * Add creator face from profile picture
   */
  async trainCreatorFromProfilePicture(creatorId: number): Promise<void> {
    const creators = await query<any>(
      "SELECT profile_picture_path FROM creators WHERE id = $1",
      [creatorId],
    );

    if (!creators[0]?.profile_picture_path) {
      throw new Error("Creator has no profile picture");
    }

    const result = await faceRecognitionClient.detectFaces(
      creators[0].profile_picture_path,
    );

    if (result.faces.length === 0) {
      throw new Error("No face detected in profile picture");
    }

    // Use best quality face
    const bestFace = result.faces.reduce((best, current) =>
      current.det_score > best.det_score ? current : best,
    );

    const vectorStr = `[${bestFace.embedding.join(",")}]`;

    await query(
      `
      INSERT INTO creator_face_embeddings 
      (creator_id, embedding, source_type, source_path, quality_score)
      VALUES ($1, $2::vector, 'profile_picture', $3, $4)
    `,
      [
        creatorId,
        vectorStr,
        creators[0].profile_picture_path,
        bestFace.det_score,
      ],
    );

    // Re-match pending faces against new creator
    await this.rematchPendingFaces(creatorId);
  }

  /**
   * Re-check pending faces against a newly added creator
   */
  private async rematchPendingFaces(newCreatorId: number): Promise<void> {
    const config = await this.getConfig();
    const autoTagThreshold = parseFloat(config.auto_tag_threshold);

    // Find pending faces that match the new creator
    const matches = await query<any>(
      `
      UPDATE video_face_detections vfd
      SET matched_creator_id = $1,
          match_confidence = subq.similarity,
          match_status = CASE 
            WHEN subq.similarity >= $2 THEN 'matched' 
            ELSE 'pending' 
          END
      FROM (
        SELECT vfd.id, 1 - (vfd.embedding <=> cfe.embedding) as similarity
        FROM video_face_detections vfd
        CROSS JOIN creator_face_embeddings cfe
        WHERE vfd.match_status = 'pending'
          AND cfe.creator_id = $1
          AND 1 - (vfd.embedding <=> cfe.embedding) > 0.5
      ) subq
      WHERE vfd.id = subq.id
      RETURNING vfd.video_id, subq.similarity
    `,
      [newCreatorId, autoTagThreshold],
    );

    // Auto-tag videos with high-confidence matches
    for (const match of matches) {
      if (match.similarity >= autoTagThreshold) {
        await this.tagVideoWithCreator(match.video_id, newCreatorId);
      }
    }
  }

  private async tagVideoWithCreator(
    videoId: number,
    creatorId: number,
  ): Promise<void> {
    await query(
      `
      INSERT INTO video_creators (video_id, creator_id)
      VALUES ($1, $2)
      ON CONFLICT (video_id, creator_id) DO NOTHING
    `,
      [videoId, creatorId],
    );
  }

  private async getConfig(): Promise<Record<string, string>> {
    const rows = await query<{ key: string; value: string }>(
      "SELECT key, value FROM face_recognition_config",
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  private async extractFrames(
    video: any,
    count: number,
  ): Promise<Array<{ path: string; timestamp: number }>> {
    // Use existing FFmpeg infrastructure from storyboards.service.ts
    // Extract frames at 10%, 30%, 50%, 70%, 90% of duration
    const timestamps = [];
    for (let i = 1; i <= count; i++) {
      timestamps.push(video.duration_seconds * (i / (count + 1)));
    }
    // ... FFmpeg extraction logic
    return [];
  }
}

export const faceRecognitionService = new FaceRecognitionService();
```

---

## Related Documentation

- [Database Migration](./01-database-migration.md) - PostgreSQL schema and pgvector queries
- [Deployment](./03-deployment.md) - Docker setup for the Python service
- [API Endpoints](./06-api-endpoints.md) - Face recognition HTTP routes
