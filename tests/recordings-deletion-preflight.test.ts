import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
let reviews: unknown[] = [], filePath = "", catalogDeletes = 0;
let guardedRows = 1; const guardedEvents: string[] = [];
const database = {
  select: (selection: Record<string, unknown>) => ({ from: () => selection.review ? { innerJoin: () => ({ where: async () => reviews }) } : { where: async () => [{ filePath }] } }),
  delete: () => ({ where: async () => { catalogDeletes++; } }),
  transaction: async (fn: (tx: any) => Promise<void>) => {
    const before = catalogDeletes;
    try { await fn({
      execute: async () => { guardedEvents.push("lock"); },
      delete: () => ({ where: () => ({ returning: async () => {
        guardedEvents.push("guarded-delete"); catalogDeletes += guardedRows;
        return Array.from({ length: guardedRows }, (_, index) => ({ id: index + 1 }));
      } }) }),
    }); } catch (error) { catalogDeletes = before; throw error; }
  },
};
mock.module("@/config/drizzle", () => ({ db: database }));
const { VideosBulkService } = await import("@/modules/videos/videos.bulk.service");
const snapshots = await import("@/modules/recordings/recordings.snapshots.store");
const { preserveRecordingReviewsBeforeDeletion } = await import("@/modules/recordings/recordings.deletion-preflight");
const roots: string[] = [], spies: ReturnType<typeof spyOn>[] = [];
afterEach(async () => { for (const spy of spies.splice(0)) spy.mockRestore(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); reviews = []; catalogDeletes = 0; guardedRows = 1; guardedEvents.length = 0; });
async function source() { const root = await mkdtemp(join(tmpdir(), "recording-delete-guard-")); roots.push(root); filePath = join(root, "synthetic.fixture"); await writeFile(filePath, "disposable fixture"); return filePath; }
function service() { const service = new VideosBulkService(); Object.assign(service, { assertNoActiveEditJobs: async () => undefined, getVideoArtifactPaths: async () => [] }); return service; }
it("archive failure retains the source and catalog before generic bulk deletion", async () => {
  const path = await source(); reviews = [{ review: { videoId: 1, savedAt: new Date(), status: "proposed", clips: [] }, source: { id: 1 } }];
  const preserve = spyOn(snapshots, "preserveRecordingTrainingSnapshot").mockRejectedValue(new Error("synthetic archive failure")); spies.push(preserve);
  await expect(service().bulkDelete([1])).rejects.toThrow("synthetic archive failure");
  expect(catalogDeletes).toBe(0); expect((await stat(path)).isFile()).toBe(true); expect(preserve.mock.calls[0]?.[2]).toBe("before-delete");
});
it("ordinary non-recording deletion needs no training snapshot and keeps normal cleanup", async () => {
  const path = await source(); const preserve = spyOn(snapshots, "preserveRecordingTrainingSnapshot").mockResolvedValue(); spies.push(preserve);
  await service().bulkDelete([1]); expect(preserve).not.toHaveBeenCalled(); expect(catalogDeletes).toBe(1); expect(await stat(path).catch(() => null)).toBeNull();
});
it("every matching review is preserved before the batch can proceed", async () => {
  reviews = [{ review: { videoId: 1, savedAt: new Date(), status: "proposed", clips: [] }, source: { id: 1 } }, { review: { videoId: 2, savedAt: new Date(), status: "proposed", clips: [] }, source: { id: 2 } }];
  const preserve = spyOn(snapshots, "preserveRecordingTrainingSnapshot").mockResolvedValue(); spies.push(preserve);
  await preserveRecordingReviewsBeforeDeletion([1, 2, 3]); expect(preserve).toHaveBeenCalledTimes(2); expect(catalogDeletes).toBe(0);
});

it("unreviewed missing-index analysis does not block normal deletion", async () => {
  const path = await source(); reviews = [{ review: { videoId: 1, savedAt: null, analyzedAt: new Date(), status: "dismissed", clips: [] }, source: { id: 1 } }];
  const exists = spyOn(snapshots, "hasRecordingTrainingSnapshot").mockResolvedValue(false); spies.push(exists);
  const preserve = spyOn(snapshots, "preserveRecordingTrainingSnapshot").mockRejectedValue(new Error("missing index")); spies.push(preserve);
  await service().bulkDelete([1]); expect(preserve).not.toHaveBeenCalled(); expect(catalogDeletes).toBe(1); expect(await stat(path).catch(() => null)).toBeNull();
});
it("legacy archive-backed decisions remain protected without savedAt", async () => {
  reviews = [{ review: { videoId: 1, savedAt: null, analyzedAt: new Date(), status: "proposed", clips: [] }, source: { id: 1 } }];
  const exists = spyOn(snapshots, "hasRecordingTrainingSnapshot").mockResolvedValue(true); spies.push(exists);
  const preserve = spyOn(snapshots, "preserveRecordingTrainingSnapshot").mockRejectedValue(new Error("corrupt archive")); spies.push(preserve);
  await expect(preserveRecordingReviewsBeforeDeletion([1])).rejects.toThrow("corrupt archive"); expect(catalogDeletes).toBe(0);
});
it("rendered lineage remains protected without savedAt", async () => {
  reviews = [{ review: { videoId: 1, savedAt: null, analyzedAt: new Date(), status: "proposed", clips: [{ output_video_id: 9 }] }, source: { id: 1 } }];
  const preserve = spyOn(snapshots, "preserveRecordingTrainingSnapshot").mockResolvedValue(); spies.push(preserve);
  await preserveRecordingReviewsBeforeDeletion([1]); expect(preserve).toHaveBeenCalledTimes(1);
});

it("recorder removal runs after the catalog FK guard while the source still exists", async () => {
  const path = await source(); let invoked = false;
  await service().bulkDelete([1], { removeSource: async () => {
    expect(catalogDeletes).toBe(1);
    expect((await stat(path)).isFile()).toBe(true);
    invoked = true;
  } });
  expect(invoked).toBe(true);
  expect(await stat(path).catch(() => null)).toBeNull();
});
it("a rejected catalog deletion never invokes recorder removal", async () => {
  const path = await source(); let invoked = false;
  const refusal = spyOn(database, "delete").mockImplementation(() => ({ where: async () => { throw new Error("synthetic active-source FK"); } })); spies.push(refusal);
  await expect(service().bulkDelete([1], { removeSource: async () => { invoked = true; } })).rejects.toThrow("active-source FK");
  expect(invoked).toBe(false);
  expect((await stat(path)).isFile()).toBe(true);
});
it("a recorder cleanup failure preserves its physical source for a durable retry", async () => {
  const path = await source();
  await expect(service().bulkDelete([1], { removeSource: async () => { throw new Error("synthetic recorder unavailable"); } })).rejects.toThrow("recorder unavailable");
  expect(catalogDeletes).toBe(1);
  expect((await stat(path)).isFile()).toBe(true);
});

it("an archival guard locks the source and review before checking the exact generation", async () => {
  await source(); const { sql } = await import("drizzle-orm");
  await service().bulkDelete([1], { catalogGuard: sql`true`, removeSource: async () => { guardedEvents.push("source-removal"); } });
  expect(guardedEvents).toEqual(["lock", "lock", "guarded-delete", "source-removal"]);
});
it("a newly saved review rolls back guarded deletion and retains its original", async () => {
  const path = await source(); const { sql } = await import("drizzle-orm"); let invoked = false; guardedRows = 0;
  await expect(service().bulkDelete([1], { catalogGuard: sql`false`, removeSource: async () => { invoked = true; } })).rejects.toThrow("changed during archival");
  expect(catalogDeletes).toBe(0); expect(invoked).toBe(false); expect((await stat(path)).isFile()).toBe(true);
});
