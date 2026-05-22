import {
  pgTable,
  serial,
  text,
  integer,
  real,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { videosTable } from "./videos.schema";
import { creatorsTable } from "./organization.schema";

// Creator face embeddings (reference faces for known creators)
export const creatorFaceEmbeddingsTable = pgTable(
  "creator_face_embeddings",
  {
    id: serial("id").primaryKey(),
    creatorId: integer("creator_id")
      .notNull()
      .references(() => creatorsTable.id, { onDelete: "cascade" }),

    // 512-dimensional face embedding from InsightFace
    // Using text type as workaround - will be cast to vector(512) in queries
    embedding: text("embedding").notNull(),

    // Source information
    sourceType: text("source_type").notNull(), // 'manual_upload', 'video_detection', 'profile_picture'
    sourceVideoId: integer("source_video_id").references(() => videosTable.id, {
      onDelete: "set null",
    }),
    sourceTimestampSeconds: real("source_timestamp_seconds"),

    // Detection metadata
    detScore: real("det_score"), // Detection confidence (0-1)
    isPrimary: boolean("is_primary").default(false).notNull(), // Primary reference face for creator

    // Face attributes from InsightFace
    estimatedAge: integer("estimated_age"),
    estimatedGender: text("estimated_gender"), // 'M' or 'F'

    // Thumbnail image path
    thumbnailPath: text("thumbnail_path"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    creatorIdx: index("idx_creator_face_embeddings_creator").on(
      table.creatorId,
    ),
    sourceVideoIdx: index("idx_creator_face_embeddings_source_video").on(
      table.sourceVideoId,
    ),
    isPrimaryIdx: index("idx_creator_face_embeddings_is_primary").on(
      table.isPrimary,
    ),
    // HNSW index for fast similarity search will be created via raw SQL migration
  }),
);

// Video face detections (faces detected in videos with timestamps)
export const videoFaceDetectionsTable = pgTable(
  "video_face_detections",
  {
    id: serial("id").primaryKey(),
    videoId: integer("video_id")
      .notNull()
      .references(() => videosTable.id, { onDelete: "cascade" }),

    // 512-dimensional face embedding from InsightFace
    // Using text type as workaround - will be cast to vector(512) in queries
    embedding: text("embedding").notNull(),

    // Position in video
    timestampSeconds: real("timestamp_seconds").notNull(),
    frameIndex: integer("frame_index"), // Corresponding storyboard frame index

    // Bounding box coordinates (normalized 0-1)
    bboxX1: real("bbox_x1").notNull(),
    bboxY1: real("bbox_y1").notNull(),
    bboxX2: real("bbox_x2").notNull(),
    bboxY2: real("bbox_y2").notNull(),

    // Detection confidence
    detScore: real("det_score").notNull(),

    // Automatic matching
    matchedCreatorId: integer("matched_creator_id").references(
      () => creatorsTable.id,
      { onDelete: "set null" },
    ),
    matchConfidence: real("match_confidence"), // Cosine similarity score (0-1)
    matchStatus: text("match_status").default("pending").notNull(), // 'pending', 'confirmed', 'rejected', 'no_match'

    // Face attributes from InsightFace
    estimatedAge: integer("estimated_age"),
    estimatedGender: text("estimated_gender"), // 'M' or 'F'

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    videoIdx: index("idx_video_face_detections_video").on(table.videoId),
    timestampIdx: index("idx_video_face_detections_timestamp").on(
      table.videoId,
      table.timestampSeconds,
    ),
    matchedCreatorIdx: index("idx_video_face_detections_matched_creator").on(
      table.matchedCreatorId,
    ),
    matchStatusIdx: index("idx_video_face_detections_match_status").on(
      table.matchStatus,
    ),
    // HNSW index for fast similarity search will be created via raw SQL migration
  }),
);

// Face extraction jobs (tracking for background queue)
export const faceExtractionJobsTable = pgTable(
  "face_extraction_jobs",
  {
    id: serial("id").primaryKey(),
    videoId: integer("video_id")
      .notNull()
      .unique()
      .references(() => videosTable.id, { onDelete: "cascade" }),

    // Job status
    status: text("status").default("pending").notNull(), // 'pending', 'processing', 'completed', 'failed', 'skipped'

    // Progress tracking
    totalFrames: integer("total_frames"),
    processedFrames: integer("processed_frames").default(0).notNull(),
    facesDetected: integer("faces_detected").default(0).notNull(),

    // Error handling
    errorMessage: text("error_message"),
    retryCount: integer("retry_count").default(0).notNull(),

    // Timestamps
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    videoIdx: index("idx_face_extraction_jobs_video").on(table.videoId),
    statusIdx: index("idx_face_extraction_jobs_status").on(table.status),
    createdAtIdx: index("idx_face_extraction_jobs_created_at").on(
      table.createdAt,
    ),
  }),
);

// Face images (stored cropped face thumbnails)
export const faceImagesTable = pgTable(
  "face_images",
  {
    id: serial("id").primaryKey(),
    detectionId: integer("detection_id")
      .notNull()
      .unique()
      .references(() => videoFaceDetectionsTable.id, { onDelete: "cascade" }),

    // File storage
    filePath: text("file_path").notNull(),
    fileSizeBytes: integer("file_size_bytes"),
    width: integer("width").notNull(),
    height: integer("height").notNull(),

    generatedAt: timestamp("generated_at").defaultNow().notNull(),
  },
  (table) => ({
    detectionIdx: index("idx_face_images_detection").on(table.detectionId),
  }),
);

// Inferred types
export type CreatorFaceEmbedding =
  typeof creatorFaceEmbeddingsTable.$inferSelect;
export type NewCreatorFaceEmbedding =
  typeof creatorFaceEmbeddingsTable.$inferInsert;
export type VideoFaceDetection = typeof videoFaceDetectionsTable.$inferSelect;
export type NewVideoFaceDetection =
  typeof videoFaceDetectionsTable.$inferInsert;
export type FaceExtractionJob = typeof faceExtractionJobsTable.$inferSelect;
export type NewFaceExtractionJob = typeof faceExtractionJobsTable.$inferInsert;
export type FaceImage = typeof faceImagesTable.$inferSelect;
export type NewFaceImage = typeof faceImagesTable.$inferInsert;
