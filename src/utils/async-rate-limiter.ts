import { env } from "@/config/env";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AsyncRateLimiter {
  private queue: Promise<void> = Promise.resolve();
  private nextAvailableAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  async schedule<T>(task: () => Promise<T>): Promise<T> {
    const run = async () => {
      const waitMs = this.nextAvailableAt - Date.now();
      if (waitMs > 0) {
        await sleep(waitMs);
      }

      this.nextAvailableAt = Date.now() + this.minIntervalMs;
      return task();
    };

    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }
}

export const imageDownloadRateLimiter = new AsyncRateLimiter(
  env.IMAGE_DOWNLOAD_MIN_INTERVAL_MS,
);
