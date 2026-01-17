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

export class RatingsService {
  async addRating(videoId: number, input: CreateRatingInput): Promise<Rating> {
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
    await videosService.findById(videoId); // Ensure video exists

    const ratings = await db
      .select()
      .from(ratingsTable)
      .where(eq(ratingsTable.videoId, videoId))
      .orderBy(desc(ratingsTable.ratedAt));

    return ratings.map(this.mapToSnakeCase);
  }

  async update(id: number, input: UpdateRatingInput): Promise<Rating> {
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
    await this.findById(id); // Ensure exists
    await db.delete(ratingsTable).where(eq(ratingsTable.id, id));
  }

  async getAverageRating(videoId: number): Promise<number | null> {
    const result = await db
      .select({ avgRating: sql<number | null>`AVG(${ratingsTable.rating})` })
      .from(ratingsTable)
      .where(eq(ratingsTable.videoId, videoId));

    return result[0]?.avgRating ?? null;
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
