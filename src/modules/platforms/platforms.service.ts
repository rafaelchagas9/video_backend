import { getDatabase } from '@/config/database';
import { NotFoundError, ConflictError } from '@/utils/errors';
import type { Platform, CreatePlatformInput } from './platforms.types';

export class PlatformsService {
  private get db() {
    return getDatabase();
  }

  async list(): Promise<Platform[]> {
    return this.db.prepare('SELECT * FROM platforms ORDER BY name ASC').all() as Platform[];
  }

  async findById(id: number): Promise<Platform> {
    const platform = this.db
      .prepare('SELECT * FROM platforms WHERE id = ?')
      .get(id) as Platform | undefined;

    if (!platform) {
      throw new NotFoundError(`Platform not found with id: ${id}`);
    }

    return platform;
  }

  async findByName(name: string): Promise<Platform | undefined> {
    return this.db
      .prepare('SELECT * FROM platforms WHERE name = ?')
      .get(name) as Platform | undefined;
  }

  async create(input: CreatePlatformInput): Promise<Platform> {
    try {
      const result = this.db
        .prepare('INSERT INTO platforms (name, base_url) VALUES (?, ?)')
        .run(input.name, input.base_url || null);

      return this.findById(result.lastInsertRowid as number);
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new ConflictError(`Platform with name "${input.name}" already exists`);
      }
      throw error;
    }
  }

  async delete(id: number): Promise<void> {
    await this.findById(id); // Ensure exists
    this.db.prepare('DELETE FROM platforms WHERE id = ?').run(id);
  }
}

export const platformsService = new PlatformsService();
