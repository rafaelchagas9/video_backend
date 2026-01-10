# Frontend API Handoff: Video Conversion

## Overview

New endpoints for GPU-accelerated video conversion, including job management and real-time WebSocket updates.

**Base URL**: `/api`
**WebSocket**: `ws://[host]:[port]/ws`

---

## 1. List Available Presets

Get a list of all available conversion presets (e.g., 1080p H.264, 720p AV1).

- **Endpoint**: `GET /presets`
- **Response**: `200 OK`

```json
{
  "success": true,
  "data": [
    {
      "id": "1080p_h264",
      "name": "1080p H.264",
      "description": "Full HD with H.264 - Best compatibility",
      "targetWidth": 1920,
      "codec": "h264_vaapi",
      "qp": 22,
      "audioBitrate": "128k",
      "container": "mkv"
    },
    ...
  ]
}
```

---

## 2. Start Conversion

Start a new conversion job for a video.

- **Endpoint**: `POST /videos/:id/convert`
- **Body**:
  ```json
  {
    "preset": "1080p_h265" // Must be a valid ID from /presets
  }
  ```
- **Response**: `201 Created`

```json
{
  "success": true,
  "data": {
    "id": 123,
    "video_id": 45,
    "status": "pending",
    "preset": "1080p_h265",
    "progress_percent": 0,
    "created_at": "2024-01-09T10:00:00.000Z",
    ...
  }
}
```

---

## 3. List Conversions for Video

Get all conversion jobs (past and present) for a specific video.

- **Endpoint**: `GET /videos/:id/conversions`
- **Response**: `200 OK`

```json
{
  "success": true,
  "data": [
    {
      "id": 123,
      "status": "completed",
      "preset": "720p_av1",
      "output_path": "...",
      "progress_percent": 100,
      ...
    }
  ]
}
```

---

## 4. Get Job Status

Get details of a specific conversion job.

- **Endpoint**: `GET /conversions/:id`
- **Response**: `200 OK`

```json
{
  "success": true,
  "data": {
    "id": 123,
    "status": "processing",
    "progress_percent": 45.5,
    ...
  }
}
```

---

## 5. Cancel Job

Cancel a pending or processing job.

- **Endpoint**: `POST /conversions/:id/cancel`
- **Response**: `200 OK` (Returns updated job object)

---

## 6. Delete Job

Delete a job and its output file (only if completed/failed/cancelled).

- **Endpoint**: `DELETE /conversions/:id`
- **Response**: `200 OK`

```json
{
  "success": true,
  "message": "Job deleted"
}
```

---

## 7. Download Converted Video

Download the result file.

- **Endpoint**: `GET /conversions/:id/download`
- **Response**: File stream (`video/x-matroska`, attachment)

---

## 8. WebSocket Events

Connect to `/ws` (cookie auth required). Listen for these events:

### Conversion Started
```json
{
  "type": "conversion:started",
  "jobId": 123,
  "videoId": 45,
  "preset": "1080p_h264"
}
```

### Conversion Progress
```json
{
  "type": "conversion:progress",
  "jobId": 123,
  "videoId": 45,
  "preset": "1080p_h264",
  "progress": 45.5
}
```

### Conversion Completed
```json
{
  "type": "conversion:completed",
  "jobId": 123,
  "videoId": 45,
  "preset": "1080p_h264",
  "progress": 100,
  "outputPath": "..."
}
```

### Conversion Failed
```json
{
  "type": "conversion:failed",
  "jobId": 123,
  "videoId": 45,
  "preset": "1080p_h264",
  "error": "FFmpeg exited with code 1"
}
```
