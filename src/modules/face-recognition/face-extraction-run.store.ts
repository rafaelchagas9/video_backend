import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/config/drizzle";
import {
  durableJobsTable,
  faceExtractionJobsTable,
  type FaceExtractionJob,
} from "@/database/schema";

export interface FaceExtractionConfig {
  [key: string]: unknown;
  detectionThreshold: number;
  intervalSeconds: number;
  keyframesOnly: boolean;
  targetWidth: number;
  outputFormat: "jpg" | "webp" | "png";
  quality: number;
  similarityThreshold: number;
  autoTagThreshold: number;
}

export interface FaceExtractionIntent {
  videoId: number;
  sourceFingerprint: string;
  config: FaceExtractionConfig;
}

export interface FaceExtractionRunStore {
  enqueue(intent: FaceExtractionIntent): Promise<FaceExtractionJob>;
  findByDurableJobId(durableJobId: number): Promise<FaceExtractionJob | null>;
  latestByVideoId(videoId: number): Promise<FaceExtractionJob | null>;
  listActive(): Promise<FaceExtractionJob[]>;
  update(
    id: number,
    values: Partial<typeof faceExtractionJobsTable.$inferInsert>
  ): Promise<void>;
}

export class PostgresFaceExtractionRunStore implements FaceExtractionRunStore {
  async enqueue(intent: FaceExtractionIntent): Promise<FaceExtractionJob> {
    try {
      return await db.transaction(async (tx) => {
        const [durableJob] = await tx
          .insert(durableJobsTable)
          .values({
            kind: "vision.face-extraction",
            payload: {
              videoId: intent.videoId,
              sourceFingerprint: intent.sourceFingerprint,
              config: intent.config,
            },
          })
          .returning({ id: durableJobsTable.id });
        if (!durableJob) throw new Error("Failed to create durable face job");

        const [run] = await tx
          .insert(faceExtractionJobsTable)
          .values({
            videoId: intent.videoId,
            durableJobId: durableJob.id,
            sourceFingerprint: intent.sourceFingerprint,
            config: intent.config,
            status: "pending",
          })
          .returning();
        if (!run) throw new Error("Failed to create face extraction run");
        return run;
      });
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
      const active = await db
        .select()
        .from(faceExtractionJobsTable)
        .where(
          and(
            eq(faceExtractionJobsTable.videoId, intent.videoId),
            inArray(faceExtractionJobsTable.status, ["pending", "processing"])
          )
        )
        .orderBy(desc(faceExtractionJobsTable.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!active) throw error;
      return active;
    }
  }

  async findByDurableJobId(
    durableJobId: number
  ): Promise<FaceExtractionJob | null> {
    return db
      .select()
      .from(faceExtractionJobsTable)
      .where(eq(faceExtractionJobsTable.durableJobId, durableJobId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async latestByVideoId(videoId: number): Promise<FaceExtractionJob | null> {
    return db
      .select()
      .from(faceExtractionJobsTable)
      .where(eq(faceExtractionJobsTable.videoId, videoId))
      .orderBy(
        desc(faceExtractionJobsTable.createdAt),
        desc(faceExtractionJobsTable.id)
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  listActive(): Promise<FaceExtractionJob[]> {
    return db
      .select()
      .from(faceExtractionJobsTable)
      .where(
        inArray(faceExtractionJobsTable.status, ["pending", "processing"])
      );
  }

  async update(
    id: number,
    values: Partial<typeof faceExtractionJobsTable.$inferInsert>
  ): Promise<void> {
    await db
      .update(faceExtractionJobsTable)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(faceExtractionJobsTable.id, id));
  }
}
