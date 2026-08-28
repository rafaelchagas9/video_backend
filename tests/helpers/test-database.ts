import postgres from "postgres";

type TestDatabase = {
  containerName: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionString: string;
  stop: () => Promise<void>;
};

const IMAGE = process.env.TEST_POSTGRES_IMAGE || "pgvector/pgvector:pg18-trixie";

async function runDocker(args: string[]): Promise<string> {
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `docker ${args.join(" ")} failed with code ${exitCode}: ${stderr.trim()}`,
    );
  }

  return stdout.trim();
}

async function waitForPostgres(connectionString: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    const sql = postgres(connectionString, {
      max: 1,
      idle_timeout: 1,
      connect_timeout: 2,
    });

    try {
      await sql`select 1`;
      await sql.end({ timeout: 1 });
      return;
    } catch (error) {
      lastError = error;
      await sql.end({ timeout: 1 }).catch(() => undefined);
      await Bun.sleep(500);
    }
  }

  throw new Error(`Timed out waiting for test Postgres: ${String(lastError)}`);
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const containerName = `conversor-video-test-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const database = "conversor_video_test";
  const user = "test_user";
  const password = "test_password";

  await runDocker([
    "run",
    "-d",
    "--rm",
    "--name",
    containerName,
    "-e",
    `POSTGRES_USER=${user}`,
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    `POSTGRES_DB=${database}`,
    "-p",
    "127.0.0.1::5432",
    IMAGE,
  ]);

  const stop = async () => {
    await runDocker(["stop", containerName]).catch(() => undefined);
  };

  try {
    const portOutput = await runDocker(["port", containerName, "5432/tcp"]);
    const port = Number(portOutput.match(/:(\d+)$/)?.[1]);

    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`Could not parse mapped Postgres port: ${portOutput}`);
    }

    const host = "127.0.0.1";
    const connectionString = `postgres://${user}:${password}@${host}:${port}/${database}`;
    await waitForPostgres(connectionString);

    return {
      containerName,
      host,
      port,
      database,
      user,
      password,
      connectionString,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

export function applyTestDatabaseEnv(database: TestDatabase): void {
  process.env.NODE_ENV = "test";
  process.env.DEMO_MODE = "false";
  process.env.POSTGRES_HOST = database.host;
  process.env.POSTGRES_PORT = String(database.port);
  process.env.POSTGRES_DB = database.database;
  process.env.POSTGRES_USER = database.user;
  process.env.POSTGRES_PASSWORD = database.password;
  process.env.POSTGRES_MAX_CONNECTIONS = "4";
  process.env.SESSION_SECRET =
    "test-session-secret-with-at-least-thirty-two-characters";
  process.env.BASE_URL = "http://localhost:3000";
  process.env.CORS_ORIGINS = "";
  process.env.POSTHOG_API_KEY = "";
  process.env.POSTHOG_CAPTURE_REQUEST_METRICS = "false";
  process.env.IMAGE_DOWNLOAD_MIN_INTERVAL_MS = "0";
}

export function assertTestDatabaseEnvironment(
  database: TestDatabase,
  effective: {
    NODE_ENV: string;
    DEMO_MODE: boolean;
    POSTGRES_HOST: string;
    POSTGRES_PORT: number;
    POSTGRES_DB: string;
    POSTGRES_USER: string;
  },
): void {
  const matches =
    effective.NODE_ENV === "test" &&
    effective.DEMO_MODE === false &&
    effective.POSTGRES_HOST === database.host &&
    effective.POSTGRES_PORT === database.port &&
    effective.POSTGRES_DB === database.database &&
    effective.POSTGRES_USER === database.user;

  if (!matches) {
    throw new Error(
      "Integration test database isolation failed: cached configuration does not match the disposable database",
    );
  }
}

export async function migrateTestDatabase(): Promise<void> {
  const proc = Bun.spawn(
    [
      "bunx",
      "drizzle-kit",
      "push",
      "--force",
      "--config",
      "drizzle.config.ts",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `drizzle-kit push failed with code ${exitCode}:\n${stdout}\n${stderr}`,
    );
  }
}
