import { db } from "@/config/drizzle";
import { eq, desc, sql } from "drizzle-orm";
import { ratingsTable } from "@/database/schema";
import { NotFoundError } from "@/utils/errors";
import type {
  Rating,
  CreateRatingInput,
  UpdateRatingInput,
} from "./ratings.types";
import { videosService } from "@/modules/videos/videos.service";
import { env } from "@/config/env";

export class RatingsService {
  async addRating(videoId: number, input: CreateRatingInput): Promise<Rating> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      return demoMockService.addRating(videoId, input) as Rating;
    }

    await videosService.findById(videoId); // Ensure video exists

    const result = await db
      .insert(ratingsTable)
      .values({
        videoId,
        rating: input.rating,
        comment: input.comment || null,
      })
      .returning({ id: ratingsTable.id });

    if (!result || result.length === 0) {
      throw new Error("Failed to add rating");
    }

    return this.findById(result[0].id);
  }

  async findById(id: number): Promise<Rating> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      const rating = demoMockService.findRatingById(id);
      if (!rating) {
        throw new NotFoundError(`Rating not found with id: ${id}`);
      }
      return rating as Rating;
    }

    const ratings = await db
      .select()
      .from(ratingsTable)
      .where(eq(ratingsTable.id, id))
      .limit(1);

    if (!ratings || ratings.length === 0) {
      throw new NotFoundError(`Rating not found with id: ${id}`);
    }

    return this.mapToSnakeCase(ratings[0]);
  }

  async getRatingsForVideo(videoId: number): Promise<Rating[]> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      return demoMockService.getRatingsForVideo(videoId) as Rating[];
    }

    await videosService.findById(videoId); // Ensure video exists

    const ratings = await db
      .select()
      .from(ratingsTable)
      .where(eq(ratingsTable.videoId, videoId))
      .orderBy(desc(ratingsTable.ratedAt));

    return ratings.map(this.mapToSnakeCase);
  }

  async update(id: number, input: UpdateRatingInput): Promise<Rating> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      const rating = demoMockService.updateRating(id, input);
      if (!rating) {
        throw new NotFoundError(`Rating not found with id: ${id}`);
      }
      return rating as Rating;
    }

    await this.findById(id); // Ensure exists

    const updates: any = {};

    if (input.rating !== undefined) {
      updates.rating = input.rating;
    }

    if (input.comment !== undefined) {
      updates.comment = input.comment;
    }

    if (Object.keys(updates).length === 0) {
      return this.findById(id);
    }

    await db.update(ratingsTable).set(updates).where(eq(ratingsTable.id, id));

    return this.findById(id);
  }

  async delete(id: number): Promise<void> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      if (!demoMockService.deleteRating(id)) {
        throw new NotFoundError(`Rating not found with id: ${id}`);
      }
      return;
    }

    await this.findById(id); // Ensure exists
    await db.delete(ratingsTable).where(eq(ratingsTable.id, id));
  }

  async getAverageRating(videoId: number): Promise<number | null> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      const ratings = demoMockService.getRatingsForVideo(videoId);
      if (ratings.length === 0) {
        return null;
      }
      return (
        ratings.reduce((total: number, rating: any) => total + rating.rating, 0) /
        ratings.length
      );
    }

    const result = await db
      .select({ avgRating: sql<number | null>`AVG(${ratingsTable.rating})` })
      .from(ratingsTable)
      .where(eq(ratingsTable.videoId, videoId));

    const avgRating = result[0]?.avgRating;

    if (avgRating === null || avgRating === undefined) {
      return null;
    }

    return Number(avgRating);
  }

  private mapToSnakeCase(rating: any): Rating {
    return {
      id: rating.id,
      video_id: rating.videoId ?? rating.video_id,
      rating: rating.rating,
      comment: rating.comment,
      rated_at:
        rating.ratedAt instanceof Date
          ? rating.ratedAt.toISOString()
          : rating.rated_at,
    };
  }
}

export const ratingsService = new RatingsService();
