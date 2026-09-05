import { afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Read local generated demo fixtures into a disposable database. */
export function useSeededDemoDatabase({ artwork = false } = {}): void {
  const originalNodeEnv = process.env.NODE_ENV;
  let root: string;
  let demo: typeof import("@/database/demo");
  let env: typeof import("@/config/env").env;
  let originalAssetsDir: string;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    ({ env } = await import("@/config/env"));
    originalAssetsDir = env.DEMO_ASSETS_DIR;
    env.DEMO_ASSETS_DIR = "demo_mode";
    root = mkdtempSync(join(tmpdir(), "conversor-demo-test-"));
    demo = await import("@/database/demo");
    demo.setDemoDatabasePathForTests(join(root, "demo.sqlite"));
    demo.importDemoJsonFile(resolve("demo_mode/demo_mode.json"), {
      reset: true,
    });
    if (artwork) {
      demo.importDemoArtworkManifestFile(
        resolve("demo_mode/artwork/manifest.json")
      );
    }
  });

  afterAll(() => {
    demo?.setDemoDatabasePathForTests(null);
    if (root) rmSync(root, { recursive: true, force: true });
    if (env) env.DEMO_ASSETS_DIR = originalAssetsDir;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });
}
