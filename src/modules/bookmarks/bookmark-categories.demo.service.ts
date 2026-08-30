import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import {
  demoSchema,
  getDemoDatabase,
  withDemoTransaction,
} from "@/database/demo";
import { ConflictError, ForbiddenError, NotFoundError } from "@/utils/errors";
import type {
  BookmarkCategory,
  CreateBookmarkCategoryInput,
  UpdateBookmarkCategoryInput,
} from "./bookmarks.types";

const {
  demoBookmarkCategoriesTable,
  demoBookmarkCategoryAssignmentsTable,
  demoBookmarksTable,
} = demoSchema;

export class BookmarkCategoriesDemoService {
  list(userId: number): BookmarkCategory[] {
    return getDemoDatabase()
      .select()
      .from(demoBookmarkCategoriesTable)
      .where(
        or(
          eq(demoBookmarkCategoriesTable.kind, "system"),
          and(
            eq(demoBookmarkCategoriesTable.kind, "custom"),
            eq(demoBookmarkCategoriesTable.userId, userId)
          )
        )
      )
      .orderBy(asc(demoBookmarkCategoriesTable.key))
      .all()
      .map(this.map);
  }

  create(userId: number, input: CreateBookmarkCategoryInput): BookmarkCategory {
    const duplicate = getDemoDatabase()
      .select({ id: demoBookmarkCategoriesTable.id })
      .from(demoBookmarkCategoriesTable)
      .where(
        and(
          eq(demoBookmarkCategoriesTable.kind, "custom"),
          eq(demoBookmarkCategoriesTable.userId, userId),
          eq(demoBookmarkCategoriesTable.key, input.key)
        )
      )
      .get();
    if (duplicate) {
      throw new ConflictError("Bookmark category key already exists");
    }

    const now = new Date().toISOString();
    const row = getDemoDatabase()
      .insert(demoBookmarkCategoriesTable)
      .values({
        key: input.key,
        name: input.name,
        kind: "custom",
        userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return this.map(row);
  }

  update(
    id: number,
    userId: number,
    input: UpdateBookmarkCategoryInput
  ): BookmarkCategory {
    const category = this.findById(id);
    this.assertMutableOwner(category, userId, "modified");
    getDemoDatabase()
      .update(demoBookmarkCategoriesTable)
      .set({ name: input.name, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(demoBookmarkCategoriesTable.id, id),
          eq(demoBookmarkCategoriesTable.userId, userId),
          eq(demoBookmarkCategoriesTable.kind, "custom")
        )
      )
      .run();
    return this.findById(id);
  }

  delete(id: number, userId: number): void {
    const category = this.findById(id);
    this.assertMutableOwner(category, userId, "deleted");
    withDemoTransaction(() => {
      const now = new Date().toISOString();
      getDemoDatabase()
        .update(demoBookmarksTable)
        .set({
          userModifiedAt: sql`coalesce(${demoBookmarksTable.userModifiedAt}, ${now})`,
          updatedAt: now,
        })
        .where(
          and(
            eq(demoBookmarksTable.userId, userId),
            eq(demoBookmarksTable.origin, "automatic"),
            sql`exists (
              select 1
              from ${demoBookmarkCategoryAssignmentsTable} assignment
              where assignment.bookmark_id = ${demoBookmarksTable.id}
                and assignment.category_id = ${id}
            )`
          )
        )
        .run();

      getDemoDatabase()
        .delete(demoBookmarkCategoriesTable)
        .where(
          and(
            eq(demoBookmarkCategoriesTable.id, id),
            eq(demoBookmarkCategoriesTable.userId, userId),
            eq(demoBookmarkCategoriesTable.kind, "custom")
          )
        )
        .run();
    });
  }

  assertAssignable(userId: number, categoryIds: number[]): void {
    if (categoryIds.length === 0) return;
    const accessible = getDemoDatabase()
      .select({ id: demoBookmarkCategoriesTable.id })
      .from(demoBookmarkCategoriesTable)
      .where(
        and(
          inArray(demoBookmarkCategoriesTable.id, categoryIds),
          or(
            eq(demoBookmarkCategoriesTable.kind, "system"),
            and(
              eq(demoBookmarkCategoriesTable.kind, "custom"),
              eq(demoBookmarkCategoriesTable.userId, userId)
            )
          )
        )
      )
      .all();
    if (accessible.length !== categoryIds.length) {
      throw new ForbiddenError(
        "One or more bookmark categories are unavailable to this user"
      );
    }
  }

  private findById(id: number): BookmarkCategory {
    const row = getDemoDatabase()
      .select()
      .from(demoBookmarkCategoriesTable)
      .where(eq(demoBookmarkCategoriesTable.id, id))
      .get();
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
    row: typeof demoBookmarkCategoriesTable.$inferSelect
  ): BookmarkCategory {
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      kind: row.kind as BookmarkCategory["kind"],
      user_id: row.userId,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }
}

export const bookmarkCategoriesDemoService =
  new BookmarkCategoriesDemoService();
