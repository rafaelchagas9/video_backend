import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  perceptualDuplicatesEngineResultSchema,
  type PerceptualDuplicatesEngineResult,
} from "./perceptual-duplicates.schemas";

export interface PerceptualDuplicatesEngineVideo {
  id: number;
  path: string;
  duration_seconds: number;
}

export interface PerceptualDuplicatesRunnerInput {
  videos: PerceptualDuplicatesEngineVideo[];
  signal: AbortSignal;
}

export interface PerceptualDuplicatesRunner {
  run(
    input: PerceptualDuplicatesRunnerInput
  ): Promise<PerceptualDuplicatesEngineResult>;
}

export interface PythonPerceptualDuplicatesRunnerOptions {
  pythonPath: string;
  moduleName: string;
  workDir: string;
  cacheDir: string;
  timeoutMs: number;
  maxOutputBytes: number;
  environment?: {
    FFMPEG_PATH?: string;
    VAAPI_DEVICE?: string;
    COPY_CACHE_MAX_BYTES?: string;
  };
}

export class PerceptualDuplicatesRunnerError extends Error {
  constructor(
    public readonly code:
      | "ENGINE_UNAVAILABLE"
      | "ENGINE_FAILED"
      | "ENGINE_TIMEOUT"
      | "ENGINE_OUTPUT_TOO_LARGE"
      | "ENGINE_INVALID_RESULT"
      | CopyEngineFailureCode,
    message: string,
    public readonly retryable: boolean,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "PerceptualDuplicatesRunnerError";
  }
}

const COPY_ENGINE_FAILURE_CODES = [
  "COPY_MODEL_MISSING",
  "COPY_MODEL_INVALID",
  "COPY_GPU_UNAVAILABLE",
  "COPY_GPU_UNVERIFIED",
  "COPY_PRECISION_INVALID",
  "COPY_SOURCE_CHANGED",
  "COPY_DECODE_FAILED",
  "COPY_CACHE_CORRUPT",
  "COPY_CACHE_FULL",
  "COPY_ANALYSIS_FAILED",
] as const;
type CopyEngineFailureCode = (typeof COPY_ENGINE_FAILURE_CODES)[number];
const copyEngineFailureCodes = new Set<string>(COPY_ENGINE_FAILURE_CODES);

const copyEngineFailureMessages: Record<CopyEngineFailureCode, string> = {
  COPY_MODEL_MISSING: "Perceptual duplicate model is unavailable",
  COPY_MODEL_INVALID: "Perceptual duplicate model is invalid",
  COPY_GPU_UNAVAILABLE: "Required GPU inference is unavailable",
  COPY_GPU_UNVERIFIED: "GPU inference could not be verified",
  COPY_PRECISION_INVALID: "GPU inference precision is invalid",
  COPY_SOURCE_CHANGED: "One or more selected videos changed during comparison",
  COPY_DECODE_FAILED: "One or more selected videos could not be decoded",
  COPY_CACHE_CORRUPT: "Perceptual duplicate cache is corrupt",
  COPY_CACHE_FULL: "Perceptual duplicate cache is full",
  COPY_ANALYSIS_FAILED: "Perceptual duplicate analysis failed",
};

function parseEngineFailureCode(
  stderrTail: Buffer
): CopyEngineFailureCode | null {
  const lastLine = stderrTail.toString("utf8").trim().split(/\r?\n/).at(-1);
  if (!lastLine) return null;
  try {
    const value = JSON.parse(lastLine) as { code?: unknown };
    return typeof value.code === "string" &&
      copyEngineFailureCodes.has(value.code)
      ? (value.code as CopyEngineFailureCode)
      : null;
  } catch {
    return null;
  }
}

function safeChildEnvironment(
  workDir: string,
  overrides: PythonPerceptualDuplicatesRunnerOptions["environment"]
): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "LD_LIBRARY_PATH",
    "ROCM_PATH",
    "HIP_PATH",
    "HSA_OVERRIDE_GFX_VERSION",
    "HIP_VISIBLE_DEVICES",
    "ROCR_VISIBLE_DEVICES",
    "COPY_MODEL_PATH",
    "COPY_CACHE_MAX_BYTES",
    "ORT_MIGRAPHX_FP16_ENABLE",
    "ORT_MIGRAPHX_MODEL_CACHE_PATH",
    "ORT_MIGRAPHX_EXHAUSTIVE_TUNE",
    "XDG_CACHE_HOME",
    "HOME",
    "TMPDIR",
  ] as const;
  const childEnv: NodeJS.ProcessEnv = {
    PYTHONPATH: resolve(workDir, "src"),
    PYTHONUNBUFFERED: "1",
    OMP_NUM_THREADS: "2",
    OPENBLAS_NUM_THREADS: "2",
  };
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) childEnv[key] = value;
  }
  if (overrides?.FFMPEG_PATH) childEnv.FFMPEG_PATH = overrides.FFMPEG_PATH;
  if (overrides?.VAAPI_DEVICE) childEnv.VAAPI_DEVICE = overrides.VAAPI_DEVICE;
  if (overrides?.COPY_CACHE_MAX_BYTES)
    childEnv.COPY_CACHE_MAX_BYTES = overrides.COPY_CACHE_MAX_BYTES;
  return childEnv;
}

export class PythonPerceptualDuplicatesRunner implements PerceptualDuplicatesRunner {
  private readonly pythonPath: string;
  private readonly workDir: string;
  private readonly cacheDir: string;

  constructor(
    private readonly options: PythonPerceptualDuplicatesRunnerOptions
  ) {
    this.pythonPath = resolve(options.pythonPath);
    this.workDir = resolve(options.workDir);
    this.cacheDir = resolve(options.cacheDir);
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be finite and positive");
    }
    if (
      !Number.isInteger(options.maxOutputBytes) ||
      options.maxOutputBytes < 1024
    ) {
      throw new RangeError(
        "maxOutputBytes must be an integer of at least 1024"
      );
    }
  }

  run(
    input: PerceptualDuplicatesRunnerInput
  ): Promise<PerceptualDuplicatesEngineResult> {
    return this.runRequest({ videos: input.videos }, input.signal, (value) => {
      const parsed = perceptualDuplicatesEngineResultSchema.parse(value);
      const expected = input.videos.map(({ id }) => id).sort((a, b) => a - b);
      const actual = parsed.videos.map(({ id }) => id).sort((a, b) => a - b);
      if (
        expected.length !== actual.length ||
        expected.some((id, index) => id !== actual[index])
      ) {
        throw new Error("Engine result did not cover the requested videos");
      }
      const expectedDurations = new Map(
        input.videos.map((video) => [video.id, video.duration_seconds])
      );
      if (
        parsed.videos.some(
          (video) => expectedDurations.get(video.id) !== video.duration_seconds
        )
      ) {
        throw new Error("Engine result changed a requested duration");
      }
      return parsed;
    });
  }

  /** Shared bounded process transport; each worker supplies its own result contract. */
  runRequest<T>(
    payload: Record<string, unknown>,
    signal: AbortSignal,
    parse: (value: unknown) => T
  ): Promise<T> {
    signal.throwIfAborted();
    const request = JSON.stringify({
      ...payload,
      version: 1,
      cache_dir: this.cacheDir,
    });

    return new Promise((resolveResult, reject) => {
      const child = spawn(this.pythonPath, ["-m", this.options.moduleName], {
        cwd: this.workDir,
        env: safeChildEnvironment(this.workDir, this.options.environment),
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stderrTail = Buffer.alloc(0);
      let settled = false;
      let forcedError: PerceptualDuplicatesRunnerError | null = null;
      let killTimer: ReturnType<typeof setTimeout> | null = null;

      const signalProcessTree = (signal: NodeJS.Signals): void => {
        if (process.platform !== "win32" && child.pid !== undefined) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
        child.kill(signal);
      };
      const terminate = (): void => {
        signalProcessTree("SIGTERM");
        killTimer ??= setTimeout(() => signalProcessTree("SIGKILL"), 2_000);
        killTimer.unref?.();
      };
      const onAbort = (): void => terminate();
      const timeout = setTimeout(() => {
        forcedError = new PerceptualDuplicatesRunnerError(
          "ENGINE_TIMEOUT",
          "Perceptual duplicate comparison timed out",
          false
        );
        terminate();
      }, this.options.timeoutMs);
      timeout.unref?.();

      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        signal.removeEventListener("abort", onAbort);
        callback();
      };

      signal.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > this.options.maxOutputBytes && !forcedError) {
          forcedError = new PerceptualDuplicatesRunnerError(
            "ENGINE_OUTPUT_TOO_LARGE",
            "Perceptual duplicate engine returned too much data",
            false
          );
          terminate();
          return;
        }
        if (!forcedError) stdout.push(chunk);
      });
      // Drain stderr so the child cannot block. Keep only a bounded tail to read
      // the final whitelisted machine code; never expose diagnostics or paths.
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-8 * 1024);
        if (stderrBytes > 64 * 1024 && !forcedError) {
          forcedError = new PerceptualDuplicatesRunnerError(
            "ENGINE_OUTPUT_TOO_LARGE",
            "Perceptual duplicate engine diagnostics exceeded the safe limit",
            false
          );
          terminate();
        }
      });
      child.once("error", (error) => {
        finish(() =>
          reject(
            new PerceptualDuplicatesRunnerError(
              "ENGINE_UNAVAILABLE",
              "Perceptual duplicate engine is unavailable",
              false,
              { cause: error }
            )
          )
        );
      });
      child.once("close", (code) => {
        finish(() => {
          if (signal.aborted) {
            reject(
              signal.reason ?? new DOMException("Cancelled", "AbortError")
            );
            return;
          }
          if (forcedError) {
            reject(forcedError);
            return;
          }
          if (code !== 0) {
            const engineCode = parseEngineFailureCode(stderrTail);
            reject(
              new PerceptualDuplicatesRunnerError(
                engineCode ?? "ENGINE_FAILED",
                engineCode
                  ? copyEngineFailureMessages[engineCode]
                  : "Perceptual duplicate engine failed",
                engineCode === "COPY_CACHE_CORRUPT"
              )
            );
            return;
          }
          try {
            resolveResult(
              parse(JSON.parse(Buffer.concat(stdout).toString("utf8")))
            );
          } catch (error) {
            reject(
              new PerceptualDuplicatesRunnerError(
                "ENGINE_INVALID_RESULT",
                "Perceptual duplicate engine returned an invalid result",
                false,
                { cause: error }
              )
            );
          }
        });
      });

      child.stdin.on("error", () => {
        // The close/error handlers provide the stable public failure contract.
      });
      child.stdin.end(request);
      if (signal.aborted) onAbort();
    });
  }
}
