import { eq, and } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { creatorAliasesTable, creatorsTable } from "@/database/schema";
import { NotFoundError, ConflictError } from "@/utils/errors";
import type {
  Alias,
  CreateAliasInput,
  UpdateAliasInput,
  BulkAliasItem,
  BulkOperationResult,
} from "./creators.types";

export class CreatorsAliasesService {
  async addAlias(creatorId: number, input: CreateAliasInput): Promise<Alias> {
    await this.verifyCreatorExists(creatorId);

    try {
      const result = await db
        .insert(creatorAliasesTable)
        .values({
          creatorId,
          name: input.name,
          note: input.note ?? null,
        })
        .returning({ id: creatorAliasesTable.id });

      if (!result || result.length === 0) {
        throw new Error("Failed to add alias");
      }

      return this.findAliasById(result[0].id);
    } catch (error: any) {
      if (error.code === "23505") {
        throw new ConflictError("This alias already exists for the creator");
      }
      throw error;
    }
  }

  async updateAlias(id: number, input: UpdateAliasInput): Promise<Alias> {
    await this.findAliasById(id); // Ensure exists

    const updates: any = {};

    if (input.name !== undefined) {
      updates.name = input.name;
    }

    if (input.note !== undefined) {
      updates.note = input.note;
    }

    if (Object.keys(updates).length === 0) {
      return this.findAliasById(id);
    }

    try {
      await db
        .update(creatorAliasesTable)
        .set(updates)
        .where(eq(creatorAliasesTable.id, id));

      return this.findAliasById(id);
    } catch (error: any) {
      if (error.code === "23505") {
        throw new ConflictError("This alias already exists for the creator");
      }
      throw error;
    }
  }

  async deleteAlias(id: number): Promise<void> {
    await this.findAliasById(id); // Ensure exists
    await db.delete(creatorAliasesTable).where(eq(creatorAliasesTable.id, id));
  }

  async getAliases(creatorId: number): Promise<Alias[]> {
    await this.verifyCreatorExists(creatorId);

    const aliases = await db
      .select()
      .from(creatorAliasesTable)
      .where(eq(creatorAliasesTable.creatorId, creatorId))
      .orderBy(creatorAliasesTable.name);

    return aliases.map(this.mapToSnakeCase);
  }

  async bulkUpsertAliases(
    creatorId: number,
    items: BulkAliasItem[],
  ): Promise<BulkOperationResult<Alias>> {
    await this.verifyCreatorExists(creatorId);

    const created: Alias[] = [];
    const updated: Alias[] = [];
    const errors: Array<{ index: number; error: string }> = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        // Upsert by creator_id + name
        const existing = await db
          .select({ id: creatorAliasesTable.id })
          .from(creatorAliasesTable)
          .where(
            and(
              eq(creatorAliasesTable.creatorId, creatorId),
              eq(creatorAliasesTable.name, item.name),
            ),
          )
          .limit(1);

        if (existing && existing.length > 0) {
          await db
            .update(creatorAliasesTable)
            .set({ note: item.note ?? null })
            .where(eq(creatorAliasesTable.id, existing[0].id));

          updated.push(await this.findAliasById(existing[0].id));
        } else {
          const result = await db
            .insert(creatorAliasesTable)
            .values({
              creatorId,
              name: item.name,
              note: item.note ?? null,
            })
            .returning({ id: creatorAliasesTable.id });

          if (!result || result.length === 0) {
            throw new Error("Failed to insert alias");
          }

          created.push(await this.findAliasById(result[0].id));
        }
      } catch (error: any) {
        errors.push({ index: i, error: error.message || "Unknown error" });
      }
    }

    return { created, updated, errors };
  }

  private async findAliasById(id: number): Promise<Alias> {
    const alias = await db
      .select()
      .from(creatorAliasesTable)
      .where(eq(creatorAliasesTable.id, id))
      .limit(1);

    if (!alias || alias.length === 0) {
      throw new NotFoundError(`Alias not found with id: ${id}`);
    }

    return this.mapToSnakeCase(alias[0]);
  }

  private async verifyCreatorExists(creatorId: number): Promise<void> {
    const creator = await db
      .select({ id: creatorsTable.id })
      .from(creatorsTable)
      .where(eq(creatorsTable.id, creatorId))
      .limit(1);

    if (!creator || creator.length === 0) {
      throw new NotFoundError(`Creator not found with id: ${creatorId}`);
    }
  }

  private mapToSnakeCase(alias: any): Alias {
    return {
      id: alias.id,
      creator_id: alias.creatorId,
      name: alias.name,
      note: alias.note ?? null,
      created_at:
        alias.createdAt instanceof Date
          ? alias.createdAt.toISOString()
          : alias.createdAt,
    };
  }
}

export const creatorsAliasesService = new CreatorsAliasesService();
