import { spawn } from "node:child_process";
import { setPriority } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";

const groupSchema = z.object({
  offset_seconds: z.number(),
  seconds: z.number(),
  status: z.enum(["verified", "ambiguous", "rejected", "superseded"]),
  reason: z.string().nullable().optional(),
  samples: z.number().int().nonnegative(),
  same: z.number().int().nonnegative().optional(),
  different: z.number().int().nonnegative().optional(),
  appearance: z.number().nullable().optional(),
  motion: z.number().nullable().optional(),
  inliers: z.number().int().nonnegative().optional(),
  scale: z.number().nullable().optional(),
});

const engineSegmentSchema = z.object({
  a_start: z.number().nonnegative(),
  a_end: z.number().positive(),
  b_start: z.number().nonnegative(),
  b_end: z.number().positive(),
  status: z.enum(["verified", "ambiguous"]),
  items: z.number().int().positive(),
  ber: z.number().min(0).max(1),
  contrast: z.number(),
  votes: z.number().int().nonnegative(),
  group: z.number().int().nonnegative(),
});

export const enginePairSchema = z.object({
  type: z.literal("pair"),
  video_a: z.number().int().positive(),
  video_b: z.number().int().positive(),
  verdict: z.enum(["match", "rejected"]),
  segments: z.array(engineSegmentSchema).max(4096),
  groups: z.array(groupSchema),
  audio: z.object({
    matched_seconds_a: z.number(),
    matched_seconds_b: z.number(),
    votes: z.number().int(),
  }),
  source_error: z.string().nullable(),
});
export type EnginePair = z.infer<typeof enginePairSchema>;

const progressSchema = z.object({
  type: z.literal("progress"),
  stage: z.enum(["join", "verify"]),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type EngineProgress = z.infer<typeof progressSchema>;

const doneSchema = z
  .object({
    type: z.literal("done"),
    revision: z.string(),
    fingerprints: z.number().int(),
    candidates: z.number().int(),
    matches: z.number().int(),
    rejected: z.number().int(),
    seconds: z.number(),
    /** Pairs that raised; their videos stay pending so the next pass retries them. */
    failed_pairs: z.array(z.tuple([z.number().int(), z.number().int()])),
  })
  .passthrough();
export type EngineDone = z.infer<typeof doneSchema>;

const lineSchema = z.discriminatedUnion("type", [progressSchema, enginePairSchema, doneSchema]);

export interface CopyEngineRequest {
  version: 1;
  fingerprints: string;
  videos: Record<string, { path: string; duration: number }>;
  focus_ids: number[] | null;
  skip_pairs: [number, number][];
  policy: {
    min_overlap_seconds: number;
    min_overlap_coverage: number;
    min_similarity_coverage: number;
    min_clip_seconds: number;
  };
}

export class CopyEngineError extends Error {
  constructor(
    readonly code: "ENGINE_UNAVAILABLE" | "ENGINE_FAILED" | "ENGINE_INVALID_RESULT" | "ENGINE_TIMEOUT",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "CopyEngineError";
  }
}

const MAX_LINE_BYTES = 4 * 1024 * 1024;

/**
 * Runs the Python matcher and hands every decided pair to `onPair` as soon as it arrives, so a
 * cancelled or crashed pass keeps the pairs it already decided.
 */
export function runCopyEngine(
  options: { pythonPath: string; workDir: string; ffmpegPath: string; ffprobePath: string; timeoutMs: number },
  request: CopyEngineRequest,
  signal: AbortSignal,
  handlers: {
    onPair(pair: EnginePair): Promise<void>;
    onProgress?(progress: EngineProgress): void;
  }
): Promise<EngineDone> {
  signal.throwIfAborted();
  const workDir = resolve(options.workDir);
  return new Promise((resolveRun, reject) => {
    const child = spawn(resolve(options.pythonPath), ["-m", "vision_service.copy_detection"], {
      cwd: workDir,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        PYTHONPATH: resolve(workDir, "src"),
        PYTHONUNBUFFERED: "1",
        OMP_NUM_THREADS: "2",
        OPENBLAS_NUM_THREADS: "2",
        FFMPEG_PATH: options.ffmpegPath,
        FFPROBE_PATH: options.ffprobePath,
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    try {
      if (child.pid) setPriority(child.pid, 10);
    } catch {
      // Priority is best effort.
    }
    let failure: Error | null = null;
    let done: EngineDone | null = null;
    let stderrTail = "";
    let chain = Promise.resolve();
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      const kill = (sig: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, sig);
        } catch {
          child.kill(sig);
        }
      };
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 2_000);
      killTimer.unref?.();
    };
    const fail = (error: Error) => {
      failure ??= error;
      terminate();
    };
    signal.addEventListener("abort", terminate, { once: true });
    const timer = setTimeout(
      () => fail(new CopyEngineError("ENGINE_TIMEOUT", "Copy detection timed out")),
      options.timeoutMs
    );
    timer.unref?.();

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (failure) return;
      if (line.length > MAX_LINE_BYTES) {
        fail(new CopyEngineError("ENGINE_INVALID_RESULT", "Copy engine line exceeded its limit"));
        return;
      }
      let message: z.infer<typeof lineSchema>;
      try {
        message = lineSchema.parse(JSON.parse(line));
      } catch (error) {
        fail(new CopyEngineError("ENGINE_INVALID_RESULT", "Copy engine returned an invalid line", { cause: error }));
        return;
      }
      if (message.type === "progress") handlers.onProgress?.(message);
      else if (message.type === "done") done = message;
      else {
        const pair = message;
        // persist in arrival order; a failed write stops the engine
        chain = chain.then(() => (failure ? undefined : handlers.onPair(pair))).catch((error: Error) => fail(error));
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-4096);
    });
    child.once("error", (error) =>
      fail(new CopyEngineError("ENGINE_UNAVAILABLE", "Copy engine is unavailable", { cause: error }))
    );
    child.once("close", (code) => {
      lines.close();
      void chain.then(() => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal.removeEventListener("abort", terminate);
        if (signal.aborted) return reject(signal.reason);
        if (failure) return reject(failure);
        if (code !== 0 || !done) {
          const last = stderrTail.trim().split("\n").at(-1) ?? "";
          return reject(new CopyEngineError("ENGINE_FAILED", `Copy engine failed (${last.slice(0, 120)})`));
        }
        resolveRun(done);
      });
    });
    child.stdin.on("error", () => {
      // close/error handlers report the failure
    });
    child.stdin.end(JSON.stringify(request));
  });
}
