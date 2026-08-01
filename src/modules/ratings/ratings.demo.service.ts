import { avg, eq } from "drizzle-orm";
import { demoSchema, getDemoDatabase } from "@/database/demo";
import { NotFoundError } from "@/utils/errors";
import type {
  CreateRatingInput,
  Rating,
  UpdateRatingInput,
} from "./ratings.types";

const { demoRatingsTable, demoVideosTable } = demoSchema;

export class RatingsDemoService {
  addRating(videoId: number, input: CreateRatingInput): Rating {
    const video = getDemoDatabase()
      .select({ id: demoVideosTable.id })
      .from(demoVideosTable)
      .where(eq(demoVideosTable.id, videoId))
      .get();
    if (!video) throw new NotFoundError(`Video not found with id: ${videoId}`);
    const result = getDemoDatabase()
      .insert(demoRatingsTable)
      .values({
        videoId,
        rating: input.rating,
        comment: input.comment ?? null,
        ratedAt: new Date().toISOString(),
      })
      .returning()
      .get();
    return this.map(result);
  }

  findById(id: number): Rating {
    const row = getDemoDatabase()
      .select()
      .from(demoRatingsTable)
      .where(eq(demoRatingsTable.id, id))
      .get();
    if (!row) throw new NotFoundError(`Rating not found with id: ${id}`);
    return this.map(row);
  }

  getRatingsForVideo(videoId: number): Rating[] {
    return getDemoDatabase()
      .select()
      .from(demoRatingsTable)
      .where(eq(demoRatingsTable.videoId, videoId))
      .all()
      .map((row) => this.map(row));
  }

  update(id: number, input: UpdateRatingInput): Rating {
    const existing = this.findById(id);
    getDemoDatabase()
      .update(demoRatingsTable)
      .set({
        rating: input.rating ?? existing.rating,
        comment: input.comment !== undefined ? input.comment : existing.comment,
      })
      .where(eq(demoRatingsTable.id, id))
      .run();
    return this.findById(id);
  }

  delete(id: number): void {
    this.findById(id);
    getDemoDatabase()
      .delete(demoRatingsTable)
      .where(eq(demoRatingsTable.id, id))
      .run();
  }

  getAverageRating(videoId: number): number | null {
    const row = getDemoDatabase()
      .select({ value: avg(demoRatingsTable.rating) })
      .from(demoRatingsTable)
      .where(eq(demoRatingsTable.videoId, videoId))
      .get();
    return row?.value == null ? null : Number(row.value);
  }

  private map(row: typeof demoRatingsTable.$inferSelect): Rating {
    return {
      id: row.id,
      video_id: row.videoId,
      rating: row.rating,
      comment: row.comment,
      rated_at: row.ratedAt,
    };
  }
}

export const ratingsDemoService = new RatingsDemoService();
