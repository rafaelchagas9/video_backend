import { statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const suitePatterns: Record<string, string> = {
  "--unit": "tests/*.test.ts",
  "--integration": "tests/integration/*.integration.test.ts",
};
const pattern = args.length === 1 ? suitePatterns[args[0]!] : undefined;
const files = pattern
  ? Array.from(new Bun.Glob(pattern).scanSync({ cwd: root })).sort()
  : args;

if (files.length === 0) {
  throw new Error(
    "Usage: bun run test:files -- <test-file> [test-file ...] | --unit | --integration"
  );
}

// Validate the entire selection before starting any tests. Absolute paths keep
// Bun from treating a bare file name as a test-path substring filter.
const paths = files.map((file) => {
  const path = resolve(pattern ? root : process.cwd(), file);
  if (
    !file.endsWith(".test.ts") ||
    !statSync(path, { throwIfNoEntry: false })?.isFile()
  ) {
    throw new Error(`Refusing invalid test file: ${file}`);
  }
  return path;
});

// Each file needs a fresh module cache: mock.module and imported env objects
// otherwise leak between files even with --max-concurrency=1.
for (const file of new Set(paths)) {
  console.log(`== ${relative(root, file)} ==`);
  const child = Bun.spawn(
    [process.execPath, "test", "--max-concurrency=1", file],
    {
      cwd: root,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        NODE_ENV: "test",
        DEMO_MODE: "false",
        SESSION_SECRET:
          "test-session-secret-with-at-least-thirty-two-characters",
        POSTHOG_API_KEY: "",
        POSTHOG_CAPTURE_REQUEST_METRICS: "false",
        // Unit tests must mock database I/O. Integration helpers replace this
        // deliberately unusable target with their disposable container port.
        POSTGRES_HOST: "127.0.0.1",
        POSTGRES_PORT: "1",
        POSTGRES_DB: "conversor_video_test",
        POSTGRES_USER: "test_user",
        POSTGRES_PASSWORD: "test_password",
      },
    }
  );
  const exitCode = await child.exited;

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
