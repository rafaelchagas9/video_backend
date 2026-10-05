import { afterEach, expect, it, spyOn } from "bun:test";
import { RecordingsService, recordingsService } from "@/modules/recordings/recordings.service";
import { videosService } from "@/modules/videos/videos.service";
import { editsService } from "@/modules/edits/edits.service";
import * as duration from "@/modules/recordings/recordings.duration";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

for (const combine of [false, true]) {
  it(`caps an existing failed review before queueing (${combine ? "combined" : "separate"})`, async () => {
    const service = new RecordingsService();
    const row = { videoId: 5847, status: "proposed", deleteOriginal: false, error: "Video rendering failed", analyzedAt: new Date(), promptsRevision: "test", curve: [], clips: [
      { id: "c4", keep: true, start_seconds: 1138, end_seconds: 2068.808, peak_seconds: 1240, score: 1, label: "highlight", job_id: null },
    ] };
    let saved: any;
    spies.push(spyOn(recordingsService, "renderingIds").mockResolvedValue([]));
    // Isolate persistence and finalizer; no database, recorder or media writes.
    Object.assign(service, {
      row: async () => row,
      save: async (value: any) => { saved = value; },
      review: async () => saved,
      settings: async () => ({ clipsDirectoryId: 1 }),
    });
    spies.push(spyOn(videosService, "findById").mockResolvedValue({ id: 5847, file_path: "/synthetic.mkv", file_name: "synthetic.mkv", duration_seconds: 2068.808 } as any));
    spies.push(spyOn(duration, "probeRecordingDuration").mockResolvedValue(2067.2));
    const create = spyOn(editsService, "create").mockResolvedValue({ id: 51 } as any);
    spies.push(create);
    await service.render(1, 5847, false, combine);
    expect(create.mock.calls[0]![1].timeline.segments).toEqual([{ start: 1138, end: 2067.2 }]);
    expect(saved.clips[0].end_seconds).toBe(2067.2);
    expect(saved.clips[0].job_id).toBe(51);
    expect(saved.status).toBe("rendering");
    expect(row.clips[0]!.end_seconds).toBe(2068.808);
  });
}
