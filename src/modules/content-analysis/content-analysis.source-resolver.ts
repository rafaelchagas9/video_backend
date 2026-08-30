import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { open, stat } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import {
  ContentAnalysisSourceChangedError,
  RetryableContentAnalysisError,
} from "./content-analysis.store";
import type { ContentAnalysisVideoSource } from "./content-analysis.types";

const PARTIAL_HASH_VERSION = "partial-sha256-v1";
const SAMPLE_BYTES = 1024 * 1024;
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

export interface ContentAnalysisSourceCandidate {
  id: number;
  filePath: string;
}

export interface ResolvedContentAnalysisSource extends ContentAnalysisVideoSource {
  filePath: string;
  durationSeconds: number;
  sizeBytes: number;
  mtimeMs: number;
}

export interface ContentAnalysisSourceSnapshotResolver {
  resolve(
    candidate: ContentAnalysisSourceCandidate,
    signal?: AbortSignal
  ): Promise<ResolvedContentAnalysisSource>;
}

export interface FileContentAnalysisSourceResolverOptions {
  ffprobePath: string;
  timeoutMs?: number;
}

function abortError(): DOMException {
  return new DOMException("Content analysis was cancelled", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function sameFileVersion(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

async function partialSha256(
  filePath: string,
  size: bigint,
  signal?: AbortSignal
): Promise<string> {
  if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Video source is unavailable");
  }
  const sizeBytes = Number(size);
  const sampleLength = Math.min(SAMPLE_BYTES, sizeBytes);
  const offsets = [
    0,
    Math.max(0, Math.floor((sizeBytes - sampleLength) / 2)),
    Math.max(0, sizeBytes - sampleLength),
  ].filter((offset, index, all) => all.indexOf(offset) === index);
  const digest = createHash("sha256");
  digest.update(`${PARTIAL_HASH_VERSION}\0${sizeBytes}\0`);
  const handle = await open(filePath, "r");
  try {
    for (const offset of offsets) {
      throwIfAborted(signal);
      const sample = Buffer.allocUnsafe(sampleLength);
      const { bytesRead } = await handle.read(sample, 0, sampleLength, offset);
      digest.update(`${offset}:${bytesRead}\0`);
      digest.update(sample.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return `${PARTIAL_HASH_VERSION}:${digest.digest("hex")}`;
}

function parseEffectiveDuration(output: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Video source duration is unavailable");
  }
  const payload = parsed as {
    streams?: Array<{ duration?: string | number }>;
    format?: { duration?: string | number };
  };
  const durations = [
    ...(payload.streams ?? []).map((stream) => Number(stream.duration)),
    Number(payload.format?.duration),
  ].filter((duration) => Number.isFinite(duration) && duration > 0);
  if (durations.length === 0) {
    throw new Error("Video source duration is unavailable");
  }
  return Math.max(...durations);
}

async function probeDuration(
  ffprobePath: string,
  filePath: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<number> {
  throwIfAborted(signal);
  return new Promise<number>((resolve, reject) => {
    const child = spawn(
      ffprobePath,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=duration:format=duration",
        "-of",
        "json",
        filePath,
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    const output: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let aborted = false;
    let forcedError: Error | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      callback();
    };
    const terminate = (): void => {
      child.kill("SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
        killTimer.unref?.();
      }
    };
    const onAbort = (): void => {
      if (aborted) return;
      aborted = true;
      terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    timeoutTimer = setTimeout(() => {
      if (settled || aborted) return;
      forcedError = new RetryableContentAnalysisError(
        "SOURCE_PROBE_TIMEOUT",
        "Video source inspection timed out"
      );
      terminate();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROBE_OUTPUT_BYTES && !forcedError) {
        forcedError = new Error("Video source duration is unavailable");
        terminate();
        return;
      }
      if (!forcedError) output.push(chunk);
    });
    child.once("error", () => {
      finish(() =>
        reject(
          aborted
            ? abortError()
            : (forcedError ?? new Error("Video source duration is unavailable"))
        )
      );
    });
    child.once("close", (code) => {
      finish(() => {
        if (aborted) {
          reject(abortError());
          return;
        }
        if (forcedError) {
          reject(forcedError);
          return;
        }
        if (code !== 0) {
          reject(new Error("Video source duration is unavailable"));
          return;
        }
        try {
          resolve(
            parseEffectiveDuration(Buffer.concat(output).toString("utf8"))
          );
        } catch {
          reject(new Error("Video source duration is unavailable"));
        }
      });
    });
  });
}

export class FileContentAnalysisSourceResolver implements ContentAnalysisSourceSnapshotResolver {
  constructor(
    private readonly options: FileContentAnalysisSourceResolverOptions
  ) {}

  async resolve(
    candidate: ContentAnalysisSourceCandidate,
    signal?: AbortSignal
  ): Promise<ResolvedContentAnalysisSource> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("timeoutMs must be a finite positive number");
    }
    throwIfAborted(signal);
    let before: BigIntStats;
    try {
      before = await stat(candidate.filePath, { bigint: true });
    } catch {
      throw new Error("Video source is unavailable");
    }
    if (!before.isFile()) throw new Error("Video source is unavailable");

    let sourceFingerprint: string;
    let durationSeconds: number;
    try {
      sourceFingerprint = await partialSha256(
        candidate.filePath,
        before.size,
        signal
      );
      durationSeconds = await probeDuration(
        this.options.ffprobePath,
        candidate.filePath,
        timeoutMs,
        signal
      );
    } catch (error) {
      if (error instanceof RetryableContentAnalysisError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      throw new Error(
        error instanceof Error &&
          error.message === "Video source duration is unavailable"
          ? error.message
          : "Video source is unavailable"
      );
    }

    throwIfAborted(signal);
    let after: BigIntStats;
    try {
      after = await stat(candidate.filePath, { bigint: true });
    } catch {
      throw new ContentAnalysisSourceChangedError();
    }
    if (!sameFileVersion(before, after)) {
      throw new ContentAnalysisSourceChangedError();
    }

    return {
      id: candidate.id,
      filePath: candidate.filePath,
      sourceFingerprint,
      durationSeconds,
      sizeBytes: Number(after.size),
      mtimeMs: Number(after.mtimeNs) / 1_000_000,
    };
  }
}
