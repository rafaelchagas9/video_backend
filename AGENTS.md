# Developer Agent Guidelines

This document provides essential information for AI agents and developers working on the Video Streaming Backend.

## 🛠 Commands

### Development & Database

- **Start Dev Server**: `bun dev` (auto-reloads on change)
- **Start Production**: `bun start`
- **Generate Migrations**: `bun db:generate` (generates Drizzle migrations from schema)
- **Run Migrations**: `bun db:migrate` (applies pending migrations)
- **Push Schema**: `bun db:push` (push schema changes directly - dev only)
- **Database Studio**: `bun db:studio` (opens Drizzle Studio GUI)

### Testing & Quality

- **Run All Tests**: `bun test`
- **Run Single Test File**: `bun test tests/integration/auth.test.ts`
- **Run Tests by Pattern**: `bun test --filter "should register"`
- **Linting**: `bunx eslint .`
- **Type Checking**: `bunx tsc --noEmit`
- **Important**: Do not run unit tests as they are currently broken.

## 🏗 Architecture & Patterns

### Module Structure

Each feature in `src/modules/` should follow this file naming convention:

- `*.types.ts`: TypeScript interfaces and types.
- `*.service.ts`: Business logic and database interactions.
- `*.routes.ts`: Fastify route definitions and registrations.
- `*.schemas.ts`: Zod validation schemas.
- `*.middleware.ts`: Feature-specific middleware (e.g., auth).

### Database Access (PostgreSQL + Drizzle ORM)

This project uses **PostgreSQL** with **Drizzle ORM**. Import the database from `@/config/drizzle`:

```typescript
import { db } from "@/config/drizzle";
import { usersTable } from "@/database/schema";
import { eq } from "drizzle-orm";

// Simple query
const user = await db.query.usersTable.findFirst({
  where: (users, { eq }) => eq(users.id, userId),
});

// Insert with returning
const [newUser] = await db.insert(usersTable).values({ name }).returning();

// Update
await db.update(usersTable).set({ name }).where(eq(usersTable.id, userId));

// Delete
await db.delete(usersTable).where(eq(usersTable.id, userId));
```

**For complex queries**, use the `sql` template tag:

```typescript
import { sql } from "drizzle-orm";

const results = await db.execute(sql`
  SELECT c.*, COUNT(vc.video_id) as video_count
  FROM creators c
  LEFT JOIN video_creators vc ON c.id = vc.creator_id
  WHERE c.name LIKE ${`%${search}%`}
  GROUP BY c.id
  LIMIT ${limit}
`);
```

### Schema Definition

Schemas are defined in `src/database/schema/` using Drizzle's pg-core:

```typescript
import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

### Path Aliases

Use the following aliases for imports:

- `@/*` -> `src/*`
- `@/modules/*` -> `src/modules/*`
- `@/utils/*` -> `src/utils/*`
- `@/config/*` -> `src/config/*`
- `@/database/*` -> `src/database/*`

### Error Handling

- Custom errors MUST extend `AppError`.
- MUST include `Object.setPrototypeOf(this, MyCustomError.prototype)` in the constructor.
- Global error handler is in `src/server.ts` and MUST be registered before routes.
- PostgreSQL error codes: `23505` (unique violation), `23503` (foreign key violation).

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
- **Note**: Test utilities need to be updated for PostgreSQL (currently broken).

## ⚙️ Environment Configuration

### Required PostgreSQL Variables

- `POSTGRES_HOST`: PostgreSQL host (default: localhost)
- `POSTGRES_PORT`: PostgreSQL port (default: 5432)
- `POSTGRES_DB`: Database name (default: video_streaming_db)
- `POSTGRES_USER`: Database user (required)
- `POSTGRES_PASSWORD`: Database password (required)
- `POSTGRES_MAX_CONNECTIONS`: Max pool connections (default: 20)

### Other Configuration

- `SESSION_SECRET`: Minimum 32 characters for cookie signing.
- `FFMPEG_PATH` & `FFPROBE_PATH`: Paths to FFmpeg binaries.
- See `.env.example` for all available options.

## 📝 Implementation Status & Roadmap

- **Completed**: Auth, Directory scanning, Metadata extraction, Video CRUD, Streaming, Creators, Tags, Ratings, Playlists, Favorites, Bookmarks, Thumbnails, Backup, Scheduler, Stats, Conversion, Triage, Auto-tagging.
- **In Progress**: Swagger documentation (infrastructure ready, schemas pending).
- **Pending**: Advanced analytics, Transcoding (future scope), Test suite migration to PostgreSQL.

## 🛠 Useful File Utilities

- `isVideoFile(path)`: Checks supported extensions.
- `computeFileHash(path)`: Generates SHA256 for file integrity.
- `getFileSize(path)`: Returns size in bytes.
- Located in `src/utils/file-utils.ts`.
