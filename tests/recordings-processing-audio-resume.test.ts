import { afterEach, expect, it, mock, spyOn } from "bun:test";
const demo = { DEMO_MODE: false }, drain = mock(async () => true), updateValues = mock(async () => undefined);
mock.module("@/config/env", () => ({ env: demo }));
mock.module("@/config/drizzle", () => ({ db: {} }));
mock.module("@/modules/settings/settings.service", () => ({ settingsService: { updateValues, getValue: async () => "false" } }));
mock.module("@/modules/recordings/recordings.scope", () => ({ recordingScope: async () => ({ directoryId: null }) }));
mock.module("@/modules/recordings/recordings.audio-cache", () => ({ drainPendingRecordingAudioJobs: drain }));
mock.module("@/utils/logger", () => ({ logger: { warn: () => undefined, info: () => undefined } }));
const { recordingsProcessing } = await import("@/modules/recordings/recordings.processing");
const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => { spies.splice(0).forEach((s) => s.mockRestore()); drain.mockClear(); updateValues.mockClear(); demo.DEMO_MODE = false; });
it("only explicit resume drains existing audio jobs once", async () => {
  const kick = spyOn(recordingsProcessing, "kick").mockResolvedValue(); spies.push(kick);
  const status = spyOn(recordingsProcessing, "status").mockResolvedValue({ paused: false, running: false, pending: 0, current: null, processedThisSession: 0, failedThisSession: 0, lastError: null }); spies.push(status);
  await recordingsProcessing.resume(); expect(drain).toHaveBeenCalledTimes(1); expect(kick).toHaveBeenCalledTimes(1); expect(updateValues).toHaveBeenCalledTimes(1);
});
it("boot/watcher kick does not drain feature jobs", async () => {
  await recordingsProcessing.kick(); await Promise.resolve(); expect(drain).not.toHaveBeenCalled();
});
it("demo resume cannot launch a feature worker", async () => {
  demo.DEMO_MODE = true;
  const status = spyOn(recordingsProcessing, "status").mockResolvedValue({ paused: false, running: false, pending: 0, current: null, processedThisSession: 0, failedThisSession: 0, lastError: null }); spies.push(status);
  await recordingsProcessing.resume(); expect(drain).not.toHaveBeenCalled();
});
