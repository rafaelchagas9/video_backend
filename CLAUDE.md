# Agent Guidelines

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

## General

dev server will be running and avaliable to test at https://video.lan.rafaelm.dev/ <- this is points to my local dev server, so any changes will be avaliable there
