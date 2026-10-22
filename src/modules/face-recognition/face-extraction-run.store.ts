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
        // A retryable failure parks the run as "pending"; if the durable job then gives up
        // (e.g. vision was down for its whole retry budget) nothing settles the run, and its
        // stale row would block every new run for the video on the active-run unique index.
        const active = await tx
          .select({
            id: faceExtractionJobsTable.id,
            durableStatus: durableJobsTable.status,
          })
          .from(faceExtractionJobsTable)
          .leftJoin(
            durableJobsTable,
            eq(durableJobsTable.id, faceExtractionJobsTable.durableJobId)
          )
          .where(
            and(
              eq(faceExtractionJobsTable.videoId, intent.videoId),
              inArray(faceExtractionJobsTable.status, ["pending", "processing"])
            )
          );
        for (const run of active) {
          const finished =
            run.durableStatus === null ||
            ["completed", "failed", "cancelled"].includes(run.durableStatus);
          if (!finished) continue;
          await tx
            .update(faceExtractionJobsTable)
            .set({
              status:
                run.durableStatus === "completed"
                  ? "completed"
                  : run.durableStatus === "cancelled"
                    ? "skipped"
                    : "failed",
              completedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(faceExtractionJobsTable.id, run.id));
        }

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
      // Drizzle wraps the driver error, so the SQLSTATE lives on its cause.
      const failure = error as { code?: string; cause?: { code?: string } };
      if ((failure.code ?? failure.cause?.code) !== "23505") throw error;
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
