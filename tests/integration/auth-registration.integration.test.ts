import { afterAll, beforeAll, expect, test } from "bun:test";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import {
  applyTestDatabaseEnv,
  assertTestDatabaseEnvironment,
  migrateTestDatabase,
  startTestDatabase,
} from "../helpers/test-database";
let database: Awaited<ReturnType<typeof startTestDatabase>>;
let closeDatabase: typeof import("@/config/drizzle").closeDrizzleDatabase;
const app = Fastify();
beforeAll(async () => {
  database = await startTestDatabase();
  applyTestDatabaseEnv(database);
  assertTestDatabaseEnvironment(database, (await import("@/config/env")).env);
  await migrateTestDatabase();
  ({ closeDrizzleDatabase: closeDatabase } = await import("@/config/drizzle"));
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error, _request, reply) => {
    const e = error as { statusCode?: number; message: string };
    reply
      .status(e.statusCode || 500)
      .send({
        success: false,
        error: { message: e.message, statusCode: e.statusCode || 500 },
      });
  });
  await app.register((await import("@/modules/auth/auth.routes")).authRoutes, {
    prefix: "/api/auth",
  });
  await app.ready();
}, 60_000);
afterAll(async () => {
  await app.close();
  await closeDatabase?.();
  await database?.stop();
});
const password = "testing-password-123";
test("invalid login preserves the upstream 401", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "missing@example.com", password },
  });
  expect(response.statusCode, response.body).toBe(401);
});
test("credential failure rolls back the owner so setup remains possible", async () => {
  const { db } = await import("@/config/drizzle");
  const { sql } = await import("drizzle-orm");
  await db.execute(
    sql`CREATE FUNCTION reject_credential() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced credential failure'; END; $$`
  );
  await db.execute(
    sql`CREATE TRIGGER reject_credential BEFORE INSERT ON accounts FOR EACH ROW EXECUTE FUNCTION reject_credential()`
  );
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "failed@example.com", password },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(await db.query.usersTable.findMany()).toHaveLength(0);
    expect(await db.query.accountsTable.findMany()).toHaveLength(0);
  } finally {
    await db.execute(sql`DROP TRIGGER reject_credential ON accounts`);
    await db.execute(sql`DROP FUNCTION reject_credential()`);
  }
});
test("racing signup endpoints create only one owner and existing login still works", async () => {
  const responses = await Promise.all([
    app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "first@example.com", name: "First", password },
    }),
    app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "second@example.com", name: "Second", password },
    }),
  ]);
  expect(
    responses.filter((r) => r.statusCode >= 200 && r.statusCode < 300)
  ).toHaveLength(1);
  expect(responses.filter((r) => r.statusCode === 403)).toHaveLength(1);
  const { db } = await import("@/config/drizzle");
  const users = await db.query.usersTable.findMany();
  expect(users).toHaveLength(1);
  const accounts = await db.query.accountsTable.findMany();
  expect(accounts).toHaveLength(1);
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: users[0].email, password },
  });
  expect(login.statusCode, login.body).toBe(200);
  expect(login.headers["set-cookie"]).toBeDefined();
  const again = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email: "third@example.com", password },
  });
  expect(again.statusCode, again.body).toBe(403);
});
