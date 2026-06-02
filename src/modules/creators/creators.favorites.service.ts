import { db } from "@/config/drizzle";
import { creatorFavoritesTable } from "@/database/schema";
import { and, eq } from "drizzle-orm";
import { env } from "@/config/env";
import { isUniqueViolation } from "@/utils/errors";
import { creatorsService } from "./creators.service";

export class CreatorFavoritesService {
  async add(userId: number, creatorId: number): Promise<void> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      demoMockService.addFavoriteCreator(creatorId);
      return;
    }

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
      if (isUniqueViolation(error)) {
        return;
      }
      throw error;
    }
  }

  async remove(userId: number, creatorId: number): Promise<void> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      demoMockService.removeFavoriteCreator(creatorId);
      return;
    }

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
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      return demoMockService.isFavoriteCreator(creatorId);
    }

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
