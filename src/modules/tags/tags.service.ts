import { eq, sql, isNull, or, like } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { tagsTable, videoTagsTable } from "@/database/schema";
import { NotFoundError, ConflictError } from "@/utils/errors";
import type {
  Tag,
  TagWithPath,
  TagTreeNode,
  CreateTagInput,
  UpdateTagInput,
  ListTagsOptions,
  PaginatedTags,
} from "./tags.types";
import type { Video } from "@/modules/videos/videos.types";

export class TagsService {
  async list(options: ListTagsOptions = {}): Promise<PaginatedTags> {
    const {
      page = 1,
      limit = 20,
      search,
      sort = "name",
      order = "asc",
      tree = false,
    } = options;

    const offset = (page - 1) * limit;

    if (tree) {
      return this.listTreeWithPagination(page, limit, search, sort, order);
    }

    // Build WHERE conditions
    const whereClauses = [];
    if (search) {
      whereClauses.push(
        or(
          like(tagsTable.name, `%${search}%`),
          like(tagsTable.description, `%${search}%`),
        ),
      );
    }

    const whereCondition =
      whereClauses.length > 0 ? whereClauses[0] : undefined;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(tagsTable)
      .where(whereCondition)
      .then((rows) => rows[0]);

    const total = Number(countResult?.count || 0);
    const totalPages = Math.ceil(total / limit);

    // Get tags with sorting
    const validSortColumns = ["name", "created_at"];
    const sortColumn = validSortColumns.includes(sort) ? sort : "name";
    const sortField =
      sortColumn === "created_at" ? tagsTable.createdAt : tagsTable.name;
    const sortOrder = order === "asc" ? sql`asc` : sql`desc`;

    const tags = await db
      .select()
      .from(tagsTable)
      .where(whereCondition)
      .orderBy(sql`${sortField} ${sortOrder}`)
      .limit(limit)
      .offset(offset);

    return {
      data: tags.map((tag) => this.mapToSnakeCase(tag)),
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  private async listTreeWithPagination(
    page: number,
    limit: number,
    search: string | undefined,
    sortColumn: string,
    sortOrder: string,
  ): Promise<PaginatedTags> {
    const offset = (page - 1) * limit;

    // Build WHERE conditions
    const whereClauses = [isNull(tagsTable.parentId)];
    if (search) {
      whereClauses.push(
        or(
          like(tagsTable.name, `%${search}%`),
          like(tagsTable.description, `%${search}%`),
        )!,
      );
    }

    const whereCondition =
      whereClauses.length > 1
        ? sql`${whereClauses[0]} AND ${whereClauses[1]}`
        : whereClauses[0];

    // Get total count of root tags
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(tagsTable)
      .where(whereCondition)
      .then((rows) => rows[0]);

    const total = Number(countResult?.count || 0);
    const totalPages = Math.ceil(total / limit);

    // Get root tags
    const sortField =
      sortColumn === "created_at" ? tagsTable.createdAt : tagsTable.name;
    const sortDir = sortOrder === "asc" ? sql`asc` : sql`desc`;

    const rootTags = await db
      .select()
      .from(tagsTable)
      .where(whereCondition)
      .orderBy(sql`${sortField} ${sortDir}`)
      .limit(limit)
      .offset(offset);

    // Build tree with children
    const treeWithChildren = await Promise.all(
      rootTags.map((tag) => this.buildTreeWithDescendants(tag.id)),
    );

    return {
      data: treeWithChildren,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  private async buildTreeWithDescendants(tagId: number): Promise<TagTreeNode> {
    const tag = await this.findById(tagId);

    const children = await db
      .select()
      .from(tagsTable)
      .where(eq(tagsTable.parentId, tagId))
      .orderBy(tagsTable.name);

    const childrenTree = await Promise.all(
      children.map((child) => this.buildTreeWithDescendants(child.id)),
    );

    return {
      ...tag,
      children: childrenTree,
    };
  }

  async getTree(): Promise<TagTreeNode[]> {
    const result = await this.list({ limit: 10000 });
    return this.buildTree(result.data as Tag[]);
  }

  private buildTree(
    tags: Tag[],
    parentId: number | null = null,
  ): TagTreeNode[] {
    return tags
      .filter((tag) => tag.parent_id === parentId)
      .map((tag) => ({
        ...tag,
        children: this.buildTree(tags, tag.id),
      }));
  }

  async findById(id: number): Promise<Tag> {
    const tag = await db
      .select()
      .from(tagsTable)
      .where(eq(tagsTable.id, id))
      .limit(1)
      .then((rows) => rows[0] || null);

    if (!tag) {
      throw new NotFoundError(`Tag not found with id: ${id}`);
    }

    return this.mapToSnakeCase(tag);
  }

  async findByIdWithPath(id: number): Promise<TagWithPath> {
    const tag = await this.findById(id);
    const ancestors = await this.getAncestors(id);
    const path = [...ancestors.map((a) => a.name), tag.name].join(" > ");

    return { ...tag, path };
  }

  async getAncestors(id: number): Promise<Tag[]> {
    // Recursive CTE to get all ancestors
    const ancestors = await db.execute<{
      id: number;
      name: string;
      parent_id: number | null;
      description: string | null;
      color: string | null;
      created_at: Date;
      updated_at: Date;
    }>(sql`
      WITH RECURSIVE ancestors AS (
        SELECT t.* FROM tags t WHERE t.id = (SELECT parent_id FROM tags WHERE id = ${id})
        UNION ALL
        SELECT t.* FROM tags t
        INNER JOIN ancestors a ON t.id = a.parent_id
      )
      SELECT * FROM ancestors ORDER BY id
    `);

    const results = Array.isArray(ancestors) ? ancestors : [];
    return results.reverse().map((row: any) => ({
      id: Number(row.id),
      name: row.name,
      parent_id: row.parent_id != null ? Number(row.parent_id) : null,
      description: row.description,
      color: row.color,
      created_at: this.toIsoString(row.created_at),
      updated_at: this.toIsoString(row.updated_at),
    }));
  }

  async getDescendants(id: number): Promise<Tag[]> {
    // Recursive CTE to get all descendants
    const descendants = await db.execute<{
      id: number;
      name: string;
      parent_id: number | null;
      description: string | null;
      color: string | null;
      created_at: Date;
      updated_at: Date;
    }>(sql`
      WITH RECURSIVE descendants AS (
        SELECT * FROM tags WHERE parent_id = ${id}
        UNION ALL
        SELECT t.* FROM tags t
        INNER JOIN descendants d ON t.parent_id = d.id
      )
      SELECT * FROM descendants ORDER BY name ASC
    `);

    const results = Array.isArray(descendants) ? descendants : [];
    return results.map((row: any) => ({
      id: Number(row.id),
      name: row.name,
      parent_id: row.parent_id != null ? Number(row.parent_id) : null,
      description: row.description,
      color: row.color,
      created_at: this.toIsoString(row.created_at),
      updated_at: this.toIsoString(row.updated_at),
    }));
  }

  async getChildren(id: number): Promise<Tag[]> {
    await this.findById(id); // Ensure exists

    const children = await db
      .select()
      .from(tagsTable)
      .where(eq(tagsTable.parentId, id))
      .orderBy(tagsTable.name);

    return children.map((child) => this.mapToSnakeCase(child));
  }

  async create(input: CreateTagInput): Promise<Tag> {
    // Verify parent exists if provided
    if (input.parent_id) {
      await this.findById(input.parent_id);
    }

    try {
      const result = await db
        .insert(tagsTable)
        .values({
          name: input.name,
          parentId: input.parent_id || null,
          description: input.description || null,
          color: input.color || null,
        })
        .returning({ id: tagsTable.id })
        .then((rows) => rows[0]);

      if (!result) {
        throw new Error("Failed to create tag");
      }

      return this.findById(result.id);
    } catch (error: any) {
      if (error.code === "23505") {
        // UNIQUE violation
        throw new ConflictError(
          `Tag with name "${input.name}" already exists at this level`,
        );
      }
      throw error;
    }
  }

  async update(id: number, input: UpdateTagInput): Promise<Tag> {
    await this.findById(id); // Ensure exists

    // Verify new parent exists and prevent circular reference
    if (input.parent_id !== undefined && input.parent_id !== null) {
      await this.findById(input.parent_id);

      // Check for circular reference
      if (input.parent_id === id) {
        throw new ConflictError("A tag cannot be its own parent");
      }

      // Check if new parent is a descendant
      const descendants = await this.getDescendants(id);
      if (descendants.some((d) => d.id === input.parent_id)) {
        throw new ConflictError("Cannot set a descendant as parent");
      }
    }

    const updates: any = {};

    if (input.name !== undefined) {
      updates.name = input.name;
    }

    if (input.parent_id !== undefined) {
      updates.parentId = input.parent_id;
    }

    if (input.description !== undefined) {
      updates.description = input.description;
    }

    if (input.color !== undefined) {
      updates.color = input.color;
    }

    if (Object.keys(updates).length === 0) {
      return this.findById(id);
    }

    try {
      await db.update(tagsTable).set(updates).where(eq(tagsTable.id, id));

      return this.findById(id);
    } catch (error: any) {
      if (error.code === "23505") {
        // UNIQUE violation
        throw new ConflictError(
          `Tag with name "${input.name}" already exists at this level`,
        );
      }
      throw error;
    }
  }

  async delete(id: number): Promise<void> {
    await this.findById(id); // Ensure exists
    // CASCADE will delete children due to schema constraint
    await db.delete(tagsTable).where(eq(tagsTable.id, id));
  }

  async getVideos(tagId: number): Promise<Video[]> {
    await this.findById(tagId); // Ensure tag exists

    // Use raw query to join with videos table
    const videos = await db.execute<any>(sql`
      SELECT v.* FROM videos v
      INNER JOIN video_tags vt ON v.id = vt.video_id
      WHERE vt.tag_id = ${tagId}
      ORDER BY v.created_at DESC
    `);

    const results = Array.isArray(videos) ? videos : [];
    return results;
  }

  async addToVideo(videoId: number, tagId: number): Promise<void> {
    // Verify tag exists
    await this.findById(tagId);

    try {
      await db.insert(videoTagsTable).values({
        videoId,
        tagId,
      });
    } catch (error: any) {
      if (error.code === "23505") {
        // UNIQUE violation
        throw new ConflictError("Tag is already associated with this video");
      }
      if (error.code === "23503") {
        // FOREIGN KEY violation
        throw new NotFoundError(`Video not found with id: ${videoId}`);
      }
      throw error;
    }
  }

  async removeFromVideo(videoId: number, tagId: number): Promise<void> {
    await db
      .delete(videoTagsTable)
      .where(
        sql`${videoTagsTable.videoId} = ${videoId} AND ${videoTagsTable.tagId} = ${tagId}`,
      );

    // Note: Drizzle postgres-js doesn't return rowCount, so we can't check if deletion happened
    // The delete will silently succeed even if no rows match
  }

  async getTagsForVideo(videoId: number): Promise<Tag[]> {
    const tags = await db.execute<{
      id: number;
      name: string;
      parent_id: number | null;
      description: string | null;
      color: string | null;
      created_at: Date;
      updated_at: Date;
    }>(sql`
      SELECT t.* FROM tags t
      INNER JOIN video_tags vt ON t.id = vt.tag_id
      WHERE vt.video_id = ${videoId}
      ORDER BY t.name ASC
    `);

    const results = Array.isArray(tags) ? tags : [];
    return results.map((row: any) => ({
      id: Number(row.id),
      name: row.name,
      parent_id: row.parent_id != null ? Number(row.parent_id) : null,
      description: row.description,
      color: row.color,
      created_at: this.toIsoString(row.created_at),
      updated_at: this.toIsoString(row.updated_at),
    }));
  }

  // Helper to safely convert Date or string to ISO string
  private toIsoString(val: unknown): string {
    if (val instanceof Date) return val.toISOString();
    if (typeof val === "string") return val;
    return new Date().toISOString(); // fallback
  }

  // Helper to map Drizzle result to snake_case API format
  private mapToSnakeCase(tag: any): Tag {
    return {
      id: Number(tag.id),
      name: tag.name,
      parent_id: tag.parentId != null ? Number(tag.parentId) : null,
      description: tag.description,
      color: tag.color,
      created_at: this.toIsoString(tag.createdAt),
      updated_at: this.toIsoString(tag.updatedAt),
    };
  }
}

export const tagsService = new TagsService();
