import { getDatabase } from '@/config/database';
import { NotFoundError, ConflictError } from '@/utils/errors';
import type {
  Tag,
  TagWithPath,
  TagTreeNode,
  CreateTagInput,
  UpdateTagInput,
} from './tags.types';
import type { Video } from '@/modules/videos/videos.types';

export class TagsService {
  private get db() {
    return getDatabase();
  }

  async list(): Promise<Tag[]> {
    return this.db
      .prepare('SELECT * FROM tags ORDER BY name ASC')
      .all() as Tag[];
  }

  async getTree(): Promise<TagTreeNode[]> {
    const tags = await this.list();
    return this.buildTree(tags);
  }

  private buildTree(tags: Tag[], parentId: number | null = null): TagTreeNode[] {
    return tags
      .filter((tag) => tag.parent_id === parentId)
      .map((tag) => ({
        ...tag,
        children: this.buildTree(tags, tag.id),
      }));
  }

  async findById(id: number): Promise<Tag> {
    const tag = this.db
      .prepare('SELECT * FROM tags WHERE id = ?')
      .get(id) as Tag | undefined;

    if (!tag) {
      throw new NotFoundError(`Tag not found with id: ${id}`);
    }

    return tag;
  }

  async findByIdWithPath(id: number): Promise<TagWithPath> {
    const tag = await this.findById(id);
    const ancestors = await this.getAncestors(id);
    const path = [...ancestors.map((a) => a.name), tag.name].join(' > ');

    return { ...tag, path };
  }

  async getAncestors(id: number): Promise<Tag[]> {
    // Recursive CTE to get all ancestors
    const ancestors = this.db
      .prepare(
        `WITH RECURSIVE ancestors AS (
          SELECT t.* FROM tags t WHERE t.id = (
            SELECT parent_id FROM tags WHERE id = ?
          )
          UNION ALL
          SELECT t.* FROM tags t
          INNER JOIN ancestors a ON t.id = a.parent_id
        )
        SELECT * FROM ancestors`
      )
      .all(id) as Tag[];

    return ancestors.reverse(); // Root first
  }

  async getDescendants(id: number): Promise<Tag[]> {
    // Recursive CTE to get all descendants
    return this.db
      .prepare(
        `WITH RECURSIVE descendants AS (
          SELECT * FROM tags WHERE parent_id = ?
          UNION ALL
          SELECT t.* FROM tags t
          INNER JOIN descendants d ON t.parent_id = d.id
        )
        SELECT * FROM descendants ORDER BY name ASC`
      )
      .all(id) as Tag[];
  }

  async getChildren(id: number): Promise<Tag[]> {
    await this.findById(id); // Ensure exists

    return this.db
      .prepare('SELECT * FROM tags WHERE parent_id = ? ORDER BY name ASC')
      .all(id) as Tag[];
  }

  async create(input: CreateTagInput): Promise<Tag> {
    // Verify parent exists if provided
    if (input.parent_id) {
      await this.findById(input.parent_id);
    }

    try {
      const result = this.db
        .prepare(
          'INSERT INTO tags (name, parent_id, description, color) VALUES (?, ?, ?, ?)'
        )
        .run(input.name, input.parent_id || null, input.description || null, input.color || null);

      return this.findById(result.lastInsertRowid as number);
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new ConflictError(
          `Tag with name "${input.name}" already exists at this level`
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
        throw new ConflictError('A tag cannot be its own parent');
      }

      // Check if new parent is a descendant
      const descendants = await this.getDescendants(id);
      if (descendants.some((d) => d.id === input.parent_id)) {
        throw new ConflictError('Cannot set a descendant as parent');
      }
    }

    const updates: string[] = [];
    const values: any[] = [];

    if (input.name !== undefined) {
      updates.push('name = ?');
      values.push(input.name);
    }

    if (input.parent_id !== undefined) {
      updates.push('parent_id = ?');
      values.push(input.parent_id);
    }

    if (input.description !== undefined) {
      updates.push('description = ?');
      values.push(input.description);
    }

    if (input.color !== undefined) {
      updates.push('color = ?');
      values.push(input.color);
    }

    if (updates.length === 0) {
      return this.findById(id);
    }

    updates.push("updated_at = datetime('now')");
    values.push(id);

    try {
      this.db
        .prepare(`UPDATE tags SET ${updates.join(', ')} WHERE id = ?`)
        .run(...values);

      return this.findById(id);
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new ConflictError(
          `Tag with name "${input.name}" already exists at this level`
        );
      }
      throw error;
    }
  }

  async delete(id: number): Promise<void> {
    await this.findById(id); // Ensure exists
    // CASCADE will delete children due to schema constraint
    this.db.prepare('DELETE FROM tags WHERE id = ?').run(id);
  }

  async getVideos(tagId: number): Promise<Video[]> {
    await this.findById(tagId); // Ensure tag exists

    return this.db
      .prepare(
        `SELECT v.* FROM videos v
         INNER JOIN video_tags vt ON v.id = vt.video_id
         WHERE vt.tag_id = ?
         ORDER BY v.created_at DESC`
      )
      .all(tagId) as Video[];
  }

  async addToVideo(videoId: number, tagId: number): Promise<void> {
    // Verify tag exists
    await this.findById(tagId);

    try {
      this.db
        .prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)')
        .run(videoId, tagId);
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new ConflictError('Tag is already associated with this video');
      }
      if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        throw new NotFoundError(`Video not found with id: ${videoId}`);
      }
      throw error;
    }
  }

  async removeFromVideo(videoId: number, tagId: number): Promise<void> {
    const result = this.db
      .prepare('DELETE FROM video_tags WHERE video_id = ? AND tag_id = ?')
      .run(videoId, tagId);

    if (result.changes === 0) {
      throw new NotFoundError('Tag association not found');
    }
  }

  async getTagsForVideo(videoId: number): Promise<Tag[]> {
    return this.db
      .prepare(
        `SELECT t.* FROM tags t
         INNER JOIN video_tags vt ON t.id = vt.tag_id
         WHERE vt.video_id = ?
         ORDER BY t.name ASC`
      )
      .all(videoId) as Tag[];
  }
}

export const tagsService = new TagsService();
