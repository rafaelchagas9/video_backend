import { eq, sql, isNull, or, and, ilike } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { tagsTable, videoTagsTable } from "@/database/schema";
import {
  NotFoundError,
  ConflictError,
  isUniqueViolation,
  isForeignKeyViolation,
} from "@/utils/errors";
import { API_PREFIX } from "@/config/constants";
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
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      const tags = demoMockService.getTags() as Tag[];
      return {
        data: tags,
        pagination: {
          page: 1,
          limit: 10000,
          total: tags.length,
          totalPages: 1
        }
      };
    }
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
          ilike(tagsTable.name, `%${search}%`),
          ilike(tagsTable.description, `%${search}%`),
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

    const sortField =
      sortColumn === "created_at" ? tagsTable.createdAt : tagsTable.name;
    const sortDir = sortOrder === "asc" ? sql`asc` : sql`desc`;

    let countResult;
    let rootTags;

    if (search) {
      const searchPattern = `%${search}%`;
      const matchingRootsSubquery = sql`
        WITH RECURSIVE matching_roots AS (
          SELECT id, parent_id
          FROM tags
          WHERE name ILIKE ${searchPattern} OR description ILIKE ${searchPattern}
          
          UNION ALL
          
          SELECT t.id, t.parent_id
          FROM tags t
          INNER JOIN matching_roots mr ON t.id = mr.parent_id
        )
        SELECT id FROM matching_roots WHERE parent_id IS NULL
      `;

      countResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(tagsTable)
        .where(sql`id IN (${matchingRootsSubquery})`)
        .then((rows) => rows[0]);

      rootTags = await db
        .select()
        .from(tagsTable)
        .where(sql`id IN (${matchingRootsSubquery})`)
        .orderBy(sql`${sortField} ${sortDir}`)
        .limit(limit)
        .offset(offset);
    } else {
      const whereCondition = isNull(tagsTable.parentId);

      countResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(tagsTable)
        .where(whereCondition)
        .then((rows) => rows[0]);

      rootTags = await db
        .select()
        .from(tagsTable)
        .where(whereCondition)
        .orderBy(sql`${sortField} ${sortDir}`)
        .limit(limit)
        .offset(offset);
    }

    const total = Number(countResult?.count || 0);
    const totalPages = Math.ceil(total / limit);

    // Fetch all tags once to build tree in-memory
    const allTags = await this.list({ limit: 10000 }).then((r) => r.data as Tag[]);

    // Build tree with children
    const treeWithChildren = await Promise.all(
      rootTags.map((tag) => this.buildTreeWithDescendants(tag.id, allTags)),
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

  private async buildTreeWithDescendants(tagId: number, preFetchedTags?: Tag[]): Promise<TagTreeNode> {
    const allTags: Tag[] = preFetchedTags ?? (await this.list({ limit: 10000 }).then((r) => (r.data as Tag[]) || []));

    const tag = allTags.find((t) => t.id === tagId);
    if (!tag) {
      throw new NotFoundError(`Tag not found with id: ${tagId}`);
    }

    const buildNode = (nodeId: number): TagTreeNode => {
      const node = allTags.find((t) => t.id === nodeId)!;
      const children = allTags
        .filter((t) => t.parent_id === nodeId)
        .sort((a, b) => a.name.localeCompare(b.name));

      return {
        ...node,
        children: children.map((child) => buildNode(child.id)),
      };
    };

    return buildNode(tagId);
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
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      const tag = demoMockService.getTags().find((t) => t.id === id);
      if (!tag) {
        throw new NotFoundError(`Tag not found with id: ${id}`);
      }
      return tag;
    }

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
    if (env.DEMO_MODE) {
      const tag = await this.findById(id);
      return { ...tag, path: tag.name };
    }

    const tag = await this.findById(id);
    const ancestors = await this.getAncestors(id);
    const path = [...ancestors.map((a) => a.name), tag.name].join(" > ");

    return { ...tag, path };
  }

  async getAncestors(id: number): Promise<Tag[]> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      const tags = demoMockService.getTags();
      const ancestors: Tag[] = [];
      let current = tags.find((t) => t.id === id);
      while (current && current.parent_id !== null) {
        const parent = tags.find((t) => t.id === current!.parent_id);
        if (parent) {
          ancestors.unshift(parent);
          current = parent;
        } else {
          break;
        }
      }
      return ancestors;
    }

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
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      const tags = demoMockService.getTags();
      const descendants: Tag[] = [];
      const queue = [id];
      while (queue.length > 0) {
        const currentId = queue.shift()!;
        const children = tags.filter((t) => t.parent_id === currentId);
        for (const child of children) {
          descendants.push(child);
          queue.push(child.id);
        }
      }
      return descendants;
    }

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
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      const tags = demoMockService.getTags();
      return tags.filter((t) => t.parent_id === id);
    }

    await this.findById(id); // Ensure exists

    const children = await db
      .select()
      .from(tagsTable)
      .where(eq(tagsTable.parentId, id))
      .orderBy(tagsTable.name);

    return children.map((child) => this.mapToSnakeCase(child));
  }

  async create(input: CreateTagInput): Promise<Tag> {
    if (env.DEMO_MODE) {
      return {
        id: 9999,
        name: input.name,
        parent_id: input.parent_id || null,
        description: input.description || null,
        color: input.color || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    }

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
      if (isUniqueViolation(error)) {
        // UNIQUE violation
        throw new ConflictError(
          `Tag with name "${input.name}" already exists at this level`,
        );
      }
      throw error;
    }
  }

  async update(id: number, input: UpdateTagInput): Promise<Tag> {
    if (env.DEMO_MODE) {
      const tag = await this.findById(id);
      return {
        ...tag,
        name: input.name !== undefined ? input.name : tag.name,
        parent_id: input.parent_id !== undefined ? input.parent_id : tag.parent_id,
        description: input.description !== undefined ? input.description : tag.description,
        color: input.color !== undefined ? input.color : tag.color,
      };
    }

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
      if (isUniqueViolation(error)) {
        // UNIQUE violation
        throw new ConflictError(
          `Tag with name "${input.name}" already exists at this level`,
        );
      }
      throw error;
    }
  }

  async delete(id: number): Promise<void> {
    if (env.DEMO_MODE) {
      return;
    }

    await this.findById(id); // Ensure exists
    // CASCADE will delete children due to schema constraint
    await db.delete(tagsTable).where(eq(tagsTable.id, id));
  }

  async getVideos(tagId: number): Promise<Video[]> {
    if (env.DEMO_MODE) {
      const descendants = await this.getDescendants(tagId);
      const tagIds = [tagId, ...descendants.map((d) => d.id)];
      const { demoMockService } = await import("@/utils/demo-mock");
      const videosObj = demoMockService.getVideos({ tagIds, limit: 100 });
      return videosObj.data as Video[];
    }

    await this.findById(tagId); // Ensure tag exists

    const descendants = await this.getDescendants(tagId);
    const tagIds = [tagId, ...descendants.map((d) => d.id)];

    const videos = await db.execute<Record<string, unknown> & { thumbnail_id?: unknown }>(sql`
      SELECT DISTINCT 
        v.*, 
        t.id as thumbnail_id
      FROM videos v
      INNER JOIN video_tags vt ON v.id = vt.video_id
      LEFT JOIN thumbnails t ON v.id = t.video_id
      WHERE vt.tag_id = ANY(${sql.raw(`ARRAY[${tagIds.join(",")}]::int[]`)})
      ORDER BY v.created_at DESC
    `);

    const results = Array.isArray(videos) ? videos : [];
    return results.map((row) => ({
      ...row,
      thumbnail_id: row.thumbnail_id != null ? Number(row.thumbnail_id) : null,
      thumbnail_url: row.thumbnail_id != null
        ? `${API_PREFIX}/thumbnails/${row.thumbnail_id}/image`
        : null,
    })) as unknown as Video[];
  }

  async addToVideo(videoId: number, tagId: number): Promise<void> {
    if (env.DEMO_MODE) {
      return;
    }

    // Verify tag exists
    await this.findById(tagId);

    // Double check if already associated to prevent duplicate records
    const existing = await db
      .select()
      .from(videoTagsTable)
      .where(
        and(
          eq(videoTagsTable.videoId, videoId),
          eq(videoTagsTable.tagId, tagId),
        ),
      )
      .limit(1);

    if (existing && existing.length > 0) {
      throw new ConflictError("Tag is already associated with this video");
    }

    try {
      await db.insert(videoTagsTable).values({
        videoId,
        tagId,
      });
    } catch (error: any) {
      if (isUniqueViolation(error)) {
        // UNIQUE violation
        throw new ConflictError("Tag is already associated with this video");
      }
      if (isForeignKeyViolation(error)) {
        // FOREIGN KEY violation
        throw new NotFoundError(`Video not found with id: ${videoId}`);
      }
      throw error;
    }
  }

  async removeFromVideo(videoId: number, tagId: number): Promise<void> {
    if (env.DEMO_MODE) {
      return;
    }

    await db
      .delete(videoTagsTable)
      .where(
        sql`${videoTagsTable.videoId} = ${videoId} AND ${videoTagsTable.tagId} = ${tagId}`,
      );

    // Note: Drizzle postgres-js doesn't return rowCount, so we can't check if deletion happened
    // The delete will silently succeed even if no rows match
  }

  async getTagsForVideo(videoId: number): Promise<Tag[]> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      const video = demoMockService.getVideoById(videoId);
      return video.tags || [];
    }
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

  async getTagsForVideos(videoIds: number[]): Promise<Map<number, Tag[]>> {
    const grouped = new Map<number, Tag[]>();
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      for (const id of videoIds) {
        try {
          const video = demoMockService.getVideoById(id);
          grouped.set(id, video.tags || []);
        } catch {
          // ignore
        }
      }
      return grouped;
    }
    if (videoIds.length === 0) {
      return grouped;
    }

    const rows = await db.execute<{
      video_id: number;
      id: number;
      name: string;
      parent_id: number | null;
      description: string | null;
      color: string | null;
      created_at: Date;
      updated_at: Date;
    }>(sql`
      SELECT
        vt.video_id,
        t.id,
        t.name,
        t.parent_id,
        t.description,
        t.color,
        t.created_at,
        t.updated_at
      FROM tags t
      INNER JOIN video_tags vt ON t.id = vt.tag_id
      WHERE vt.video_id = ANY(${sql.raw(`ARRAY[${videoIds.join(",")}]::int[]`)})
      ORDER BY vt.video_id ASC, t.name ASC
    `);

    const results = Array.isArray(rows) ? rows : [];
    for (const row of results) {
      const tag: Tag = {
        id: Number(row.id),
        name: row.name,
        parent_id: row.parent_id != null ? Number(row.parent_id) : null,
        description: row.description,
        color: row.color,
        created_at: this.toIsoString(row.created_at),
        updated_at: this.toIsoString(row.updated_at),
      };
      const existing = grouped.get(Number(row.video_id)) ?? [];
      existing.push(tag);
      grouped.set(Number(row.video_id), existing);
    }

    return grouped;
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
