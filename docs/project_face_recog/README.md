# Face Recognition Project

This project integrates face recognition capabilities into the video streaming backend using PostgreSQL with pgvector for vector operations and an InsightFace Python microservice.

## Overview

### Key Components

- **Database**: PostgreSQL 16+ with pgvector extension for native vector storage and HNSW-indexed similarity search
- **Face Recognition Engine**: InsightFace (Python microservice) with FastAPI
- **GPU Acceleration**: AMD ROCm/MIGraphX support for RX 7800 XT
- **Backend Integration**: Bun/Fastify backend with pgvector client

### Architecture Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                        Bun/Fastify Backend                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │   Watcher    │  │   Videos     │  │  Face Recognition    │  │
│  │   Service    │──│   Service    │──│      Service         │  │
│  └──────────────┘  └──────────────┘  └──────────┬───────────┘  │
└─────────────────────────────────────────────────────────────────┘
                               │ HTTP/REST
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│              PostgreSQL + pgvector                                │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  creator_face_embeddings (vector(512) with HNSW index)   │   │
│  │  video_face_detections (vector(512) with HNSW index)     │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│              Python Face Recognition Service                     │
│  InsightFace + ONNX Runtime (buffalo_l model, 512-dim)           │
│  FastAPI server with ROCm/MIGraphX GPU support                  │
└─────────────────────────────────────────────────────────────────┘
```

## Documentation

| Document                                                               | Description                                                                |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [Database Migration](./01-database-migration.md)                       | SQLite to PostgreSQL + pgvector migration, schema changes, vector queries  |
| [Face Recognition Architecture](./02-face-recognition-architecture.md) | Python microservice implementation, Bun backend integration, face matching |
| [Deployment](./03-deployment.md)                                       | Docker Compose setup, AMD GPU/ROCm configuration                           |
| [Environment Configuration](./04-environment-config.md)                | Backend and face service environment variables                             |
| [Implementation Timeline](./05-implementation-timeline.md)             | Phased implementation plan with priorities                                 |
| [API Endpoints](./06-api-endpoints.md)                                 | Face recognition API routes and usage                                      |

## Implementation Status

- **Total Duration**: ~4-5 weeks
- **Priority Tasks**: Database migration, Python service setup, backend integration

## Benefits of This Architecture

1. **Native Vector Operations**: PostgreSQL pgvector provides efficient similarity search with HNSW indexing (O(log n))
2. **Scalability**: Supports millions of face embeddings vs ~100K rows with SQLite
3. **GPU Acceleration**: AMD ROCm support for faster face recognition
4. **Automatic Processing**: Background processing of new videos with face detection and matching
5. **Review Queue**: Lower-confidence matches require manual approval
6. **Clean Separation**: ML service isolated from existing backend
