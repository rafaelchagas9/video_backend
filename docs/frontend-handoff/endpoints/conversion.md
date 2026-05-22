# Conversion API Documentation

Scope: conversion queue/history/download endpoints

## Integration notes

- All conversion endpoints require authentication.
- Conversion is async/job-based; combine polling + SSE (`conversion:*` events).
- Presets are backend-defined; UI should fetch `GET /api/presets` rather than hardcode.
- `GET /api/conversions/:id/download` is a file download stream (non-JSON).

## Endpoints

### POST /api/videos/:id/convert
- Body:
  - `preset` string (must match available preset id)
  - `deleteOriginal` boolean optional
- Success: `201` -> `{ success: true, data: ConversionJob }`

### POST /api/videos/convert/bulk
- Body:
  - `videoIds` number[]
  - `preset` string
  - `deleteOriginal` boolean optional
- Success: `201` -> `{ success: true, data: { batchId, jobs: ConversionJob[] } }`
- Behavior note: backend may partially succeed per video in the batch.

### GET /api/videos/convert/queue
- Success: `200` -> `{ success: true, data: unknown[] }` (queue entries)

### GET /api/videos/:id/conversions
- Success: `200` -> `{ success: true, data: ConversionJob[] }`

### GET /api/conversions/history
- Query:
  - `limit` 1..200 optional
  - `offset` >= 0 optional
  - `videoId` positive int optional
  - `preset` string optional
- Success: `200` -> `{ success: true, data: ConversionHistoryItem[] }`

### GET /api/conversions/history/overview
- Query:
  - `videoId` optional
  - `preset` optional
- Success: `200` -> `{ success: true, data: ConversionHistoryOverview }`

### GET /api/conversions/:id
- Success: `200` -> `{ success: true, data: ConversionJob }`

### POST /api/conversions/:id/cancel
- Success: `200` -> `{ success: true, data: ConversionJob }`

### DELETE /api/conversions/:id
- Success: `200` -> `{ success: true, message }`

### GET /api/conversions/:id/download
- Success: `200` file stream
- Headers:
  - `Content-Type: video/x-matroska`
  - `Content-Disposition: attachment; filename="..."`
  - `Content-Length`
- Errors: not-found style when output unavailable.

### GET /api/presets
- Success: `200` -> `{ success: true, data: Preset[] }`

### GET /api/conversion/status
- Success: `200` -> `{ success: true, data: { queueLength, activeJobs, isProcessing } }`

### GET /api/conversions/active
- Success: `200` -> `{ success: true, data: ActiveConversion[] }`

### POST /api/conversions/queue/clear
- Success: `200` -> `{ success: true, data: { pendingCleared, processingReset, message } }`

## Key models

- `ConversionJob.status`: `pending | processing | completed | failed | cancelled`
- `ActiveConversion.status`: `pending | processing`
