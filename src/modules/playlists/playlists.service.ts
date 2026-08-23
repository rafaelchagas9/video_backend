import { db } from "@/config/drizzle";
import { eq, and, sql, inArray } from "drizzle-orm";
import {
  playlistsTable,
  playlistVideosTable,
  videoStatsTable,
  videosTable,
} from "@/database/schema";
import {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} from "@/utils/errors";
import { API_PREFIX } from "@/config/constants";
import type {
  Playlist,
  CreatePlaylistInput,
  UpdatePlaylistInput,
} from "./playlists.types";
import { videosService } from "@/modules/videos/videos.service";
import { env } from "@/config/env";
import { playlistsDemoService } from "./playlists.demo.service";
import { isVideoWatched } from "@/modules/video-stats/video-watch-state";

type PlaylistInclude = "artwork";

type PlaylistSummaryRow = {
  id: number;
  user_id: number;
  name: string;
  description: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  video_count: number;
  watched_count: number;
  runtime_seconds: number;
  last_played_at: string | Date | null;
  thumbnail_id: number | null;
  artwork_source_video_id: number | null;
};

export class PlaylistsService {
  async create(userId: number, input: CreatePlaylistInput): Promise<Playlist> {
    if (env.DEMO_MODE) {
      return playlistsDemoService.create(userId, input);
    }

    const result = await db
      .insert(playlistsTable)
      .values({
        userId,
        name: input.name,
        description: input.description || null,
      })
      .returning({ id: playlistsTable.id });

    if (!result || result.length === 0) {
      throw new Error("Failed to create playlist");
    }

    return this.findById(result[0].id, userId);
  }

  async findById(
    id: number,
    userId = 0,
    include: PlaylistInclude[] = [],
  ): Promise<Playlist> {
    if (env.DEMO_MODE) {
      return (
        await this.attachArtwork(
          [playlistsDemoService.findById(id, userId)],
          include,
        )
      )[0]!;
    }

    const rows = await this.querySummaries(userId, id);
    if (!rows[0]) {
      throw new NotFoundError(`Playlist not found with id: ${id}`);
    }
    return (
      await this.attachArtwork(await this.mapSummaries(rows, userId), include)
    )[0]!;
  }

  async list(
    userId: number,
    include: PlaylistInclude[] = [],
  ): Promise<Playlist[]> {
    if (env.DEMO_MODE) {
      return this.attachArtwork(playlistsDemoService.list(userId), include);
    }

    return this.attachArtwork(
      await this.mapSummaries(await this.querySummaries(userId), userId),
      include,
    );
  }

  private async querySummaries(
    userId: number,
    id?: number,
  ): Promise<PlaylistSummaryRow[]> {
    return db.execute<PlaylistSummaryRow>(sql`
      SELECT
        p.id,
        p.user_id,
        p.name,
        p.description,
        p.created_at,
        p.updated_at,
        COUNT(pv.video_id)::int AS video_count,
        COUNT(pv.video_id) FILTER (
          WHERE vs.play_count > 0
            AND (
              vs.last_position_seconds = 0
              OR (
                v.duration_seconds > 0
                AND vs.last_position_seconds / v.duration_seconds >= 0.95
              )
            )
        )::int AS watched_count,
        COALESCE(SUM(v.duration_seconds), 0)::double precision AS runtime_seconds,
        MAX(vs.last_played_at) AS last_played_at,
        (
          SELECT t.id
          FROM playlist_videos pv_thumb
          JOIN videos v_thumb ON pv_thumb.video_id = v_thumb.id
          LEFT JOIN thumbnails t ON v_thumb.id = t.video_id
          WHERE pv_thumb.playlist_id = p.id
          ORDER BY pv_thumb.position ASC
          LIMIT 1
        ) AS thumbnail_id,
        p.artwork_source_video_id
      FROM playlists p
      LEFT JOIN playlist_videos pv ON pv.playlist_id = p.id
      LEFT JOIN videos v ON v.id = pv.video_id
      LEFT JOIN video_stats vs
        ON vs.video_id = pv.video_id AND vs.user_id = ${userId}
      WHERE p.user_id = ${userId}
        ${id === undefined ? sql`` : sql`AND p.id = ${id}`}
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `);
  }

  private async mapSummaries(
    rows: PlaylistSummaryRow[],
    userId: number,
  ): Promise<Playlist[]> {
    const resumes = await this.getResumeByPlaylistIds(
      rows.map((row) => row.id),
      userId,
    );
    return rows.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      name: row.name,
      description: row.description,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      thumbnail_url: row.thumbnail_id
        ? `${API_PREFIX}/thumbnails/${row.thumbnail_id}/image`
        : null,
      video_count: Number(row.video_count),
      watched_count: Number(row.watched_count),
      runtime_seconds: Number(row.runtime_seconds),
      last_played_at: row.last_played_at
        ? new Date(row.last_played_at).toISOString()
        : null,
      resume: resumes.get(row.id) ?? null,
      artwork_source_video_id: row.artwork_source_video_id,
    }));
  }

  async update(
    id: number,
    userId: number,
    input: UpdatePlaylistInput
  ): Promise<Playlist> {
    if (env.DEMO_MODE) {
      return playlistsDemoService.update(id, userId, input);
    }

    const playlist = await this.findById(id, userId);

    // Verify ownership
    if (playlist.user_id !== userId) {
      throw new ForbiddenError(
        "You do not have permission to update this playlist"
      );
    }

    const updates: any = {};

    if (input.name !== undefined) {
      updates.name = input.name;
    }

    if (input.description !== undefined) {
      updates.description = input.description;
    }

    if (input.artwork_source_video_id !== undefined) {
      updates.artworkSourceVideoId = input.artwork_source_video_id;
    }

    if (Object.keys(updates).length === 0) {
      return playlist;
    }

    updates.updatedAt = new Date();

    await db.transaction(async (tx) => {
      // Serialize cover selection with membership removal. A plain membership
      // read does not protect against a concurrent delete under READ COMMITTED.
      const [lockedPlaylist] = await tx
        .select({ id: playlistsTable.id })
        .from(playlistsTable)
        .where(
          and(
            eq(playlistsTable.id, id),
            eq(playlistsTable.userId, userId),
          ),
        )
        .limit(1)
        .for("update");
      if (!lockedPlaylist) {
        throw new NotFoundError(`Playlist not found with id: ${id}`);
      }

      if (input.artwork_source_video_id !== undefined) {
        const member = await tx
          .select({ videoId: playlistVideosTable.videoId })
          .from(playlistVideosTable)
          .where(
            and(
              eq(playlistVideosTable.playlistId, id),
              eq(
                playlistVideosTable.videoId,
                input.artwork_source_video_id,
              ),
            ),
          )
          .limit(1);

        if (!member[0]) {
          throw new BadRequestError(
            "Artwork source video must belong to this playlist",
          );
        }
      }

      await tx
        .update(playlistsTable)
        .set(updates)
        .where(eq(playlistsTable.id, id));
    });

    return this.findById(id, userId);
  }

  async delete(id: number, userId: number): Promise<void> {
    if (env.DEMO_MODE) {
      playlistsDemoService.delete(id, userId);
      return;
    }

    const playlist = await this.findById(id, userId);

    // Verify ownership
    if (playlist.user_id !== userId) {
      throw new ForbiddenError(
        "You do not have permission to delete this playlist"
      );
    }

    await db.delete(playlistsTable).where(eq(playlistsTable.id, id));
  }

  async addVideo(
    playlistId: number,
    userId: number,
    videoId: number,
    position?: number
  ): Promise<void> {
    if (env.DEMO_MODE) {
      playlistsDemoService.addVideo(playlistId, userId, videoId, position);
      return;
    }

    const playlist = await this.findById(playlistId, userId);

    // Verify ownership
    if (playlist.user_id !== userId) {
      throw new ForbiddenError(
        "You do not have permission to modify this playlist"
      );
    }

    // Verify video exists
    await videosService.findById(videoId);

    // Check if video already in playlist
    const existing = await db
      .select()
      .from(playlistVideosTable)
      .where(
        and(
          eq(playlistVideosTable.playlistId, playlistId),
          eq(playlistVideosTable.videoId, videoId)
        )
      )
      .limit(1);

    if (existing && existing.length > 0) {
      throw new ConflictError("Video already exists in this playlist");
    }

    // If no position provided, add to end
    let finalPosition = position;
    if (finalPosition === undefined) {
      const maxPosResult = await db
        .select({
          maxPos: sql<number | null>`MAX(${playlistVideosTable.position})`,
        })
        .from(playlistVideosTable)
        .where(eq(playlistVideosTable.playlistId, playlistId));

      finalPosition = (maxPosResult[0]?.maxPos ?? -1) + 1;
    }

    await db.insert(playlistVideosTable).values({
      playlistId,
      videoId,
      position: finalPosition,
    });

    await db
      .update(playlistsTable)
      .set({
        artworkSourceVideoId: sql`COALESCE(${playlistsTable.artworkSourceVideoId}, ${videoId})`,
        updatedAt: new Date(),
      })
      .where(eq(playlistsTable.id, playlistId));
  }

  async removeVideo(
    playlistId: number,
    userId: number,
    videoId: number
  ): Promise<void> {
    if (env.DEMO_MODE) {
      playlistsDemoService.removeVideo(playlistId, userId, videoId);
      return;
    }

    const playlist = await this.findById(playlistId, userId);

    // Verify ownership
    if (playlist.user_id !== userId) {
      throw new ForbiddenError(
        "You do not have permission to modify this playlist"
      );
    }

    await db.transaction(async (tx) => {
      const [lockedPlaylist] = await tx
        .select({ artworkSourceVideoId: playlistsTable.artworkSourceVideoId })
        .from(playlistsTable)
        .where(
          and(
            eq(playlistsTable.id, playlistId),
            eq(playlistsTable.userId, userId),
          ),
        )
        .limit(1)
        .for("update");
      if (!lockedPlaylist) {
        throw new NotFoundError(`Playlist not found with id: ${playlistId}`);
      }

      await tx
        .delete(playlistVideosTable)
        .where(
          and(
            eq(playlistVideosTable.playlistId, playlistId),
            eq(playlistVideosTable.videoId, videoId),
          ),
        );

      if (lockedPlaylist.artworkSourceVideoId === videoId) {
        const [replacement] = await tx
          .select({ videoId: playlistVideosTable.videoId })
          .from(playlistVideosTable)
          .where(eq(playlistVideosTable.playlistId, playlistId))
          .orderBy(playlistVideosTable.position)
          .limit(1);
        await tx
          .update(playlistsTable)
          .set({
            artworkSourceVideoId: replacement?.videoId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(playlistsTable.id, playlistId));
      }
    });

    // Drizzle doesn't return rowCount, so we'll just proceed
    // The delete will succeed even if no rows match
  }

  async getVideos(playlistId: number, userId: number) {
    if (env.DEMO_MODE) {
      return playlistsDemoService.getVideos(playlistId, userId);
    }

    const playlist = await this.findById(playlistId, userId);

    // Verify ownership
    if (playlist.user_id !== userId) {
      throw new ForbiddenError(
        "You do not have permission to view this playlist"
      );
    }

    const query = sql`
      SELECT
        v.*,
        pv.position,
        pv.added_at as added_to_playlist_at,
        t.id as thumbnail_id,
        vs.play_count,
        vs.last_position_seconds
      FROM videos v
      INNER JOIN playlist_videos pv ON v.id = pv.video_id
      LEFT JOIN (
        SELECT DISTINCT ON (video_id) id, video_id FROM thumbnails
      ) t ON v.id = t.video_id
      LEFT JOIN video_stats vs
        ON vs.video_id = v.id AND vs.user_id = ${userId}
      WHERE pv.playlist_id = ${playlistId}
      ORDER BY pv.position ASC
    `;

    const result = await db.execute(query);
    const videos = result as any[];

    // Add thumbnail_url to each video
    return videos.map((video) => ({
      ...video,
      duration_seconds:
        video.duration_seconds === null ? null : Number(video.duration_seconds),
      watched: isVideoWatched({
        playCount: video.play_count === null ? null : Number(video.play_count),
        positionSeconds:
          video.last_position_seconds === null
            ? null
            : Number(video.last_position_seconds),
        durationSeconds:
          video.duration_seconds === null
            ? null
            : Number(video.duration_seconds),
      }),
      position_seconds:
        video.last_position_seconds === null
          ? null
          : Number(video.last_position_seconds),
      thumbnail_url: video.thumbnail_id
        ? `${API_PREFIX}/thumbnails/${video.thumbnail_id}/image`
        : null,
    }));
  }

  async reorderVideos(
    playlistId: number,
    userId: number,
    positions: { video_id: number; position: number }[]
  ): Promise<void> {
    if (env.DEMO_MODE) {
      playlistsDemoService.reorderVideos(playlistId, userId, positions);
      return;
    }

    const playlist = await this.findById(playlistId, userId);

    // Verify ownership
    if (playlist.user_id !== userId) {
      throw new ForbiddenError(
        "You do not have permission to modify this playlist"
      );
    }

    if (positions.length === 0) return;

    const videoIds = positions.map((p) => p.video_id);

    // Construct the SQL CASE expression
    const cases = positions
      .map((p) => sql`WHEN video_id = ${p.video_id} THEN ${p.position}`)
      .reduce((acc, curr) => sql`${acc} ${curr}`);

    const query = sql`
      UPDATE playlist_videos
      SET position = (CASE ${cases} END)::integer
      WHERE playlist_id = ${playlistId}
        AND video_id IN (${sql.join(
          videoIds.map((videoId) => sql`${videoId}`),
          sql`, `,
        )})
    `;

    await db.execute(query);
  }

  // Bulk Actions
  async bulkUpdateVideos(
    playlistId: number,
    userId: number,
    input: { videoIds: number[]; action: "add" | "remove" }
  ): Promise<void> {
    if (env.DEMO_MODE) {
      playlistsDemoService.bulkUpdateVideos(playlistId, userId, input);
      return;
    }

    const { videoIds, action } = input;
    if (videoIds.length === 0) return;

    const playlist = await this.findById(playlistId, userId);
    if (playlist.user_id !== userId) {
      throw new ForbiddenError(
        "You do not have permission to modify this playlist"
      );
    }

    if (action === "add") {
      const maxPosResult = await db
        .select({
          maxPos: sql<number | null>`MAX(${playlistVideosTable.position})`,
        })
        .from(playlistVideosTable)
        .where(eq(playlistVideosTable.playlistId, playlistId));

      let nextPos = (maxPosResult[0]?.maxPos ?? -1) + 1;

      // Check which video IDs are already in the playlist
      const existingRows = await db
        .select({ videoId: playlistVideosTable.videoId })
        .from(playlistVideosTable)
        .where(
          and(
            eq(playlistVideosTable.playlistId, playlistId),
            inArray(playlistVideosTable.videoId, videoIds)
          )
        );

      const existingIds = new Set(existingRows.map((r) => r.videoId));
      const toAdd = videoIds.filter((id) => !existingIds.has(id));

      if (toAdd.length > 0) {
        const values = toAdd.map((videoId) => ({
          playlistId,
          videoId,
          position: nextPos++,
        }));

        await db
          .insert(playlistVideosTable)
          .values(values)
          .onConflictDoNothing();

        await db
          .update(playlistsTable)
          .set({
            artworkSourceVideoId: sql`COALESCE(${playlistsTable.artworkSourceVideoId}, ${toAdd[0]})`,
            updatedAt: new Date(),
          })
          .where(eq(playlistsTable.id, playlistId));
      }
    } else {
      await db.transaction(async (tx) => {
        const [lockedPlaylist] = await tx
          .select({ artworkSourceVideoId: playlistsTable.artworkSourceVideoId })
          .from(playlistsTable)
          .where(
            and(
              eq(playlistsTable.id, playlistId),
              eq(playlistsTable.userId, userId),
            ),
          )
          .limit(1)
          .for("update");
        if (!lockedPlaylist) {
          throw new NotFoundError(`Playlist not found with id: ${playlistId}`);
        }

        await tx
          .delete(playlistVideosTable)
          .where(
            and(
              eq(playlistVideosTable.playlistId, playlistId),
              inArray(playlistVideosTable.videoId, videoIds),
            ),
          );

        if (
          lockedPlaylist.artworkSourceVideoId !== null &&
          videoIds.includes(lockedPlaylist.artworkSourceVideoId)
        ) {
          const [replacement] = await tx
            .select({ videoId: playlistVideosTable.videoId })
            .from(playlistVideosTable)
            .where(eq(playlistVideosTable.playlistId, playlistId))
            .orderBy(playlistVideosTable.position)
            .limit(1);
          await tx
            .update(playlistsTable)
            .set({
              artworkSourceVideoId: replacement?.videoId ?? null,
              updatedAt: new Date(),
            })
            .where(eq(playlistsTable.id, playlistId));
        }
      });
    }
  }

  private async getResumeByPlaylistIds(
    playlistIds: number[],
    userId: number,
  ): Promise<Map<number, NonNullable<Playlist["resume"]>>> {
    if (playlistIds.length === 0) return new Map();

    const rows = await db.execute<{
      playlist_id: number;
      video_id: number;
      position_seconds: number;
    }>(sql`
      SELECT DISTINCT ON (pv.playlist_id)
        pv.playlist_id,
        pv.video_id,
        COALESCE(vs.last_position_seconds, 0)::double precision AS position_seconds
      FROM ${playlistVideosTable} pv
      INNER JOIN ${videosTable} v ON v.id = pv.video_id
      LEFT JOIN ${videoStatsTable} vs
        ON vs.video_id = pv.video_id AND vs.user_id = ${userId}
      WHERE pv.playlist_id IN (
        ${sql.join(playlistIds.map((playlistId) => sql`${playlistId}`), sql`, `)}
      )
        AND NOT (
          COALESCE(vs.play_count, 0) > 0
          AND (
            vs.last_position_seconds = 0
            OR (
              v.duration_seconds > 0
              AND vs.last_position_seconds / v.duration_seconds >= 0.95
            )
          )
        )
      ORDER BY pv.playlist_id, pv.position
    `);

    return new Map(
      rows.map((row) => [
        row.playlist_id,
        {
          video_id: row.video_id,
          position_seconds: Number(row.position_seconds),
        },
      ]),
    );
  }

  private async attachArtwork(
    playlists: Playlist[],
    include: PlaylistInclude[],
  ): Promise<Playlist[]> {
    if (!include.includes("artwork") || playlists.length === 0) {
      return playlists;
    }
    const sourceIds = playlists
      .map((playlist) => playlist.artwork_source_video_id)
      .filter((id): id is number => id !== null);
    const { artworkService } = await import("@/modules/artwork/artwork.service");
    const artwork = await artworkService.getSummariesByVideoIds(sourceIds);
    return playlists.map((playlist) => ({
      ...playlist,
      artwork: playlist.artwork_source_video_id
        ? (artwork.get(playlist.artwork_source_video_id) ?? null)
        : null,
    }));
  }
}

export const playlistsService = new PlaylistsService();
