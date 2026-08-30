import { describe, expect, it } from "bun:test";
import {
  DEFAULT_VISION_SERVICE_URL,
  resolveVisionServiceEnvironment,
} from "@/config/vision-service-env";

describe("vision service environment compatibility", () => {
  it("prefers VISION_SERVICE_URL when both names are configured", () => {
    expect(
      resolveVisionServiceEnvironment({
        VISION_SERVICE_URL: "http://vision.internal:8100",
        FACE_SERVICE_URL: "http://legacy-face.internal:8100",
      }).url
    ).toBe("http://vision.internal:8100");
  });

  it("falls back to FACE_SERVICE_URL when the new variable is absent or blank", () => {
    expect(
      resolveVisionServiceEnvironment({
        VISION_SERVICE_URL: "   ",
        FACE_SERVICE_URL: "http://legacy-face.internal:8100",
      }).url
    ).toBe("http://legacy-face.internal:8100");
  });

  it("uses the local default only when neither variable has a value", () => {
    expect(resolveVisionServiceEnvironment({}).url).toBe(
      DEFAULT_VISION_SERVICE_URL
    );
  });

  it("preserves the legacy secret when the new secret variable is blank", () => {
    expect(
      resolveVisionServiceEnvironment({
        VISION_SERVICE_SECRET: "",
        FACE_SERVICE_SECRET: "legacy-internal-secret",
      }).secret
    ).toBe("legacy-internal-secret");
  });

  it("applies the fallback through the real env loader in an isolated process", async () => {
    const processResult = Bun.spawn(
      [
        process.execPath,
        "-e",
        'const { env } = await import("./src/config/env.ts"); process.stdout.write(env.VISION_SERVICE_URL);',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: "test",
          POSTGRES_USER: "test_user",
          POSTGRES_PASSWORD: "test-password",
          POSTGRES_DB: "conversor_video_test",
          SESSION_SECRET: "isolated-env-test-secret-at-least-32-characters",
          VISION_SERVICE_URL: "",
          FACE_SERVICE_URL: "http://legacy-face.internal:8100",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [exitCode, stdout, stderr] = await Promise.all([
      processResult.exited,
      new Response(processResult.stdout).text(),
      new Response(processResult.stderr).text(),
    ]);

    expect({ exitCode, stdout, stderr }).toEqual({
      exitCode: 0,
      stdout: "http://legacy-face.internal:8100",
      stderr: "",
    });
  });
});
