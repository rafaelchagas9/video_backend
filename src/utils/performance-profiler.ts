import { appendFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { env } from "@/config/env";
import { logger } from "@/utils/logger";
import { captureTelemetryEvent } from "@/utils/telemetry";

type PerfContext = {
  scenario: "storyboard" | "face" | "editing";
  videoId?: number;
  jobId?: number;
  mode?: string;
};

let directoryReady: Promise<void> | null = null;
let warnedWriteFailure = false;

async function ensureDirectoryReady(): Promise<void> {
  if (!directoryReady) {
    directoryReady = mkdir(dirname(env.PERF_PROFILING_LOG_PATH), {
      recursive: true,
    }).then(() => undefined);
  }

  await directoryReady;
}

export async function recordPerfStage(
  context: PerfContext,
  stage: string,
  durationMs: number,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  if (!env.PERF_PROFILING_ENABLED) {
    return;
  }

  const entry = {
    ts: new Date().toISOString(),
    ...context,
    stage,
    durationMs,
    ...metadata,
  };

  logger.debug(entry, "Performance stage");
  captureTelemetryEvent("performance stage recorded", entry);

  try {
    await ensureDirectoryReady();
    await appendFile(env.PERF_PROFILING_LOG_PATH, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    if (!warnedWriteFailure) {
      warnedWriteFailure = true;
      logger.warn(
        { error, path: env.PERF_PROFILING_LOG_PATH },
        "Failed to write performance profile log",
      );
    }
  }
}
