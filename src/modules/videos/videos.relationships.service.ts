import { and, asc, inArray, sql } from "drizzle-orm";
import { db, type DrizzleTransaction } from "@/config/drizzle";
import { env } from "@/config/env";
import { videosTable, videoStudiosTable } from "@/database/schema";
import {
  getDemoSqlite,
  initializeDemoDatabase,
  withDemoTransaction,
} from "@/database/demo";
import { studioAssignmentService } from "@/modules/studios/studio-assignment.service";
import { studioAssignmentDemoService } from "@/modules/studios/studio-assignment.demo.service";
import { videosRelatedService } from "./videos.related.service";
import { ConflictError, NotFoundError } from "@/utils/errors";

export interface VideoRelationshipActions {
  addCreatorIds?: number[];
  removeCreatorIds?: number[];
  addTagIds?: number[];
  removeTagIds?: number[];
  addStudioIds?: number[];
  removeStudioIds?: number[];
  studioAssignmentStatus?: "confirmed_none" | "unknown";
}

export function emptyRelationshipCounts() {
  return {
    creators_added: 0,
    creators_removed: 0,
    tags_added: 0,
    tags_removed: 0,
    studios_added: 0,
    studios_removed: 0,
  };
}

const operations = [
  ["addCreatorIds", "video_creators", "creator_id", "creators_added", true],
  [
    "removeCreatorIds",
    "video_creators",
    "creator_id",
    "creators_removed",
    false,
  ],
  ["addTagIds", "video_tags", "tag_id", "tags_added", true],
  ["removeTagIds", "video_tags", "tag_id", "tags_removed", false],
] as const;

/** Atomic relationship batches with actual row counts and related-video invalidation. */
class VideoRelationshipsService {
  async apply(
    videoIds: number[],
    actions: VideoRelationshipActions,
    executor?: DrizzleTransaction
  ) {
    const ids = [...new Set(videoIds)].sort((a, b) => a - b);
    if (
      actions.studioAssignmentStatus &&
      (actions.addStudioIds?.length || actions.removeStudioIds?.length)
    )
      throw new ConflictError(
        "Studio assignment status cannot be combined with studio link changes"
      );
    if (env.DEMO_MODE) return this.applyDemo(ids, actions);
    const operation = async (tx: DrizzleTransaction) => {
      const details = emptyRelationshipCounts();
      const affected = new Set<number>();
      // Keep SQL parameter counts and intermediate cross products bounded while
      // retaining one transaction for the complete selection.
      for (let offset = 0; offset < ids.length; offset += 250) {
        const batch = ids.slice(offset, offset + 250);
        const videos = await tx
          .select({
            id: videosTable.id,
            absence: videosTable.studioAbsenceConfirmedAt,
          })
          .from(videosTable)
          .where(inArray(videosTable.id, batch))
          .orderBy(asc(videosTable.id))
          .for("update");
        if (videos.length !== batch.length)
          throw new NotFoundError("One or more videos were not found");
        for (const [key, tableName, columnName, countKey, add] of operations) {
          const targetIds = [...new Set(actions[key] ?? [])];
          for (let start = 0; start < targetIds.length; start += 100) {
            const targets = targetIds.slice(start, start + 100);
            const table = sql.identifier(tableName);
            const column = sql.identifier(columnName);
            const rows = add
              ? await tx.execute(
                  sql`INSERT INTO ${table} (video_id, ${column}) VALUES ${sql.join(
                    batch.flatMap((videoId) =>
                      targets.map((targetId) => sql`(${videoId}, ${targetId})`)
                    ),
                    sql`, `
                  )} ON CONFLICT DO NOTHING RETURNING video_id`
                )
              : await tx.execute(
                  sql`DELETE FROM ${table} WHERE video_id IN (${sql.join(
                    batch.map((id) => sql`${id}`),
                    sql`, `
                  )}) AND ${column} IN (${sql.join(
                    targets.map((id) => sql`${id}`),
                    sql`, `
                  )}) RETURNING video_id`
                );
            details[countKey] += rows.length;
            for (const row of rows) affected.add(Number(row.video_id));
          }
        }
        for (const [key, countKey, add] of [
          ["addStudioIds", "studios_added", true],
          ["removeStudioIds", "studios_removed", false],
        ] as const) {
          const targets = [...new Set(actions[key] ?? [])];
          if (!targets.length) continue;
          for (let start = 0; start < targets.length; start += 100) {
            const studioBatch = targets.slice(start, start + 100);
            const links = await tx
              .select()
              .from(videoStudiosTable)
              .where(
                and(
                  inArray(videoStudiosTable.videoId, batch),
                  inArray(videoStudiosTable.studioId, studioBatch)
                )
              );
            const existing = new Set(
              links.map((link) => `${link.videoId}:${link.studioId}`)
            );
            for (const video of videos)
              if (
                video.absence ||
                studioBatch.some(
                  (target) => add !== existing.has(`${video.id}:${target}`)
                )
              )
                affected.add(video.id);
            details[countKey] += add
              ? await studioAssignmentService.linkMany(batch, studioBatch, tx)
              : await studioAssignmentService.unlinkMany(
                  batch,
                  studioBatch,
                  tx
                );
          }
        }
        if (actions.studioAssignmentStatus) {
          for (const video of videos)
            if (
              actions.studioAssignmentStatus === "confirmed_none"
                ? !video.absence
                : !!video.absence
            )
              affected.add(video.id);
          if (actions.studioAssignmentStatus === "confirmed_none")
            await studioAssignmentService.confirmNone(batch, tx);
          else await studioAssignmentService.markUnknown(batch, tx);
        }
        const changed = batch.filter((id) => affected.has(id));
        if (changed.length)
          await videosRelatedService.invalidateForVideos(changed, tx);
      }
      return { processed: ids.length, affected: affected.size, details };
    };
    return executor ? operation(executor) : db.transaction(operation);
  }

  applyDemo(videoIds: number[], actions: VideoRelationshipActions) {
    if (
      actions.studioAssignmentStatus &&
      (actions.addStudioIds?.length || actions.removeStudioIds?.length)
    )
      throw new ConflictError(
        "Studio assignment status cannot be combined with studio link changes"
      );
    initializeDemoDatabase();
    const ids = [...new Set(videoIds)];
    return withDemoTransaction(() => {
      const sqlite = getDemoSqlite();
      const details = emptyRelationshipCounts();
      const affected = new Set<number>();
      for (const videoId of ids) {
        const video = sqlite
          .query<
            { studio_absence_confirmed_at: string | null },
            [number]
          >("SELECT studio_absence_confirmed_at FROM demo_videos WHERE id = ?")
          .get(videoId);
        if (!video)
          throw new NotFoundError("One or more videos were not found");
        for (const [key, table, column, countKey, add] of operations) {
          const query = sqlite.query(
            add
              ? `INSERT INTO demo_${table} (video_id, ${column}) VALUES (?, ?) ON CONFLICT DO NOTHING`
              : `DELETE FROM demo_${table} WHERE video_id = ? AND ${column} = ?`
          );
          for (const targetId of new Set(actions[key] ?? [])) {
            const { changes } = query.run(videoId, targetId);
            details[countKey] += changes;
            if (changes) affected.add(videoId);
          }
        }
        for (const [key, countKey, add] of [
          ["addStudioIds", "studios_added", true],
          ["removeStudioIds", "studios_removed", false],
        ] as const) {
          const targets = [...new Set(actions[key] ?? [])];
          if (!targets.length) continue;
          const changes = add
            ? studioAssignmentDemoService.linkMany([videoId], targets)
            : studioAssignmentDemoService.unlinkMany([videoId], targets);
          details[countKey] += changes;
          if (changes || video.studio_absence_confirmed_at)
            affected.add(videoId);
        }
        if (actions.studioAssignmentStatus) {
          if (
            actions.studioAssignmentStatus === "confirmed_none"
              ? !video.studio_absence_confirmed_at
              : !!video.studio_absence_confirmed_at
          )
            affected.add(videoId);
          if (actions.studioAssignmentStatus === "confirmed_none")
            studioAssignmentDemoService.confirmNone([videoId]);
          else studioAssignmentDemoService.markUnknown([videoId]);
        }
      }
      return { processed: ids.length, affected: affected.size, details };
    });
  }
}

export const videoRelationshipsService = new VideoRelationshipsService();
