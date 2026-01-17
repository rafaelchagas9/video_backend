# Environment Configuration

Environment variable configuration for the backend and face recognition service.

## Backend (.env)

```env
# Database
DATABASE_URL=postgresql://app:password@localhost:5432/video_streaming

# Face Recognition
FACE_RECOGNITION_SERVICE_URL=http://localhost:8100
FACE_RECOGNITION_ENABLED=true

# Existing config...
```

## Face Service (.env)

```env
HOST=0.0.0.0
PORT=8100
ONNX_PROVIDERS=ROCMExecutionProvider,CPUExecutionProvider
INSIGHTFACE_MODEL=buffalo_l
LOG_LEVEL=INFO
```

---

## Related Documentation

- [Deployment](./03-deployment.md) - Full Docker Compose configuration
- [Database Migration](./01-database-migration.md) - Database connection setup
