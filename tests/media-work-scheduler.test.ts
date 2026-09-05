import { expect, it } from "bun:test";
import { MediaWorkScheduler } from "@/utils/media-work-scheduler";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it("admits a preview during two conversions and prioritizes queued previews", async () => {
  const scheduler = new MediaWorkScheduler(3, 2);
  const gates = [deferred(), deferred(), deferred()];
  const started: string[] = [];
  const jobs = gates.map((gate, i) =>
    scheduler.run("background", async () => {
      started.push(`conversion-${i}`);
      await gate.promise;
    })
  );
  const previewGate = deferred();
  const preview = scheduler.run("interactive", async () => {
    started.push("preview");
    await previewGate.promise;
  });
  await Promise.resolve();
  expect(started).toEqual(["conversion-0", "conversion-1", "preview"]);
  const nextPreview = scheduler.run("interactive", async () => {
    started.push("next-preview");
  });
  gates[0]!.release();
  await jobs[0];
  await nextPreview;
  expect(started.indexOf("next-preview")).toBeLessThan(
    started.indexOf("conversion-2")
  );
  gates.forEach((gate) => gate.release());
  previewGate.release();
  await Promise.all([...jobs, preview]);
  expect(scheduler.status).toEqual({ active: 0, background: 0, waiting: 0 });
});

it("cancels queued work without running it and releases failed work", async () => {
  const scheduler = new MediaWorkScheduler(1, 1);
  const gate = deferred();
  const active = scheduler.run("background", () => gate.promise);
  const controller = new AbortController();
  let called = false;
  const cancelled = scheduler.run(
    "interactive",
    async () => {
      called = true;
    },
    controller.signal
  );
  controller.abort();
  await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  gate.release();
  await active;
  expect(called).toBe(false);
  await expect(
    scheduler.run("background", async () => {
      throw new Error("fixture");
    })
  ).rejects.toThrow("fixture");
  expect(scheduler.status.active).toBe(0);
});

it("lets analysis progress during two long conversions and serves previews between analysis batches", async () => {
  const scheduler = new MediaWorkScheduler(3, 2);
  const conversions = [deferred(), deferred()];
  const jobs = conversions.map((gate) =>
    scheduler.run("background", () => gate.promise)
  );
  const analysisGate = deferred();
  const started: string[] = [];
  const analysis = scheduler.run("analysis", async () => {
    started.push("analysis");
    await analysisGate.promise;
  });
  await Promise.resolve();
  expect(started).toEqual(["analysis"]);
  const nextAnalysis = scheduler.run("analysis", async () => {
    started.push("next-analysis");
  });
  const preview = scheduler.run("interactive", async () => {
    started.push("preview");
  });
  analysisGate.release();
  await analysis;
  await preview;
  await nextAnalysis;
  expect(started).toEqual(["analysis", "preview", "next-analysis"]);
  conversions.forEach((gate) => gate.release());
  await Promise.all(jobs);
});
