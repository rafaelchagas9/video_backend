# Frontend Face Recognition Implementation Guide

This document outlines the new endpoints available for the Face Recognition feature.

**Base URL:** `/api`

## 1. Creator Faces

Manage reference face embeddings for creators. These embeddings are used to identify creators in videos.

### Upload Reference Face

Upload an image file to create a reference face for a creator.

- **Endpoint:** `POST /creators/:id/face-embeddings`
- **Description:** Uploads an image, detects the face, and stores it as a reference embedding for the specified creator.
- **Content-Type:** `multipart/form-data`

**Request Body:**
| Field | Type | Description |
|-------|------|-------------|
| `file` | File | The image file containing the creator's face (JPEG, PNG, WebP). |

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "id": 123,
    "creatorId": 456,
    "embedding": "[0.123, ...]",
    "sourceType": "manual_upload",
    "detScore": 0.99,
    "isPrimary": false,
    "estimatedAge": 30,
    "estimatedGender": "M",
    "createdAt": "2024-03-20T10:00:00.000Z",
    "updatedAt": "2024-03-20T10:00:00.000Z"
  }
}
```

### List Reference Faces

Get all reference face embeddings for a creator.

- **Endpoint:** `GET /creators/:id/face-embeddings`
- **Description:** Returns a list of all reference faces associated with the creator.

**Response (200 OK):**

```json
{
  "success": true,
  "data": [
    {
      "id": 123,
      "creatorId": 456,
      "sourceType": "manual_upload",
      "isPrimary": true,
      "detScore": 0.98,
      "createdAt": "2024-03-20T10:00:00.000Z"
      // ... other embedding fields
    }
    // ...
  ]
}
```

### Set Primary Reference Face

Mark a specific embedding as the primary reference for the creator.

- **Endpoint:** `PUT /creators/:id/face-embeddings/:eid/primary`
- **Description:** Sets the specified embedding (`:eid`) as the primary face for the creator. This unsets any existing primary embedding.

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "message": "Primary embedding updated"
  }
}
```

### Delete Reference Face

Remove a reference face.

- **Endpoint:** `DELETE /creators/:id/face-embeddings/:eid`
- **Description:** Permanently deletes the specified face embedding.

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "message": "Face embedding deleted"
  }
}
```

## 2. Video Faces

Manage faces detected within videos.

### List Detections

Get all faces detected in a video.

- **Endpoint:** `GET /videos/:id/faces`
- **Description:** Returns all face detections for a specific video, including their timestamps and match status.

**Response (200 OK):**

```json
{
  "success": true,
  "data": [
    {
      "id": 789,
      "videoId": 100,
      "timestampSeconds": 12.5,
      "frameIndex": 300,
      "bboxX1": 0.2,
      "bboxY1": 0.1,
      "bboxX2": 0.4,
      "bboxY2": 0.3,
      "detScore": 0.95,
      "matchedCreatorId": 456,
      "matchConfidence": 0.85,
      "matchStatus": "confirmed", // 'pending', 'confirmed', 'rejected', 'no_match'
      "createdAt": "2024-03-20T12:00:00.000Z"
    }
    // ...
  ]
}
```

### Trigger Extraction

Start the face extraction process for a video.

- **Endpoint:** `POST /videos/:id/faces/extract`
- **Description:** Queues a job to process the video, extract frames, detect faces, and run recognition.

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "message": "Face extraction started"
  }
}
```

### Confirm Match

Manually confirm a face match.

- **Endpoint:** `PUT /videos/:id/faces/:did/confirm`
- **Description:** Confirms that the detected face (`:did`) belongs to the specified creator.

**Request Body:**

```json
{
  "creator_id": 456
}
```

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "message": "Face match confirmed"
  }
}
```

### Reject Match

Manually reject a face match.

- **Endpoint:** `PUT /videos/:id/faces/:did/reject`
- **Description:** Marks the detected face (`:did`) as a rejected match.

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "message": "Face match rejected"
  }
}
```

## 3. Search & Utilities

### Search by Face

Find creators using an uploaded face image.

- **Endpoint:** `POST /faces/search`
- **Description:** Upload an image to find similar creators in the database.
- **Content-Type:** `multipart/form-data`
- **Query Parameters:**
  - `limit` (optional): Max results (default: 10)
  - `threshold` (optional): Similarity threshold (default: 0.65)

**Request Body:**
| Field | Type | Description |
|-------|------|-------------|
| `file` | File | The image file to search with. |

**Response (200 OK):**

```json
{
  "success": true,
  "data": [
    {
      "creator_id": 456,
      "creator_name": "Jane Doe",
      "similarity": 0.92,
      "reference_embedding_id": 123,
      "reference_source_type": "manual_upload"
    }
    // ...
  ]
}
```

### Videos by Creator (Face)

Find videos containing a creator based on face recognition.

- **Endpoint:** `GET /creators/:id/videos-by-face`
- **Description:** Returns videos where the creator has been identified via face recognition.
- **Query Parameters:**
  - `min_confidence` (optional): Minimum match confidence (default: 0.65).

**Response (200 OK):**

```json
{
  "success": true,
  "data": [
    // Array of Video objects
    {
      "id": 100,
      "title": "Video Title",
      "path": "/path/to/video.mp4"
      // ... video fields
    }
  ]
}
```

### Service Health

Check the status of the face recognition service.

- **Endpoint:** `GET /faces/health`
- **Description:** Returns the health status of the underlying Python face recognition service.

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "status": "healthy", // 'healthy', 'degraded', 'unhealthy'
    "version": "1.0.0",
    "model_loaded": true,
    "uptime_seconds": 3600
  }
}
```
