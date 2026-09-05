import { eq, sql, isNull, or, and, ilike, inArray, asc, getTableColumns } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import {
  tagAliasesTable,
  tagCategoriesTable,
  tagsTable,
  videoTagsTable,
} from "@/database/schema";
import { demoSchema, getDemoDatabase } from "@/database/demo";
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
  TagCategoryWithCount,
  TagInclude,
} from "./tags.types";
import type { Video } from "@/modules/videos/videos.types";
import { tagsDemoService } from "./tags.demo.service";
import { videosDemoService } from "@/modules/videos/videos.demo.service";

export class TagsService {
  async listCategories(): Promise<TagCategoryWithCount[]> {
    if (env.DEMO_MODE) {
      const rows = getDemoDatabase()
        .select({
          id: demoSchema.demoTagCategoriesTable.id,
          name: demoSchema.demoTagCategoriesTable.name,
          group: demoSchema.demoTagCategoriesTable.group,
          description: demoSchema.demoTagCategoriesTable.description,
          tagCount: sql<number>`count(${demoSchema.demoTagsTable.id})`,
        })
        .from(demoSchema.demoTagCategoriesTable)
        .leftJoin(
          demoSchema.demoTagsTable,
          eq(
            demoSchema.demoTagsTable.categoryId,
            demoSchema.demoTagCategoriesTable.id
          )
        )
        .groupBy(demoSchema.demoTagCategoriesTable.id)
        .orderBy(
          asc(demoSchema.demoTagCategoriesTable.group),
          asc(demoSchema.demoTagCategoriesTable.name)
        )
        .all();
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        group: row.group,
        description: row.description,
        tag_count: Number(row.tagCount),
      }));
    }

    const rows = await db
      .select({
        id: tagCategoriesTable.id,
        name: tagCategoriesTable.name,
        group: tagCategoriesTable.group,
        description: tagCategoriesTable.description,
        tagCount: sql<number>`count(${tagsTable.id})`,
      })
      .from(tagCategoriesTable)
      .leftJoin(tagsTable, eq(tagsTable.categoryId, tagCategoriesTable.id))
      .groupBy(tagCategoriesTable.id)
      .orderBy(tagCategoriesTable.group, tagCategoriesTable.name);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      group: row.group,
      description: row.description,
      tag_count: Number(row.tagCount),
    }));
  }

  async list(options: ListTagsOptions = {}): Promise<PaginatedTags> {
    if (env.DEMO_MODE) {
      const page = options.page ?? 1;
      const limit = options.limit ?? 20;
      const countRows = getDemoDatabase()
        .select({
          tagId: demoSchema.demoVideoTagsTable.tagId,
          videoCount: sql<number>`count(*)`,
        })
        .from(demoSchema.demoVideoTagsTable)
        .groupBy(demoSchema.demoVideoTagsTable.tagId)
        .all();
      const counts = new Map(
        countRows.map((row) => [row.tagId, Number(row.videoCount)]),
      );
      const allTags = tagsDemoService.list().map((tag) => ({
        ...tag,
        video_count: counts.get(tag.id) ?? 0,
      }));
      let tags = allTags;

      const aliases = getDemoDatabase()
        .select()
        .from(demoSchema.demoTagAliasesTable)
        .all();
      const categoryAssignments = getDemoDatabase()
        .select({
          id: demoSchema.demoTagsTable.id,
          categoryId: demoSchema.demoTagsTable.categoryId,
        })
        .from(demoSchema.demoTagsTable)
        .all();

      if (options.search) {
        const search = options.search.toLowerCase();
        tags = tags.filter(
          (tag) =>
            tag.name.toLowerCase().includes(search) ||
            tag.description?.toLowerCase().includes(search) ||
            aliases.some(
              (alias) =>
                alias.tagId === tag.id &&
                alias.name.toLowerCase().includes(search)
            )
        );
      }
      if (options.category_id !== undefined) {
        const matchingIds = new Set(
          categoryAssignments
            .filter((row) => row.categoryId === options.category_id)
            .map((row) => row.id)
        );
        tags = tags.filter((tag) => matchingIds.has(tag.id));
      }

      tags.sort((left, right) =>
        options.sort === "video_count"
          ? (left.video_count ?? 0) - (right.video_count ?? 0) ||
            left.name.localeCompare(right.name)
          : options.sort === "created_at"
            ? left.created_at.localeCompare(right.created_at)
            : left.name.localeCompare(right.name),
      );
      if (options.order === "desc") {
        tags.reverse();
      }

      let result: Tag[] | TagTreeNode[];
      if (options.tree) {
        const rootIds = new Set<number>();
        for (const match of tags) {
          let current = match;
          const visited = new Set<number>();
          while (current.parent_id !== null && !visited.has(current.id)) {
            visited.add(current.id);
            const parent = allTags.find((tag) => tag.id === current.parent_id);
            if (!parent) break;
            current = parent;
          }
          rootIds.add(current.id);
        }
        const expanded = await this.attachIncludes(
          allTags,
          options.include ?? []
        );
        result = this.buildTree(expanded)
          .filter((root) => rootIds.has(root.id))
          .sort((left, right) =>
            options.sort === "video_count"
              ? (left.video_count ?? 0) - (right.video_count ?? 0) ||
                left.name.localeCompare(right.name)
              : options.sort === "created_at"
                ? left.created_at.localeCompare(right.created_at)
                : left.name.localeCompare(right.name),
          );
        if (options.order === "desc") result.reverse();
      } else {
        result = await this.attachIncludes(tags, options.include ?? []);
      }
      const total = result.length;
      return {
        data: result.slice((page - 1) * limit, page * limit),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
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
      return this.listTreeWithPagination(
        page,
        limit,
        search,
        sort,
        order,
        options.category_id,
        options.include ?? []
      );
    }

    // Build WHERE conditions
    const whereClauses = [];
    if (search) {
      whereClauses.push(or(
        ilike(tagsTable.name, `%${search}%`),
        ilike(tagsTable.description, `%${search}%`),
        sql`EXISTS (
          SELECT 1 FROM tag_aliases ta
          WHERE ta.tag_id = ${tagsTable.id}
            AND ta.name ILIKE ${`%${search}%`}
        )`
      ));
    }
    if (options.category_id !== undefined) {
      whereClauses.push(eq(tagsTable.categoryId, options.category_id));
    }

    const whereCondition =
      whereClauses.length > 0 ? and(...whereClauses) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(tagsTable)
      .where(whereCondition)
      .then((rows) => rows[0]);

    const total = Number(countResult?.count || 0);
    const totalPages = Math.ceil(total / limit);

    // Get tags with sorting
    const validSortColumns = ["name", "created_at", "video_count"];
    const sortColumn = validSortColumns.includes(sort) ? sort : "name";
    const videoCountExpression = sql<number>`(
      SELECT count(*) FROM ${videoTagsTable} vt_count
      WHERE vt_count.tag_id = ${tagsTable.id}
    )`;
    const sortField = sortColumn === "video_count"
      ? videoCountExpression
      : sortColumn === "created_at"
        ? tagsTable.createdAt
        : tagsTable.name;
    const sortOrder = order === "asc" ? sql`asc` : sql`desc`;

    const tags = await db
      .select({ ...getTableColumns(tagsTable), videoCount: videoCountExpression })
      .from(tagsTable)
      .where(whereCondition)
      .orderBy(sql`${sortField} ${sortOrder}`)
      .limit(limit)
      .offset(offset);

    return {
      data: await this.attachIncludes(
        tags.map((tag) => this.mapToSnakeCase(tag)),
        options.include ?? []
      ),
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
    categoryId: number | undefined,
    include: TagInclude[]
  ): Promise<PaginatedTags> {
    const offset = (page - 1) * limit;

    const videoCountExpression = sql<number>`(
      SELECT count(*) FROM ${videoTagsTable} vt_count
      WHERE vt_count.tag_id = ${tagsTable.id}
    )`;
    const sortField = sortColumn === "video_count"
      ? videoCountExpression
      : sortColumn === "created_at"
        ? tagsTable.createdAt
        : tagsTable.name;
    const sortDir = sortOrder === "asc" ? sql`asc` : sql`desc`;

    let countResult;
    let rootTags;

    if (search || categoryId !== undefined) {
      const searchPattern = search ? `%${search}%` : null;
      const matchingRootsSubquery = sql`
        WITH RECURSIVE matching_roots AS (
          SELECT id, parent_id
          FROM tags
          WHERE
            (${searchPattern}::text IS NULL OR name ILIKE ${searchPattern}
              OR description ILIKE ${searchPattern}
              OR EXISTS (
                SELECT 1 FROM tag_aliases ta
                WHERE ta.tag_id = tags.id AND ta.name ILIKE ${searchPattern}
              ))
            AND (${categoryId ?? null}::int IS NULL OR category_id = ${categoryId ?? null})
          
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
        .select({ ...getTableColumns(tagsTable), videoCount: videoCountExpression })
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
        .select({ ...getTableColumns(tagsTable), videoCount: videoCountExpression })
        .from(tagsTable)
        .where(whereCondition)
        .orderBy(sql`${sortField} ${sortDir}`)
        .limit(limit)
        .offset(offset);
    }

    const total = Number(countResult?.count || 0);
    const totalPages = Math.ceil(total / limit);

    // Fetch all tags once to build tree in-memory
    const allTagRows = await db
      .select({ ...getTableColumns(tagsTable), videoCount: videoCountExpression })
      .from(tagsTable);
    const allTags = await this.attachIncludes(
      allTagRows.map((tag) => this.mapToSnakeCase(tag)),
      include
    );

    // Build tree with children
    const treeWithChildren = await Promise.all(
      rootTags.map((tag) => this.buildTreeWithDescendants(tag.id, allTags))
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

  private async buildTreeWithDescendants(
    tagId: number,
    preFetchedTags?: Tag[]
  ): Promise<TagTreeNode> {
    const allTags: Tag[] =
      preFetchedTags ??
      (await this.list({ limit: 10000 }).then((r) => (r.data as Tag[]) || []));

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
    parentId: number | null = null
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
      return tagsDemoService.findById(id);
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

  async findByIdWithPath(
    id: number,
    include: TagInclude[] = []
  ): Promise<TagWithPath> {
    if (env.DEMO_MODE) {
      const [tag] = await this.attachIncludes([await this.findById(id)], include);
      const ancestors = await this.getAncestors(id);
      return {
        ...tag,
        path: [...ancestors.map((ancestor) => ancestor.name), tag.name].join(
          " > "
        ),
      };
    }

    const [tag] = await this.attachIncludes([await this.findById(id)], include);
    const ancestors = await this.getAncestors(id);
    const path = [...ancestors.map((a) => a.name), tag.name].join(" > ");

    return { ...tag, path };
  }

  async getAncestors(id: number): Promise<Tag[]> {
    if (env.DEMO_MODE) {
      const tags = tagsDemoService.list();
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
      return tagsDemoService.getDescendants(id);
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
      return tagsDemoService.getChildren(id);
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
      return tagsDemoService.create(input);
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
          `Tag with name "${input.name}" already exists at this level`
        );
      }
      throw error;
    }
  }

  async update(id: number, input: UpdateTagInput): Promise<Tag> {
    if (env.DEMO_MODE) {
      return tagsDemoService.update(id, input);
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
          `Tag with name "${input.name}" already exists at this level`
        );
      }
      throw error;
    }
  }

  async delete(id: number): Promise<void> {
    if (env.DEMO_MODE) {
      tagsDemoService.delete(id);
      return;
    }

    await this.findById(id); // Ensure exists
    // CASCADE will delete children due to schema constraint
    await db.delete(tagsTable).where(eq(tagsTable.id, id));

    // Enrichment suggestions/runs are polymorphic (no FK) — clean up explicitly.
    const { enrichmentService } =
      await import("@/modules/enrichment/enrichment.service");
    await enrichmentService.deleteForEntity("tag", id);
  }

  async getVideos(tagId: number): Promise<Video[]> {
    if (env.DEMO_MODE) {
      const descendants = await this.getDescendants(tagId);
      const tagIds = [tagId, ...descendants.map((d) => d.id)];
      const { demoRepository } = await import("@/database/demo/repository");
      const videosObj = demoRepository.getVideos({ tagIds, limit: 100 });
      return videosObj.data as Video[];
    }

    await this.findById(tagId); // Ensure tag exists

    const descendants = await this.getDescendants(tagId);
    const tagIds = [tagId, ...descendants.map((d) => d.id)];

    const videos = await db.execute<
      Record<string, unknown> & { thumbnail_id?: unknown }
    >(sql`
      SELECT DISTINCT 
        v.*, 
        CASE WHEN EXISTS (SELECT 1 FROM video_studios vs_status WHERE vs_status.video_id = v.id) THEN 'assigned'
             WHEN v.studio_absence_confirmed_at IS NOT NULL THEN 'confirmed_none'
             ELSE 'unknown' END AS studio_assignment_status,
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
      thumbnail_url:
        row.thumbnail_id != null
          ? `${API_PREFIX}/thumbnails/${row.thumbnail_id}/image`
          : null,
    })) as unknown as Video[];
  }

  async addToVideo(videoId: number, tagId: number): Promise<void> {
    if (env.DEMO_MODE) {
      videosDemoService.updateRelationships([videoId], "tags", [tagId], "add");
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
          eq(videoTagsTable.tagId, tagId)
        )
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
      videosDemoService.updateRelationships(
        [videoId],
        "tags",
        [tagId],
        "remove"
      );
      return;
    }

    await db
      .delete(videoTagsTable)
      .where(
        sql`${videoTagsTable.videoId} = ${videoId} AND ${videoTagsTable.tagId} = ${tagId}`
      );

    // Note: Drizzle postgres-js doesn't return rowCount, so we can't check if deletion happened
    // The delete will silently succeed even if no rows match
  }

  async getTagsForVideo(videoId: number): Promise<Tag[]> {
    if (env.DEMO_MODE) {
      const { demoRepository } = await import("@/database/demo/repository");
      const video = demoRepository.getVideoById(videoId);
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
      const { demoRepository } = await import("@/database/demo/repository");
      for (const id of videoIds) {
        try {
          const video = demoRepository.getVideoById(id);
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

  private async attachIncludes(tags: Tag[], include: TagInclude[]): Promise<Tag[]> {
    if (tags.length === 0 || include.length === 0) return tags;
    const ids = tags.map((tag) => tag.id);
    const wantsCategory = include.includes("category");
    const wantsAliases = include.includes("aliases");

    const assignments = wantsCategory
      ? env.DEMO_MODE
        ? getDemoDatabase()
            .select({
              tagId: demoSchema.demoTagsTable.id,
              categoryId: demoSchema.demoTagsTable.categoryId,
            })
            .from(demoSchema.demoTagsTable)
            .where(inArray(demoSchema.demoTagsTable.id, ids))
            .all()
        : await db
            .select({ tagId: tagsTable.id, categoryId: tagsTable.categoryId })
            .from(tagsTable)
            .where(inArray(tagsTable.id, ids))
      : [];
    const categoryIds = assignments.flatMap((row) =>
      row.categoryId === null ? [] : [row.categoryId]
    );
    const categories = !wantsCategory || categoryIds.length === 0
      ? []
      : env.DEMO_MODE
        ? getDemoDatabase()
            .select()
            .from(demoSchema.demoTagCategoriesTable)
            .where(inArray(demoSchema.demoTagCategoriesTable.id, categoryIds))
            .all()
        : await db
            .select()
            .from(tagCategoriesTable)
            .where(inArray(tagCategoriesTable.id, categoryIds));
    const aliases = !wantsAliases
      ? []
      : env.DEMO_MODE
        ? getDemoDatabase()
            .select()
            .from(demoSchema.demoTagAliasesTable)
            .where(inArray(demoSchema.demoTagAliasesTable.tagId, ids))
            .orderBy(asc(demoSchema.demoTagAliasesTable.name))
            .all()
        : await db
            .select()
            .from(tagAliasesTable)
            .where(inArray(tagAliasesTable.tagId, ids))
            .orderBy(tagAliasesTable.name);

    return tags.map((tag) => {
      const assignment = assignments.find((row) => row.tagId === tag.id);
      const category = categories.find(
        (row) => row.id === assignment?.categoryId
      );
      return {
        ...tag,
        ...(wantsCategory
          ? {
              category: category
                ? {
                    id: category.id,
                    name: category.name,
                    group: category.group,
                    description: category.description,
                  }
                : null,
            }
          : {}),
        ...(wantsAliases
          ? {
              aliases: aliases
                .filter((alias) => alias.tagId === tag.id)
                .map((alias) => ({
                  id: alias.id,
                  name: alias.name,
                  note: alias.note,
                })),
            }
          : {}),
      };
    });
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
      ...(tag.videoCount !== undefined || tag.video_count !== undefined
        ? { video_count: Number(tag.videoCount ?? tag.video_count ?? 0) }
        : {}),
    };
  }
}

export const tagsService = new TagsService();
