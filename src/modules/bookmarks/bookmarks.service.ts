import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import {
  bookmarkCategoriesTable,
  bookmarkCategoryAssignmentsTable,
  bookmarksTable,
} from "@/database/schema";
import { videosService } from "@/modules/videos/videos.service";
import { ForbiddenError, NotFoundError, ValidationError } from "@/utils/errors";
import { bookmarksDemoService } from "./bookmarks.demo.service";
import type {
  Bookmark,
  BookmarkCategoryAssignment,
  BookmarkListFilters,
  CreateBookmarkInput,
  UpdateBookmarkInput,
} from "./bookmarks.types";

type BookmarkRow = typeof bookmarksTable.$inferSelect;

export class BookmarksService {
  async create(
    videoId: number,
    userId: number,
    input: CreateBookmarkInput
  ): Promise<Bookmark> {
    const video = await videosService.findById(videoId);
    this.validateInterval(
      input.timestamp_seconds,
      input.peak_timestamp_seconds ?? null,
      input.end_timestamp_seconds ?? null,
      this.videoDuration(video)
    );

    if (env.DEMO_MODE) {
      return bookmarksDemoService.create(videoId, userId, input);
    }

    const categoryIds = input.category_ids ?? [];
    const id = await db.transaction(async (tx) => {
      await this.assertAssignableCategories(tx, userId, categoryIds);
      const [row] = await tx
        .insert(bookmarksTable)
        .values({
          videoId,
          userId,
          timestampSeconds: input.timestamp_seconds,
          endTimestampSeconds: input.end_timestamp_seconds ?? null,
          peakTimestampSeconds: input.peak_timestamp_seconds ?? null,
          origin: "manual",
          analysisRunId: null,
          name: input.name,
          description: input.description ?? null,
        })
        .returning({ id: bookmarksTable.id });
      if (!row) throw new Error("Failed to create bookmark");
      if (categoryIds.length > 0) {
        await tx.insert(bookmarkCategoryAssignmentsTable).values(
          categoryIds.map((categoryId) => ({
            bookmarkId: row.id,
            categoryId,
          }))
        );
      }
      return row.id;
    });

    return this.findById(id);
  }

  async findById(id: number): Promise<Bookmark> {
    if (env.DEMO_MODE) return bookmarksDemoService.findById(id);

    const [bookmark] = await db
      .select()
      .from(bookmarksTable)
      .where(eq(bookmarksTable.id, id))
      .limit(1);
    if (!bookmark) {
      throw new NotFoundError(`Bookmark not found with id: ${id}`);
    }
    const [mapped] = await this.hydrate([bookmark]);
    return mapped!;
  }

  async getBookmarksForVideo(
    videoId: number,
    userId: number,
    filters: BookmarkListFilters = {}
  ): Promise<Bookmark[]> {
    await videosService.findById(videoId);
    if (env.DEMO_MODE) {
      return bookmarksDemoService.getBookmarksForVideo(
        videoId,
        userId,
        filters
      );
    }

    const conditions = [
      eq(bookmarksTable.videoId, videoId),
      eq(bookmarksTable.userId, userId),
    ];
    if (filters.origin && filters.origin !== "all") {
      conditions.push(eq(bookmarksTable.origin, filters.origin));
    }
    if (filters.category) {
      conditions.push(sql`EXISTS (
        SELECT 1
        FROM ${bookmarkCategoryAssignmentsTable} assignment
        INNER JOIN ${bookmarkCategoriesTable} category
          ON category.id = assignment.category_id
        WHERE assignment.bookmark_id = ${bookmarksTable.id}
          AND category.key = ${filters.category}
      )`);
    }

    const rows = await db
      .select()
      .from(bookmarksTable)
      .where(and(...conditions))
      .orderBy(asc(bookmarksTable.timestampSeconds), asc(bookmarksTable.id));
    return this.hydrate(rows);
  }

  async update(
    id: number,
    userId: number,
    input: UpdateBookmarkInput
  ): Promise<Bookmark> {
    const bookmark = await this.findById(id);
    this.assertOwner(bookmark, userId, "update");
    if (Object.keys(input).length === 0) return bookmark;

    const video = await videosService.findById(bookmark.video_id);
    const videoDuration = this.videoDuration(video);

    if (env.DEMO_MODE) {
      const start = input.timestamp_seconds ?? bookmark.timestamp_seconds;
      const peak =
        input.peak_timestamp_seconds !== undefined
          ? input.peak_timestamp_seconds
          : bookmark.peak_timestamp_seconds;
      const end =
        input.end_timestamp_seconds !== undefined
          ? input.end_timestamp_seconds
          : bookmark.end_timestamp_seconds;
      this.validateInterval(start, peak, end, videoDuration);
      return bookmarksDemoService.update(id, userId, input);
    }

    await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(bookmarksTable)
        .where(eq(bookmarksTable.id, id))
        .limit(1)
        .for("update");
      if (!current) {
        throw new NotFoundError(`Bookmark not found with id: ${id}`);
      }
      if (current.userId !== userId) {
        throw new ForbiddenError("Bookmark ownership changed");
      }
      const start = input.timestamp_seconds ?? current.timestampSeconds;
      const peak =
        input.peak_timestamp_seconds !== undefined
          ? input.peak_timestamp_seconds
          : current.peakTimestampSeconds;
      const end =
        input.end_timestamp_seconds !== undefined
          ? input.end_timestamp_seconds
          : current.endTimestampSeconds;
      this.validateInterval(start, peak, end, videoDuration);

      if (input.category_ids !== undefined) {
        await this.assertAssignableCategories(tx, userId, input.category_ids);
      }
      const now = new Date();
      const updates: Partial<typeof bookmarksTable.$inferInsert> = {
        updatedAt: now,
      };
      if (input.timestamp_seconds !== undefined) {
        updates.timestampSeconds = input.timestamp_seconds;
      }
      if (input.peak_timestamp_seconds !== undefined) {
        updates.peakTimestampSeconds = input.peak_timestamp_seconds;
      }
      if (input.end_timestamp_seconds !== undefined) {
        updates.endTimestampSeconds = input.end_timestamp_seconds;
      }
      if (input.name !== undefined) updates.name = input.name;
      if (input.description !== undefined) {
        updates.description = input.description;
      }
      if (current.origin === "automatic") {
        updates.userModifiedAt = current.userModifiedAt ?? now;
      }
      const updated = await tx
        .update(bookmarksTable)
        .set(updates)
        .where(
          and(eq(bookmarksTable.id, id), eq(bookmarksTable.userId, userId))
        )
        .returning({ id: bookmarksTable.id });
      if (updated.length === 0) {
        throw new ForbiddenError("Bookmark ownership changed");
      }

      if (input.category_ids !== undefined) {
        await tx
          .delete(bookmarkCategoryAssignmentsTable)
          .where(eq(bookmarkCategoryAssignmentsTable.bookmarkId, id));
        if (input.category_ids.length > 0) {
          await tx.insert(bookmarkCategoryAssignmentsTable).values(
            input.category_ids.map((categoryId) => ({
              bookmarkId: id,
              categoryId,
            }))
          );
        }
      }
    });
    return this.findById(id);
  }

  async delete(id: number, userId: number): Promise<void> {
    const bookmark = await this.findById(id);
    this.assertOwner(bookmark, userId, "delete");
    if (env.DEMO_MODE) {
      bookmarksDemoService.delete(id, userId);
      return;
    }

    const deleted = await db
      .delete(bookmarksTable)
      .where(and(eq(bookmarksTable.id, id), eq(bookmarksTable.userId, userId)))
      .returning({ id: bookmarksTable.id });
    if (deleted.length === 0)
      throw new ForbiddenError("Bookmark ownership changed");
  }

  private async hydrate(rows: BookmarkRow[]): Promise<Bookmark[]> {
    if (rows.length === 0) return [];
    const assignments = await db
      .select({
        bookmarkId: bookmarkCategoryAssignmentsTable.bookmarkId,
        id: bookmarkCategoriesTable.id,
        key: bookmarkCategoriesTable.key,
        name: bookmarkCategoriesTable.name,
        kind: bookmarkCategoriesTable.kind,
        confidence: bookmarkCategoryAssignmentsTable.confidence,
        providerLabel: bookmarkCategoryAssignmentsTable.providerLabel,
      })
      .from(bookmarkCategoryAssignmentsTable)
      .innerJoin(
        bookmarkCategoriesTable,
        eq(
          bookmarkCategoriesTable.id,
          bookmarkCategoryAssignmentsTable.categoryId
        )
      )
      .where(
        inArray(
          bookmarkCategoryAssignmentsTable.bookmarkId,
          rows.map(({ id }) => id)
        )
      )
      .orderBy(asc(bookmarkCategoriesTable.key));
    const byBookmark = new Map<number, BookmarkCategoryAssignment[]>();
    for (const assignment of assignments) {
      const categories = byBookmark.get(assignment.bookmarkId) ?? [];
      categories.push({
        id: assignment.id,
        key: assignment.key,
        name: assignment.name,
        kind: assignment.kind as BookmarkCategoryAssignment["kind"],
        confidence: assignment.confidence,
        provider_label: assignment.providerLabel,
      });
      byBookmark.set(assignment.bookmarkId, categories);
    }
    return rows.map((row) => this.map(row, byBookmark.get(row.id) ?? []));
  }

  private async assertAssignableCategories(
    executor: Pick<typeof db, "select">,
    userId: number,
    categoryIds: number[]
  ): Promise<void> {
    if (categoryIds.length === 0) return;
    if (new Set(categoryIds).size !== categoryIds.length) {
      throw new ValidationError("category_ids must not contain duplicates");
    }
    const accessible = await executor
      .select({ id: bookmarkCategoriesTable.id })
      .from(bookmarkCategoriesTable)
      .where(
        and(
          inArray(bookmarkCategoriesTable.id, categoryIds),
          sql`(${bookmarkCategoriesTable.kind} = 'system' OR (${bookmarkCategoriesTable.kind} = 'custom' AND ${bookmarkCategoriesTable.userId} = ${userId}))`
        )
      );
    if (accessible.length !== categoryIds.length) {
      throw new ForbiddenError(
        "One or more bookmark categories are unavailable to this user"
      );
    }
  }

  private validateInterval(
    start: number,
    peak: number | null,
    end: number | null,
    duration: number | null
  ): void {
    if (!Number.isFinite(start) || start < 0) {
      throw new ValidationError("Bookmark timestamp must be non-negative");
    }
    if ((peak === null) !== (end === null)) {
      throw new ValidationError(
        "Bookmark end and peak timestamps must be provided together"
      );
    }
    if (peak !== null && end !== null && !(start <= peak && peak <= end)) {
      throw new ValidationError(
        "Bookmark timestamps must satisfy start <= peak <= end"
      );
    }
    if (duration !== null && Math.max(start, peak ?? 0, end ?? 0) > duration) {
      throw new ValidationError("Bookmark timestamp exceeds video duration");
    }
  }

  private videoDuration(video: unknown): number | null {
    const candidate = (video as { duration_seconds?: unknown })
      .duration_seconds;
    return typeof candidate === "number" && Number.isFinite(candidate)
      ? candidate
      : null;
  }

  private assertOwner(
    bookmark: Bookmark,
    userId: number,
    action: "update" | "delete"
  ): void {
    if (bookmark.user_id !== userId) {
      throw new ForbiddenError(
        `You do not have permission to ${action} this bookmark`
      );
    }
  }

  private map(
    bookmark: BookmarkRow,
    categories: BookmarkCategoryAssignment[]
  ): Bookmark {
    return {
      id: bookmark.id,
      video_id: bookmark.videoId,
      user_id: bookmark.userId,
      timestamp_seconds: bookmark.timestampSeconds,
      end_timestamp_seconds: bookmark.endTimestampSeconds,
      peak_timestamp_seconds: bookmark.peakTimestampSeconds,
      origin: bookmark.origin as Bookmark["origin"],
      analysis_run_id: bookmark.analysisRunId,
      user_modified_at: bookmark.userModifiedAt?.toISOString() ?? null,
      is_user_edited: bookmark.userModifiedAt !== null,
      name: bookmark.name,
      description: bookmark.description,
      categories,
      created_at: bookmark.createdAt.toISOString(),
      updated_at: bookmark.updatedAt.toISOString(),
    };
  }
}

export const bookmarksService = new BookmarksService();
