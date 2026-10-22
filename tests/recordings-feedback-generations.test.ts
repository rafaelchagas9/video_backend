import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { RecordingClip, RecordingProposal } from "@/database/schema";
import { feedbackRows, mergeTarget } from "@/modules/recordings/recordings.feedback";
import * as feedback from "@/modules/recordings/recordings.feedback";
import { RecordingsService } from "@/modules/recordings/recordings.service";
import { isAuditRecording } from "@/modules/recordings/recordings.training-value";
import { videosService } from "@/modules/videos/videos.service";
import * as snapshots from "@/modules/recordings/recordings.snapshots.store";
import { ConflictError } from "@/utils/errors";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

const proposal = (id: string, start: number, end: number, keep = true): RecordingProposal =>
  ({ id, start_seconds: start, end_seconds: end, peak_seconds: (start + end) / 2, score: 1, label: "synthetic", keep });
const clip = (id: string, start: number, end: number, keep: boolean): RecordingClip =>
  ({ id, start_seconds: start, end_seconds: end, peak_seconds: (start + end) / 2, score: 1, label: "synthetic", keep });
const source = (proposals: RecordingProposal[] | null) => ({
  videoId: 7, analyzedAt: new Date("2026-10-08T00:00:00Z"), promptsRevision: "synthetic",
  fileName: "someone_2026-10-08_01-02-03.mkv", durationSeconds: 600, proposals,
});

describe("feedback rows", () => {
  it("keeps a merged-away proposal with its own range, pointing at the clip it joined", () => {
    const proposals = [proposal("c1", 10, 40), proposal("c2", 60, 90, false)];
    // The reviewer trimmed and merged c2 into c1, then kept it.
    const rows = feedbackRows(source(proposals), [{ ...clip("c1", 12, 88, true), detected: { start_seconds: 10, end_seconds: 90 } }]);
    const merged = rows.find((row) => row.clipId === "c2")!;
    expect(merged.mergedInto).toBe("c1");
    expect([merged.detectedStart, merged.detectedEnd]).toEqual([60, 90]);
    expect(merged.shownDefault).toBe("likely-skip");
    const survivor = rows.find((row) => row.clipId === "c1")!;
    // The merge's combined range never replaces what detection proposed for c1.
    expect([survivor.detectedStart, survivor.detectedEnd]).toEqual([10, 40]);
    expect([survivor.startSeconds, survivor.endSeconds]).toEqual([12, 88]);
    expect(survivor.mergedInto).toBeNull();
    expect(survivor.shownDefault).toBe("keep");
  });

  it("labels every verdict as triage and carries the Save's context and the channel's footage", () => {
    const context = { batch: "b1", queuePosition: 3, queueSort: "useful", audit: true };
    const rows = feedbackRows(source([proposal("c1", 0, 30)]), [clip("c1", 5, 30, true), clip("added-1", 100, 120, true)],
      { context, channel: { keptSeconds: 300, renderedSeconds: 120 } });
    for (const row of rows) {
      expect(row.labelType).toBe("triage");
      expect(row).toMatchObject({ saveBatch: "b1", queuePosition: 3, queueSort: "useful", audit: true, channelKeptSeconds: 300, channelRenderedSeconds: 120 });
    }
    expect(rows.find((row) => row.clipId === "added-1")!.shownDefault).toBeNull();
  });

  it("leaves Save context out when a call does not carry it, so a render keeps the Save's", () => {
    const [row] = feedbackRows(source(null), [clip("c1", 0, 30, true)], { rendered: true });
    expect(row).not.toHaveProperty("saveBatch");
    expect(row).not.toHaveProperty("channelKeptSeconds");
    expect(row).not.toHaveProperty("labelType");
    expect(row!.rendered).toBe(true);
  });

  it("labels a highlights pass apart from triage", () => {
    const context = { batch: "b2", queuePosition: null, queueSort: null, audit: false, pass: "highlights" as const };
    const rows = feedbackRows(source([proposal("c1", 0, 30)]), [clip("c1", 0, 30, false), clip("added-span-1", 100, 160, true)], { context });
    expect(rows.map((row) => row.labelType)).toEqual(["highlight", "highlight"]);
  });

  it("logs each proposal's baseline rank, the review order and refinements of keeps only", () => {
    const proposals = [{ ...proposal("c1", 0, 30), score: 0.5 }, { ...proposal("c2", 100, 1300), score: 0.9 }];
    const context = { batch: "b1", queuePosition: null, queueSort: null, audit: false, reviewOrder: "best" };
    const rows = feedbackRows(source(proposals), [
      { ...clip("c1", 0, 30, false), refinement: "save" },
      { ...clip("c2", 100, 1300, true), refinement: "watch" },
      clip("added-1", 2000, 2100, true),
    ], { context });
    const by = (id: string) => rows.find((row) => row.clipId === id)!;
    expect([by("c2").baselineRank, by("c1").baselineRank, by("added-1").baselineRank]).toEqual([1, 2, null]);
    expect(by("c2").baselineScore).toBeGreaterThan(by("c1").baselineScore!);
    expect([by("c1").refinement, by("c2").refinement, by("added-1").refinement]).toEqual([null, "watch", null]);
    for (const row of rows) expect(row.reviewOrder).toBe("best");
  });

  it("finds the clip a proposal went into by its peak, else by overlap", () => {
    expect(mergeTarget(proposal("c2", 60, 90), [clip("c1", 10, 100, true)])?.id).toBe("c1");
    expect(mergeTarget({ start_seconds: 60, end_seconds: 90, peak_seconds: 89 }, [clip("c1", 50, 70, true)])?.id).toBe("c1");
    expect(mergeTarget(proposal("c2", 60, 90), [clip("c1", 0, 10, true)])).toBeNull();
  });
});

describe("audit slice", () => {
  it("picks about one recording in ten, the same ones every time", () => {
    const picked = Array.from({ length: 20_000 }, (_, id) => isAuditRecording(id + 1)).filter(Boolean).length;
    expect(picked / 20_000).toBeGreaterThan(0.09);
    expect(picked / 20_000).toBeLessThan(0.11);
    expect(isAuditRecording(4242)).toBe(isAuditRecording(4242));
  });
});

const saved = { videoId: 7, status: "proposed", clips: [clip("c1", 0, 30, true)], curve: [], promptsRevision: "synthetic",
  proposals: [proposal("c1", 0, 30)], savedAt: new Date("2026-10-08T00:05:00Z"), deleteOriginal: false, error: null,
  analyzedAt: new Date("2026-10-08T00:00:00Z") };

describe("analysis claim", () => {
  it("automatic analysis leaves an existing review alone", async () => {
    const service = new RecordingsService();
    const find = spyOn(videosService, "findById"); spies.push(find);
    Object.assign(service, { row: async () => saved, review: async () => saved });
    await service.analyze(1, 7, { automatic: true });
    expect(find).not.toHaveBeenCalled();
  });

  it("concurrent callers share one analysis run", async () => {
    const service = new RecordingsService();
    let runs = 0;
    let finish!: () => void;
    Object.assign(service, {
      runAnalysis: () => { runs += 1; return new Promise((resolve) => { finish = () => resolve(saved); }); },
      review: async () => saved,
    });
    const first = service.analyze(1, 7);
    const second = service.analyze(1, 7, { automatic: true });
    await Promise.resolve();
    finish();
    await Promise.all([first, second]);
    expect(runs).toBe(1);
  });
});

describe("Save", () => {
  it("refuses a Save that answers an older analysis", async () => {
    const service = new RecordingsService();
    let wrote = false;
    Object.assign(service, { row: async () => saved, saveIfCurrent: async () => { wrote = true; return true; } });
    spies.push(spyOn(videosService, "findById").mockResolvedValue({ id: 7, file_name: "someone_2026-10-08_01-02-03.mkv", duration_seconds: 600 } as any));
    spies.push(spyOn(snapshots, "preserveRecordingTrainingSnapshot").mockResolvedValue());
    await expect(service.updateClips(1, 7, saved.clips, { analyzedAt: "2026-10-07T00:00:00.000Z" })).rejects.toBeInstanceOf(ConflictError);
    expect(wrote).toBe(false);
  });

  it("refuses when the review was re-analysed while saving, and records nothing", async () => {
    const service = new RecordingsService();
    let recorded = false;
    Object.assign(service, { row: async () => saved, saveIfCurrent: async () => false, recordDecisions: async () => { recorded = true; } });
    spies.push(spyOn(videosService, "findById").mockResolvedValue({ id: 7, file_name: "someone_2026-10-08_01-02-03.mkv", duration_seconds: 600 } as any));
    spies.push(spyOn(snapshots, "preserveRecordingTrainingSnapshot").mockResolvedValue());
    await expect(service.updateClips(1, 7, saved.clips)).rejects.toBeInstanceOf(ConflictError);
    expect(recorded).toBe(false);
  });

  it("gives each Save its own batch and passes queue context to decisions and snapshot", async () => {
    const service = new RecordingsService();
    const contexts: any[] = [];
    Object.assign(service, {
      row: async () => saved, saveIfCurrent: async () => true, review: async () => saved,
      recordDecisions: async (_row: unknown, _video: unknown, _clips: unknown, _rendered: unknown, context: unknown) => { contexts.push(context); },
    });
    spies.push(spyOn(videosService, "findById").mockResolvedValue({ id: 7, file_name: "someone_2026-10-08_01-02-03.mkv", duration_seconds: 600 } as any));
    const preserve = spyOn(snapshots, "preserveRecordingTrainingSnapshot").mockResolvedValue(); spies.push(preserve);
    const origin = { analyzedAt: saved.analyzedAt.toISOString(), queuePosition: 4, queueSort: "useful" };
    await service.updateClips(1, 7, saved.clips, origin);
    await service.updateClips(1, 7, saved.clips, origin);
    expect(contexts[0]).toMatchObject({ queuePosition: 4, queueSort: "useful", audit: isAuditRecording(7) });
    expect(contexts[0].batch).not.toBe(contexts[1].batch);
    expect(preserve.mock.calls[0]![3]).toEqual(contexts[0]);
  });
});

describe("deleting from review", () => {
  const unsaved = { ...saved, savedAt: null, clips: [clip("c1", 0, 30, true), clip("c2", 60, 90, false)] };
  const deleting = (row: typeof saved | typeof unsaved) => {
    const service = new RecordingsService();
    const decided: { clips: RecordingClip[] }[] = [];
    Object.assign(service, { row: async () => row, remove: async () => {}, recordDecisions: async (_row: unknown, _video: unknown, clips: RecordingClip[]) => { decided.push({ clips }); } });
    spies.push(spyOn(videosService, "findById").mockResolvedValue({ id: 7, file_name: "someone_2026-10-08_01-02-03.mkv", duration_seconds: 600 } as any));
    const marked = spyOn(feedback, "markRecordingDiscarded").mockResolvedValue(); spies.push(marked);
    return { service, decided, marked };
  };

  it("records every undecided highlight as skipped when nothing was worth keeping", async () => {
    const { service, decided, marked } = deleting(unsaved);
    await service.discard(1, 7, "nothing");
    expect(decided[0]!.clips.map((c) => [c.id, c.keep, c.reasons])).toEqual([["c1", false, ["skip_tame"]], ["c2", false, ["skip_tame"]]]);
    expect(marked).toHaveBeenCalledWith(7, "nothing");
  });

  it("learns nothing about the content when the audio was out of sync or the file a fragment", async () => {
    for (const reason of ["desync", "fragment"] as const) {
      const { service, decided, marked } = deleting(unsaved);
      await service.discard(1, 7, reason);
      expect(decided).toEqual([]);
      expect(marked).toHaveBeenCalledWith(7, reason);
    }
  });

  it("leaves saved decisions as they are", async () => {
    const { service, decided } = deleting(saved);
    await service.discard(1, 7, "nothing");
    expect(decided).toEqual([]);
  });
});
