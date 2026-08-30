import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import {
  bookmarkCategoriesTable,
  bookmarkCategoryAssignmentsTable,
  bookmarksTable,
} from "@/database/schema";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  isUniqueViolation,
} from "@/utils/errors";
import { bookmarkCategoriesDemoService } from "./bookmark-categories.demo.service";
import { SYSTEM_BOOKMARK_CATEGORY_KEYS } from "./bookmark-categories.constants";
import type {
  BookmarkCategory,
  CreateBookmarkCategoryInput,
  UpdateBookmarkCategoryInput,
} from "./bookmarks.types";

export class BookmarkCategoriesService {
  async list(userId: number): Promise<BookmarkCategory[]> {
    if (env.DEMO_MODE) return bookmarkCategoriesDemoService.list(userId);

    const rows = await db
      .select()
      .from(bookmarkCategoriesTable)
      .where(
        or(
          eq(bookmarkCategoriesTable.kind, "system"),
          and(
            eq(bookmarkCategoriesTable.kind, "custom"),
            eq(bookmarkCategoriesTable.userId, userId)
          )
        )
      )
      .orderBy(asc(bookmarkCategoriesTable.key));
    return rows.map(this.map);
  }

  async create(
    userId: number,
    input: CreateBookmarkCategoryInput
  ): Promise<BookmarkCategory> {
    if (
      SYSTEM_BOOKMARK_CATEGORY_KEYS.includes(
        input.key as (typeof SYSTEM_BOOKMARK_CATEGORY_KEYS)[number]
      )
    ) {
      throw new ConflictError(
        "Bookmark category key is reserved by the system"
      );
    }
    if (env.DEMO_MODE) {
      return bookmarkCategoriesDemoService.create(userId, input);
    }

    try {
      const [row] = await db
        .insert(bookmarkCategoriesTable)
        .values({
          key: input.key,
          name: input.name,
          kind: "custom",
          userId,
        })
        .returning();
      if (!row) throw new Error("Failed to create bookmark category");
      return this.map(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError("Bookmark category key already exists");
      }
      throw error;
    }
  }

  async update(
    id: number,
    userId: number,
    input: UpdateBookmarkCategoryInput
  ): Promise<BookmarkCategory> {
    if (env.DEMO_MODE) {
      return bookmarkCategoriesDemoService.update(id, userId, input);
    }

    const category = await this.findById(id);
    this.assertMutableOwner(category, userId, "modified");
    const [updated] = await db
      .update(bookmarkCategoriesTable)
      .set({ name: input.name, updatedAt: new Date() })
      .where(
        and(
          eq(bookmarkCategoriesTable.id, id),
          eq(bookmarkCategoriesTable.kind, "custom"),
          eq(bookmarkCategoriesTable.userId, userId)
        )
      )
      .returning();
    if (!updated)
      throw new ForbiddenError("Bookmark category ownership changed");
    return this.map(updated);
  }

  async delete(id: number, userId: number): Promise<void> {
    if (env.DEMO_MODE) {
      bookmarkCategoriesDemoService.delete(id, userId);
      return;
    }

    const category = await this.findById(id);
    this.assertMutableOwner(category, userId, "deleted");
    await db.transaction(async (tx) => {
      const now = new Date();
      await tx
        .update(bookmarksTable)
        .set({
          userModifiedAt: sql<Date>`coalesce(${bookmarksTable.userModifiedAt}, ${now.toISOString()}::timestamp)`,
          updatedAt: now,
        })
        .where(
          and(
            eq(bookmarksTable.userId, userId),
            eq(bookmarksTable.origin, "automatic"),
            sql`exists (
              select 1
              from ${bookmarkCategoryAssignmentsTable} assignment
              where assignment.bookmark_id = ${bookmarksTable.id}
                and assignment.category_id = ${id}
            )`
          )
        );

      const deleted = await tx
        .delete(bookmarkCategoriesTable)
        .where(
          and(
            eq(bookmarkCategoriesTable.id, id),
            eq(bookmarkCategoriesTable.kind, "custom"),
            eq(bookmarkCategoriesTable.userId, userId)
          )
        )
        .returning({ id: bookmarkCategoriesTable.id });
      if (deleted.length === 0) {
        throw new ForbiddenError("Bookmark category ownership changed");
      }
    });
  }

  async assertAssignable(userId: number, categoryIds: number[]): Promise<void> {
    if (categoryIds.length === 0) return;
    if (env.DEMO_MODE) {
      bookmarkCategoriesDemoService.assertAssignable(userId, categoryIds);
      return;
    }

    const accessible = await db
      .select({ id: bookmarkCategoriesTable.id })
      .from(bookmarkCategoriesTable)
      .where(
        and(
          inArray(bookmarkCategoriesTable.id, categoryIds),
          or(
            eq(bookmarkCategoriesTable.kind, "system"),
            and(
              eq(bookmarkCategoriesTable.kind, "custom"),
              eq(bookmarkCategoriesTable.userId, userId)
            )
          )
        )
      );
    if (accessible.length !== categoryIds.length) {
      throw new ForbiddenError(
        "One or more bookmark categories are unavailable to this user"
      );
    }
  }

  private async findById(id: number): Promise<BookmarkCategory> {
    const [row] = await db
      .select()
      .from(bookmarkCategoriesTable)
      .where(eq(bookmarkCategoriesTable.id, id))
      .limit(1);
    if (!row) throw new NotFoundError(`Bookmark category not found: ${id}`);
    return this.map(row);
  }

  private assertMutableOwner(
    category: BookmarkCategory,
    userId: number,
    operation: "modified" | "deleted"
  ): void {
    if (category.kind === "system") {
      throw new ForbiddenError(
        `System bookmark categories cannot be ${operation}`
      );
    }
    if (category.user_id !== userId) {
      const verb = operation === "modified" ? "modify" : "delete";
      throw new ForbiddenError(
        `You do not have permission to ${verb} this bookmark category`
      );
    }
  }

  private map(
    row: typeof bookmarkCategoriesTable.$inferSelect
  ): BookmarkCategory {
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      kind: row.kind as BookmarkCategory["kind"],
      user_id: row.userId,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }
}

export const bookmarkCategoriesService = new BookmarkCategoriesService();
