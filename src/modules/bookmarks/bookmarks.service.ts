import { db } from "@/config/drizzle";
import { eq, and, asc } from "drizzle-orm";
import { bookmarksTable } from "@/database/schema";
import { NotFoundError, ForbiddenError } from "@/utils/errors";
import type {
  Bookmark,
  CreateBookmarkInput,
  UpdateBookmarkInput,
} from "./bookmarks.types";
import { videosService } from "@/modules/videos/videos.service";
import { env } from "@/config/env";

export class BookmarksService {
  async create(
    videoId: number,
    userId: number,
    input: CreateBookmarkInput,
  ): Promise<Bookmark> {
    // Verify video exists
    await videosService.findById(videoId);

    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      const bookmark = demoMockService.createBookmark(videoId, userId, input);
      if (!bookmark) {
        throw new NotFoundError(`Video not found with id: ${videoId}`);
      }
      return this.mapToSnakeCase(bookmark);
    }

    const result = await db
      .insert(bookmarksTable)
      .values({
        videoId,
        userId,
        timestampSeconds: input.timestamp_seconds,
        name: input.name,
        description: input.description || null,
      })
      .returning({ id: bookmarksTable.id });

    if (!result || result.length === 0) {
      throw new Error("Failed to create bookmark");
    }

    return this.findById(result[0].id);
  }

  async findById(id: number): Promise<Bookmark> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      const bookmark = demoMockService.findBookmarkById(id);
      if (!bookmark) {
        throw new NotFoundError(`Bookmark not found with id: ${id}`);
      }
      return this.mapToSnakeCase(bookmark);
    }

    const bookmarks = await db
      .select()
      .from(bookmarksTable)
      .where(eq(bookmarksTable.id, id))
      .limit(1);

    if (!bookmarks || bookmarks.length === 0) {
      throw new NotFoundError(`Bookmark not found with id: ${id}`);
    }

    return this.mapToSnakeCase(bookmarks[0]);
  }

  async getBookmarksForVideo(
    videoId: number,
    userId: number,
  ): Promise<Bookmark[]> {
    // Verify video exists
    await videosService.findById(videoId);

    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      const bookmarks = demoMockService.getBookmarksForVideo(videoId, userId);
      if (!bookmarks) {
        throw new NotFoundError(`Video not found with id: ${videoId}`);
      }
      return bookmarks.map((bookmark: any) => this.mapToSnakeCase(bookmark));
    }

    const bookmarks = await db
      .select()
      .from(bookmarksTable)
      .where(
        and(
          eq(bookmarksTable.videoId, videoId),
          eq(bookmarksTable.userId, userId),
        ),
      )
      .orderBy(asc(bookmarksTable.timestampSeconds));

    return bookmarks.map(this.mapToSnakeCase);
  }

  async update(
    id: number,
    userId: number,
    input: UpdateBookmarkInput,
  ): Promise<Bookmark> {
    const bookmark = await this.findById(id);

    // Verify ownership
    if (bookmark.user_id !== userId) {
      throw new ForbiddenError(
        "You do not have permission to update this bookmark",
      );
    }

    const updates: any = {};

    if (input.timestamp_seconds !== undefined) {
      updates.timestampSeconds = input.timestamp_seconds;
    }

    if (input.name !== undefined) {
      updates.name = input.name;
    }

    if (input.description !== undefined) {
      updates.description = input.description;
    }

    if (Object.keys(updates).length === 0) {
      return bookmark;
    }

    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      const updated = demoMockService.updateBookmark(id, input);
      if (!updated) {
        throw new NotFoundError(`Bookmark not found with id: ${id}`);
      }
      return this.mapToSnakeCase(updated);
    }

    updates.updatedAt = new Date();

    await db
      .update(bookmarksTable)
      .set(updates)
      .where(eq(bookmarksTable.id, id));

    return this.findById(id);
  }

  async delete(id: number, userId: number): Promise<void> {
    const bookmark = await this.findById(id);

    // Verify ownership
    if (bookmark.user_id !== userId) {
      throw new ForbiddenError(
        "You do not have permission to delete this bookmark",
      );
    }

    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      if (!demoMockService.deleteBookmark(id)) {
        throw new NotFoundError(`Bookmark not found with id: ${id}`);
      }
      return;
    }

    await db.delete(bookmarksTable).where(eq(bookmarksTable.id, id));
  }

  private mapToSnakeCase(bookmark: any): Bookmark {
    return {
      id: bookmark.id,
      video_id: bookmark.videoId ?? bookmark.video_id,
      user_id: bookmark.userId ?? bookmark.user_id,
      timestamp_seconds:
        bookmark.timestampSeconds ?? bookmark.timestamp_seconds,
      name: bookmark.name,
      description: bookmark.description,
      created_at:
        bookmark.createdAt instanceof Date
          ? bookmark.createdAt.toISOString()
          : bookmark.created_at,
      updated_at:
        bookmark.updatedAt instanceof Date
          ? bookmark.updatedAt.toISOString()
          : bookmark.updated_at,
    };
  }
}

export const bookmarksService = new BookmarksService();
