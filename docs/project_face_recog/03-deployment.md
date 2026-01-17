# Deployment

This document covers deployment configuration for the face recognition system, including Docker Compose setup and AMD GPU optimization.

## Table of Contents

- [Docker Compose Setup](#docker-compose-setup)
- [AMD GPU Setup (ROCm)](#amd-gpu-setup-rocm)

---

## Docker Compose Setup

### docker-compose.yml

```yaml
version: "3.8"
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
```

---

## AMD GPU Setup (ROCm)

### Install ROCm 6.4 on Ubuntu 22.04+

```bash
wget https://repo.radeon.com/amdgpu-install/6.4/ubuntu/jammy/amdgpu-install_6.4.60400-1_all.deb
sudo apt install ./amdgpu-install_6.4.60400-1_all.deb
sudo amdgpu-install --usecase=rocm
```

### Add User to Required Groups

```bash
sudo usermod -aG video,render $USER
```

### Verify Installation

```bash
rocminfo
```

### Install ONNX Runtime with ROCm

```bash
pip install onnxruntime-rocm --extra-index-url https://repo.radeon.com/rocm/manylinux/rocm-rel-6.4/
```

---

## Related Documentation

- [Environment Configuration](./04-environment-config.md) - Environment variables for services
- [Face Recognition Architecture](./02-face-recognition-architecture.md) - Python service structure
- [Implementation Timeline](./05-implementation-timeline.md) - Deployment phases
