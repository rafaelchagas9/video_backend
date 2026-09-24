import { afterEach, describe, expect, it } from "bun:test";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { perceptualDuplicatesEngineResultSchema } from "@/modules/perceptual-duplicates/perceptual-duplicates.schemas";
import { PythonPerceptualDuplicatesRunner } from "@/modules/perceptual-duplicates/perceptual-duplicates.runner";

const temporaryDirectories: string[] = [];

async function fakePythonModule(source: string): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "perceptual-duplicates-test-")
  );
  temporaryDirectories.push(directory);
  await writeFile(join(directory, "fake_engine.py"), source);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("perceptual duplicate engine contract", () => {
  it("strips unrecognized video fields and rejects invalid match topology", () => {
    const parsed = perceptualDuplicatesEngineResultSchema.parse({
      version: 1,
      revision: "copy-v1",
      videos: [
        {
          id: 1,
          frame_count: 10,
          duration_seconds: 10,
          path: "/private/one.mp4",
        },
        {
          id: 2,
          frame_count: 20,
          duration_seconds: 20,
          path: "/private/two.mp4",
        },
      ],
      matches: [],
      runtime: {
        inference_provider: "MIGraphXExecutionProvider",
        onnxruntime: "1.25.0",
        precision: "fp32",
        decode: "vaapi",
        model_sha256: "a".repeat(64),
        initialization_seconds: 0.5,
        elapsed_seconds: 1,
        sample_rate: 1,
        verification_rate: 5,
        candidate_limit_per_pair: 8,
        candidate_limited_pairs: 0,
      },
    });
    expect(parsed.videos[0]).toEqual({
      id: 1,
      frame_count: 10,
      duration_seconds: 10,
    });
    expect(JSON.stringify(parsed)).not.toContain("private");

    expect(() =>
      perceptualDuplicatesEngineResultSchema.parse({
        ...parsed,
        matches: [
          {
            video_a: 1,
            video_b: 99,
            status: "verified",
            segments: [],
            coverage_a: 1,
            coverage_b: 1,
          },
        ],
      })
    ).toThrow();
  });

  it("rejects hostile segment bounds, status, coverage, and empty matches", () => {
    const segment = {
      a_start: 1,
      a_end: 4,
      b_start: 2,
      b_end: 8,
      speed: 1,
      matched_frames: 6,
      spatial_inliers: 100,
      status: "verified" as const,
      motion: 0.8,
      timing_error_seconds: 0.05,
    };
    const match = {
      video_a: 1,
      video_b: 2,
      status: "verified" as const,
      segments: [segment],
      coverage_a: 0.3,
      coverage_b: 0.3,
    };
    const result = {
      version: 1 as const,
      revision: "copy-v1",
      videos: [
        { id: 1, frame_count: 10, duration_seconds: 10 },
        { id: 2, frame_count: 20, duration_seconds: 20 },
      ],
      matches: [match],
      runtime: {
        inference_provider: "MIGraphXExecutionProvider" as const,
        onnxruntime: "1.25.0",
        precision: "fp32" as const,
        decode: "vaapi" as const,
        model_sha256: "a".repeat(64),
        initialization_seconds: 0.5,
        elapsed_seconds: 1,
        sample_rate: 1,
        verification_rate: 5,
        candidate_limit_per_pair: 8,
        candidate_limited_pairs: 0,
      },
    };
    expect(
      perceptualDuplicatesEngineResultSchema.safeParse(result).success
    ).toBe(true);

    const hostileResults = [
      { ...result, matches: [{ ...match, segments: [] }] },
      {
        ...result,
        matches: [
          { ...match, segments: [{ ...segment, a_end: 11 }], coverage_a: 1 },
        ],
      },
      {
        ...result,
        matches: [
          {
            ...match,
            segments: [{ ...segment, status: "ambiguous" as const }],
          },
        ],
      },
      { ...result, matches: [{ ...match, coverage_a: 0.4 }] },
    ];
    for (const hostile of hostileResults) {
      expect(
        perceptualDuplicatesEngineResultSchema.safeParse(hostile).success
      ).toBe(false);
    }
  });

  it("passes the bounded stdin contract and accepts one final JSON object", async () => {
    const directory = await fakePythonModule(`
import json, sys
request = json.load(sys.stdin)
videos = [{"id": item["id"], "frame_count": 3, "duration_seconds": item["duration_seconds"], "path": item["path"]} for item in request["videos"]]
runtime = {"inference_provider": "MIGraphXExecutionProvider", "onnxruntime": "1.25.0", "precision": "fp32", "decode": "vaapi", "model_sha256": "a" * 64, "initialization_seconds": 0.05, "elapsed_seconds": 0.1, "sample_rate": 1, "verification_rate": 5, "candidate_limit_per_pair": 8, "candidate_limited_pairs": 0}
print(json.dumps({"version": 1, "revision": "fake-v1", "videos": videos, "matches": [], "runtime": runtime}))
`);
    const runner = new PythonPerceptualDuplicatesRunner({
      pythonPath: "/usr/bin/python3",
      moduleName: "fake_engine",
      workDir: directory,
      cacheDir: join(directory, "cache"),
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    });
    const result = await runner.run({
      videos: [
        { id: 1, path: "/private/one.mp4", duration_seconds: 10 },
        { id: 2, path: "/private/two.mp4", duration_seconds: 20 },
      ],
      signal: new AbortController().signal,
    });

    expect(result.revision).toBe("fake-v1");
    expect(result.videos).toEqual([
      { id: 1, frame_count: 3, duration_seconds: 10 },
      { id: 2, frame_count: 3, duration_seconds: 20 },
    ]);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("rejects an engine result that changes an input duration", async () => {
    const directory = await fakePythonModule(`
import json, sys
request = json.load(sys.stdin)
videos = [{"id": item["id"], "frame_count": 3, "duration_seconds": item["duration_seconds"] + (1 if index == 0 else 0)} for index, item in enumerate(request["videos"])]
runtime = {"inference_provider": "MIGraphXExecutionProvider", "onnxruntime": "1.25.0", "precision": "fp32", "decode": "vaapi", "model_sha256": "a" * 64, "initialization_seconds": 0.05, "elapsed_seconds": 0.1, "sample_rate": 1, "verification_rate": 5, "candidate_limit_per_pair": 8, "candidate_limited_pairs": 0}
print(json.dumps({"version": 1, "revision": "hostile-v1", "videos": videos, "matches": [], "runtime": runtime}))
`);
    const runner = new PythonPerceptualDuplicatesRunner({
      pythonPath: "/usr/bin/python3",
      moduleName: "fake_engine",
      workDir: directory,
      cacheDir: join(directory, "cache"),
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    });

    await expect(
      runner.run({
        videos: [
          { id: 1, path: "/private/one.mp4", duration_seconds: 10 },
          { id: 2, path: "/private/two.mp4", duration_seconds: 20 },
        ],
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ code: "ENGINE_INVALID_RESULT" });
  });

  it("maps only whitelisted engine failure codes without exposing stderr", async () => {
    const directory = await fakePythonModule(`
import json, sys
json.load(sys.stdin)
print(json.dumps({"code": "COPY_CACHE_FULL", "detail": "/private/cache"}), file=sys.stderr)
raise SystemExit(1)
`);
    const runner = new PythonPerceptualDuplicatesRunner({
      pythonPath: "/usr/bin/python3",
      moduleName: "fake_engine",
      workDir: directory,
      cacheDir: join(directory, "cache"),
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    });
    const running = runner.run({
      videos: [
        { id: 1, path: "/private/one.mp4", duration_seconds: 10 },
        { id: 2, path: "/private/two.mp4", duration_seconds: 20 },
      ],
      signal: new AbortController().signal,
    });

    await expect(running).rejects.toMatchObject({
      code: "COPY_CACHE_FULL",
      message: "Perceptual duplicate cache is full",
      retryable: false,
    });
  });

  it("terminates an active engine when cancelled", async () => {
    const orphanMarker = join(
      tmpdir(),
      `perceptual-orphan-${crypto.randomUUID()}`
    );
    const directory = await fakePythonModule(`
import json, subprocess, sys, time
json.load(sys.stdin)
subprocess.Popen([sys.executable, "-c", ${JSON.stringify(
      `import time; time.sleep(0.75); open(${JSON.stringify(orphanMarker)}, "w").write("orphan")`
    )}])
time.sleep(30)
`);
    await chmod(join(directory, "fake_engine.py"), 0o600);
    const runner = new PythonPerceptualDuplicatesRunner({
      pythonPath: "/usr/bin/python3",
      moduleName: "fake_engine",
      workDir: directory,
      cacheDir: join(directory, "cache"),
      timeoutMs: 60_000,
      maxOutputBytes: 64 * 1024,
    });
    const controller = new AbortController();
    const startedAt = performance.now();
    const running = runner.run({
      videos: [
        { id: 1, path: "/private/one.mp4", duration_seconds: 10 },
        { id: 2, path: "/private/two.mp4", duration_seconds: 20 },
      ],
      signal: controller.signal,
    });
    setTimeout(
      () => controller.abort(new DOMException("Cancelled", "AbortError")),
      50
    );

    await expect(running).rejects.toHaveProperty("name", "AbortError");
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    await Bun.sleep(1_000);
    await expect(access(orphanMarker)).rejects.toHaveProperty("code", "ENOENT");
  });
});
