import { spawn } from "node:child_process";
import { gpuModes } from "@/utils/gpu-modes";

export interface MediaProcessOptions {
  label: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  includeStderr?: boolean;
  /** A user waits on this VAAPI job (GPU modes); defaults to the async scope. */
  interactive?: boolean;
}

/** VAAPI work must hold the GPU media lane: see `gpu-modes.ts`. */
export function usesVaapi(args: readonly string[]): boolean {
  return args.some((arg) => arg.includes("vaapi"));
}

/** No shell, bounded output, and rejection only after the child has been reaped. */
export function runMediaProcess(
  executable: string,
  args: string[],
  options: MediaProcessOptions
): Promise<{ stdout: string; stderr: string }> {
  if (!usesVaapi(args)) return runChild(executable, args, options);
  return gpuModes.runMedia(
    (signal) => runChild(executable, args, { ...options, signal }),
    {
      label: options.label,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.interactive !== undefined
        ? { interactive: options.interactive }
        : {}),
    }
  );
}

async function runChild(
  executable: string,
  args: string[],
  options: MediaProcessOptions
): Promise<{ stdout: string; stderr: string }> {
  if (options.signal?.aborted) throw new Error(`${options.label} cancelled`);
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    throw new Error("Invalid media process timeout");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const limit = options.maxOutputBytes ?? 1_048_576;
    let outputBytes = 0;
    const output: Buffer[] = [];
    let stderr = "";
    let failure: Error | undefined;
    const stop = (message: string) => {
      failure ??= new Error(message);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    };
    const abort = () => stop(`${options.label} cancelled`);
    const timer = setTimeout(
      () => stop(`${options.label} timed out`),
      options.timeoutMs
    );
    timer.unref();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      outputBytes += chunk.length;
      if (outputBytes > limit) stop(`${options.label} output is too large`);
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-16_384);
    });
    child.once("error", (error) => {
      failure ??= new Error(`${options.label} could not start`, {
        cause: error,
      });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (failure) return reject(failure);
      if (code !== 0) {
        const detail =
          options.includeStderr && stderr.trim() ? `: ${stderr.trim()}` : "";
        return reject(
          new Error(
            `${options.label} failed (exit ${code ?? signal ?? "unknown"})${detail}`
          )
        );
      }
      resolve({ stdout: Buffer.concat(output).toString(), stderr });
    });
  });
}
