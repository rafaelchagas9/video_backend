# Agent Guidelines

## Commands

### Dev & Database
| Command | Description |
|---|---|
| `bun dev` | Dev server with auto-reload |
| `bun start` | Production server |
| `bun db:generate` | Generate Drizzle migrations |
| `bun db:migrate` | Apply pending migrations |
| `bun db:push` | Direct schema sync (dev only; dangerous) |
| `bun db:studio` | Drizzle Studio GUI |
| `bun db:introspect` | Introspect DB to schema |
| `bun db:apply-migration` | Run custom migration script |

### Quality
| Command | Description |
|---|---|
| `bunx eslint .` | Lint |
| `bunx tsc --noEmit` | Type check |

No test command or CI/CD pipeline configured.

## Module Pattern

Modules in `src/modules/<name>/` use:
- `*.types.ts` — TypeScript interfaces
- `*.service.ts` — Business logic (singleton instance exported, not class)
- `*.routes.ts` — Fastify route definitions
- `*.schemas.ts` — Zod validation schemas
- `*.middleware.ts` — Feature-specific middleware

## Path Aliases

`@/*` → `src/*`, `@/modules/*`, `@/utils/*`, `@/config/*`, `@/database/*`

## Migration Safety

- **Never** run `db:push` on shared/prod databases — can propose destructive diffs.
- Workflow: update `src/database/schema/*.ts` → `bun db:generate` → review SQL → `bun db:migrate`.
- Migrations live in `src/database/drizzle-migrations/` (configured in `drizzle.config.ts`).
- No manual SQL ALTERs without explicit approval.

## Key Patterns

- **Errors**: extend `AppError`, call `Object.setPrototypeOf(this, MyError.prototype)`. PG codes: `23505` (unique), `23503` (FK).
- **Validation**: `validateSchema(schema, data)` from `@/utils/validation`.
- **Logging**: Pino from `@/utils/logger` — no `console.log`.
- **Auth**: `authenticateUser` for protected routes, `optionalAuth` for guest access. Single-user system — registration auto-disables after first user.
