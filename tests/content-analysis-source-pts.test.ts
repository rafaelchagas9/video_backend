import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileContentAnalysisSourceResolver,
  PtsAwareChunkExtractor,
  RetryableContentAnalysisError,
  sourceMatchesRun,
} from "@/modules/content-analysis";
import { ContentAnalysisSourceChangedError } from "@/modules/content-analysis/content-analysis.store";

const FFMPEG_PATH = "/usr/bin/ffmpeg";
const FFPROBE_PATH = "/usr/bin/ffprobe";

async function run(command: string, args: string[]): Promise<void> {
  const process = Bun.spawn([command, ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(process.stderr).text();
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(`Synthetic fixture command failed: ${stderr}`);
  }
}

async function createVfrFixture(root: string): Promise<string> {
  const colors = [
    "255 0 0 255 0 0 255 0 0 255 0 0",
    "0 255 0 0 255 0 0 255 0 0 255 0",
    "0 0 255 0 0 255 0 0 255 0 0 255",
  ];
  const images = await Promise.all(
    colors.map(async (pixels, index) => {
      const path = join(root, `${index}.ppm`);
      await writeFile(path, `P3\n2 2\n255\n${pixels}\n`);
      return path;
    })
  );
  const manifest = join(root, "vfr.txt");
  await writeFile(
    manifest,
    [
      `file '${images[0]}'`,
      "duration 0.1",
      `file '${images[1]}'`,
      "duration 0.4",
      `file '${images[2]}'`,
      "duration 0.2",
      `file '${images[2]}'`,
    ].join("\n")
  );
  const output = join(root, "fixture-vfr.mkv");
  await run(FFMPEG_PATH, [
    "-y",
    "-v",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    manifest,
    "-fps_mode",
    "vfr",
    "-c:v",
    "ffv1",
    output,
  ]);
  return output;
}

async function visibleEntries(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).filter((entry) => !entry.startsWith("."));
  } catch {
    return [];
  }
}

describe("content analysis source snapshots and PTS extraction", () => {
  let root: string;
  let fixturePath: string;
  let extractionRoot: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "content-analysis-pts-test-"));
    extractionRoot = join(root, "extraction");
    await mkdir(extractionRoot);
    fixturePath = await createVfrFixture(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves a stable, versioned source snapshot with effective duration", async () => {
    const resolver = new FileContentAnalysisSourceResolver({
      ffprobePath: FFPROBE_PATH,
    });

    const source = await resolver.resolve({ id: 41, filePath: fixturePath });

    expect(source.id).toBe(41);
    expect(source.filePath).toBe(fixturePath);
    expect(source.sourceFingerprint).toMatch(
      /^partial-sha256-v1:[a-f0-9]{64}$/
    );
    expect(source.durationSeconds).toBeGreaterThanOrEqual(0.72);
    expect(source.durationSeconds).toBeLessThan(1);
    expect(source.sizeBytes).toBeGreaterThan(0);
  });

  it("accepts the float32 PostgreSQL round-trip of an unchanged duration", () => {
    expect(
      sourceMatchesRun(
        {
          id: 41,
          sourceFingerprint: "partial-sha256-v1:same",
          durationSeconds: 0.72,
        },
        {
          sourceFingerprint: "partial-sha256-v1:same",
          sourceDurationSeconds: Math.fround(0.72),
        }
      )
    ).toBe(true);
    expect(
      sourceMatchesRun(
        {
          id: 41,
          sourceFingerprint: "partial-sha256-v1:same",
          durationSeconds: 0.8,
        },
        {
          sourceFingerprint: "partial-sha256-v1:same",
          sourceDurationSeconds: Math.fround(0.72),
        }
      )
    ).toBe(false);
  });

  it("rejects a source changed between the two stats without exposing its path", async () => {
    const fakeProbe = join(root, "slow-ffprobe");
    await writeFile(
      fakeProbe,
      '#!/bin/sh\nsleep 0.15\nprintf \'{"streams":[{"duration":"1.0"}]}\'\n'
    );
    await chmod(fakeProbe, 0o755);
    const sourcePath = join(root, "private-owner-video.bin");
    await writeFile(sourcePath, "first-version");
    const resolver = new FileContentAnalysisSourceResolver({
      ffprobePath: fakeProbe,
    });

    const resolving = resolver.resolve({ id: 42, filePath: sourcePath });
    await Bun.sleep(40);
    await writeFile(sourcePath, "second-version-with-new-size");

    let caught: unknown;
    try {
      await resolving;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ContentAnalysisSourceChangedError);
    expect(String(caught)).not.toContain(sourcePath);
    expect(String(caught)).not.toContain("private-owner-video.bin");
  });

  it("emits the real absolute PTS of a generated VFR fixture", async () => {
    const extractor = new PtsAwareChunkExtractor({
      ffmpegPath: FFMPEG_PATH,
      temporaryRoot: extractionRoot,
    });
    const chunks = extractor.extract({
      filePath: fixturePath,
      durationSeconds: 0.8,
      chunkDurationSeconds: 0.4,
      sampleIntervalSeconds: 0.01,
      maxFramesPerChunk: 10,
    });
    const seen: number[] = [];
    const extensions: string[] = [];

    for await (const chunk of chunks) {
      seen.push(...chunk.frames.map((frame) => frame.ptsSeconds));
      extensions.push(...chunk.frames.map((frame) => frame.path.slice(-4)));
      await chunk.dispose();
    }

    expect(seen).toEqual([0, 0.12, 0.52, 0.72]);
    expect(extensions).toEqual([".jpg", ".jpg", ".jpg", ".jpg"]);
    expect(await visibleEntries(extractionRoot)).toEqual([]);
  });

  it("uses VAAPI decoding and bounded JPEG encoding without keyframe-only sampling", async () => {
    const capturedArgs = join(root, "captured-content-analysis-args.json");
    const fakeFfmpeg = join(root, "capturing-ffmpeg");
    await writeFile(
      fakeFfmpeg,
      [
        "#!/usr/bin/env bun",
        'import { writeFile } from "node:fs/promises";',
        `const capturedArgs = ${JSON.stringify(capturedArgs)};`,
        "const args = process.argv.slice(2);",
        "await writeFile(capturedArgs, JSON.stringify(args));",
        'const output = args.at(-1).replace("%06d", "000000");',
        'await writeFile(output, "synthetic-jpeg");',
        'process.stderr.write("[Parsed_showinfo_0] n: 0 pts: 0 pts_time:0\\n");',
      ].join("\n")
    );
    await chmod(fakeFfmpeg, 0o755);
    const extractor = new PtsAwareChunkExtractor({
      ffmpegPath: fakeFfmpeg,
      temporaryRoot: extractionRoot,
      hardwareAcceleration: {
        type: "vaapi",
        device: "/dev/dri/renderD128",
      },
      outputFormat: "jpg",
      jpegQuality: 5,
    });

    const chunks = extractor.extract({
      filePath: fixturePath,
      durationSeconds: 0.8,
    });
    for await (const chunk of chunks) {
      expect(chunk.frames[0]?.path).toEndWith(".jpg");
    }
    const args = JSON.parse(await Bun.file(capturedArgs).text()) as string[];
    const hardwareIndex = args.indexOf("-hwaccel");

    expect(args.slice(hardwareIndex, hardwareIndex + 4)).toEqual([
      "-hwaccel",
      "vaapi",
      "-hwaccel_device",
      "/dev/dri/renderD128",
    ]);
    expect(args).toContain("-qscale:v");
    expect(args[args.indexOf("-qscale:v") + 1]).toBe("5");
    expect(args.indexOf("-t")).toBeLessThan(args.indexOf("-i"));
    expect(args).not.toContain("-skip_frame");
    expect(args.at(-1)).toEndWith(".jpg");
    expect(await visibleEntries(extractionRoot)).toEqual([]);

    for await (const chunk of extractor.extract({
      filePath: fixturePath,
      durationSeconds: 0.8,
      keyframesOnly: true,
    })) {
      await chunk.dispose();
    }
    const keyframeArgs = JSON.parse(
      await Bun.file(capturedArgs).text()
    ) as string[];
    const skipIndex = keyframeArgs.indexOf("-skip_frame");
    expect(keyframeArgs.slice(skipIndex, skipIndex + 2)).toEqual([
      "-skip_frame",
      "nokey",
    ]);
    expect(skipIndex).toBeLessThan(keyframeArgs.indexOf("-i"));
  });

  it("uses deterministic chunk indexes for refinement windows and keeps PTS absolute", async () => {
    const extractor = new PtsAwareChunkExtractor({
      ffmpegPath: FFMPEG_PATH,
      temporaryRoot: extractionRoot,
    });
    const chunks = extractor.extract({
      filePath: fixturePath,
      durationSeconds: 0.8,
      windows: [
        { startSeconds: 0.08, endSeconds: 0.3 },
        { startSeconds: 0.5, endSeconds: 0.8 },
      ],
      chunkDurationSeconds: 0.3,
      sampleIntervalSeconds: 0.01,
      maxFramesPerChunk: 10,
    });
    const observed: Array<{ index: number; pts: number[] }> = [];

    for await (const chunk of chunks) {
      observed.push({
        index: chunk.chunkIndex,
        pts: chunk.frames.map((frame) => frame.ptsSeconds),
      });
    }

    expect(observed.map(({ index }) => index)).toEqual([0, 1]);
    expect(observed.flatMap(({ pts }) => pts)).toEqual([0.12, 0.52, 0.72]);
    expect(await visibleEntries(extractionRoot)).toEqual([]);
  });

  it("cleans temporary frames when extraction fails", async () => {
    const extractor = new PtsAwareChunkExtractor({
      ffmpegPath: FFMPEG_PATH,
      temporaryRoot: extractionRoot,
    });

    await expect(
      Array.fromAsync(
        extractor.extract({
          filePath: join(root, "missing-private-video.mkv"),
          durationSeconds: 1,
        })
      )
    ).rejects.toThrow("Frame extraction failed");
    expect(await visibleEntries(extractionRoot)).toEqual([]);
  });

  it("treats a valid window without selected frames as an empty bounded chunk", async () => {
    const extractor = new PtsAwareChunkExtractor({
      ffmpegPath: FFMPEG_PATH,
      temporaryRoot: extractionRoot,
    });

    const chunks = await Array.fromAsync(
      extractor.extract({
        filePath: fixturePath,
        durationSeconds: 0.8,
        windows: [{ startSeconds: 0.28, endSeconds: 0.3 }],
        sampleIntervalSeconds: 0.01,
      })
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.frames).toEqual([]);
    expect(await visibleEntries(extractionRoot)).toEqual([]);
  });

  it("fails closed and cleans up when a chunk exceeds its frame bound", async () => {
    const extractor = new PtsAwareChunkExtractor({
      ffmpegPath: FFMPEG_PATH,
      temporaryRoot: extractionRoot,
    });

    await expect(
      Array.fromAsync(
        extractor.extract({
          filePath: fixturePath,
          durationSeconds: 0.8,
          chunkDurationSeconds: 0.4,
          sampleIntervalSeconds: 0.01,
          maxFramesPerChunk: 1,
        })
      )
    ).rejects.toThrow("Frame extraction exceeded the bounded chunk limit");
    expect(await visibleEntries(extractionRoot)).toEqual([]);
  });

  it("aborts active extraction and cleans every temporary", async () => {
    const hangingFfmpeg = join(root, "hanging-ffmpeg");
    await writeFile(
      hangingFfmpeg,
      '#!/usr/bin/env bun\nprocess.on("SIGTERM", () => undefined);\nsetInterval(() => undefined, 1000);\n'
    );
    await chmod(hangingFfmpeg, 0o755);
    const extractor = new PtsAwareChunkExtractor({
      ffmpegPath: hangingFfmpeg,
      temporaryRoot: extractionRoot,
    });
    const controller = new AbortController();
    const running = Array.fromAsync(
      extractor.extract(
        { filePath: fixturePath, durationSeconds: 1 },
        controller.signal
      )
    );
    await Bun.sleep(50);
    controller.abort();

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(controller.signal.aborted).toBe(true);
    expect(await visibleEntries(extractionRoot)).toEqual([]);
  });

  it("times out silent ffprobe and ffmpeg processes without leaving temporaries", async () => {
    const hangingCommand = join(root, "silent-hanging-command");
    await writeFile(
      hangingCommand,
      '#!/usr/bin/env bun\nprocess.on("SIGTERM", () => undefined);\nsetInterval(() => undefined, 1000);\n'
    );
    await chmod(hangingCommand, 0o755);
    const resolver = new FileContentAnalysisSourceResolver({
      ffprobePath: hangingCommand,
      timeoutMs: 25,
    });
    await expect(
      resolver.resolve({ id: 41, filePath: fixturePath })
    ).rejects.toBeInstanceOf(RetryableContentAnalysisError);

    const extractor = new PtsAwareChunkExtractor({
      ffmpegPath: hangingCommand,
      temporaryRoot: extractionRoot,
      timeoutMs: 25,
    });
    await expect(
      Array.fromAsync(
        extractor.extract({ filePath: fixturePath, durationSeconds: 1 })
      )
    ).rejects.toBeInstanceOf(RetryableContentAnalysisError);
    expect(await visibleEntries(extractionRoot)).toEqual([]);
  });
  it("precomputes the refinement grid in one decode with the same frame timestamps and pixels", async () => {
    const extractor = new PtsAwareChunkExtractor({
      ffmpegPath: FFMPEG_PATH,
      temporaryRoot: extractionRoot,
    });
    const fingerprint = async (part: {
      startSeconds: number;
      endSeconds: number;
      frames: readonly { ptsSeconds: number; path: string }[];
    }) => ({
      start: part.startSeconds,
      end: part.endSeconds,
      frames: await Promise.all(
        part.frames.map(async (frame) => ({
          pts: frame.ptsSeconds,
          hash: new Bun.CryptoHasher("sha256")
            .update(await Bun.file(frame.path).arrayBuffer())
            .digest("hex"),
        }))
      ),
    });
    const cached = [];
    const coarse = [];
    for await (const part of extractor.extract({
      filePath: fixturePath,
      durationSeconds: 0.76,
      chunkDurationSeconds: 0.76,
      sampleIntervalSeconds: 0.2,
      prefetchRefinement: {
        chunkDurationSeconds: 0.2,
        sampleIntervalSeconds: 0.04,
      },
    })) {
      coarse.push(await fingerprint(part));
      for (const dense of part.prefetchedChunks ?? [])
        cached.push(await fingerprint(dense));
    }
    const precise = [];
    for await (const part of extractor.extract({
      filePath: fixturePath,
      durationSeconds: 0.76,
      chunkDurationSeconds: 0.2,
      sampleIntervalSeconds: 0.04,
    }))
      precise.push(await fingerprint(part));
    expect(cached).toEqual(precise);
    const originalCoarse = [];
    for await (const part of extractor.extract({
      filePath: fixturePath,
      durationSeconds: 0.76,
      chunkDurationSeconds: 0.76,
      sampleIntervalSeconds: 0.2,
    }))
      originalCoarse.push(await fingerprint(part));
    expect(coarse).toEqual(originalCoarse);
    expect(await visibleEntries(extractionRoot)).toEqual([]);
  });
});
