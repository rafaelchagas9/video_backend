import { spawn, type ChildProcess } from "node:child_process";
import { setPriority } from "node:os";

/**
 * Chromaprint parameters are part of the stored data: changing any of them invalidates every
 * fingerprint. Audio is resampled against container timestamps (gaps become silence) so item
 * k stays at k * FINGERPRINT_HOP_SECONDS on the video timeline.
 */
export const FINGERPRINT_REVISION = "chromaprint2-mono11025-async-v1";
export const FINGERPRINT_HOP_SECONDS = 4096 / 3 / 11025;

export type FingerprintResult =
  | { status: "ready"; items: Uint32Array }
  | { status: "no_audio" };

export class FingerprintError extends Error {
  constructor(
    message: string,
    options?: ErrorOptions,
    readonly code: "COPY_DECODE_FAILED" | "ENGINE_UNAVAILABLE" = "COPY_DECODE_FAILED"
  ) {
    super(message, options);
    this.name = "FingerprintError";
  }
}

const NO_AUDIO = /does not contain any stream|matches no streams|Not enough audio data/i;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** No decoded audio for this long means a hung decoder, not a slow disk. */
const STALL_MS = 5 * 60 * 1000;

/**
 * Fingerprints the first audio stream. The pipeline is I/O bound on spinning disks (one pass
 * at ~130 MB/s), so both processes run at the lowest CPU/IO priority.
 */
export function extractFingerprint(
  path: string,
  options: {
    ffmpegPath: string;
    fpcalcPath: string;
    durationSeconds: number | null;
    signal: AbortSignal;
    timeoutMs?: number;
    stallMs?: number;
  }
): Promise<FingerprintResult> {
  const { signal } = options;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      options.ffmpegPath,
      [
        "-nostdin", "-v", "error", "-i", path,
        "-map", "0:a:0?", "-vn", "-sn", "-dn",
        "-ac", "1", "-ar", "11025", "-af", "aresample=async=1:first_pts=0",
        "-f", "s16le", "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const fpcalc = spawn(
      options.fpcalcPath,
      ["-format", "s16le", "-rate", "11025", "-channels", "1", "-raw", "-length", "0", "-json", "-"],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    for (const child of [ffmpeg, fpcalc]) {
      try {
        if (child.pid) setPriority(child.pid, 19);
      } catch {
        // Priority is best effort.
      }
    }
    ffmpeg.stdout.pipe(fpcalc.stdin);
    fpcalc.stdin.on("error", () => {
      // fpcalc exiting early surfaces through its exit code.
    });

    let ffmpegErr = "";
    let fpcalcErr = "";
    const out: Buffer[] = [];
    let outBytes = 0;
    let failure: Error | undefined;
    const exit = new Map<ChildProcess, number | null>();
    const kill = () => {
      ffmpeg.kill("SIGKILL");
      fpcalc.kill("SIGKILL");
    };
    const onAbort = () => kill();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      failure = new FingerprintError("Audio fingerprinting timed out");
      kill();
    }, options.timeoutMs ?? 2 * 60 * 60 * 1000);
    timer.unref?.();
    let lastAudio = Date.now();
    ffmpeg.stdout.on("data", () => {
      lastAudio = Date.now();
    });
    const watchdog = setInterval(() => {
      if (Date.now() - lastAudio < (options.stallMs ?? STALL_MS)) return;
      failure ??= new FingerprintError("Audio decoding stalled");
      kill();
    }, 5_000);
    watchdog.unref?.();

    ffmpeg.stderr.on("data", (d: Buffer) => {
      ffmpegErr = (ffmpegErr + d.toString()).slice(-4096);
    });
    fpcalc.stderr.on("data", (d: Buffer) => {
      fpcalcErr = (fpcalcErr + d.toString()).slice(-4096);
    });
    fpcalc.stdout.on("data", (d: Buffer) => {
      outBytes += d.length;
      if (outBytes > MAX_OUTPUT_BYTES) {
        failure ??= new FingerprintError("Fingerprint output exceeded its limit");
        kill();
        return;
      }
      out.push(d);
    });
    const settle = () => {
      if (exit.size < 2) return;
      clearInterval(watchdog);
      const ffmpegCode = exit.get(ffmpeg);
      const fpcalcCode = exit.get(fpcalc);
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) return reject(signal.reason);
      if (failure) return reject(failure);
      if (fpcalcCode !== 0) {
        if (NO_AUDIO.test(ffmpegErr) || NO_AUDIO.test(fpcalcErr))
          return resolve({ status: "no_audio" });
        return reject(new FingerprintError("Audio could not be decoded for fingerprinting"));
      }
      let items: Uint32Array;
      try {
        const parsed = JSON.parse(Buffer.concat(out).toString("utf8")) as { fingerprint?: unknown };
        if (!Array.isArray(parsed.fingerprint)) throw new Error("missing fingerprint");
        items = Uint32Array.from(parsed.fingerprint as number[]);
      } catch (error) {
        return reject(new FingerprintError("fpcalc returned an invalid fingerprint", { cause: error }));
      }
      if (ffmpegCode !== 0) {
        // A decoder error part way through leaves a shorter fingerprint. Keep it only when it
        // still spans nearly the whole video; otherwise coverage would be understated for good.
        const spans = items.length * FINGERPRINT_HOP_SECONDS + 2.6;
        if (!options.durationSeconds || spans < 0.9 * options.durationSeconds)
          return reject(new FingerprintError("Audio decoding failed part way through"));
      }
      resolve({ status: "ready", items });
    };
    for (const child of [ffmpeg, fpcalc] as ChildProcess[]) {
      child.once("error", (error) => {
        failure ??= new FingerprintError(
          "Could not start audio fingerprinting",
          { cause: error },
          "ENGINE_UNAVAILABLE"
        );
        kill();
        // a process that never started does not emit "close" on every runtime
        if (!child.pid && !exit.has(child)) {
          exit.set(child, null);
          settle();
        }
      });
      child.once("close", (code) => {
        if (exit.has(child)) return;
        exit.set(child, code);
        settle();
      });
    }
  });
}
