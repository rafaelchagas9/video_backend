import { and, asc, eq } from "drizzle-orm";
import { demoSchema, getDemoDatabase } from "@/database/demo";
import { ForbiddenError, NotFoundError } from "@/utils/errors";
import type {
  Bookmark,
  CreateBookmarkInput,
  UpdateBookmarkInput,
} from "./bookmarks.types";

const { demoBookmarksTable, demoVideosTable } = demoSchema;

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
    const timestamp = new Date().toISOString();
    const row = getDemoDatabase()
      .insert(demoBookmarksTable)
      .values({
        videoId,
        userId,
        timestampSeconds: input.timestamp_seconds,
        name: input.name,
        description: input.description ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
    return this.map(row);
  }

  findById(id: number): Bookmark {
    const row = getDemoDatabase()
      .select()
      .from(demoBookmarksTable)
      .where(eq(demoBookmarksTable.id, id))
      .get();
    if (!row) throw new NotFoundError(`Bookmark not found with id: ${id}`);
    return this.map(row);
  }

  getBookmarksForVideo(videoId: number, userId: number): Bookmark[] {
    return getDemoDatabase()
      .select()
      .from(demoBookmarksTable)
      .where(
        and(
          eq(demoBookmarksTable.videoId, videoId),
          eq(demoBookmarksTable.userId, userId)
        )
      )
      .orderBy(asc(demoBookmarksTable.timestampSeconds))
      .all()
      .map((row) => this.map(row));
  }

  update(id: number, userId: number, input: UpdateBookmarkInput): Bookmark {
    const existing = this.findById(id);
    this.assertOwner(existing, userId);
    getDemoDatabase()
      .update(demoBookmarksTable)
      .set({
        timestampSeconds: input.timestamp_seconds ?? existing.timestamp_seconds,
        name: input.name ?? existing.name,
        description:
          input.description !== undefined
            ? input.description
            : existing.description,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(demoBookmarksTable.id, id))
      .run();
    return this.findById(id);
  }

  delete(id: number, userId: number): void {
    const existing = this.findById(id);
    this.assertOwner(existing, userId);
    getDemoDatabase()
      .delete(demoBookmarksTable)
      .where(eq(demoBookmarksTable.id, id))
      .run();
  }

  private assertOwner(bookmark: Bookmark, userId: number): void {
    if (bookmark.user_id !== userId)
      throw new ForbiddenError(
        "You do not have permission to modify this bookmark"
      );
  }

  private map(row: typeof demoBookmarksTable.$inferSelect): Bookmark {
    return {
      id: row.id,
      video_id: row.videoId,
      user_id: row.userId,
      timestamp_seconds: row.timestampSeconds,
      name: row.name,
      description: row.description,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }
}

export const bookmarksDemoService = new BookmarksDemoService();
