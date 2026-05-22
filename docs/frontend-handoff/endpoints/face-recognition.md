# Face Recognition API Documentation

Scope: face embeddings, detections, search, extraction queue

## Integration notes

- All endpoints are authenticated.
- Mix of JSON + multipart upload + image binary responses.
- Asynchronous operations emit SSE events (`face:extraction_started`, `face:extraction_complete`, `face:extraction_error`).

## Endpoints

### GET /api/faces/health
- Success: `200` -> `{ success: true, data: { status, version?, ... } }`

### POST /api/creators/:id/face-embeddings
- Content-Type: `multipart/form-data`
- Body: uploaded image file
- Success: `200` -> `{ success: true, data: embedding }`
- Errors: `400` when no file uploaded

### POST /api/creators/:id/face-embeddings/base64
- Body:
  - `image_base64` string
  - `is_primary` boolean optional
- Success: `200` -> `{ success: true, data: embedding }`

### GET /api/creators/:id/face-embeddings
- Success: `200` -> `{ success: true, data: embedding[] }`
- Note: includes `image_url` pointing to thumbnail endpoint when available.

### PUT /api/creators/:id/face-embeddings/:eid/primary
- Success: `200` -> `{ success: true, data: { message } }`

### DELETE /api/creators/:id/face-embeddings/:eid
- Success: `200` -> `{ success: true, data: { message } }`

### GET /api/creators/:id/face-embeddings/:eid/thumbnail
- Success: `200` image bytes (`image/webp`)
- Errors: `404` if thumbnail record/file missing

### GET /api/videos/:id/faces
- Success: `200` -> `{ success: true, data: FaceDetection[] }`
- Note: frontend-friendly shape includes `faceImageUrl` and optional `matchedCreator`.

### GET /api/faces/:id/image
- Success: `200` image bytes (`image/webp` or `image/jpeg`)
- Behavior: image may be lazily generated on first request.

### POST /api/videos/:id/faces/extract
- Success: `202` -> `{ success: true, data: { message: "Face extraction started" } }`
- Errors: `400` for invalid preconditions (e.g., missing video duration)

### PUT /api/videos/:id/faces/:did/confirm
- Body:
  - `creator_id` number
- Success: `200` -> `{ success: true, data: { message } }`

### PUT /api/videos/:id/faces/:did/reject
- Success: `200` -> `{ success: true, data: { message } }`

### GET /api/creators/:id/videos-by-face
- Query:
  - `min_confidence` number 0..1 optional (default around 0.65)
- Success: `200` -> `{ success: true, data: [...] }`

### POST /api/faces/search
- Content-Type: `multipart/form-data`
- Query:
  - `limit` int <= 100 optional (default 10)
  - `threshold` number 0..1 optional (default ~0.65)
- Body: uploaded image file
- Success: `200` -> `{ success: true, data: matches[] }`
- Errors: `400` for no file or no detectable face

### GET /api/videos/:id/faces/status
- Success: `200` -> `{ success: true, data: job }`
- Errors: `404` when no job exists

### DELETE /api/faces/queue
- Success: `200` -> `{ success: true, data: { message } }`

## Frontend cautions

- Treat extraction/search flows as long-running and failure-prone; provide retries and clear feedback.
- Use image endpoints directly in `<img>` with authenticated session context.
- Centralize face status updates through polling + SSE to keep triage UI in sync.
