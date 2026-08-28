import { expect, it, mock } from "bun:test";

mock.module("@/config/env", () => ({
  env: { FFMPEG_PATH: "/usr/bin/sleep" },
}));
mock.module("@/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

it("terminates the active encoder when cancellation is requested", async () => {
  const { ConversionCancelledError, FfmpegService } =
    await import("@/modules/conversion/conversion.ffmpeg.service");
  const service = new FfmpegService() as unknown as {
    executeFfmpeg(options: {
      jobId: number;
      args: string[];
      durationSeconds: number;
      onProgress: (progress: number) => void;
      logPath: string;
      encodingMode: "hw";
      bitratePlan: {
        profileVersion: number;
        videoBitrateBps: number;
        maxBitrateBps: number;
        qp: number;
      };
      signal: AbortSignal;
    }): Promise<unknown>;
  };
  const controller = new AbortController();
  const startedAt = Date.now();

  const running = service.executeFfmpeg({
    jobId: 1,
    args: ["30"],
    durationSeconds: 0,
    onProgress: () => undefined,
    logPath: "/dev/null",
    encodingMode: "hw",
    bitratePlan: {
      profileVersion: 1,
      videoBitrateBps: 1,
      maxBitrateBps: 1,
      qp: 1,
    },
    signal: controller.signal,
  });

  setTimeout(() => controller.abort(), 20);

  await expect(running).rejects.toBeInstanceOf(ConversionCancelledError);
  expect(Date.now() - startedAt).toBeLessThan(2_000);
});
