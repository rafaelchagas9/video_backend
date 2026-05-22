# Edits API Documentation

Scope: video editing job workflow

## Integration notes

- All endpoints require authentication.
- Editing is async/job-based. Poll job status and merge with SSE notifications where available.
- `GET /api/videos/:id/editing-metadata` is the bootstrap endpoint for edit UI.

## Endpoints

### GET /api/videos/:id/editing-metadata
- Success: `200` -> `{ success: true, data: { id, title, duration, fps, resolution, bitrate, audio, storyboard_vtt } }`
- Notes:
  - `storyboard_vtt` may be `null`.
  - Includes audio metadata extracted through ffprobe.

### POST /api/videos/:id/edits
- Body:
  - `output`: `{ directory_id, file_name, format="mkv", video_codec="av1", audio_codec="copy"|"aac", preserve? }`
  - `timeline`: `{ snap_to_clips?, segments: [{ start, end, speed? }] }`
- Success: `200` -> `{ success: true, data: { job_id, status, video_id, output }, message }`

### GET /api/edits/jobs/:id
- Success: `200` -> `{ success: true, data: { job_id, status, progress?, started_at?, completed_at?, output?, error? } }`
- Notes:
  - On completed jobs, `output.stream_url` may be present and can be used with video player.

### POST /api/edits/jobs/:id/cancel
- Success: `200` -> `{ success: true, data: { job_id, status } }`

## Key enums

- Edit job status: `pending | queued | running | completed | failed | cancelled`
