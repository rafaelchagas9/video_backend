import {
  pgTable,
  serial,
  text,
  integer,
  real,
  timestamp,
  index,
  halfvec,
  primaryKey,
  unique,
} from "drizzle-orm/pg-core";
import { videosTable } from "./videos.schema";
import { tagsTable } from "./organization.schema";

/** SigLIP2 so400m embeds into 1152 dimensions; stored as fp16 (identical rankings to fp32). */
export const VISUAL_EMBEDDING_DIMENSION = 1152;

/**
 * One SigLIP2 image embedding per storyboard tile. Tiles are the frames clients already
 * scrub, so a hit maps straight onto a storyboard thumbnail and a seek position.
 * The HNSW index (cosine) is created in SQL; the backfill script drops and rebuilds it
 * around bulk loads.
 */
export const videoFrameEmbeddingsTable = pgTable(
  "video_frame_embeddings",
  {
    videoId: integer("video_id")
      .notNull()
      .references(() => videosTable.id, { onDelete: "cascade" }),
    frameIndex: integer("frame_index").notNull(),
    timestampSeconds: real("timestamp_seconds").notNull(),
    embedding: halfvec("embedding", {
      dimensions: VISUAL_EMBEDDING_DIMENSION,
    }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.videoId, table.frameIndex] })]
);

/** Which storyboard (and model) a video's frame embeddings were computed from. */
export const videoVisualIndexTable = pgTable("video_visual_index", {
  videoId: integer("video_id")
    .primaryKey()
    .references(() => videosTable.id, { onDelete: "cascade" }),
  modelRevision: text("model_revision").notNull(),
  storyboardGeneratedAt: timestamp("storyboard_generated_at").notNull(),
  intervalSeconds: real("interval_seconds").notNull(),
  frameCount: integer("frame_count").notNull(),
  indexedAt: timestamp("indexed_at").defaultNow().notNull(),
});

/**
 * Natural-language descriptions that define a tag visually ("what this tag looks like").
 * Saved when a search result set is tagged, and replayed to suggest untagged videos.
 */
export const tagVisualQueriesTable = pgTable(
  "tag_visual_queries",
  {
    id: serial("id").primaryKey(),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tagsTable.id, { onDelete: "cascade" }),
    query: text("query").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("tag_visual_queries_tag_query_unique").on(table.tagId, table.query),
    index("idx_tag_visual_queries_tag").on(table.tagId),
  ]
);
