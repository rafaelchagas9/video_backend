import { expect, it } from "bun:test";
import { keptRecordingSeconds } from "@/modules/recordings/recordings.kept-duration";
const clip = (start_seconds: number, end_seconds: number, keep = true) => ({ start_seconds, end_seconds, keep });
it("counts kept timeline coverage once with touching and overlapping proposals", () => {
  expect(keptRecordingSeconds([clip(20, 30), clip(0, 15), clip(10, 20), clip(40, 50, false)], 60)).toBe(30);
});
it("caps coverage at known source bounds and ignores invalid ranges", () => {
  expect(keptRecordingSeconds([clip(-5, 5), clip(9, 14), clip(12, 11), clip(NaN, 6), clip(0, Infinity)], 10)).toBe(6);
  expect(keptRecordingSeconds([clip(2, 7)], null)).toBe(5);
  expect(keptRecordingSeconds([], 10)).toBe(0);
});
