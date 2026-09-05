import { expect, it, mock } from "bun:test";
mock.module("@/config/drizzle", () => ({ db: {} }));
const { ConversionCalibrationService } =
  await import("@/modules/conversion/conversion.calibration.service");

it("coalesces reads, expires snapshots, and invalidates after new history", async () => {
  let calls = 0;
  let now = 0;
  const service = new ConversionCalibrationService(
    async () => ({
      historyCount: ++calls,
      calibration: { exact: new Map(), anyVersion: new Map() },
    }),
    () => now
  );
  const [first, second] = await Promise.all([service.get(), service.get()]);
  expect(first).toBe(second);
  expect(calls).toBe(1);
  now = 60_001;
  expect((await service.get()).historyCount).toBe(2);
  service.invalidate();
  expect((await service.get()).historyCount).toBe(3);
});

it("does not retain a failed history read", async () => {
  let calls = 0;
  const service = new ConversionCalibrationService(async () => {
    if (++calls === 1) throw new Error("fixture");
    return {
      historyCount: 0,
      calibration: { exact: new Map(), anyVersion: new Map() },
    };
  });
  await expect(service.get()).rejects.toThrow("fixture");
  expect((await service.get()).historyCount).toBe(0);
});
