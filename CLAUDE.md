# Developer Agent Guidelines

This document provides essential information for AI agents working on the Video Streaming Backend.

## 🛠 Commands

### Development & Database

| Command           | Description                             |
| ----------------- | --------------------------------------- |
| `bun dev`         | Start dev server with auto-reload       |
| `bun start`       | Start production server                 |
| `bun db:generate` | Generate Drizzle migrations from schema |
| `bun db:migrate`  | Apply pending migrations                |
| `bun db:push`     | Push schema changes directly (dev only) |
| `bun db:studio`   | Open Drizzle Studio GUI                 |

### Testing & Quality

| Command                                   | Description          |
| ----------------------------------------- | -------------------- |
| `bun test`                                | Run all tests        |
| `bun test tests/integration/auth.test.ts` | Run single test file |
| `bun test --filter "should register"`     | Run tests by pattern |
| `bunx eslint .`                           | Run linter           |
| `bunx tsc --noEmit`                       | Run type checking    |

**Note**: Unit tests are currently broken. Focus on integration tests.

## 🏗 Architecture & Patterns

### Module Structure

Features in `src/modules/` follow this file pattern:

- `*.types.ts` - TypeScript interfaces and types
- `*.service.ts` - Business logic and database interactions
- `*.routes.ts` - Fastify route definitions
- `*.schemas.ts` - Zod validation schemas
- `*.middleware.ts` - Feature-specific middleware

### Database (PostgreSQL + Drizzle ORM)

```typescript
import { db } from "@/config/drizzle";
import { usersTable } from "@/database/schema";
import { eq } from "drizzle-orm";

// Query examples
const user = await db.query.usersTable.findFirst({
  where: (users, { eq }) => eq(users.id, userId),
});

const [newUser] = await db.insert(usersTable).values({ name }).returning();
await db.update(usersTable).set({ name }).where(eq(usersTable.id, userId));
await db.delete(usersTable).where(eq(usersTable.id, userId));
```

For complex queries, use the `sql` template tag from `drizzle-orm`.

### Path Aliases

```
@/* -> src/*
@/modules/* -> src/modules/*
@/utils/* -> src/utils/*
@/config/* -> src/config/*
@/database/* -> src/database/*
```

## 🎨 Code Style

### General

- **Naming**: `PascalCase` for classes/types, `camelCase` for variables/functions, `kebab-case` for files
- **Type Safety**: Avoid `any`. Use strict TypeScript with explicit interfaces
- **Imports**: Group in order: Built-ins → Third-party → Internal aliases → Relative

### Error Handling

- Custom errors MUST extend `AppError`
- Include `Object.setPrototypeOf(this, MyCustomError.prototype)` in constructor
- Global error handler in `src/server.ts` (register before routes)
- PostgreSQL codes: `23505` (unique), `23503` (FK violation)

### Validation & Logging

- Use Zod schemas with `validateSchema(schema, data)` from `@/utils/validation`
- Use Pino logger from `@/utils/logger` (avoid `console.log`)

### Services

- Instantiate services as singletons at the bottom of `*.service.ts`
- Export the instance, not the class

### Authentication

- Single-user system: registration blocked after first user
- Use `authenticateUser` middleware for protected routes
- Use `optionalAuth` for guest-accessible routes

## 🧪 Testing

Use Bun's built-in test runner (`bun:test`). Integration tests use Fastify's `.inject()`. Use helpers from `tests/helpers/test-utils.ts`. Clean database in `beforeEach` for isolation.

## ⚙️ Environment Configuration

Required PostgreSQL variables:

- `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`
- `POSTGRES_MAX_CONNECTIONS` (default: 20)

Other keys: `SESSION_SECRET` (min 32 chars), `FFMPEG_PATH`, `FFPROBE_PATH`. See `.env.example`.

## 🛠 Useful Utilities

- `isVideoFile(path)` - Check supported extensions
- `computeFileHash(path)` - SHA256 for integrity
- `getFileSize(path)` - Size in bytes
- Located in `src/utils/file-utils.ts`
