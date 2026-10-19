import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { env } from "@/config/env";
import { logger } from "@/utils/logger";

/**
 * Keep the GPU's two engines apart.
 *
 * On this machine (RX 7800 XT, ROCm/MIGraphX) the vision service's ROCm context
 * and a VAAPI decode on the GPU at the same time hard-reset the whole PC with a
 * "data fabric sync flood". Model residency alone was enough: two captured
 * crashes had no inference in flight. So the guarantee is process-level: while
 * any VAAPI job runs the vision unit is stopped, and while it runs no VAAPI job
 * starts. See ~/crashlogs/NOTES.md for the evidence.
 *
 * Media (VAAPI) has priority. Vision work runs once media has been idle for a
 * grace period. Interactive vision work (a search, an uploaded face) preempts
 * background media jobs, which are killed and transparently rerun later.
 * Interactive media (casting) drains vision work instead of killing it.
 */
export type GpuLane = "media" | "compute";

export interface GpuLeaseOptions {
  label: string;
  /** Defaults to the surrounding `interactiveGpuWork` scope. */
  interactive?: boolean;
  signal?: AbortSignal;
}

export interface ComputeLeaseOptions extends GpuLeaseOptions {
  /** Run only if vision is already up; never start it (status probes). */
  passive?: boolean;
}

const interactiveScope = new AsyncLocalStorage<boolean>();

/** Mark GPU work started inside `work` as a user waiting on it (routes). */
export function interactiveGpuWork<T>(work: () => T): T {
  return interactiveScope.run(true, work);
}

/** A passive probe found vision stopped for VAAPI work. */
export class GpuLaneUnavailableError extends Error {
  constructor(label: string) {
    super(`${label} skipped: the vision service is not running`);
    this.name = "GpuLaneUnavailableError";
  }
}

export interface GpuModes {
  /** `work` must stop its ffmpeg when the signal aborts; preempted work is rerun. */
  runMedia<T>(
    work: (signal: AbortSignal) => Promise<T>,
    options: GpuLeaseOptions
  ): Promise<T>;
  runCompute<T>(
    work: () => Promise<T>,
    options: ComputeLeaseOptions
  ): Promise<T>;
  readonly status: Record<string, unknown>;
}

/** Owns the process whose ROCm context must never coexist with VAAPI work. */
export interface ComputeServiceControl {
  isActive(): Promise<boolean>;
  /** Resolves once the service answers requests. */
  start(): Promise<void>;
  /** Resolves once the service process has exited. */
  stop(): Promise<void>;
}

export class GpuPreemptedError extends Error {
  constructor(label: string) {
    super(`${label} preempted by interactive vision work`);
    this.name = "GpuPreemptedError";
  }
}

interface Lease {
  lane: GpuLane;
  interactive: boolean;
  label: string;
  controller: AbortController;
  preempted: boolean;
}

interface Waiter {
  lane: GpuLane;
  interactive: boolean;
  label: string;
  resolve: (lease: Lease) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  abort: () => void;
}

export interface GpuModeOptions {
  /** Media must be idle this long before the vision unit starts. */
  mediaIdleGraceMs: number;
  /** Stop the vision unit after this long without vision work (0 keeps it). */
  computeIdleStopMs: number;
  /** How often media admission re-checks that nobody started the unit by hand. */
  guardIntervalMs?: number;
  /** Backoff after a failed start or stop. */
  retryDelayMs?: number;
  /**
   * Start the vision unit for waiting vision work (default true). When false,
   * vision work runs only while someone started the unit by hand, and Kura
   * never stops it for idleness, only before VAAPI work.
   */
  autoStart?: boolean;
  clock?: () => number;
}

export class GpuModeCoordinator implements GpuModes {
  private mode: GpuLane | "unknown" = "unknown";
  private switching = false;
  private readonly active = new Set<Lease>();
  private readonly waiting: Waiter[] = [];
  private mediaIdleSince: number;
  private computeIdleSince: number;
  private lastGuard = Number.NEGATIVE_INFINITY;
  private guarded = false;
  private retryAt = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerAt = Number.POSITIVE_INFINITY;
  private readonly clock: () => number;
  private readonly guardIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly autoStart: boolean;

  constructor(
    private readonly service: ComputeServiceControl,
    private readonly options: GpuModeOptions
  ) {
    this.clock = options.clock ?? Date.now;
    this.guardIntervalMs = options.guardIntervalMs ?? 5_000;
    this.retryDelayMs = options.retryDelayMs ?? 15_000;
    this.autoStart = options.autoStart ?? true;
    this.mediaIdleSince = this.clock();
    this.computeIdleSince = this.clock();
  }

  get status() {
    return {
      mode: this.mode,
      switching: this.switching,
      activeMedia: this.count("media"),
      activeCompute: this.count("compute"),
      waitingMedia: this.waiting.filter((entry) => entry.lane === "media")
        .length,
      waitingCompute: this.waiting.filter((entry) => entry.lane === "compute")
        .length,
    };
  }

  async runMedia<T>(
    work: (signal: AbortSignal) => Promise<T>,
    options: GpuLeaseOptions
  ): Promise<T> {
    for (;;) {
      const lease = await this.acquire("media", options);
      const signal = options.signal
        ? AbortSignal.any([options.signal, lease.controller.signal])
        : lease.controller.signal;
      try {
        return await work(signal);
      } catch (error) {
        if (!lease.preempted || options.signal?.aborted) throw error;
        logger.info(
          { label: options.label },
          "GPU media work preempted; rerunning when the media lane returns"
        );
      } finally {
        this.release(lease);
      }
    }
  }

  async runCompute<T>(
    work: () => Promise<T>,
    options: ComputeLeaseOptions
  ): Promise<T> {
    if (
      options.passive &&
      (this.mode !== "compute" || this.switching || this.hasWaiting("media"))
    )
      throw new GpuLaneUnavailableError(options.label);
    const lease = await this.acquire("compute", options);
    try {
      return await work();
    } finally {
      this.release(lease);
    }
  }

  private acquire(lane: GpuLane, options: GpuLeaseOptions): Promise<Lease> {
    options.signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        lane,
        interactive:
          options.interactive ?? interactiveScope.getStore() === true,
        label: options.label,
        resolve,
        reject,
        ...(options.signal ? { signal: options.signal } : {}),
        abort: () => {
          const index = this.waiting.indexOf(waiter);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          reject(options.signal!.reason);
          this.drain();
        },
      };
      options.signal?.addEventListener("abort", waiter.abort, { once: true });
      this.waiting.push(waiter);
      this.drain();
    });
  }

  private release(lease: Lease): void {
    if (!this.active.delete(lease)) return;
    if (!this.count(lease.lane)) {
      if (lease.lane === "media") this.mediaIdleSince = this.clock();
      else this.computeIdleSince = this.clock();
    }
    this.drain();
  }

  private count(lane: GpuLane, interactive?: boolean): number {
    let total = 0;
    for (const lease of this.active)
      if (
        lease.lane === lane &&
        (interactive === undefined || lease.interactive === interactive)
      )
        total++;
    return total;
  }

  private hasWaiting(lane: GpuLane, interactive?: boolean): boolean {
    return this.waiting.some(
      (entry) =>
        entry.lane === lane &&
        (interactive === undefined || entry.interactive === interactive)
    );
  }

  /** Which side should own the GPU next, or undefined when nothing waits. */
  private target(): GpuLane | undefined {
    if (this.hasWaiting("compute", true) && !this.count("media", true))
      return "compute";
    if (this.hasWaiting("media")) return "media";
    if (this.hasWaiting("compute")) return "compute";
    return undefined;
  }

  private drain(): void {
    if (this.switching) return;
    const backoff = this.retryAt - this.clock();
    if (backoff > 0) return this.wakeAfter(backoff);
    const target = this.target();
    if (target === undefined) return this.scheduleIdleStop();
    if (target === this.mode) {
      if (
        target === "media" &&
        !this.guarded &&
        this.clock() - this.lastGuard >= this.guardIntervalMs
      )
        return void this.guard();
      this.guarded = false;
      return this.admit(target);
    }
    // Another side should own the GPU: the current side drains first.
    if (this.mode === "media" && this.count("media")) {
      if (this.hasWaiting("compute", true) && !this.count("media", true))
        this.preemptBackgroundMedia();
      return;
    }
    if (this.mode === "compute" && this.count("compute")) return;
    if (
      target === "compute" &&
      this.mode === "media" &&
      !this.hasWaiting("compute", true)
    ) {
      const wait =
        this.mediaIdleSince + this.options.mediaIdleGraceMs - this.clock();
      if (wait > 0) return this.wakeAfter(wait);
    }
    void this.switchTo(target);
  }

  private admit(lane: GpuLane): void {
    const mediaWaiting = this.hasWaiting("media");
    for (const waiter of [...this.waiting]) {
      if (waiter.lane !== lane) continue;
      // Media first: only interactive vision work enters while VAAPI work waits.
      if (lane === "compute" && mediaWaiting && !waiter.interactive) continue;
      this.waiting.splice(this.waiting.indexOf(waiter), 1);
      waiter.signal?.removeEventListener("abort", waiter.abort);
      const lease: Lease = {
        lane,
        interactive: waiter.interactive,
        label: waiter.label,
        controller: new AbortController(),
        preempted: false,
      };
      this.active.add(lease);
      waiter.resolve(lease);
    }
  }

  private preemptBackgroundMedia(): void {
    for (const lease of this.active) {
      if (lease.lane !== "media" || lease.interactive || lease.preempted)
        continue;
      lease.preempted = true;
      logger.info({ label: lease.label }, "Preempting GPU media work");
      lease.controller.abort(new GpuPreemptedError(lease.label));
    }
  }

  private scheduleIdleStop(): void {
    if (
      this.mode !== "compute" ||
      this.count("compute") ||
      !this.autoStart ||
      this.options.computeIdleStopMs <= 0
    )
      return;
    const wait =
      this.computeIdleSince + this.options.computeIdleStopMs - this.clock();
    if (wait > 0) return this.wakeAfter(wait);
    void this.switchTo("media");
  }

  /** Someone may have started the vision unit by hand while VAAPI work is admitted. */
  private async guard(): Promise<void> {
    this.switching = true;
    try {
      if (await this.service.isActive()) {
        logger.warn(
          "Vision service is running in GPU media mode; stopping it before VAAPI work"
        );
        await this.service.stop();
      }
      this.lastGuard = this.clock();
      this.guarded = true;
    } catch (error) {
      logger.error({ error }, "Could not verify that the vision service is stopped");
      this.retryAt = this.clock() + this.retryDelayMs;
    } finally {
      this.switching = false;
      this.drain();
    }
  }

  private async switchTo(target: GpuLane): Promise<void> {
    this.switching = true;
    this.clearTimer();
    const startedAt = this.clock();
    try {
      if (target === "compute" && !this.autoStart) {
        if (!(await this.service.isActive())) {
          // Not a failure: the unit is simply off, so no backoff for media.
          this.rejectWaiting("compute", new GpuLaneUnavailableError("Vision work"));
          return;
        }
      } else if (target === "compute") await this.service.start();
      else await this.service.stop();
      this.mode = target;
      if (target === "media") this.lastGuard = this.clock();
      else this.computeIdleSince = this.clock();
      logger.info(
        { mode: target, durationMs: this.clock() - startedAt },
        "GPU mode switched"
      );
    } catch (error) {
      this.mode = "unknown";
      this.retryAt = this.clock() + this.retryDelayMs;
      logger.error({ error, target }, "GPU mode switch failed");
      // Vision callers already handle an unavailable service; media waits for a safe stop.
      if (target === "compute") this.rejectWaiting("compute", error);
    } finally {
      this.switching = false;
      this.drain();
    }
  }

  private rejectWaiting(lane: GpuLane, error: unknown): void {
    for (const waiter of [...this.waiting]) {
      if (waiter.lane !== lane) continue;
      this.waiting.splice(this.waiting.indexOf(waiter), 1);
      waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.reject(error);
    }
  }

  private wakeAfter(ms: number): void {
    const at = this.clock() + ms;
    if (this.timer && this.timerAt <= at) return;
    this.clearTimer();
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerAt = Number.POSITIVE_INFINITY;
      this.drain();
    }, ms);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.timerAt = Number.POSITIVE_INFINITY;
  }
}

/** Without coordination both lanes run freely, as before. */
class UncoordinatedGpuModes implements GpuModes {
  runMedia<T>(
    work: (signal: AbortSignal) => Promise<T>,
    options: GpuLeaseOptions
  ): Promise<T> {
    return work(options.signal ?? new AbortController().signal);
  }

  runCompute<T>(work: () => Promise<T>): Promise<T> {
    return work();
  }

  get status() {
    return { mode: "uncoordinated" };
  }
}

function systemctl(args: string[], timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      "systemctl",
      ["--user", ...args],
      { timeout: timeoutMs },
      (error) => {
        if (!error) return resolve(0);
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        if (typeof code === "number") return resolve(code);
        reject(error);
      }
    );
  });
}

/** Controls the vision service through its systemd user unit. */
export class SystemdComputeService implements ComputeServiceControl {
  constructor(
    private readonly unit: string,
    private readonly readyUrl: string,
    private readonly startTimeoutMs: number
  ) {}

  async isActive(): Promise<boolean> {
    return (await systemctl(["is-active", "--quiet", this.unit], 10_000)) === 0;
  }

  async start(): Promise<void> {
    const code = await systemctl(["start", this.unit], 60_000);
    if (code !== 0) throw new Error(`systemctl start ${this.unit} exited ${code}`);
    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(this.readyUrl, {
          signal: AbortSignal.timeout(5_000),
        });
        if (response.ok) return;
      } catch {
        // Not listening yet.
      }
      if (!(await this.isActive()))
        throw new Error(`${this.unit} stopped while starting`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`${this.unit} was not ready within ${this.startTimeoutMs} ms`);
  }

  async stop(): Promise<void> {
    const code = await systemctl(["stop", this.unit], 150_000);
    if (code !== 0) throw new Error(`systemctl stop ${this.unit} exited ${code}`);
    if (await this.isActive()) throw new Error(`${this.unit} is still active`);
  }
}

export const gpuModes: GpuModes =
  env.GPU_MODE_COORDINATION && !env.DEMO_MODE
    ? new GpuModeCoordinator(
        new SystemdComputeService(
          env.GPU_VISION_UNIT,
          `${env.VISION_SERVICE_URL.replace(/\/+$/, "")}/readyz`,
          env.GPU_VISION_START_TIMEOUT_MS
        ),
        {
          mediaIdleGraceMs: env.GPU_MEDIA_IDLE_GRACE_MS,
          computeIdleStopMs: env.GPU_COMPUTE_IDLE_STOP_MS,
          autoStart: env.GPU_VISION_AUTOSTART,
        }
      )
    : new UncoordinatedGpuModes();
