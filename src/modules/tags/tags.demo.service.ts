import { and, asc, eq, isNull, max } from "drizzle-orm";
import { demoSchema, getDemoDatabase } from "@/database/demo";
import { ConflictError, NotFoundError } from "@/utils/errors";
import type { CreateTagInput, Tag, UpdateTagInput } from "./tags.types";

const { demoTagsTable, demoVideoTagsTable, demoTagAliasesTable, demoEnrichmentSuggestionsTable, demoEnrichmentRunsTable } = demoSchema;

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

  merge(fromId: number, intoId: number): Tag {
    if (fromId === intoId) throw new ConflictError("A tag cannot merge into itself");
    const source = this.findById(fromId);
    this.findById(intoId);
    if (this.getDescendants(fromId).some((tag) => tag.id === intoId)) {
      throw new ConflictError("Cannot merge a tag into one of its children");
    }
    const children = this.getChildren(fromId);
    const targetNames = new Set(this.getChildren(intoId).map((tag) => tag.name.toLocaleLowerCase()));
    if (children.some((tag) => targetNames.has(tag.name.toLocaleLowerCase()))) {
      throw new ConflictError("A child tag with the same name already exists under the destination");
    }

    getDemoDatabase().transaction((tx) => {
      const videos = tx.select({ videoId: demoVideoTagsTable.videoId })
        .from(demoVideoTagsTable).where(eq(demoVideoTagsTable.tagId, fromId)).all();
      for (const video of videos) {
        tx.insert(demoVideoTagsTable).values({ videoId: video.videoId, tagId: intoId })
          .onConflictDoNothing().run();
      }
      const aliases = tx.select().from(demoTagAliasesTable)
        .where(eq(demoTagAliasesTable.tagId, fromId)).all();
      for (const alias of aliases) {
        tx.insert(demoTagAliasesTable).values({ tagId: intoId, name: alias.name, note: alias.note, createdAt: alias.createdAt })
          .onConflictDoNothing().run();
      }
      if (source.name !== this.findById(intoId).name) {
        tx.insert(demoTagAliasesTable).values({ tagId: intoId, name: source.name, createdAt: now() })
          .onConflictDoNothing().run();
      }
      tx.update(demoTagsTable).set({ parentId: intoId, updatedAt: now() })
        .where(eq(demoTagsTable.parentId, fromId)).run();
      tx.update(demoEnrichmentSuggestionsTable).set({ entityId: intoId })
        .where(and(eq(demoEnrichmentSuggestionsTable.entityType, "tag"), eq(demoEnrichmentSuggestionsTable.entityId, fromId))).run();
      tx.update(demoEnrichmentRunsTable).set({ entityId: intoId })
        .where(and(eq(demoEnrichmentRunsTable.entityType, "tag"), eq(demoEnrichmentRunsTable.entityId, fromId))).run();
      tx.delete(demoTagsTable).where(eq(demoTagsTable.id, fromId)).run();
    });
    return this.findById(intoId);
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
