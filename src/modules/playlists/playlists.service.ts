import { db } from "@/config/drizzle";
import { eq, and, sql } from "drizzle-orm";
import { playlistsTable, playlistVideosTable } from "@/database/schema";
import { NotFoundError, ForbiddenError, ConflictError } from "@/utils/errors";
import { API_PREFIX } from "@/config/constants";
import type {
  Playlist,
  CreatePlaylistInput,
  UpdatePlaylistInput,
} from "./playlists.types";
import { videosService } from "@/modules/videos/videos.service";

export class PlaylistsService {
  async create(userId: number, input: CreatePlaylistInput): Promise<Playlist> {
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

    return this.findById(result[0].id);
  }

  async findById(id: number): Promise<Playlist> {
    const playlists = await db
      .select()
      .from(playlistsTable)
      .where(eq(playlistsTable.id, id))
      .limit(1);

    if (!playlists || playlists.length === 0) {
      throw new NotFoundError(`Playlist not found with id: ${id}`);
    }

    return this.mapToSnakeCase(playlists[0]);
  }

  async list(userId: number): Promise<Playlist[]> {
    // Use raw SQL for complex subquery
    const query = sql`
      SELECT
        p.*,
        (
          SELECT t.id
          FROM playlist_videos pv
          JOIN videos v ON pv.video_id = v.id
          LEFT JOIN thumbnails t ON v.id = t.video_id
          WHERE pv.playlist_id = p.id
          ORDER BY pv.position ASC
          LIMIT 1
        ) as thumbnail_id
      FROM playlists p
      WHERE p.user_id = ${userId}
      ORDER BY p.created_at DESC
    `;

    const result = await db.execute(query);
    const playlists = result as any[];

    return playlists.map((p) => ({
      ...this.mapToSnakeCase(p),
      thumbnail_url: p.thumbnail_id
        ? `${API_PREFIX}/thumbnails/${p.thumbnail_id}/image`
        : null,
    }));
  }

  async update(
    id: number,
    userId: number,
    input: UpdatePlaylistInput,
  ): Promise<Playlist> {
    const playlist = await this.findById(id);

    // Verify ownership
    if (playlist.user_id !== userId) {
      throw new ForbiddenError(
        "You do not have permission to update this playlist",
      );
    }

    const updates: any = {};

    if (input.name !== undefined) {
      updates.name = input.name;
    }

    if (input.description !== undefined) {
      updates.description = input.description;
    }

    if (Object.keys(updates).length === 0) {
      return playlist;
    }

    updates.updatedAt = new Date();

    await db
      .update(playlistsTable)
      .set(updates)
      .where(eq(playlistsTable.id, id));

    return this.findById(id);
  }

  async delete(id: number, userId: number): Promise<void> {
    const playlist = await this.findById(id);

    // Verify ownership
    if (playlist.user_id !== userId) {
      throw new ForbiddenError(
        "You do not have permission to delete this playlist",
      );
    }

    await db.delete(playlistsTable).where(eq(playlistsTable.id, id));
  }

  async addVideo(
    playlistId: number,
    userId: number,
    videoId: number,
    position?: number,
  ): Promise<void> {
    const playlist = await this.findById(playlistId);

    // Verify ownership
    if (playlist.user_id !== userId) {
      throw new ForbiddenError(
        "You do not have permission to modify this playlist",
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
          eq(playlistVideosTable.videoId, videoId),
        ),
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
  }

  async removeVideo(
    playlistId: number,
    userId: number,
    videoId: number,
  ): Promise<void> {
    const playlist = await this.findById(playlistId);

    // Verify ownership
    if (playlist.user_id !== userId) {
      throw new ForbiddenError(
        "You do not have permission to modify this playlist",
      );
    }

    await db
      .delete(playlistVideosTable)
      .where(
        and(
          eq(playlistVideosTable.playlistId, playlistId),
          eq(playlistVideosTable.videoId, videoId),
        ),
      );

    // Drizzle doesn't return rowCount, so we'll just proceed
    // The delete will succeed even if no rows match
  }

  async getVideos(playlistId: number, userId: number) {
    const playlist = await this.findById(playlistId);

    // Verify ownership
    if (playlist.user_id !== userId) {
      throw new ForbiddenError(
        "You do not have permission to view this playlist",
      );
    }

    const query = sql`
      SELECT
        v.*,
        pv.position,
        pv.added_at as added_to_playlist_at,
        t.id as thumbnail_id
      FROM videos v
      INNER JOIN playlist_videos pv ON v.id = pv.video_id
      LEFT JOIN thumbnails t ON v.id = t.video_id
      WHERE pv.playlist_id = ${playlistId}
      ORDER BY pv.position ASC
    `;

    const result = await db.execute(query);
    const videos = result as any[];

    // Add thumbnail_url to each video
    return videos.map((video) => ({
      ...video,
      thumbnail_url: video.thumbnail_id
        ? `${API_PREFIX}/thumbnails/${video.thumbnail_id}/image`
        : null,
    }));
  }

  async reorderVideos(
    playlistId: number,
    userId: number,
    positions: { video_id: number; position: number }[],
  ): Promise<void> {
    const playlist = await this.findById(playlistId);

    // Verify ownership
    if (playlist.user_id !== userId) {
      throw new ForbiddenError(
        "You do not have permission to modify this playlist",
      );
    }

    // Update positions
    for (const { video_id, position } of positions) {
      await db
        .update(playlistVideosTable)
        .set({ position })
        .where(
          and(
            eq(playlistVideosTable.playlistId, playlistId),
            eq(playlistVideosTable.videoId, video_id),
          ),
        );
    }
  }

  // Bulk Actions
  async bulkUpdateVideos(
    playlistId: number,
    userId: number,
    input: { videoIds: number[]; action: "add" | "remove" },
  ): Promise<void> {
    const { videoIds, action } = input;
    if (videoIds.length === 0) return;

    const playlist = await this.findById(playlistId);
    if (playlist.user_id !== userId) {
      throw new ForbiddenError(
        "You do not have permission to modify this playlist",
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

      for (const videoId of videoIds) {
        // Check if exists to avoid duplicates
        const exists = await db
          .select()
          .from(playlistVideosTable)
          .where(
            and(
              eq(playlistVideosTable.playlistId, playlistId),
              eq(playlistVideosTable.videoId, videoId),
            ),
          )
          .limit(1);

        if (!exists || exists.length === 0) {
          try {
            await db.insert(playlistVideosTable).values({
              playlistId,
              videoId,
              position: nextPos++,
            });
          } catch {
            // Ignore duplicates from race conditions
          }
        }
      }
    } else {
      // Delete multiple videos
      for (const videoId of videoIds) {
        await db
          .delete(playlistVideosTable)
          .where(
            and(
              eq(playlistVideosTable.playlistId, playlistId),
              eq(playlistVideosTable.videoId, videoId),
            ),
          );
      }
    }
  }

  private mapToSnakeCase(playlist: any): Playlist {
    return {
      id: playlist.id,
      user_id: playlist.userId ?? playlist.user_id,
      name: playlist.name,
      description: playlist.description,
      created_at:
        playlist.createdAt instanceof Date
          ? playlist.createdAt.toISOString()
          : playlist.created_at,
      updated_at:
        playlist.updatedAt instanceof Date
          ? playlist.updatedAt.toISOString()
          : playlist.updated_at,
    };
  }
}

export const playlistsService = new PlaylistsService();
