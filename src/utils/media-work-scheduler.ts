type Priority = "interactive" | "analysis" | "background";
interface Waiter {
  priority: Priority;
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  abort: () => void;
}

/** Coordinate this server's GPU work. Long conversions leave room for previews and analysis. */
export class MediaWorkScheduler {
  private active = 0;
  private background = 0;
  private readonly waiting: Waiter[] = [];

  constructor(
    private readonly capacity = 3,
    private readonly backgroundLimit = 2
  ) {
    if (
      !Number.isInteger(capacity) ||
      !Number.isInteger(backgroundLimit) ||
      capacity < 1 ||
      backgroundLimit < 1 ||
      backgroundLimit > capacity
    ) {
      throw new Error("Invalid media work concurrency limits");
    }
  }

  async run<T>(
    priority: Priority,
    work: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const release = await this.acquire(priority, signal);
    try {
      signal?.throwIfAborted();
      return await work();
    } finally {
      release();
    }
  }

  get status() {
    return {
      active: this.active,
      background: this.background,
      waiting: this.waiting.length,
    };
  }

  private acquire(
    priority: Priority,
    signal?: AbortSignal
  ): Promise<() => void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        priority,
        resolve,
        reject,
        ...(signal ? { signal } : {}),
        abort: () => {
          const index = this.waiting.indexOf(waiter);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          reject(signal!.reason);
          this.drain();
        },
      };
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.waiting.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.capacity) {
      let index = this.waiting.findIndex(
        (entry) => entry.priority === "interactive"
      );
      if (index < 0)
        index = this.waiting.findIndex(
          (entry) => entry.priority === "analysis"
        );
      if (index < 0 && this.background < this.backgroundLimit) index = 0;
      if (index < 0 || index >= this.waiting.length) return;
      const [entry] = this.waiting.splice(index, 1);
      entry!.signal?.removeEventListener("abort", entry!.abort);
      this.active++;
      if (entry!.priority === "background") this.background++;
      let released = false;
      entry!.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        if (entry!.priority === "background") this.background--;
        this.drain();
      });
    }
  }
}

// Two background operations retain measured conversion throughput. A third
// slot admits previews or bounded analysis work even during two long conversions.
export const mediaWorkScheduler = new MediaWorkScheduler();
