import { afterAll, expect, it, mock } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const directory = mkdtempSync(join(tmpdir(), "conversion-probe-"));
const executable = join(directory, "ffprobe");
writeFileSync(executable, "#!/bin/sh\nexec sleep 30\n", { mode: 0o700 });
mock.module("@/config/env", () => ({ env: { FFPROBE_PATH: executable } }));
mock.module("@/utils/logger", () => ({
  logger: { debug() {}, error() {}, info() {}, warn() {} },
}));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it("cancels a pending duration probe before starting an encoder", async () => {
  const { FfmpegService, ConversionCancelledError } =
    await import("@/modules/conversion/conversion.ffmpeg.service");
  const service = new FfmpegService() as unknown as {
    getVideoDuration(path: string, signal: AbortSignal): Promise<number>;
  };
  const controller = new AbortController();
  const start = Date.now();
  const running = service.getVideoDuration("/unused/input", controller.signal);
  setTimeout(() => controller.abort(), 20);
  await expect(running).rejects.toBeInstanceOf(ConversionCancelledError);
  expect(Date.now() - start).toBeLessThan(2000);
}, 35000);
