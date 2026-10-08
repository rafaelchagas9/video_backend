import { afterEach, expect, it, spyOn } from "bun:test";
import { RecordingsService } from "@/modules/recordings/recordings.service";
import { videosService } from "@/modules/videos/videos.service";
import * as snapshots from "@/modules/recordings/recordings.snapshots.store";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });
const clips = [{ id: "c1", keep: true, start_seconds: 0, end_seconds: 5, peak_seconds: 2, score: 0.8, label: "synthetic" },
  { id: "c2", keep: false, start_seconds: 5, end_seconds: 10, peak_seconds: 7, score: 0.5, label: "synthetic" }];
const row = { videoId: 1, analyzedAt: new Date("2026-10-08T00:00:00Z"), status: "proposed", promptsRevision: "synthetic", clips, curve: [], deleteOriginal: false, error: null };
const video = { id: 1, file_name: "synthetic.mkv", duration_seconds: 10 } as any;

it("Save archives every current verdict before acknowledging or persisting a review", async () => {
  const service = new RecordingsService(); const events: string[] = [];
  Object.assign(service, { row: async () => row, saveIfCurrent: async () => { events.push("review"); return true; },
    recordDecisions: async () => { events.push("feedback"); }, review: async () => row });
  spies.push(spyOn(videosService, "findById").mockResolvedValue(video));
  const preserve = spyOn(snapshots, "preserveRecordingTrainingSnapshot").mockImplementation(async () => { events.push("snapshot"); }); spies.push(preserve);
  await service.updateClips(1, 1, clips);
  expect(events).toEqual(["snapshot", "review", "feedback"]);
  expect(preserve.mock.calls[0]![0].clips).toEqual(clips);
  expect(preserve.mock.calls[0]![2]).toBe("save");
});

it("a failed snapshot cannot become a successful Save", async () => {
  const service = new RecordingsService(); let saved = false;
  Object.assign(service, { row: async () => row, saveIfCurrent: async () => { saved = true; return true; }, review: async () => row });
  spies.push(spyOn(videosService, "findById").mockResolvedValue(video));
  spies.push(spyOn(snapshots, "preserveRecordingTrainingSnapshot").mockRejectedValue(new Error("synthetic disk full")));
  await expect(service.updateClips(1, 1, clips)).rejects.toThrow("synthetic disk full");
  expect(saved).toBe(false);
});

it("a missing archive blocks original removal before any recorder or media deletion", async () => {
  const service = new RecordingsService();
  Object.assign(service, { row: async () => row });
  spies.push(spyOn(snapshots, "preserveRecordingTrainingSnapshot").mockRejectedValue(new Error("synthetic unavailable archive")));
  const remove = spyOn(videosService, "delete").mockResolvedValue(); spies.push(remove);
  await expect((service as any).remove(video)).rejects.toThrow("synthetic unavailable archive");
  expect(remove).not.toHaveBeenCalled();
});

it("post-job archive failure keeps queued job IDs tracked instead of turning render into a failed retry", async () => {
  const service = new RecordingsService(); const events: string[] = []; let saved: any;
  Object.assign(service, { row: async () => row, settings: async () => ({ clipsDirectoryId: 1 }),
    save: async (value: any) => { saved = value; events.push("saved"); },
    recordDecisions: async () => undefined, review: async () => saved });
  spies.push(spyOn(videosService, "findById").mockResolvedValue(video));
  const duration = await import("@/modules/recordings/recordings.duration");
  const edits = await import("@/modules/edits/edits.service");
  const recordings = await import("@/modules/recordings/recordings.service");
  spies.push(spyOn(duration, "probeRecordingDuration").mockResolvedValue(10));
  spies.push(spyOn(recordings.recordingsService, "renderingIds").mockResolvedValue([]));
  const create = spyOn(edits.editsService, "create").mockImplementation(async () => { events.push("job"); return { id: 21 } as any; }); spies.push(create);
  const preserve = spyOn(snapshots, "preserveRecordingTrainingSnapshot").mockImplementation(async (_review, _video, event) => {
    if (event === "rendering") throw new Error("synthetic post-job disk failure");
    events.push("snapshot");
  }); spies.push(preserve);
  const result = await service.render(1, 1, true);
  expect(events.slice(0, 3)).toEqual(["snapshot", "job", "saved"]);
  expect(create).toHaveBeenCalledTimes(1);
  expect(result.status).toBe("rendering");
  expect(result.clips[0].job_id).toBe(21);
  expect(result.error).toContain("original is retained");
});

it("completed output stays truthful when lineage storage fails and requested deletion is deferred", async () => {
  const service = new RecordingsService(); let saved: any; let deleted = false;
  const rendering = { ...row, status: "rendering", deleteOriginal: true, clips: [{ ...clips[0]!, job_id: 21 }, clips[1]!] };
  Object.assign(service, { row: async () => rendering, save: async (value: any) => { saved = value; },
    deleteOriginal: async () => { deleted = true; } });
  const edits = await import("@/modules/edits/edits.service");
  spies.push(spyOn(edits.editsService, "getById").mockResolvedValue({ status: "completed", outputVideoId: 22 } as any));
  spies.push(spyOn(videosService, "findById").mockResolvedValue(video));
  spies.push(spyOn(snapshots, "preserveRecordingTrainingSnapshot").mockRejectedValue(new Error("synthetic lineage disk failure")));
  const result = await service.finalize(1);
  expect(result!.status).toBe("done");
  expect(saved.clips[0].output_video_id).toBe(22);
  expect(result!.error).toContain("original has been retained");
  expect(deleted).toBe(false);
});
