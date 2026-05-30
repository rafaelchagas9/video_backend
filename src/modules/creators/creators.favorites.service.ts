import { db } from "@/config/drizzle";
import { creatorFavoritesTable } from "@/database/schema";
import { and, eq } from "drizzle-orm";
import { creatorsService } from "./creators.service";

export class CreatorFavoritesService {
  async add(userId: number, creatorId: number): Promise<void> {
    await creatorsService.findById(creatorId);

    if (await this.isFavorite(userId, creatorId)) {
      return;
    }

    try {
      await db.insert(creatorFavoritesTable).values({
        userId,
        creatorId,
      });
    } catch (error: any) {
      if (error.code === "23505") {
        return;
      }
      throw error;
    }
  }

  async remove(userId: number, creatorId: number): Promise<void> {
    await db
      .delete(creatorFavoritesTable)
      .where(
        and(
          eq(creatorFavoritesTable.userId, userId),
          eq(creatorFavoritesTable.creatorId, creatorId),
        ),
      );
  }

  async isFavorite(userId: number, creatorId: number): Promise<boolean> {
    const result = await db
      .select({ creatorId: creatorFavoritesTable.creatorId })
      .from(creatorFavoritesTable)
      .where(
        and(
          eq(creatorFavoritesTable.userId, userId),
          eq(creatorFavoritesTable.creatorId, creatorId),
        ),
      )
      .limit(1);

    return result.length > 0;
  }
}

export const creatorFavoritesService = new CreatorFavoritesService();
