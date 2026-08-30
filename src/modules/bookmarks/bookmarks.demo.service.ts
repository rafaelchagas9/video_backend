import { and, asc, eq } from "drizzle-orm";
import {
  demoSchema,
  getDemoDatabase,
  withDemoTransaction,
} from "@/database/demo";
import { ForbiddenError, NotFoundError } from "@/utils/errors";
import { bookmarkCategoriesDemoService } from "./bookmark-categories.demo.service";
import type {
  Bookmark,
  BookmarkCategoryAssignment,
  BookmarkListFilters,
  CreateBookmarkInput,
  UpdateBookmarkInput,
} from "./bookmarks.types";

const {
  demoBookmarkCategoriesTable,
  demoBookmarkCategoryAssignmentsTable,
  demoBookmarksTable,
  demoVideosTable,
} = demoSchema;

export class BookmarksDemoService {
  create(
    videoId: number,
    userId: number,
    input: CreateBookmarkInput
  ): Bookmark {
    const video = getDemoDatabase()
      .select({ id: demoVideosTable.id })
      .from(demoVideosTable)
      .where(eq(demoVideosTable.id, videoId))
      .get();
    if (!video) throw new NotFoundError(`Video not found with id: ${videoId}`);

    const id = withDemoTransaction(() => {
      const categoryIds = input.category_ids ?? [];
      bookmarkCategoriesDemoService.assertAssignable(userId, categoryIds);
      const timestamp = new Date().toISOString();
      const row = getDemoDatabase()
        .insert(demoBookmarksTable)
        .values({
          videoId,
          userId,
          timestampSeconds: input.timestamp_seconds,
          endTimestampSeconds: input.end_timestamp_seconds ?? null,
          peakTimestampSeconds: input.peak_timestamp_seconds ?? null,
          origin: "manual",
          analysisRunId: null,
          userModifiedAt: null,
          name: input.name,
          description: input.description ?? null,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning({ id: demoBookmarksTable.id })
        .get();
      if (categoryIds.length > 0) {
        getDemoDatabase()
          .insert(demoBookmarkCategoryAssignmentsTable)
          .values(
            categoryIds.map((categoryId) => ({
              bookmarkId: row.id,
              categoryId,
            }))
          )
          .run();
      }
      return row.id;
    });
    return this.findById(id);
  }

  findById(id: number): Bookmark {
    const row = getDemoDatabase()
      .select()
      .from(demoBookmarksTable)
      .where(eq(demoBookmarksTable.id, id))
      .get();
    if (!row) throw new NotFoundError(`Bookmark not found with id: ${id}`);
    return this.map(row, this.categoriesForBookmark(id));
  }

  getBookmarksForVideo(
    videoId: number,
    userId: number,
    filters: BookmarkListFilters = {}
  ): Bookmark[] {
    const rows = getDemoDatabase()
      .select()
      .from(demoBookmarksTable)
      .where(
        and(
          eq(demoBookmarksTable.videoId, videoId),
          eq(demoBookmarksTable.userId, userId),
          filters.origin && filters.origin !== "all"
            ? eq(demoBookmarksTable.origin, filters.origin)
            : undefined
        )
      )
      .orderBy(
        asc(demoBookmarksTable.timestampSeconds),
        asc(demoBookmarksTable.id)
      )
      .all();

    return rows
      .map((row) => this.map(row, this.categoriesForBookmark(row.id)))
      .filter(
        (bookmark) =>
          !filters.category ||
          bookmark.categories.some(({ key }) => key === filters.category)
      );
  }

  update(id: number, userId: number, input: UpdateBookmarkInput): Bookmark {
    const existing = this.findById(id);
    this.assertOwner(existing, userId);
    withDemoTransaction(() => {
      if (input.category_ids !== undefined) {
        bookmarkCategoriesDemoService.assertAssignable(
          userId,
          input.category_ids
        );
      }
      const now = new Date().toISOString();
      getDemoDatabase()
        .update(demoBookmarksTable)
        .set({
          timestampSeconds:
            input.timestamp_seconds ?? existing.timestamp_seconds,
          endTimestampSeconds:
            input.end_timestamp_seconds !== undefined
              ? input.end_timestamp_seconds
              : existing.end_timestamp_seconds,
          peakTimestampSeconds:
            input.peak_timestamp_seconds !== undefined
              ? input.peak_timestamp_seconds
              : existing.peak_timestamp_seconds,
          name: input.name ?? existing.name,
          description:
            input.description !== undefined
              ? input.description
              : existing.description,
          userModifiedAt:
            existing.origin === "automatic"
              ? (existing.user_modified_at ?? now)
              : existing.user_modified_at,
          updatedAt: now,
        })
        .where(
          and(
            eq(demoBookmarksTable.id, id),
            eq(demoBookmarksTable.userId, userId)
          )
        )
        .run();

      if (input.category_ids !== undefined) {
        getDemoDatabase()
          .delete(demoBookmarkCategoryAssignmentsTable)
          .where(eq(demoBookmarkCategoryAssignmentsTable.bookmarkId, id))
          .run();
        if (input.category_ids.length > 0) {
          getDemoDatabase()
            .insert(demoBookmarkCategoryAssignmentsTable)
            .values(
              input.category_ids.map((categoryId) => ({
                bookmarkId: id,
                categoryId,
              }))
            )
            .run();
        }
      }
    });
    return this.findById(id);
  }

  delete(id: number, userId: number): void {
    const existing = this.findById(id);
    this.assertOwner(existing, userId);
    getDemoDatabase()
      .delete(demoBookmarksTable)
      .where(
        and(
          eq(demoBookmarksTable.id, id),
          eq(demoBookmarksTable.userId, userId)
        )
      )
      .run();
  }

  private categoriesForBookmark(
    bookmarkId: number
  ): BookmarkCategoryAssignment[] {
    return getDemoDatabase()
      .select({
        id: demoBookmarkCategoriesTable.id,
        key: demoBookmarkCategoriesTable.key,
        name: demoBookmarkCategoriesTable.name,
        kind: demoBookmarkCategoriesTable.kind,
        confidence: demoBookmarkCategoryAssignmentsTable.confidence,
        providerLabel: demoBookmarkCategoryAssignmentsTable.providerLabel,
      })
      .from(demoBookmarkCategoryAssignmentsTable)
      .innerJoin(
        demoBookmarkCategoriesTable,
        eq(
          demoBookmarkCategoriesTable.id,
          demoBookmarkCategoryAssignmentsTable.categoryId
        )
      )
      .where(eq(demoBookmarkCategoryAssignmentsTable.bookmarkId, bookmarkId))
      .orderBy(asc(demoBookmarkCategoriesTable.key))
      .all()
      .map((row) => ({
        id: row.id,
        key: row.key,
        name: row.name,
        kind: row.kind as BookmarkCategoryAssignment["kind"],
        confidence: row.confidence,
        provider_label: row.providerLabel,
      }));
  }

  private assertOwner(bookmark: Bookmark, userId: number): void {
    if (bookmark.user_id !== userId) {
      throw new ForbiddenError(
        "You do not have permission to modify this bookmark"
      );
    }
  }

  private map(
    row: typeof demoBookmarksTable.$inferSelect,
    categories: BookmarkCategoryAssignment[]
  ): Bookmark {
    return {
      id: row.id,
      video_id: row.videoId,
      user_id: row.userId,
      timestamp_seconds: row.timestampSeconds,
      end_timestamp_seconds: row.endTimestampSeconds,
      peak_timestamp_seconds: row.peakTimestampSeconds,
      origin: row.origin as Bookmark["origin"],
      analysis_run_id: row.analysisRunId,
      user_modified_at: row.userModifiedAt,
      is_user_edited: row.userModifiedAt !== null,
      name: row.name,
      description: row.description,
      categories,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }
}

export const bookmarksDemoService = new BookmarksDemoService();
