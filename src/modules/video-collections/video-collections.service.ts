import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { API_PREFIX } from "@/config/constants";
import {
  thumbnailsTable,
  videoCollectionEntriesTable,
  videoCollectionsTable,
  videosTable,
} from "@/database/schema";
import { ConflictError, NotFoundError, isUniqueViolation } from "@/utils/errors";
import { env } from "@/config/env";
import type {
  CreateVideoCollectionEntryInput,
  CreateVideoCollectionInput,
  ReorderVideoCollectionEntriesInput,
  UpdateVideoCollectionInput,
  VideoCollection,
  VideoCollectionEntry,
  VideoCollectionEntryKind,
  VideoCollectionContext,
  VideoCollectionKind,
  VideoCollectionNeighborItem,
  VideoCollectionNeighbors,
} from "./video-collections.types";

type CollectionEntryRow = {
  id: number;
  collectionId: number;
  videoId: number;
  entryKind: string;
  sequenceNumber: number | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodePart: number | null;
  absoluteNumber: number | null;
  displayTitleOverride: string | null;
  createdAt: Date;
  updatedAt: Date;
  fileName?: string;
  title?: string | null;
  isAvailable?: boolean;
  thumbnailId?: number | null;
};

export class VideoCollectionsService {
  async list(): Promise<VideoCollection[]> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      return demoMockService.listCollections();
    }

    const rows = await db.execute<{
      id: number;
      title: string;
      kind: VideoCollection["kind"];
      description: string | null;
      release_year: number | null;
      external_ids_json: string | null;
      entry_count: number;
      created_at: string;
      updated_at: string;
    }>(sql`
      SELECT
        c.id,
        c.title,
        c.kind,
        c.description,
        c.release_year,
        c.external_ids_json,
        COUNT(e.id)::int AS entry_count,
        c.created_at,
        c.updated_at
      FROM ${videoCollectionsTable} c
      LEFT JOIN ${videoCollectionEntriesTable} e
        ON c.id = e.collection_id
      GROUP BY c.id
      ORDER BY c.updated_at DESC, c.id DESC
    `);

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      kind: row.kind as VideoCollectionKind,
      description: row.description,
      release_year: row.release_year,
      external_ids_json: row.external_ids_json,
      entry_count: Number(row.entry_count),
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
    }));
  }

  async create(input: CreateVideoCollectionInput): Promise<VideoCollection> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      return demoMockService.createCollection(input);
    }

    const result = await db
      .insert(videoCollectionsTable)
      .values({
        title: input.title,
        kind: input.kind,
        description: input.description ?? null,
        releaseYear: input.release_year ?? null,
        externalIdsJson: input.external_ids_json ?? null,
      })
      .returning({ id: videoCollectionsTable.id });

    if (!result[0]) {
      throw new Error("Failed to create video collection");
    }

    return this.findById(result[0].id);
  }

  async findById(id: number): Promise<VideoCollection> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      return demoMockService.getCollectionById(id);
    }

    const rows = await db.execute<{
      id: number;
      title: string;
      kind: VideoCollection["kind"];
      description: string | null;
      release_year: number | null;
      external_ids_json: string | null;
      entry_count: number;
      created_at: string;
      updated_at: string;
    }>(sql`
      SELECT
        c.id,
        c.title,
        c.kind,
        c.description,
        c.release_year,
        c.external_ids_json,
        COUNT(e.id)::int AS entry_count,
        c.created_at,
        c.updated_at
      FROM ${videoCollectionsTable} c
      LEFT JOIN ${videoCollectionEntriesTable} e
        ON c.id = e.collection_id
      WHERE c.id = ${id}
      GROUP BY c.id
      LIMIT 1
    `);

    const row = rows[0];
    if (!row) {
      throw new NotFoundError(`Video collection not found with id: ${id}`);
    }

    return {
      id: row.id,
      title: row.title,
      kind: row.kind as VideoCollectionKind,
      description: row.description,
      release_year: row.release_year,
      external_ids_json: row.external_ids_json,
      entry_count: Number(row.entry_count),
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
    };
  }

  async update(
    id: number,
    input: UpdateVideoCollectionInput,
  ): Promise<VideoCollection> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      return demoMockService.updateCollection(id, input);
    }

    await this.findById(id);

    const updates: Partial<typeof videoCollectionsTable.$inferInsert> = {};

    if (input.title !== undefined) updates.title = input.title;
    if (input.kind !== undefined) updates.kind = input.kind;
    if (input.description !== undefined) updates.description = input.description;
    if (input.release_year !== undefined)
      updates.releaseYear = input.release_year;
    if (input.external_ids_json !== undefined)
      updates.externalIdsJson = input.external_ids_json;

    if (Object.keys(updates).length === 0) {
      return this.findById(id);
    }

    updates.updatedAt = new Date();

    await db
      .update(videoCollectionsTable)
      .set(updates)
      .where(eq(videoCollectionsTable.id, id));

    return this.findById(id);
  }

  async delete(id: number): Promise<void> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      demoMockService.deleteCollection(id);
      return;
    }

    await this.findById(id);
    await db
      .delete(videoCollectionsTable)
      .where(eq(videoCollectionsTable.id, id));
  }

  async listEntries(collectionId: number): Promise<VideoCollectionEntry[]> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      return demoMockService.listCollectionEntries(collectionId);
    }

    await this.findById(collectionId);

    const rows = await db
      .select({
        id: videoCollectionEntriesTable.id,
        collectionId: videoCollectionEntriesTable.collectionId,
        videoId: videoCollectionEntriesTable.videoId,
        entryKind: videoCollectionEntriesTable.entryKind,
        sequenceNumber: videoCollectionEntriesTable.sequenceNumber,
        seasonNumber: videoCollectionEntriesTable.seasonNumber,
        episodeNumber: videoCollectionEntriesTable.episodeNumber,
        episodePart: videoCollectionEntriesTable.episodePart,
        absoluteNumber: videoCollectionEntriesTable.absoluteNumber,
        displayTitleOverride: videoCollectionEntriesTable.displayTitleOverride,
        createdAt: videoCollectionEntriesTable.createdAt,
        updatedAt: videoCollectionEntriesTable.updatedAt,
        fileName: videosTable.fileName,
        title: videosTable.title,
        isAvailable: videosTable.isAvailable,
        thumbnailId: thumbnailsTable.id,
      })
      .from(videoCollectionEntriesTable)
      .innerJoin(videosTable, eq(videoCollectionEntriesTable.videoId, videosTable.id))
      .leftJoin(thumbnailsTable, eq(videosTable.id, thumbnailsTable.videoId))
      .where(eq(videoCollectionEntriesTable.collectionId, collectionId))
      .orderBy(
        sql`CASE WHEN ${videoCollectionEntriesTable.sequenceNumber} IS NULL THEN 1 ELSE 0 END`,
        asc(videoCollectionEntriesTable.sequenceNumber),
        asc(videoCollectionEntriesTable.seasonNumber),
        asc(videoCollectionEntriesTable.episodeNumber),
        asc(videoCollectionEntriesTable.episodePart),
        asc(videoCollectionEntriesTable.absoluteNumber),
        asc(videoCollectionEntriesTable.createdAt),
      );

    return rows.map((row) => this.mapEntryRow(row, true));
  }

  async addEntry(
    collectionId: number,
    input: CreateVideoCollectionEntryInput,
  ): Promise<VideoCollectionEntry> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      return demoMockService.addCollectionEntry(collectionId, input);
    }

    await this.findById(collectionId);

    const video = await db
      .select({ id: videosTable.id })
      .from(videosTable)
      .where(eq(videosTable.id, input.video_id))
      .limit(1);

    if (!video[0]) {
      throw new NotFoundError(`Video not found with id: ${input.video_id}`);
    }

    const existingMembership = await db
      .select({ id: videoCollectionEntriesTable.id })
      .from(videoCollectionEntriesTable)
      .where(eq(videoCollectionEntriesTable.videoId, input.video_id))
      .limit(1);

    if (existingMembership[0]) {
      throw new ConflictError("Video already belongs to a collection");
    }

    try {
      const result = await db
        .insert(videoCollectionEntriesTable)
        .values({
          collectionId,
          videoId: input.video_id,
          entryKind: input.entry_kind,
          sequenceNumber: input.sequence_number ?? null,
          seasonNumber: input.season_number ?? null,
          episodeNumber: input.episode_number ?? null,
          episodePart: input.episode_part ?? null,
          absoluteNumber: input.absolute_number ?? null,
          displayTitleOverride: input.display_title_override ?? null,
        })
        .returning({ id: videoCollectionEntriesTable.id });

      await db
        .update(videoCollectionsTable)
        .set({ updatedAt: new Date() })
        .where(eq(videoCollectionsTable.id, collectionId));

      const created = await this.listEntries(collectionId);
      const entry = created.find((item) => item.id === result[0]?.id);
      if (!entry) {
        throw new Error("Failed to load created collection entry");
      }

      return entry;
    } catch (error) {
      this.rethrowCollectionConflict(error);
      throw error;
    }
  }

  async reorderEntries(
    collectionId: number,
    input: ReorderVideoCollectionEntriesInput,
  ): Promise<VideoCollectionEntry[]> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      return demoMockService.reorderCollectionEntries(collectionId, input);
    }

    await this.findById(collectionId);

    const existingEntries = await db
      .select({
        videoId: videoCollectionEntriesTable.videoId,
      })
      .from(videoCollectionEntriesTable)
      .where(eq(videoCollectionEntriesTable.collectionId, collectionId));

    const existingVideoIds = new Set(existingEntries.map((entry) => entry.videoId));
    for (const entry of input.entries) {
      if (!existingVideoIds.has(entry.video_id)) {
        throw new NotFoundError(
          `Collection entry not found for video id: ${entry.video_id}`,
        );
      }
    }

    try {
      await db.transaction(async (tx) => {
        for (const entry of input.entries) {
          await tx
            .update(videoCollectionEntriesTable)
            .set({
              sequenceNumber: entry.sequence_number ?? null,
              seasonNumber: entry.season_number ?? null,
              episodeNumber: entry.episode_number ?? null,
              episodePart: entry.episode_part ?? null,
              absoluteNumber: entry.absolute_number ?? null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(videoCollectionEntriesTable.collectionId, collectionId),
                eq(videoCollectionEntriesTable.videoId, entry.video_id),
              ),
            );
        }

        await tx
          .update(videoCollectionsTable)
          .set({ updatedAt: new Date() })
          .where(eq(videoCollectionsTable.id, collectionId));
      });
    } catch (error) {
      this.rethrowCollectionConflict(error);
      throw error;
    }

    return this.listEntries(collectionId);
  }

  async removeEntry(collectionId: number, videoId: number): Promise<void> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      demoMockService.removeCollectionEntry(collectionId, videoId);
      return;
    }

    await this.findById(collectionId);

    const existing = await db
      .select({ id: videoCollectionEntriesTable.id })
      .from(videoCollectionEntriesTable)
      .where(
        and(
          eq(videoCollectionEntriesTable.collectionId, collectionId),
          eq(videoCollectionEntriesTable.videoId, videoId),
        ),
      )
      .limit(1);

    if (!existing[0]) {
      throw new NotFoundError(
        `Collection entry not found for video id: ${videoId}`,
      );
    }

    await db
      .delete(videoCollectionEntriesTable)
      .where(
        and(
          eq(videoCollectionEntriesTable.collectionId, collectionId),
          eq(videoCollectionEntriesTable.videoId, videoId),
        ),
      );

    await db
      .update(videoCollectionsTable)
      .set({ updatedAt: new Date() })
      .where(eq(videoCollectionsTable.id, collectionId));
  }

  async getCollectionContextByVideoId(
    videoId: number,
  ): Promise<VideoCollectionContext | null> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      return demoMockService.getCollectionContextByVideoId(videoId);
    }

    const rows = await db
      .select({
        collectionId: videoCollectionsTable.id,
        collectionTitle: videoCollectionsTable.title,
        collectionKind: videoCollectionsTable.kind,
        collectionDescription: videoCollectionsTable.description,
        collectionReleaseYear: videoCollectionsTable.releaseYear,
        entryId: videoCollectionEntriesTable.id,
        entryKind: videoCollectionEntriesTable.entryKind,
        sequenceNumber: videoCollectionEntriesTable.sequenceNumber,
        seasonNumber: videoCollectionEntriesTable.seasonNumber,
        episodeNumber: videoCollectionEntriesTable.episodeNumber,
        episodePart: videoCollectionEntriesTable.episodePart,
        absoluteNumber: videoCollectionEntriesTable.absoluteNumber,
        displayTitleOverride: videoCollectionEntriesTable.displayTitleOverride,
        createdAt: videoCollectionEntriesTable.createdAt,
        updatedAt: videoCollectionEntriesTable.updatedAt,
      })
      .from(videoCollectionEntriesTable)
      .innerJoin(
        videoCollectionsTable,
        eq(videoCollectionEntriesTable.collectionId, videoCollectionsTable.id),
      )
      .where(eq(videoCollectionEntriesTable.videoId, videoId))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      entry_id: row.entryId,
      collection_id: row.collectionId,
      title: row.collectionTitle,
      kind: row.collectionKind as VideoCollectionKind,
      description: row.collectionDescription,
      release_year: row.collectionReleaseYear,
      entry: {
        id: row.entryId,
        collection_id: row.collectionId,
        video_id: videoId,
        entry_kind: row.entryKind as VideoCollectionEntryKind,
        sequence_number: row.sequenceNumber,
        season_number: row.seasonNumber,
        episode_number: row.episodeNumber,
        episode_part: row.episodePart,
        absolute_number: row.absoluteNumber,
        display_title_override: row.displayTitleOverride,
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
      },
    };
  }

  async getCollectionContextsByVideoIds(
    videoIds: number[],
  ): Promise<Map<number, VideoCollectionContext>> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      return demoMockService.getCollectionContextsByVideoIds(videoIds);
    }

    if (videoIds.length === 0) {
      return new Map();
    }

    const rows = await db
      .select({
        videoId: videoCollectionEntriesTable.videoId,
        collectionId: videoCollectionsTable.id,
        collectionTitle: videoCollectionsTable.title,
        collectionKind: videoCollectionsTable.kind,
        collectionDescription: videoCollectionsTable.description,
        collectionReleaseYear: videoCollectionsTable.releaseYear,
        entryId: videoCollectionEntriesTable.id,
        entryKind: videoCollectionEntriesTable.entryKind,
        sequenceNumber: videoCollectionEntriesTable.sequenceNumber,
        seasonNumber: videoCollectionEntriesTable.seasonNumber,
        episodeNumber: videoCollectionEntriesTable.episodeNumber,
        episodePart: videoCollectionEntriesTable.episodePart,
        absoluteNumber: videoCollectionEntriesTable.absoluteNumber,
        displayTitleOverride: videoCollectionEntriesTable.displayTitleOverride,
        createdAt: videoCollectionEntriesTable.createdAt,
        updatedAt: videoCollectionEntriesTable.updatedAt,
      })
      .from(videoCollectionEntriesTable)
      .innerJoin(
        videoCollectionsTable,
        eq(videoCollectionEntriesTable.collectionId, videoCollectionsTable.id),
      )
      .where(inArray(videoCollectionEntriesTable.videoId, videoIds));

    const map = new Map<number, VideoCollectionContext>();
    for (const row of rows) {
      map.set(row.videoId, {
        entry_id: row.entryId,
        collection_id: row.collectionId,
        title: row.collectionTitle,
        kind: row.collectionKind as VideoCollectionKind,
        description: row.collectionDescription,
        release_year: row.collectionReleaseYear,
        entry: {
          id: row.entryId,
          collection_id: row.collectionId,
          video_id: row.videoId,
          entry_kind: row.entryKind as VideoCollectionEntryKind,
          sequence_number: row.sequenceNumber,
          season_number: row.seasonNumber,
          episode_number: row.episodeNumber,
          episode_part: row.episodePart,
          absolute_number: row.absoluteNumber,
          display_title_override: row.displayTitleOverride,
          created_at: row.createdAt.toISOString(),
          updated_at: row.updatedAt.toISOString(),
        },
      });
    }

    return map;
  }

  async getNeighborsByVideoId(
    videoId: number,
  ): Promise<VideoCollectionNeighbors | null> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      return demoMockService.getNeighborsByVideoId(videoId);
    }

    const context = await this.getCollectionContextByVideoId(videoId);
    if (!context) {
      return null;
    }

    const entries = await this.listEntries(context.collection_id);
    const index = entries.findIndex((entry) => entry.video_id === videoId);
    if (index === -1) {
      return null;
    }

    return {
      previous: this.mapNeighborItem(entries[index - 1]),
      next: this.mapNeighborItem(entries[index + 1]),
    };
  }

  private mapNeighborItem(
    entry: VideoCollectionEntry | undefined,
  ): VideoCollectionNeighborItem | null {
    if (!entry?.video) {
      return null;
    }

    return {
      video_id: entry.video_id,
      entry_id: entry.id,
      title: entry.video.title,
      file_name: entry.video.file_name,
      display_title_override: entry.display_title_override,
      sequence_number: entry.sequence_number,
      season_number: entry.season_number,
      episode_number: entry.episode_number,
      episode_part: entry.episode_part,
      absolute_number: entry.absolute_number,
      thumbnail_id: entry.video.thumbnail_id,
      thumbnail_url: entry.video.thumbnail_url,
    };
  }

  private mapEntryRow(
    row: CollectionEntryRow,
    includeVideo: boolean,
  ): VideoCollectionEntry {
    return {
      id: row.id,
      collection_id: row.collectionId,
      video_id: row.videoId,
      entry_kind: row.entryKind as VideoCollectionEntryKind,
      sequence_number: row.sequenceNumber,
      season_number: row.seasonNumber,
      episode_number: row.episodeNumber,
      episode_part: row.episodePart,
      absolute_number: row.absoluteNumber,
      display_title_override: row.displayTitleOverride,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
      ...(includeVideo
        ? {
            video: {
              id: row.videoId,
              file_name: row.fileName!,
              title: row.title ?? null,
              thumbnail_id: row.thumbnailId ?? null,
              thumbnail_url: row.thumbnailId
                ? `${API_PREFIX}/thumbnails/${row.thumbnailId}/image`
                : null,
              is_available: row.isAvailable ?? false,
            },
          }
        : {}),
    };
  }

  private rethrowCollectionConflict(error: unknown): void {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "Collection entry conflicts with an existing video order or membership",
      );
    }
  }
}

export const videoCollectionsService = new VideoCollectionsService();
