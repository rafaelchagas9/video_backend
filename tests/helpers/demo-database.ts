import { afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDemoFixtureFiles } from "./demo-fixtures";

/** Read synthetic demo fixtures into a disposable database. */
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
    root = mkdtempSync(join(tmpdir(), "conversor-demo-test-"));
    env.DEMO_ASSETS_DIR = root;
    const fixtures = createDemoFixtureFiles(root);
    demo = await import("@/database/demo");
    demo.setDemoDatabasePathForTests(join(root, "demo.sqlite"));
    demo.importDemoJsonFile(fixtures.seedPath, {
      reset: true,
    });
    if (artwork) {
      demo.importDemoArtworkManifestFile(
        fixtures.manifestPath
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
