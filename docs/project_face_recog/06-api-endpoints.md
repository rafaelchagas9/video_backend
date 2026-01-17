# API Endpoints

Face recognition API routes and usage.

## Face Recognition Routes

| Method | Endpoint                                         | Description                        |
| ------ | ------------------------------------------------ | ---------------------------------- |
| POST   | `/api/face-recognition/process/:videoId`         | Manually trigger face processing   |
| GET    | `/api/face-recognition/video/:videoId/faces`     | Get all detected faces for a video |
| GET    | `/api/face-recognition/pending`                  | Get pending matches for review     |
| POST   | `/api/face-recognition/confirm/:faceId`          | Confirm a pending match            |
| POST   | `/api/face-recognition/reject/:faceId`           | Reject a pending match             |
| POST   | `/api/face-recognition/creator/:creatorId/train` | Train from profile picture         |
| GET    | `/api/face-recognition/stats`                    | Recognition statistics             |
| PATCH  | `/api/face-recognition/config`                   | Update thresholds                  |

---

## Endpoint Details

### POST /api/face-recognition/process/:videoId

Manually trigger face processing for a specific video.

**Parameters:**

- `videoId` (path): ID of the video to process

**Response:**

```json
{
  "success": true,
  "facesDetected": 12,
  "facesMatched": 8,
  "processingTime": 2.5
}
```

### GET /api/face-recognition/video/:videoId/faces

Retrieve all detected faces for a video with match status.

**Parameters:**

- `videoId` (path): ID of the video

**Response:**

```json
{
  "faces": [
    {
      "id": 123,
      "frameTimestamp": 12.5,
      "bbox": { "x": 100, "y": 150, "width": 80, "height": 80 },
      "matchStatus": "matched",
      "matchedCreator": {
        "id": 5,
        "name": "John Doe"
      },
      "matchConfidence": 0.85
    }
  ]
}
```

### GET /api/face-recognition/pending

Get pending face matches that require manual review.

**Query Parameters:**

- `limit` (optional): Number of results (default: 50)
- `offset` (optional): Pagination offset (default: 0)

**Response:**

```json
{
  "pending": [
    {
      "id": 456,
      "videoId": 10,
      "videoTitle": "Video Title",
      "frameTimestamp": 25.0,
      "bbox": { "x": 200, "y": 300, "width": 90, "height": 90 },
      "suggestedMatches": [
        {
          "creatorId": 3,
          "creatorName": "Jane Smith",
          "similarity": 0.65
        }
      ]
    }
  ],
  "total": 24
}
```

### POST /api/face-recognition/confirm/:faceId

Confirm a pending match by associating it with a creator.

**Parameters:**

- `faceId` (path): ID of the face detection

**Request Body:**

```json
{
  "creatorId": 5
}
```

**Response:**

```json
{
  "success": true
}
```

### POST /api/face-recognition/reject/:faceId

Reject a pending match, marking it as not matching any creator.

**Parameters:**

- `faceId` (path): ID of the face detection

**Response:**

```json
{
  "success": true
}
```

### POST /api/face-recognition/creator/:creatorId/train

Train the face recognition system with a creator's profile picture.

**Parameters:**

- `creatorId` (path): ID of the creator

**Response:**

```json
{
  "success": true,
  "facesDetected": 1,
  "embeddingStored": true,
  "pendingFacesRematched": 7
}
```

### GET /api/face-recognition/stats

Get recognition statistics and system status.

**Response:**

```json
{
  "totalDetections": 1250,
  "matchedDetections": 980,
  "pendingDetections": 270,
  "creators": 15,
  "averageConfidence": 0.78
}
```

### PATCH /api/face-recognition/config

Update face recognition configuration thresholds.

**Request Body:**

```json
{
  "matchThreshold": 0.5,
  "autoTagThreshold": 0.7,
  "framesPerVideo": 5,
  "minFaceSize": 64
}
```

**Response:**

```json
{
  "matchThreshold": 0.5,
  "autoTagThreshold": 0.7,
  "framesPerVideo": 5,
  "minFaceSize": 64,
  "enabled": true
}
```

---

## Related Documentation

- [Face Recognition Architecture](./02-face-recognition-architecture.md) - Service implementation details
- [Database Migration](./01-database-migration.md) - Database schema used by endpoints
- [Implementation Timeline](./05-implementation-timeline.md) - UI development phase (Phase 6)
