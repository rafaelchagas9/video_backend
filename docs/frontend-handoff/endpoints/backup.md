# Backup API Documentation

Scope: `/api/backup/*`

## Integration notes

- All endpoints require authentication.
- This is an admin/maintenance surface.
- Mix of JSON and downloadable JSON export.
- Route descriptions still mention SQLite in places; verify runtime expectations if frontend exposes this broadly.

## Endpoints

### POST /api/backup

- Success: `201` -> `{ success: true, data: BackupInfo, message }`
- Errors: `401`, `500`

### GET /api/backup

- Success: `200` -> `{ success: true, data: BackupInfo[] }`

### GET /api/backup/export

- Success: `200` downloadable JSON file
- Headers:
  - `Content-Type: application/json`
  - `Content-Disposition: attachment; filename="export-YYYY-MM-DD.json"`

### POST /api/backup/:filename/restore

- Params:
  - `filename` string
- Success: `200` -> `{ success: true, message }`
- Errors: `401`, `404`

### DELETE /api/backup/:filename

- Params:
  - `filename` string
- Success: `200` -> `{ success: true, message }`
- Errors: `401`, `404`

## Backup info model

- `filename`
- `path`
- `sizeBytes`
- `createdAt`

## Frontend cautions

1. Treat restore/delete as dangerous actions and require confirmation.
2. Export endpoint is a file download, not a JSON API payload for rendering.
