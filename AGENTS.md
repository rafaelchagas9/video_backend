# Developer Agent Guidelines

This document provides essential information for AI agents and developers working on the Video Streaming Backend.

## 🛠 Commands

### Development & Database

- **Start Dev Server**: `bun dev` (auto-reloads on change)
- **Start Production**: `bun start`
- **Database Migrations**: `bun db:migrate`

### Testing & Quality

- **Run All Tests**: `bun test`
- **Run Single Test File**: `bun test tests/integration/auth.test.ts`
- **Run Tests by Pattern**: `bun test --filter "should register"`
- **Linting**: `bunx eslint .`
- **Type Checking**: `bunx tsc --noEmit`

## 🏗 Architecture & Patterns

### Module Structure

Each feature in `src/modules/` should follow this file naming convention:

- `*.types.ts`: TypeScript interfaces and types.
- `*.service.ts`: Business logic and database interactions.
- `*.routes.ts`: Fastify route definitions and registrations.
- `*.schemas.ts`: Zod validation schemas.
- `*.middleware.ts`: Feature-specific middleware (e.g., auth).

### Database Access (Bun SQLite)

**CRITICAL**: Always use a getter to access the database reference in services. Do NOT cache it as a property.

```typescript
// ✅ Correct
export class MyService {
  private get db() {
    return getDatabase();
  }
}
```

_Why_: Tests close/reopen the database between suites; cached references become stale.

### Path Aliases

Use the following aliases for imports:

- `@/*` -> `src/*`
- `@/modules/*` -> `src/modules/*`
- `@/utils/*` -> `src/utils/*`
- `@/config/*` -> `src/config/*`

### Error Handling

- Custom errors MUST extend `AppError`.
- MUST include `Object.setPrototypeOf(this, MyCustomError.prototype)` in the constructor.
- Global error handler is in `src/server.ts` and MUST be registered before routes.

### Validation & Logging

- **Validation**: Use Zod schemas with `validateSchema(schema, data)` from `@/utils/validation`.
- **Logging**: Use the Pino logger from `@/utils/logger`. Avoid `console.log`.

## 🎨 Code Style

### Formatting & Naming

- **Naming**: Use `PascalCase` for classes/types, `camelCase` for variables/functions/properties, and `kebab-case` for file names.
- **Imports**: Group imports (Built-ins, Third-party, Internal Aliases, Relative).
- **Type Safety**: Avoid `any`. Use strict TypeScript. Define interfaces for all service method parameters and returns.

### Services

- Instantiate services as singletons at the bottom of the `*.service.ts` file.
- Export the instance, not the class.

### Authentication

- Single-user system: Registration is blocked after the first user is created.
- Use `authenticateUser` middleware for protected routes.
- Use `optionalAuth` for routes that behave differently for guests.

## 🧪 Testing Guidelines

- Use Bun's built-in test runner (`bun:test`).
- Integration tests should use Fastify's `.inject()` for HTTP simulation.
- Use `setupTestServer()`, `cleanupTestServer()`, and `cleanupDatabase()` from `tests/helpers/test-utils.ts`.
- Ensure tests are isolated by cleaning the database in `beforeEach`.

## ⚙️ Environment Configuration

- `DATABASE_PATH`: Path to SQLite database file.
- `SESSION_SECRET`: Minimum 32 characters for cookie signing.
- `FFMPEG_PATH` & `FFPROBE_PATH`: Paths to FFmpeg binaries.
- See `.env.example` for all available options.

## 📝 Implementation Status & Roadmap

- **Completed**: Auth, Directory scanning, Metadata extraction, Video CRUD, Streaming, Creators, Tags, Ratings, Playlists, Favorites, Bookmarks, Thumbnails, Backup, Scheduler.
- **In Progress**: Swagger documentation (infrastructure ready, schemas pending).
- **Pending**: Advanced analytics, Transcoding (future scope).

## 🛠 Useful File Utilities

- `isVideoFile(path)`: Checks supported extensions.
- `computeFileHash(path)`: Generates SHA256 for file integrity.
- `getFileSize(path)`: Returns size in bytes.
- Located in `src/utils/file-utils.ts`.
