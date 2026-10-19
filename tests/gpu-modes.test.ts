import { expect, it } from "bun:test";
import {
  type ComputeServiceControl,
  GpuModeCoordinator,
  GpuPreemptedError,
} from "@/utils/gpu-modes";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeVisionService implements ComputeServiceControl {
  active = false;
  starts = 0;
  stops = 0;
  failStart = false;
  readonly events: string[] = [];

  async isActive() {
    return this.active;
  }

  async start() {
    await tick();
    if (this.failStart) throw new Error("vision failed to start");
    this.starts++;
    this.active = true;
    this.events.push("start");
  }

  async stop() {
    await tick();
    this.stops++;
    this.active = false;
    this.events.push("stop");
  }
}

function coordinator(
  service: FakeVisionService,
  mediaIdleGraceMs = 0,
  autoStart = true
) {
  return new GpuModeCoordinator(service, {
    autoStart,
    mediaIdleGraceMs,
    computeIdleStopMs: 0,
    guardIntervalMs: 0,
    retryDelayMs: 0,
  });
}

/** Each job asserts the invariant that kept the machine from resetting. */
function media(
  gpu: GpuModeCoordinator,
  service: FakeVisionService,
  label: string,
  gate?: Promise<void>,
  interactive?: boolean
) {
  return gpu.runMedia(
    async (signal) => {
      expect(service.active).toBe(false);
      service.events.push(`media:${label}`);
      if (gate)
        await Promise.race([
          gate,
          new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            })
          ),
        ]);
      expect(service.active).toBe(false);
      return label;
    },
    { label, interactive }
  );
}

function compute(
  gpu: GpuModeCoordinator,
  service: FakeVisionService,
  label: string,
  gate?: Promise<void>,
  interactive?: boolean
) {
  return gpu.runCompute(
    async () => {
      expect(service.active).toBe(true);
      service.events.push(`compute:${label}`);
      await gate;
      expect(service.active).toBe(true);
      return label;
    },
    { label, interactive }
  );
}

it("stops the vision unit before media work and starts it only after media is idle", async () => {
  const service = new FakeVisionService();
  service.active = true;
  const gpu = coordinator(service);
  const gate = deferred();
  const decode = media(gpu, service, "decode", gate.promise);
  const faces = compute(gpu, service, "faces");
  await tick();
  await tick();
  expect(service.events).toEqual(["stop", "media:decode"]);
  gate.release();
  expect(await decode).toBe("decode");
  expect(await faces).toBe("faces");
  expect(service.events).toEqual(["stop", "media:decode", "start", "compute:faces"]);
});

it("puts waiting media work ahead of background vision work", async () => {
  const service = new FakeVisionService();
  const gpu = coordinator(service);
  const first = deferred();
  const running = compute(gpu, service, "running", first.promise);
  await tick();
  await tick();
  const decode = media(gpu, service, "decode");
  const queued = compute(gpu, service, "queued");
  first.release();
  await Promise.all([running, decode, queued]);
  expect(service.events).toEqual([
    "start",
    "compute:running",
    "stop",
    "media:decode",
    "start",
    "compute:queued",
  ]);
});

it("waits out the media idle grace so back-to-back ffmpeg steps keep the lane", async () => {
  const service = new FakeVisionService();
  const gpu = coordinator(service, 40);
  await media(gpu, service, "frames");
  const faces = compute(gpu, service, "faces");
  await tick();
  const thumbnail = media(gpu, service, "thumbnail");
  await thumbnail;
  await faces;
  expect(service.events).toEqual([
    "stop",
    "media:frames",
    "media:thumbnail",
    "start",
    "compute:faces",
  ]);
});

it("lets interactive vision work preempt background media and reruns the media job", async () => {
  const service = new FakeVisionService();
  const gpu = coordinator(service);
  const conversion = deferred();
  let attempts = 0;
  const job = gpu.runMedia(
    async (signal) => {
      attempts++;
      expect(service.active).toBe(false);
      if (attempts === 1)
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          })
        );
      await conversion.promise;
      return attempts;
    },
    { label: "conversion" }
  );
  await tick();
  await tick();
  const search = compute(gpu, service, "search", undefined, true);
  expect(await search).toBe("search");
  conversion.release();
  expect(await job).toBe(2);
});

it("does not kill an interactive cast; vision work waits for it", async () => {
  const service = new FakeVisionService();
  const gpu = coordinator(service);
  const cast = deferred();
  const casting = media(gpu, service, "cast", cast.promise, true);
  await tick();
  await tick();
  const search = compute(gpu, service, "search", undefined, true);
  await tick();
  await tick();
  expect(service.events).toEqual(["stop", "media:cast"]);
  cast.release();
  await casting;
  await search;
  expect(service.events).toEqual(["stop", "media:cast", "start", "compute:search"]);
});

it("drains vision work before an interactive cast without killing it", async () => {
  const service = new FakeVisionService();
  const gpu = coordinator(service);
  const request = deferred();
  const faces = compute(gpu, service, "faces", request.promise);
  await tick();
  await tick();
  const cast = media(gpu, service, "cast", undefined, true);
  await tick();
  expect(service.events).toEqual(["start", "compute:faces"]);
  request.release();
  await Promise.all([faces, cast]);
  expect(service.events).toEqual(["start", "compute:faces", "stop", "media:cast"]);
});

it("stops a vision unit started by hand before admitting more media work", async () => {
  const service = new FakeVisionService();
  const gpu = coordinator(service);
  await media(gpu, service, "first");
  service.active = true;
  await media(gpu, service, "second");
  expect(service.stops).toBe(2);
});

it("rejects vision work when the unit cannot start, then recovers", async () => {
  const service = new FakeVisionService();
  service.failStart = true;
  const gpu = coordinator(service);
  await expect(compute(gpu, service, "faces")).rejects.toThrow(
    "vision failed to start"
  );
  service.failStart = false;
  expect(await compute(gpu, service, "faces")).toBe("faces");
});

it("does not rerun media work that its caller cancelled", async () => {
  const service = new FakeVisionService();
  const gpu = coordinator(service);
  const controller = new AbortController();
  let attempts = 0;
  const job = gpu.runMedia(
    (signal) =>
      new Promise((_, reject) => {
        attempts++;
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
    { label: "conversion", signal: controller.signal }
  );
  await tick();
  await tick();
  controller.abort(new Error("cancelled by user"));
  await expect(job).rejects.toThrow("cancelled by user");
  expect(attempts).toBe(1);
});

it("never overlaps the two sides under a mixed load", async () => {
  const service = new FakeVisionService();
  const gpu = coordinator(service);
  const jobs: Promise<unknown>[] = [];
  for (let i = 0; i < 40; i++) {
    const gate = new Promise<void>((resolve) => setTimeout(resolve, i % 3));
    const interactive = i % 7 === 0;
    const run =
      i % 2
        ? media(gpu, service, `m${i}`, gate, interactive)
        : compute(gpu, service, `c${i}`, gate, interactive);
    jobs.push(run.catch((error) => {
      if (!(error instanceof GpuPreemptedError)) throw error;
    }));
    if (i % 5 === 0) await tick();
  }
  await Promise.all(jobs);
  expect(gpu.status.activeMedia).toBe(0);
  expect(gpu.status.activeCompute).toBe(0);
});

it("answers passive probes only while vision is already up", async () => {
  const service = new FakeVisionService();
  const gpu = coordinator(service);
  await expect(
    gpu.runCompute(async () => "health", { label: "health", passive: true })
  ).rejects.toThrow("vision service is not running");
  expect(service.starts).toBe(0);
  await compute(gpu, service, "faces");
  expect(
    await gpu.runCompute(async () => "health", { label: "health", passive: true })
  ).toBe("health");
});

it("treats work inside interactiveGpuWork as interactive", async () => {
  const { interactiveGpuWork } = await import("@/utils/gpu-modes");
  const service = new FakeVisionService();
  const gpu = coordinator(service);
  let attempts = 0;
  const conversion = gpu.runMedia(
    async (signal) => {
      attempts++;
      if (attempts === 1)
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          })
        );
      return attempts;
    },
    { label: "conversion" }
  );
  await tick();
  await tick();
  await interactiveGpuWork(() => compute(gpu, service, "upload"));
  expect(await conversion).toBe(2);
});

it("without autostart, vision work fails fast while the unit is off and never starts it", async () => {
  const service = new FakeVisionService();
  const gpu = coordinator(service, 0, false);
  await expect(compute(gpu, service, "faces")).rejects.toThrow(
    "vision service is not running"
  );
  await expect(
    compute(gpu, service, "search", undefined, true)
  ).rejects.toThrow("vision service is not running");
  expect(service.starts).toBe(0);
  // A failed vision request must not delay media work.
  expect(await media(gpu, service, "decode")).toBe("decode");
});

it("without autostart, uses a hand-started unit but still stops it for media", async () => {
  const service = new FakeVisionService();
  service.active = true;
  const gpu = coordinator(service, 0, false);
  expect(await compute(gpu, service, "faces")).toBe("faces");
  await tick();
  expect(service.stops).toBe(0);
  expect(await media(gpu, service, "decode")).toBe("decode");
  expect(service.stops).toBe(1);
  await expect(compute(gpu, service, "faces")).rejects.toThrow(
    "vision service is not running"
  );
  expect(service.starts).toBe(0);
});
