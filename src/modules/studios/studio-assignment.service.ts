import { and, asc, inArray } from "drizzle-orm";
import { db, type DrizzleTransaction } from "@/config/drizzle";
import { env } from "@/config/env";
import { videosTable, videoStudiosTable } from "@/database/schema";
import { ConflictError, NotFoundError } from "@/utils/errors";
import { videosRelatedService } from "@/modules/videos/videos.related.service";
import { studioAssignmentDemoService } from "./studio-assignment.demo.service";

export type StudioAssignmentExecutor = DrizzleTransaction;

function unique(ids: number[]): number[] {
  return [...new Set(ids)];
}

/** All runtime video/studio relationship mutations must go through this service. */
class StudioAssignmentService {
  async linkMany(videoIds: number[], studioIds: number[], executor?: StudioAssignmentExecutor): Promise<number> {
    if (env.DEMO_MODE) return studioAssignmentDemoService.linkMany(videoIds, studioIds);
    const videos = unique(videoIds); const studios = unique(studioIds);
    if (!videos.length || !studios.length) return 0;
    return this.run(executor, async (tx) => {
      await this.lockVideos(tx, videos);
      await tx.update(videosTable).set({ studioAbsenceConfirmedAt: null }).where(inArray(videosTable.id, videos));
      const inserted = await tx.insert(videoStudiosTable).values(videos.flatMap((videoId) => studios.map((studioId) => ({ videoId, studioId })))).onConflictDoNothing().returning({ videoId: videoStudiosTable.videoId });
      await videosRelatedService.invalidateForVideos(videos, tx);
      return inserted.length;
    });
  }

  async unlinkMany(videoIds: number[], studioIds: number[], executor?: StudioAssignmentExecutor): Promise<number> {
    if (env.DEMO_MODE) return studioAssignmentDemoService.unlinkMany(videoIds, studioIds);
    const videos = unique(videoIds); const studios = unique(studioIds);
    if (!videos.length) return 0;
    return this.run(executor, async (tx) => {
      await this.lockVideos(tx, videos);
      const removed = studios.length ? await tx.delete(videoStudiosTable).where(and(inArray(videoStudiosTable.videoId, videos), inArray(videoStudiosTable.studioId, studios))).returning({ videoId: videoStudiosTable.videoId }) : [];
      await tx.update(videosTable).set({ studioAbsenceConfirmedAt: null }).where(inArray(videosTable.id, videos));
      await videosRelatedService.invalidateForVideos(videos, tx);
      return removed.length;
    });
  }

  async confirmNone(videoIds: number[], executor?: StudioAssignmentExecutor): Promise<void> {
    if (env.DEMO_MODE) return studioAssignmentDemoService.confirmNone(videoIds);
    const videos = unique(videoIds); if (!videos.length) return;
    await this.run(executor, async (tx) => {
      await this.lockVideos(tx, videos);
      const linked = await tx.select({ id: videoStudiosTable.videoId }).from(videoStudiosTable).where(inArray(videoStudiosTable.videoId, videos)).limit(1);
      if (linked.length) throw new ConflictError("A studio is still assigned to one or more videos");
      await tx.update(videosTable).set({ studioAbsenceConfirmedAt: new Date() }).where(inArray(videosTable.id, videos));
      await videosRelatedService.invalidateForVideos(videos, tx);
    });
  }

  async markUnknown(videoIds: number[], executor?: StudioAssignmentExecutor): Promise<void> {
    if (env.DEMO_MODE) return studioAssignmentDemoService.markUnknown(videoIds);
    const videos = unique(videoIds); if (!videos.length) return;
    await this.run(executor, async (tx) => {
      await this.lockVideos(tx, videos);
      await tx.update(videosTable).set({ studioAbsenceConfirmedAt: null }).where(inArray(videosTable.id, videos));
      await videosRelatedService.invalidateForVideos(videos, tx);
    });
  }

  private async run<T>(executor: StudioAssignmentExecutor | undefined, operation: (tx: StudioAssignmentExecutor) => Promise<T>): Promise<T> {
    if (executor) return operation(executor);
    return db.transaction(operation);
  }

  private async lockVideos(tx: StudioAssignmentExecutor, videoIds: number[]): Promise<void> {
    const rows = await tx.select({ id: videosTable.id })
      .from(videosTable)
      .where(inArray(videosTable.id, videoIds))
      .orderBy(asc(videosTable.id))
      .for("update");
    if (rows.length !== videoIds.length) {
      const found = new Set(rows.map((row) => row.id));
      const missing = videoIds.filter((id) => !found.has(id));
      throw new NotFoundError(`Video not found with id: ${missing[0]}`);
    }
  }
}

export const studioAssignmentService = new StudioAssignmentService();
