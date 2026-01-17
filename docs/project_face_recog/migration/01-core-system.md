# Core System Tables

Tables for authentication, configuration, and directory management.

## 1. users

Single-user authentication system.

### SQLite Schema
```sql
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### PostgreSQL Schema
```sql
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Current Data**: 1 user

---

## 2. sessions

Session-based authentication tokens.

### SQLite Schema
```sql
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
```

### PostgreSQL Schema
```sql
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
```

**Current Data**: 15 active sessions

**Migration Notes**:
- Session IDs are UUIDs (already TEXT)
- Expired sessions can be cleaned before migration
- Consider setting longer expiry times during migration

---

## 3. app_settings

Global application configuration.

### SQLite Schema
```sql
CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### PostgreSQL Schema
```sql
CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Current Data**: 6 settings

| Key | Value |
|-----|-------|
| min_watch_seconds | 60 |
| short_video_watch_seconds | 10 |
| short_video_duration_seconds | 60 |
| downscale_inactive_days | 90 |
| watch_session_gap_minutes | 30 |
| max_suggestions | 200 |

**Migration Notes**:
- All values stored as TEXT (parsed as needed)
- Direct data transfer without transformation

---

## 4. watched_directories

Video source directories for scanning.

### SQLite Schema
```sql
CREATE TABLE watched_directories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    is_active BOOLEAN DEFAULT 1,
    auto_scan BOOLEAN DEFAULT 1,
    scan_interval_minutes INTEGER DEFAULT 30,
    last_scan_at DATETIME,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### PostgreSQL Schema
```sql
CREATE TABLE watched_directories (
    id SERIAL PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    is_active BOOLEAN DEFAULT true,
    auto_scan BOOLEAN DEFAULT true,
    scan_interval_minutes INTEGER DEFAULT 30,
    last_scan_at TIMESTAMP,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Current Data**: 1 directory

**Migration Notes**:
- Boolean conversion: `1` → `true`, `0` → `false`
- File paths are absolute on the server

---

## Migration Script Example

```typescript
// Export from SQLite
const users = db.query("SELECT * FROM users").all();
const sessions = db.query("SELECT * FROM sessions WHERE expires_at > datetime('now')").all();
const settings = db.query("SELECT * FROM app_settings").all();
const directories = db.query("SELECT * FROM watched_directories").all();

// Transform booleans
directories.forEach(dir => {
    dir.is_active = Boolean(dir.is_active);
    dir.auto_scan = Boolean(dir.auto_scan);
});

// Import to PostgreSQL
await pgPool.query('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)',
    [user.id, user.username, user.password_hash, user.created_at, user.updated_at]);

// Similar for other tables...
```

## Verification Queries

```sql
-- Verify row counts
SELECT 'users' as table_name, COUNT(*) FROM users
UNION ALL
SELECT 'sessions', COUNT(*) FROM sessions
UNION ALL
SELECT 'app_settings', COUNT(*) FROM app_settings
UNION ALL
SELECT 'watched_directories', COUNT(*) FROM watched_directories;

-- Verify foreign keys
SELECT s.id, s.user_id, u.username
FROM sessions s
LEFT JOIN users u ON u.id = s.user_id
WHERE u.id IS NULL; -- Should return 0 rows
```
