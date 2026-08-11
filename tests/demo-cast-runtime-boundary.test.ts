import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";

process.env.NODE_ENV = "test";
process.env.POSTGRES_USER ||= "demo-cast-boundary-test";
process.env.POSTGRES_PASSWORD ||= "demo-cast-boundary-test";
process.env.SESSION_SECRET ||=
  "demo-cast-boundary-session-secret-at-least-32-characters";

const testRoot = `/tmp/conversor-video-demo-cast-boundary-${process.pid}`;
const demoAssetsRoot = join(testRoot, "demo-assets");
const productionCastRoot = join(testRoot, "production-cast");
const staleProductionSession = join(productionCastRoot, "a".repeat(64));

let originalConfig: {
  demoMode: boolean;
  demoAssetsDir: string;
  castTranscodeDir: string;
};

beforeAll(async () => {
  rmSync(testRoot, { recursive: true, force: true });
  mkdirSync(demoAssetsRoot, { recursive: true });
  mkdirSync(staleProductionSession, { recursive: true });
  writeFileSync(join(staleProductionSession, "sentinel.txt"), "private");
  const old = new Date(0);
  utimesSync(staleProductionSession, old, old);

  const { env } = await import("@/config/env");
  originalConfig = {
    demoMode: env.DEMO_MODE,
    demoAssetsDir: env.DEMO_ASSETS_DIR,
    castTranscodeDir: env.CAST_TRANSCODE_DIR,
  };
  env.DEMO_MODE = true;
  env.DEMO_ASSETS_DIR = demoAssetsRoot;
  env.CAST_TRANSCODE_DIR = productionCastRoot;
});

afterAll(async () => {
  const { env } = await import("@/config/env");
  env.DEMO_MODE = originalConfig.demoMode;
  env.DEMO_ASSETS_DIR = originalConfig.demoAssetsDir;
  env.CAST_TRANSCODE_DIR = originalConfig.castTranscodeDir;
  rmSync(testRoot, { recursive: true, force: true });
});

describe("demo Cast runtime boundary", () => {
  it("lazily initializes only inside the isolated demo runtime", async () => {
    const { CastTranscodingService, getCastTranscodeRoot } =
      await import("@/modules/cast/cast-transcoding.service");
    const service = new CastTranscodingService();
    const expectedDemoRoot = join(demoAssetsRoot, "runtime", "cast-transcodes");

    expect(getCastTranscodeRoot()).toBe(expectedDemoRoot);
    await service.start();

    expect(existsSync(expectedDemoRoot)).toBe(true);
    expect(existsSync(staleProductionSession)).toBe(true);
    expect(existsSync(join(staleProductionSession, "sentinel.txt"))).toBe(true);
    await service.stop();
  });
});
