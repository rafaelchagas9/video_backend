export type DatabaseTarget = {
  host: string;
  port: number;
  database: string;
  user: string;
};

const TEST_DATABASE = "conversor_video_test";
const TEST_USER = "test_user";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function assertSafeTestDatabaseTarget(
  target: DatabaseTarget,
  runtimeNodeEnv: string | undefined,
): void {
  if (runtimeNodeEnv !== "test") return;

  const safe =
    target.database === TEST_DATABASE &&
    target.user === TEST_USER &&
    LOOPBACK_HOSTS.has(target.host);

  if (!safe) {
    throw new Error(
      "Test-mode PostgreSQL access refused: the active connection is not the isolated test database",
    );
  }
}

export function guardDatabaseAccess<T extends object>(
  database: T,
  target: DatabaseTarget,
  getRuntimeNodeEnv: () => string | undefined,
): T {
  return new Proxy(database, {
    get(databaseTarget, property, receiver) {
      assertSafeTestDatabaseTarget(target, getRuntimeNodeEnv());
      return Reflect.get(databaseTarget, property, receiver);
    },
  });
}
