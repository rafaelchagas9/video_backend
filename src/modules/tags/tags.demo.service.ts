import { and, asc, eq, isNull, max } from "drizzle-orm";
import { demoSchema, getDemoDatabase } from "@/database/demo";
import { ConflictError, NotFoundError } from "@/utils/errors";
import type { CreateTagInput, Tag, UpdateTagInput } from "./tags.types";

const { demoTagsTable } = demoSchema;

function now(): string {
  return new Date().toISOString();
}

function mapTag(row: typeof demoTagsTable.$inferSelect): Tag {
  return {
    id: row.id,
    name: row.name,
    parent_id: row.parentId,
    description: row.description,
    color: row.color,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export class TagsDemoService {
  list(): Tag[] {
    return getDemoDatabase()
      .select()
      .from(demoTagsTable)
      .orderBy(asc(demoTagsTable.name))
      .all()
      .map(mapTag);
  }

  findById(id: number): Tag {
    const row = getDemoDatabase()
      .select()
      .from(demoTagsTable)
      .where(eq(demoTagsTable.id, id))
      .get();
    if (!row) throw new NotFoundError(`Tag not found with id: ${id}`);
    return mapTag(row);
  }

  create(input: CreateTagInput): Tag {
    if (input.parent_id !== null && input.parent_id !== undefined) {
      this.findById(input.parent_id);
    }
    this.assertUnique(input.name, input.parent_id ?? null);
    const id =
      Number(
        getDemoDatabase()
          .select({ value: max(demoTagsTable.id) })
          .from(demoTagsTable)
          .get()?.value ?? 0
      ) + 1;
    const timestamp = now();
    getDemoDatabase()
      .insert(demoTagsTable)
      .values({
        id,
        name: input.name,
        parentId: input.parent_id ?? null,
        description: input.description ?? null,
        color: input.color ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    return this.findById(id);
  }

  update(id: number, input: UpdateTagInput): Tag {
    const existing = this.findById(id);
    const parentId =
      input.parent_id !== undefined ? input.parent_id : existing.parent_id;
    if (parentId === id)
      throw new ConflictError("A tag cannot be its own parent");
    if (parentId !== null) {
      this.findById(parentId);
      if (this.getDescendants(id).some((tag) => tag.id === parentId)) {
        throw new ConflictError("Cannot set a descendant as parent");
      }
    }
    const name = input.name ?? existing.name;
    this.assertUnique(name, parentId, id);
    getDemoDatabase()
      .update(demoTagsTable)
      .set({
        name,
        parentId,
        description:
          input.description !== undefined
            ? input.description
            : existing.description,
        color: input.color !== undefined ? input.color : existing.color,
        updatedAt: now(),
      })
      .where(eq(demoTagsTable.id, id))
      .run();
    return this.findById(id);
  }

  delete(id: number): void {
    this.findById(id);
    getDemoDatabase()
      .delete(demoTagsTable)
      .where(eq(demoTagsTable.id, id))
      .run();
  }

  getChildren(id: number): Tag[] {
    this.findById(id);
    return getDemoDatabase()
      .select()
      .from(demoTagsTable)
      .where(eq(demoTagsTable.parentId, id))
      .orderBy(asc(demoTagsTable.name))
      .all()
      .map(mapTag);
  }

  getDescendants(id: number): Tag[] {
    this.findById(id);
    const descendants: Tag[] = [];
    const queue = [id];
    while (queue.length > 0) {
      const parentId = queue.shift()!;
      const children = getDemoDatabase()
        .select()
        .from(demoTagsTable)
        .where(eq(demoTagsTable.parentId, parentId))
        .all()
        .map(mapTag);
      descendants.push(...children);
      queue.push(...children.map((child) => child.id));
    }
    return descendants;
  }

  private assertUnique(
    name: string,
    parentId: number | null,
    excludingId?: number
  ): void {
    const parentPredicate =
      parentId === null
        ? isNull(demoTagsTable.parentId)
        : eq(demoTagsTable.parentId, parentId);
    const existing = getDemoDatabase()
      .select({ id: demoTagsTable.id })
      .from(demoTagsTable)
      .where(and(eq(demoTagsTable.name, name), parentPredicate))
      .get();
    if (existing && existing.id !== excludingId) {
      throw new ConflictError(
        `Tag with name "${name}" already exists at this level`
      );
    }
  }
}

export const tagsDemoService = new TagsDemoService();
