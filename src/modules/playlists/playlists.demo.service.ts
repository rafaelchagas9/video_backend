import { and, asc, desc, eq, max } from "drizzle-orm";
import {
  demoSchema,
  getDemoDatabase,
  withDemoTransaction,
} from "@/database/demo";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@/utils/errors";
import type {
  CreatePlaylistInput,
  Playlist,
  UpdatePlaylistInput,
} from "./playlists.types";
import { isVideoWatched } from "@/modules/video-stats/video-watch-state";

const {
  demoPlaylistsTable,
  demoPlaylistVideosTable,
  demoThumbnailsTable,
  demoVideoStatsTable,
  demoVideosTable,
} = demoSchema;

export class PlaylistsDemoService {
  create(userId: number, input: CreatePlaylistInput): Playlist {
    const timestamp = new Date().toISOString();
    const row = getDemoDatabase()
      .insert(demoPlaylistsTable)
      .values({
        userId,
        name: input.name,
        description: input.description ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
    return this.findById(row.id, userId);
  }

  findById(id: number, userId?: number): Playlist {
    const row = getDemoDatabase()
      .select()
      .from(demoPlaylistsTable)
      .where(eq(demoPlaylistsTable.id, id))
      .get();
    if (!row) throw new NotFoundError(`Playlist not found with id: ${id}`);
    const ownerId = userId ?? row.userId;
    const entries = getDemoDatabase()
      .select({
        videoId: demoPlaylistVideosTable.videoId,
        position: demoPlaylistVideosTable.position,
        durationSeconds: demoVideosTable.durationSeconds,
        playCount: demoVideoStatsTable.playCount,
        positionSeconds: demoVideoStatsTable.lastPositionSeconds,
        lastPlayedAt: demoVideoStatsTable.lastPlayedAt,
      })
      .from(demoPlaylistVideosTable)
      .innerJoin(
        demoVideosTable,
        eq(demoVideosTable.id, demoPlaylistVideosTable.videoId)
      )
      .leftJoin(
        demoVideoStatsTable,
        and(
          eq(demoVideoStatsTable.videoId, demoPlaylistVideosTable.videoId),
          eq(demoVideoStatsTable.userId, ownerId)
        )
      )
      .where(eq(demoPlaylistVideosTable.playlistId, id))
      .orderBy(asc(demoPlaylistVideosTable.position))
      .all();
    const first = getDemoDatabase()
      .select({ thumbnail: demoThumbnailsTable.videoId })
      .from(demoPlaylistVideosTable)
      .leftJoin(
        demoThumbnailsTable,
        eq(demoThumbnailsTable.videoId, demoPlaylistVideosTable.videoId)
      )
      .where(eq(demoPlaylistVideosTable.playlistId, id))
      .orderBy(asc(demoPlaylistVideosTable.position))
      .get();
    return {
      id: row.id,
      user_id: row.userId,
      name: row.name,
      description: row.description,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      video_count: entries.length,
      watched_count: entries.filter((entry) =>
        isVideoWatched({
          playCount: entry.playCount,
          positionSeconds: entry.positionSeconds,
          durationSeconds: entry.durationSeconds,
        })
      ).length,
      runtime_seconds: entries.reduce(
        (sum, entry) => sum + (entry.durationSeconds ?? 0),
        0
      ),
      last_played_at:
        entries
          .map((entry) => entry.lastPlayedAt)
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1) ?? null,
      resume: (() => {
        const entry = entries.find(
          (candidate) =>
            !isVideoWatched({
              playCount: candidate.playCount,
              positionSeconds: candidate.positionSeconds,
              durationSeconds: candidate.durationSeconds,
            })
        );
        return entry
          ? {
              video_id: entry.videoId,
              position_seconds: entry.positionSeconds ?? 0,
            }
          : null;
      })(),
      artwork_source_video_id: row.artworkSourceVideoId,
      thumbnail_url: first?.thumbnail
        ? `/api/thumbnails/${first.thumbnail}/image`
        : null,
    };
  }

  list(userId: number): Playlist[] {
    return getDemoDatabase()
      .select({ id: demoPlaylistsTable.id })
      .from(demoPlaylistsTable)
      .where(eq(demoPlaylistsTable.userId, userId))
      .orderBy(desc(demoPlaylistsTable.createdAt))
      .all()
      .map(({ id }) => this.findById(id, userId));
  }

  update(id: number, userId: number, input: UpdatePlaylistInput): Playlist {
    const existing = this.findOwned(id, userId);
    withDemoTransaction(() => {
      if (input.artwork_source_video_id !== undefined) {
        const member = getDemoDatabase()
          .select({ videoId: demoPlaylistVideosTable.videoId })
          .from(demoPlaylistVideosTable)
          .where(
            and(
              eq(demoPlaylistVideosTable.playlistId, id),
              eq(
                demoPlaylistVideosTable.videoId,
                input.artwork_source_video_id
              )
            )
          )
          .get();
        if (!member) {
          throw new BadRequestError(
            "Artwork source video must belong to this playlist"
          );
        }
      }
      getDemoDatabase()
        .update(demoPlaylistsTable)
        .set({
          name: input.name ?? existing.name,
          description:
            input.description !== undefined
              ? input.description
              : existing.description,
          artworkSourceVideoId:
            input.artwork_source_video_id ?? existing.artwork_source_video_id,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(demoPlaylistsTable.id, id))
        .run();
    });
    return this.findById(id, userId);
  }

  delete(id: number, userId: number): void {
    this.findOwned(id, userId);
    getDemoDatabase()
      .delete(demoPlaylistsTable)
      .where(eq(demoPlaylistsTable.id, id))
      .run();
  }

  addVideo(
    playlistId: number,
    userId: number,
    videoId: number,
    position?: number
  ): void {
    this.findOwned(playlistId, userId);
    this.assertVideo(videoId);
    const existing = getDemoDatabase()
      .select({ id: demoPlaylistVideosTable.videoId })
      .from(demoPlaylistVideosTable)
      .where(
        and(
          eq(demoPlaylistVideosTable.playlistId, playlistId),
          eq(demoPlaylistVideosTable.videoId, videoId)
        )
      )
      .get();
    if (existing)
      throw new ConflictError("Video already exists in this playlist");
    const finalPosition =
      position ??
      Number(
        getDemoDatabase()
          .select({ value: max(demoPlaylistVideosTable.position) })
          .from(demoPlaylistVideosTable)
          .where(eq(demoPlaylistVideosTable.playlistId, playlistId))
          .get()?.value ?? -1
      ) + 1;
    getDemoDatabase()
      .insert(demoPlaylistVideosTable)
      .values({
        playlistId,
        videoId,
        position: finalPosition,
        addedAt: new Date().toISOString(),
      })
      .run();
    if (this.findById(playlistId, userId).artwork_source_video_id === null) {
      getDemoDatabase()
        .update(demoPlaylistsTable)
        .set({ artworkSourceVideoId: videoId })
        .where(eq(demoPlaylistsTable.id, playlistId))
        .run();
    }
  }

  removeVideo(playlistId: number, userId: number, videoId: number): void {
    withDemoTransaction(() => {
      this.findOwned(playlistId, userId);
      getDemoDatabase()
        .delete(demoPlaylistVideosTable)
        .where(
          and(
            eq(demoPlaylistVideosTable.playlistId, playlistId),
            eq(demoPlaylistVideosTable.videoId, videoId)
          )
        )
        .run();
      const playlist = this.findById(playlistId, userId);
      if (playlist.artwork_source_video_id === videoId) {
        const replacement = getDemoDatabase()
          .select({ videoId: demoPlaylistVideosTable.videoId })
          .from(demoPlaylistVideosTable)
          .where(eq(demoPlaylistVideosTable.playlistId, playlistId))
          .orderBy(asc(demoPlaylistVideosTable.position))
          .get();
        getDemoDatabase()
          .update(demoPlaylistsTable)
          .set({ artworkSourceVideoId: replacement?.videoId ?? null })
          .where(eq(demoPlaylistsTable.id, playlistId))
          .run();
      }
    });
  }

  getVideos(
    playlistId: number,
    userId: number
  ): Array<Record<string, unknown>> {
    this.findOwned(playlistId, userId);
    return getDemoDatabase()
      .select({
        video: demoVideosTable,
        position: demoPlaylistVideosTable.position,
        addedAt: demoPlaylistVideosTable.addedAt,
        thumbnailId: demoThumbnailsTable.videoId,
        playCount: demoVideoStatsTable.playCount,
        positionSeconds: demoVideoStatsTable.lastPositionSeconds,
      })
      .from(demoPlaylistVideosTable)
      .innerJoin(
        demoVideosTable,
        eq(demoVideosTable.id, demoPlaylistVideosTable.videoId)
      )
      .leftJoin(
        demoThumbnailsTable,
        eq(demoThumbnailsTable.videoId, demoVideosTable.id)
      )
      .leftJoin(
        demoVideoStatsTable,
        and(
          eq(demoVideoStatsTable.videoId, demoVideosTable.id),
          eq(demoVideoStatsTable.userId, userId)
        )
      )
      .where(eq(demoPlaylistVideosTable.playlistId, playlistId))
      .orderBy(asc(demoPlaylistVideosTable.position))
      .all()
      .map(
        ({
          video,
          position,
          addedAt,
          thumbnailId,
          playCount,
          positionSeconds,
        }) => ({
        ...video,
        file_path: video.filePath,
        file_name: video.fileName,
        is_available: video.isAvailable,
        duration_seconds: video.durationSeconds,
        watched: isVideoWatched({
          playCount,
          positionSeconds,
          durationSeconds: video.durationSeconds,
        }),
        position_seconds: positionSeconds,
        position,
        added_to_playlist_at: addedAt,
        thumbnail_id: thumbnailId,
        thumbnail_url: thumbnailId
          ? `/api/thumbnails/${thumbnailId}/image`
          : null,
      })
      );
  }

  reorderVideos(
    playlistId: number,
    userId: number,
    positions: { video_id: number; position: number }[]
  ): void {
    this.findOwned(playlistId, userId);
    withDemoTransaction(() => {
      for (const item of positions) {
        getDemoDatabase()
          .update(demoPlaylistVideosTable)
          .set({ position: item.position })
          .where(
            and(
              eq(demoPlaylistVideosTable.playlistId, playlistId),
              eq(demoPlaylistVideosTable.videoId, item.video_id)
            )
          )
          .run();
      }
    });
  }

  bulkUpdateVideos(
    playlistId: number,
    userId: number,
    input: { videoIds: number[]; action: "add" | "remove" }
  ): void {
    this.findOwned(playlistId, userId);
    withDemoTransaction(() => {
      for (const videoId of input.videoIds) {
        if (input.action === "remove") {
          this.removeVideo(playlistId, userId, videoId);
          continue;
        }
        const exists = getDemoDatabase()
          .select({ id: demoPlaylistVideosTable.videoId })
          .from(demoPlaylistVideosTable)
          .where(
            and(
              eq(demoPlaylistVideosTable.playlistId, playlistId),
              eq(demoPlaylistVideosTable.videoId, videoId)
            )
          )
          .get();
        if (!exists) this.addVideo(playlistId, userId, videoId);
      }
    });
  }

  private findOwned(id: number, userId: number): Playlist {
    const playlist = this.findById(id, userId);
    if (playlist.user_id !== userId)
      throw new ForbiddenError(
        "You do not have permission to modify this playlist"
      );
    return playlist;
  }

  private assertVideo(id: number): void {
    if (
      !getDemoDatabase()
        .select({ id: demoVideosTable.id })
        .from(demoVideosTable)
        .where(eq(demoVideosTable.id, id))
        .get()
    )
      throw new NotFoundError(`Video not found with id: ${id}`);
  }
}

export const playlistsDemoService = new PlaylistsDemoService();
