import { and, inArray, sql } from "drizzle-orm";
import {
  getDemoDatabase,
  withDemoTransaction,
} from "@/database/demo";
import {
  demoVideosTable,
  demoVideoStudiosTable,
} from "@/database/demo/schema";
import { ConflictError, NotFoundError } from "@/utils/errors";

function unique(ids: number[]): number[] {
  return [...new Set(ids)];
}

class StudioAssignmentDemoService {
  linkMany(videoIds: number[], studioIds: number[]): number {
    const videos = unique(videoIds);
    const studios = unique(studioIds);
    if (!videos.length || !studios.length) return 0;
    return withDemoTransaction(() => {
      this.assertVideosExist(videos);
      const before = this.countLinks(videos, studios);
      getDemoDatabase().update(demoVideosTable).set({ studioAbsenceConfirmedAt: null })
        .where(inArray(demoVideosTable.id, videos)).run();
      getDemoDatabase().insert(demoVideoStudiosTable).values(
        videos.flatMap((videoId) => studios.map((studioId) => ({ videoId, studioId }))),
      ).onConflictDoNothing().run();
      return this.countLinks(videos, studios) - before;
    });
  }

  unlinkMany(videoIds: number[], studioIds: number[]): number {
    const videos = unique(videoIds);
    const studios = unique(studioIds);
    if (!videos.length) return 0;
    return withDemoTransaction(() => {
      this.assertVideosExist(videos);
      const before = studios.length ? this.countLinks(videos, studios) : 0;
      if (studios.length) {
        getDemoDatabase().delete(demoVideoStudiosTable).where(and(
          inArray(demoVideoStudiosTable.videoId, videos),
          inArray(demoVideoStudiosTable.studioId, studios),
        )).run();
      }
      getDemoDatabase().update(demoVideosTable).set({ studioAbsenceConfirmedAt: null })
        .where(inArray(demoVideosTable.id, videos)).run();
      return before - (studios.length ? this.countLinks(videos, studios) : 0);
    });
  }

  replaceMany(videoIds: number[], studioIds: number[]): void {
    const videos = unique(videoIds); const studios = unique(studioIds);
    if (!videos.length) return;
    withDemoTransaction(() => {
      this.assertVideosExist(videos);
      getDemoDatabase().delete(demoVideoStudiosTable)
        .where(inArray(demoVideoStudiosTable.videoId, videos)).run();
      getDemoDatabase().update(demoVideosTable).set({ studioAbsenceConfirmedAt: null })
        .where(inArray(demoVideosTable.id, videos)).run();
      if (studios.length) getDemoDatabase().insert(demoVideoStudiosTable).values(
        videos.flatMap((videoId) => studios.map((studioId) => ({ videoId, studioId }))),
      ).onConflictDoNothing().run();
    });
  }

  confirmNone(videoIds: number[]): void {
    const videos = unique(videoIds);
    if (!videos.length) return;
    withDemoTransaction(() => {
      this.assertVideosExist(videos);
      const linked = getDemoDatabase().select({ id: demoVideoStudiosTable.videoId })
        .from(demoVideoStudiosTable).where(inArray(demoVideoStudiosTable.videoId, videos)).get();
      if (linked) throw new ConflictError("A studio is still assigned to one or more videos");
      getDemoDatabase().update(demoVideosTable)
        .set({ studioAbsenceConfirmedAt: new Date().toISOString() })
        .where(inArray(demoVideosTable.id, videos)).run();
    });
  }

  markUnknown(videoIds: number[]): void {
    const videos = unique(videoIds);
    if (!videos.length) return;
    withDemoTransaction(() => {
      this.assertVideosExist(videos);
      getDemoDatabase().update(demoVideosTable).set({ studioAbsenceConfirmedAt: null })
        .where(inArray(demoVideosTable.id, videos)).run();
    });
  }

  private countLinks(videoIds: number[], studioIds: number[]): number {
    const row = getDemoDatabase().select({ count: sql<number>`count(*)` })
      .from(demoVideoStudiosTable)
      .where(and(
        inArray(demoVideoStudiosTable.videoId, videoIds),
        inArray(demoVideoStudiosTable.studioId, studioIds),
      ))
      .get();
    return Number(row?.count ?? 0);
  }

  private assertVideosExist(videoIds: number[]): void {
    const rows = getDemoDatabase().select({ id: demoVideosTable.id })
      .from(demoVideosTable)
      .where(inArray(demoVideosTable.id, videoIds))
      .all();
    if (rows.length !== videoIds.length) {
      const found = new Set(rows.map((row) => row.id));
      const missing = videoIds.filter((id) => !found.has(id));
      throw new NotFoundError(`Video not found with id: ${missing[0]}`);
    }
  }
}

export const studioAssignmentDemoService = new StudioAssignmentDemoService();
