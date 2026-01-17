# Implementation Timeline

Phased implementation plan for the face recognition system.

## Timeline

| Phase | Task                                        | Duration | Priority |
| ----- | ------------------------------------------- | -------- | -------- |
| 1     | PostgreSQL migration prep (schema, queries) | 1 week   | Critical |
| 2     | Python face service (InsightFace setup)     | 3-4 days | Critical |
| 3     | Database migration execution                | 2-3 days | Critical |
| 4     | Backend face recognition service            | 1 week   | High     |
| 5     | Watcher integration (auto-processing)       | 2-3 days | High     |
| 6     | Review UI for pending matches               | 3-4 days | Medium   |
| 7     | AMD GPU optimization                        | 2-3 days | Low      |

**Total**: ~4-5 weeks

---

## Phase Details

### Phase 1: PostgreSQL Migration Prep (1 week) - Critical

- Design new schema with pgvector columns
- Write migration scripts for existing data
- Create HNSW indexes for vector search
- Test vector queries with sample data

### Phase 2: Python Face Service (3-4 days) - Critical

- Set up FastAPI project structure
- Install and configure InsightFace
- Implement `/detect` endpoint
- Test face detection on sample images

### Phase 3: Database Migration Execution (2-3 days) - Critical

- Backup existing SQLite database
- Run migration scripts
- Verify data integrity
- Update database connection configuration

### Phase 4: Backend Face Recognition Service (1 week) - High

- Implement `FaceRecognitionService` class
- Create pgvector query methods
- Build HTTP client for Python service
- Test face matching logic

### Phase 5: Watcher Integration (2-3 days) - High

- Hook into video watcher service
- Trigger face processing on new videos
- Implement frame extraction from FFmpeg
- Test auto-tagging workflow

### Phase 6: Review UI for Pending Matches (3-4 days) - Medium

- Build admin review interface
- Show pending face matches
- Add confirm/reject actions
- Test manual matching flow

### Phase 7: AMD GPU Optimization (2-3 days) - Low

- Install ROCm drivers
- Configure ONNX Runtime with ROCm
- Benchmark CPU vs GPU performance
- Optimize batch processing

---

## Related Documentation

- [Database Migration](./01-database-migration.md) - Phase 1 & 3 details
- [Face Recognition Architecture](./02-face-recognition-architecture.md) - Phase 2 & 4 details
- [Deployment](./03-deployment.md) - Phase 7 details
- [API Endpoints](./06-api-endpoints.md) - Phase 6 details
