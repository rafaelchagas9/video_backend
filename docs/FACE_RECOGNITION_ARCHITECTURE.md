Face Recognition Architecture with PostgreSQL + pgvector
Executive Summary
This document details the architecture for integrating face recognition capabilities into the video streaming backend, along with a migration from SQLite to PostgreSQL with pgvector for native vector operations.
Key Decisions:
- Face Recognition Engine: InsightFace (Python microservice)
- Database: PostgreSQL 16+ with pgvector extension
- GPU Acceleration: AMD ROCm/MIGraphX for RX 7800 XT
- Vector Storage: Native PostgreSQL vector type with HNSW indexing
---
Part 1: Database Migration (SQLite → PostgreSQL)
Why PostgreSQL + pgvector?
| Feature | SQLite | PostgreSQL + pgvector |
|---------|--------|----------------------|
| Vector type | BLOB (manual) | Native vector(512) |
| Similarity search | O(n) in code | O(log n) with HNSW |
| Concurrent writes | Limited | Full support |
| Scaling | ~100K rows | Millions+ |
| Distance functions | Manual | Built-in (cosine, L2, inner product) |
Migration Strategy
Phase 1: Infrastructure Setup
# Install PostgreSQL 16+
sudo apt install postgresql-16 postgresql-16-pgvector
# Create database
sudo -u postgres createdb video_streaming
sudo -u postgres psql -d video_streaming -c "CREATE EXTENSION vector;"
Phase 2: Code Changes
Replace Bun SQLite with PostgreSQL client:
// Before: src/config/database.ts
import { Database } from 'bun:sqlite';
// After: src/config/database.ts
import { Pool } from 'pg';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
});
export function getDatabase() {
  return pool;
}
// Query helper for compatibility
export async function query<T>(sql: string, params?: any[]): Promise<T[]> {
  const result = await pool.query(sql, params);
  return result.rows;
}
Phase 3: Schema Migration
Key changes for existing tables:
- INTEGER PRIMARY KEY → SERIAL PRIMARY KEY
- DATETIME → TIMESTAMP
- BOOLEAN → BOOLEAN (same, but true/false not 1/0)
- Add vector columns for face embeddings
New Schema with pgvector
-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;
-- Existing tables (adapted for PostgreSQL)
CREATE TABLE creators (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    profile_picture_path TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE videos (
    id SERIAL PRIMARY KEY,
    file_path TEXT NOT NULL UNIQUE,
    title TEXT,
    duration_seconds REAL,
    width INTEGER,
    height INTEGER,
    codec TEXT,
    file_size_bytes BIGINT,
    file_hash TEXT,
    is_available BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- NEW: Face embeddings for creators (known faces)
CREATE TABLE creator_face_embeddings (
    id SERIAL PRIMARY KEY,
    creator_id INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    embedding vector(512) NOT NULL,  -- InsightFace buffalo_l produces 512-dim vectors
    source_type TEXT NOT NULL CHECK (source_type IN ('profile_picture', 'video_frame', 'manual')),
    source_path TEXT,
    quality_score REAL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- NEW: Detected faces in videos
CREATE TABLE video_face_detections (
    id SERIAL PRIMARY KEY,
    video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    frame_timestamp REAL NOT NULL,
    embedding vector(512) NOT NULL,
    bbox_x REAL NOT NULL,
    bbox_y REAL NOT NULL,
    bbox_width REAL NOT NULL,
    bbox_height REAL NOT NULL,
    quality_score REAL,
    matched_creator_id INTEGER REFERENCES creators(id) ON DELETE SET NULL,
    match_confidence REAL,
    match_status TEXT DEFAULT 'pending' CHECK (match_status IN ('pending', 'matched', 'rejected', 'manual')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- NEW: Face recognition configuration
CREATE TABLE face_recognition_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO face_recognition_config (key, value) VALUES
    ('match_threshold', '0.5'),
    ('auto_tag_threshold', '0.7'),
    ('frames_per_video', '5'),
    ('min_face_size', '64'),
    ('enabled', 'true');
-- HNSW index for fast similarity search
CREATE INDEX idx_creator_faces_embedding ON creator_face_embeddings 
    USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_video_faces_embedding ON video_face_detections 
    USING hnsw (embedding vector_cosine_ops);
-- Standard indexes
CREATE INDEX idx_video_faces_video ON video_face_detections(video_id);
CREATE INDEX idx_video_faces_status ON video_face_detections(match_status);
CREATE INDEX idx_creator_faces_creator ON creator_face_embeddings(creator_id);
Vector Query Examples
-- Find matching creator for a face (single query!)
SELECT 
    cfe.creator_id,
    c.name,
    1 - (cfe.embedding <=> $1::vector) AS similarity
FROM creator_face_embeddings cfe
JOIN creators c ON c.id = cfe.creator_id
WHERE 1 - (cfe.embedding <=> $1::vector) > 0.5  -- threshold
ORDER BY cfe.embedding <=> $1::vector
LIMIT 1;
-- Find all videos potentially containing a creator
SELECT DISTINCT v.id, v.title
FROM video_face_detections vfd
JOIN videos v ON v.id = vfd.video_id
WHERE 1 - (vfd.embedding <=> (
    SELECT embedding FROM creator_face_embeddings 
    WHERE creator_id = $1 
    ORDER BY quality_score DESC 
    LIMIT 1
)) > 0.6
ORDER BY v.created_at DESC;
-- Cluster unmatched faces (find potential new creators)
SELECT 
    vfd1.id as face1_id,
    vfd2.id as face2_id,
    1 - (vfd1.embedding <=> vfd2.embedding) AS similarity
FROM video_face_detections vfd1
CROSS JOIN video_face_detections vfd2
WHERE vfd1.id < vfd2.id
    AND vfd1.match_status = 'pending'
    AND vfd2.match_status = 'pending'
    AND 1 - (vfd1.embedding <=> vfd2.embedding) > 0.7
ORDER BY similarity DESC
LIMIT 100;
---
Part 2: Face Recognition Architecture
System Overview
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
Python Service Implementation
Project Structure:
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
Dependencies (pyproject.toml):
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
Core Engine (face_engine.py):
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
API Endpoint (routes/detect.py):
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
Bun Backend Integration
Updated Service with pgvector:
// src/modules/face-recognition/face-recognition.service.ts
import { query, getDatabase } from '@/config/database';
import { faceRecognitionClient } from './face-recognition.client';
import { logger } from '@/utils/logger';
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
    const vectorStr = `[${embedding.join(',')}]`;
    
    const results = await query<FaceMatch>(`
      SELECT 
        cfe.creator_id as "creatorId",
        c.name as "creatorName",
        1 - (cfe.embedding <=> $1::vector) as similarity
      FROM creator_face_embeddings cfe
      JOIN creators c ON c.id = cfe.creator_id
      WHERE 1 - (cfe.embedding <=> $1::vector) > $2
      ORDER BY cfe.embedding <=> $1::vector
      LIMIT 1
    `, [vectorStr, threshold]);
    
    return results[0] || null;
  }
  
  /**
   * Process video: extract frames, detect faces, match and store
   */
  async processVideo(videoId: number): Promise<void> {
    const videos = await query<any>('SELECT * FROM videos WHERE id = $1', [videoId]);
    const video = videos[0];
    if (!video) throw new Error('Video not found');
    
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
          const vectorStr = `[${face.embedding.join(',')}]`;
          
          await query(`
            INSERT INTO video_face_detections 
            (video_id, frame_timestamp, embedding, bbox_x, bbox_y, bbox_width, bbox_height, quality_score)
            VALUES ($1, $2, $3::vector, $4, $5, $6, $7, $8)
          `, [
            videoId,
            frame.timestamp,
            vectorStr,
            face.bbox[0],
            face.bbox[1],
            face.bbox[2] - face.bbox[0],
            face.bbox[3] - face.bbox[1],
            face.det_score
          ]);
          
          // Try to find matching creator
          const match = await this.findMatchingCreator(face.embedding);
          
          if (match) {
            // Update face detection with match
            await query(`
              UPDATE video_face_detections 
              SET matched_creator_id = $1, 
                  match_confidence = $2,
                  match_status = $3
              WHERE video_id = $4 
                AND frame_timestamp = $5
                AND bbox_x = $6
            `, [
              match.creatorId,
              match.similarity,
              match.similarity >= autoTagThreshold ? 'matched' : 'pending',
              videoId,
              frame.timestamp,
              face.bbox[0]
            ]);
            
            // Auto-tag if high confidence
            if (match.similarity >= autoTagThreshold) {
              await this.tagVideoWithCreator(videoId, match.creatorId);
              logger.info({ videoId, creatorId: match.creatorId, similarity: match.similarity }, 
                'Auto-tagged video with creator');
            }
          }
        }
      } catch (error) {
        logger.error({ error, videoId, frame }, 'Face detection failed');
      }
    }
  }
  
  /**
   * Add creator face from profile picture
   */
  async trainCreatorFromProfilePicture(creatorId: number): Promise<void> {
    const creators = await query<any>(
      'SELECT profile_picture_path FROM creators WHERE id = $1', 
      [creatorId]
    );
    
    if (!creators[0]?.profile_picture_path) {
      throw new Error('Creator has no profile picture');
    }
    
    const result = await faceRecognitionClient.detectFaces(creators[0].profile_picture_path);
    
    if (result.faces.length === 0) {
      throw new Error('No face detected in profile picture');
    }
    
    // Use best quality face
    const bestFace = result.faces.reduce((best, current) => 
      current.det_score > best.det_score ? current : best
    );
    
    const vectorStr = `[${bestFace.embedding.join(',')}]`;
    
    await query(`
      INSERT INTO creator_face_embeddings 
      (creator_id, embedding, source_type, source_path, quality_score)
      VALUES ($1, $2::vector, 'profile_picture', $3, $4)
    `, [creatorId, vectorStr, creators[0].profile_picture_path, bestFace.det_score]);
    
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
    const matches = await query<any>(`
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
    `, [newCreatorId, autoTagThreshold]);
    
    // Auto-tag videos with high-confidence matches
    for (const match of matches) {
      if (match.similarity >= autoTagThreshold) {
        await this.tagVideoWithCreator(match.video_id, newCreatorId);
      }
    }
  }
  
  private async tagVideoWithCreator(videoId: number, creatorId: number): Promise<void> {
    await query(`
      INSERT INTO video_creators (video_id, creator_id)
      VALUES ($1, $2)
      ON CONFLICT (video_id, creator_id) DO NOTHING
    `, [videoId, creatorId]);
  }
  
  private async getConfig(): Promise<Record<string, string>> {
    const rows = await query<{key: string, value: string}>(
      'SELECT key, value FROM face_recognition_config'
    );
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  }
  
  private async extractFrames(video: any, count: number): Promise<Array<{path: string, timestamp: number}>> {
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
---
Part 3: Deployment
Docker Compose Setup
# docker-compose.yml
version: '3.8'
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: video_streaming
      POSTGRES_USER: app
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d video_streaming"]
      interval: 10s
      timeout: 5s
      retries: 5
  face-service:
    build: ./face-service
    ports:
      - "8100:8100"
    volumes:
      - ./data/profile-pictures:/data/profile-pictures:ro
      - ./data/thumbnails:/data/thumbnails:ro
      - face_models:/root/.insightface
    environment:
      - ONNX_PROVIDERS=ROCMExecutionProvider,CPUExecutionProvider
    devices:
      - /dev/kfd:/dev/kfd
      - /dev/dri:/dev/dri
    group_add:
      - video
      - render
    depends_on:
      - postgres
  backend:
    build: .
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://app:${DB_PASSWORD}@postgres:5432/video_streaming
      - FACE_RECOGNITION_SERVICE_URL=http://face-service:8100
    volumes:
      - ./data:/app/data
    depends_on:
      postgres:
        condition: service_healthy
      face-service:
        condition: service_started
volumes:
  postgres_data:
  face_models:
AMD GPU Setup (ROCm)
# Install ROCm 6.4 on Ubuntu 22.04+
wget https://repo.radeon.com/amdgpu-install/6.4/ubuntu/jammy/amdgpu-install_6.4.60400-1_all.deb
sudo apt install ./amdgpu-install_6.4.60400-1_all.deb
sudo amdgpu-install --usecase=rocm
# Add user to required groups
sudo usermod -aG video,render $USER
# Verify installation
rocminfo
# Install ONNX Runtime with ROCm
pip install onnxruntime-rocm --extra-index-url https://repo.radeon.com/rocm/manylinux/rocm-rel-6.4/
---
Part 4: Environment Configuration
Backend (.env)
# Database
DATABASE_URL=postgresql://app:password@localhost:5432/video_streaming
# Face Recognition
FACE_RECOGNITION_SERVICE_URL=http://localhost:8100
FACE_RECOGNITION_ENABLED=true
# Existing config...
Face Service (.env)
HOST=0.0.0.0
PORT=8100
ONNX_PROVIDERS=ROCMExecutionProvider,CPUExecutionProvider
INSIGHTFACE_MODEL=buffalo_l
LOG_LEVEL=INFO
---
Part 5: Implementation Timeline
| Phase | Task | Duration | Priority |
|-------|------|----------|----------|
| 1 | PostgreSQL migration prep (schema, queries) | 1 week | Critical |
| 2 | Python face service (InsightFace setup) | 3-4 days | Critical |
| 3 | Database migration execution | 2-3 days | Critical |
| 4 | Backend face recognition service | 1 week | High |
| 5 | Watcher integration (auto-processing) | 2-3 days | High |
| 6 | Review UI for pending matches | 3-4 days | Medium |
| 7 | AMD GPU optimization | 2-3 days | Low |
Total: ~4-5 weeks
---
Part 6: API Endpoints
Face Recognition Routes
POST /api/face-recognition/process/:videoId
  - Manually trigger face processing
GET /api/face-recognition/video/:videoId/faces
  - Get all detected faces for a video
GET /api/face-recognition/pending
  - Get pending matches for review
POST /api/face-recognition/confirm/:faceId
  - Confirm a pending match
POST /api/face-recognition/reject/:faceId
  - Reject a pending match
POST /api/face-recognition/creator/:creatorId/train
  - Train from profile picture
GET /api/face-recognition/stats
  - Recognition statistics
PATCH /api/face-recognition/config
  - Update thresholds
---
Summary
This design provides:
1. PostgreSQL + pgvector for native vector operations and HNSW-indexed similarity search
2. InsightFace Python microservice for SOTA face recognition
3. AMD GPU support via ROCm for your RX 7800 XT
4. Automatic background processing of new videos
5. Review queue for lower-confidence matches
6. Clean separation between existing backend and ML service
The PostgreSQL migration is significant but provides substantial benefits for vector operations, better concurrency, and future scalability.