import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let root: string;
let input: string;
let output: string;
let outputDuration = 60;
let sourceDuration: number | null = 60;
let sourceProbeFails = false;
let controller: AbortController;
const video = {
  id: 1,
  title: "Fixture",
  file_name: "source.mkv",
  file_size_bytes: 20,
  width: 1920,
  height: 1080,
  duration_seconds: 60,
  audio_codec: "aac",
  codec: "h264",
  bitrate: 5000,
  fps: 30,
};
const replaceFile = mock(async (_id: number, _path: string) => video);
const completed = mock(async () => true);
const failed = mock(async () => true);
const batch = mock(async (_id: string) => {});
const encode = mock(
  async (_job: number, _video: unknown, _input: string, path: string) => {
    await writeFile(path, "converted fixture");
    return {
      command: "fake ffmpeg",
      durationMs: 100,
      profileVersion: 1,
      encodingMode: "hw",
    };
  }
);
mock.module("@/modules/videos/videos.service", () => ({
  videosService: { findById: async () => video, replaceFile },
}));
mock.module("@/modules/videos/metadata.service", () => ({
  metadataService: {
    extractMetadata: async (path: string) => {
      if (path === input && sourceProbeFails)
        throw new Error("source probe unavailable");
      return {
        ...video,
        duration_seconds: path === input ? sourceDuration : outputDuration,
      };
    },
  },
}));
mock.module("@/modules/conversion/conversion.ffmpeg.service", () => ({
  ffmpegService: { runConversion: encode },
  ConversionCancelledError: class ConversionCancelledError extends Error {},
}));
mock.module("@/modules/conversion/conversion.jobs.service", () => ({
  conversionJobsService: {
    claimForProcessing: async () => true,
    findById: async () => ({ target_resolution: "1920x1080" }),
    updateProgress: async () => true,
    markAsCompleted: completed,
    markAsFailed: failed,
  },
}));
mock.module("@/modules/conversion/conversion.batch.service", () => ({
  conversionBatchService: { checkBatchCompletion: batch },
}));
mock.module("@/modules/conversion/conversion.history.service", () => ({
  conversionHistoryService: { createCompletedEntry: async () => {} },
}));
mock.module("@/modules/events/events.service", () => ({
  eventsService: { broadcast: () => {} },
}));
mock.module("@/utils/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));
const { ConversionProcessorService } =
  await import("@/modules/conversion/conversion.processor.service");
const processor = new ConversionProcessorService();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "conversion-publication-"));
  input = join(root, "source.mkv");
  output = join(root, "output.mkv");
  await writeFile(input, "original fixture");
  outputDuration = 60;
  sourceDuration = 60;
  sourceProbeFails = false;
  controller = new AbortController();
  for (const fn of [replaceFile, completed, failed, batch, encode])
    fn.mockClear();
  replaceFile.mockImplementation(async () => video);
  batch.mockImplementation(async () => {});
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const payload = (deleteOriginal = false) => ({
  createdAt: "2026-09-04T00:00:00Z",
  jobId: 7,
  videoId: 1,
  preset: "1080p_h264",
  inputPath: input,
  outputPath: output,
  deleteOriginal,
  batchId: "batch-fixture",
});

it("refuses to overwrite a pre-existing output file", async () => {
  await writeFile(output, "existing media");
  await expect(
    processor.processJob(payload(), controller.signal)
  ).rejects.toThrow();
  expect(await readFile(output, "utf8")).toBe("existing media");
  expect(encode).not.toHaveBeenCalled();
});

it("preserves the source if catalog replacement fails", async () => {
  replaceFile.mockImplementation(async () => {
    throw new Error("database unavailable");
  });
  await processor.processJob(payload(true), controller.signal);
  expect(await readFile(input, "utf8")).toBe("original fixture");
  expect(await readFile(output, "utf8")).toBe("converted fixture");
});

it("keeps the source available until replacement succeeds", async () => {
  let sourceAtPublication = "";
  replaceFile.mockImplementation(async () => {
    sourceAtPublication = await readFile(input, "utf8");
    return video;
  });
  await processor.processJob(payload(true), controller.signal);
  expect(sourceAtPublication).toBe("original fixture");
  expect(await readFile(output, "utf8")).toBe("converted fixture");
});

it("does not remove committed output if post-completion work aborts", async () => {
  batch.mockImplementation(async () => {
    controller.abort();
    throw new Error("batch unavailable");
  });
  await processor.processJob(payload(), controller.signal).catch(() => {});
  expect(completed).toHaveBeenCalledTimes(1);
  expect(failed).not.toHaveBeenCalled();
  expect(await readFile(output, "utf8")).toBe("converted fixture");
});

it("rejects truncated conversion before completion or source replacement", async () => {
  outputDuration = 10;
  await expect(
    processor.processJob(payload(true), controller.signal)
  ).rejects.toThrow();
  expect(completed).not.toHaveBeenCalled();
  expect(replaceFile).not.toHaveBeenCalled();
  expect(await readFile(input, "utf8")).toBe("original fixture");
});

it("preserves a source path replaced by another file during catalog publication", async () => {
  replaceFile.mockImplementation(async () => {
    const replacement = join(root, "replacement.mkv");
    await writeFile(replacement, "new user media");
    await rename(replacement, input);
    return video;
  });
  await processor.processJob(payload(true), controller.signal);
  expect(await readFile(input, "utf8")).toBe("new user media");
  expect(await readFile(output, "utf8")).toBe("converted fixture");
});

it("preserves a source modified in place during catalog publication", async () => {
  replaceFile.mockImplementation(async () => {
    await writeFile(input, "user media changed in place");
    return video;
  });
  await processor.processJob(payload(true), controller.signal);
  expect(await readFile(input, "utf8")).toBe("user media changed in place");
});

it("refuses a source and output referring to the same path", async () => {
  output = input;
  await expect(
    processor.processJob(payload(true), controller.signal)
  ).rejects.toThrow();
  expect(await readFile(input, "utf8")).toBe("original fixture");
  expect(encode).not.toHaveBeenCalled();
});

it("does not retire or encode a source that could not be probed", async () => {
  sourceProbeFails = true;
  await expect(
    processor.processJob(payload(true), controller.signal)
  ).rejects.toThrow();
  expect(encode).not.toHaveBeenCalled();
  expect(completed).not.toHaveBeenCalled();
  expect(await readFile(input, "utf8")).toBe("original fixture");
});
it("does not retire a source with unknown duration", async () => {
  sourceDuration = null;
  await expect(
    processor.processJob(payload(true), controller.signal)
  ).rejects.toThrow();
  expect(encode).not.toHaveBeenCalled();
  expect(completed).not.toHaveBeenCalled();
  expect(await readFile(input, "utf8")).toBe("original fixture");
});
