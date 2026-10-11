import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDemoFixtureFiles } from "../tests/helpers/demo-fixtures";

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
  const storageRoot = mkdtempSync(join(tmpdir(), "conversor-video-test-"));
  const storageDirectories = [
    "THUMBNAILS_DIR", "ARTWORK_DIR", "PROFILE_PICTURES_DIR", "FACES_DIR",
    "CREATOR_FACE_THUMBNAILS_DIR", "LOGS_DIR", "STORYBOARDS_DIR", "PREVIEWS_DIR",
    "CONVERTED_VIDEOS_DIR", "COPY_DETECTION_CACHE_DIR", "CAST_TRANSCODE_DIR",
    "FRAME_EXTRACTION_TEMP_DIR", "DEMO_ASSETS_DIR",
  ];
  const isolatedStorage = Object.fromEntries(storageDirectories.map((key) => {
    const path = join(storageRoot, key.toLowerCase());
    mkdirSync(path, { recursive: true });
    return [key, path];
  }));
  try {
    // The helper has only filesystem and type-only imports. All catalog rows
    // and placeholders are synthetic; never copy existing demo/media data.
    const demoAssets = isolatedStorage.DEMO_ASSETS_DIR!;
    const demoFixtures = createDemoFixtureFiles(demoAssets);
    mkdirSync(join(demoAssets, "artwork"), { recursive: true });
    copyFileSync(demoFixtures.manifestPath, join(demoAssets, "artwork", "manifest.json"));
    const child = Bun.spawn(
      [process.execPath, "test", "--max-concurrency=1", file],
      {
        cwd: root,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: {
          ...process.env,
          ...isolatedStorage,
          TEST_STORAGE_ROOT: storageRoot,
          DEMO_DATABASE_PATH: join(storageRoot, "demo.sqlite"),
          RECORDINGS_HIGHLIGHT_PROBE: join(storageRoot, "highlight-probe.json"),
          PERF_PROFILING_LOG_PATH: join(storageRoot, "performance.jsonl"),
          REDIS_URL: "redis://127.0.0.1:1",
          GOONDVR_API_URL: "http://127.0.0.1:1/api/v1",
          GOONDVR_USERNAME: "",
          GOONDVR_PASSWORD: "",
          ENRICHMENT_SERVICE_URL: "http://127.0.0.1:1",
          FACE_SERVICE_URL: "http://127.0.0.1:1",
          FACE_SERVICE_SECRET: "",
          VISION_SERVICE_URL: "http://127.0.0.1:1",
          VISION_SERVICE_SECRET: "",
          OLLAMA_URL: "http://127.0.0.1:1",
          POSTHOG_HOST: "http://127.0.0.1:1",
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
      process.exitCode = exitCode;
      break;
    }
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
}
