import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { videosTable } from "./videos.schema";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * Raw Chromaprint items (little-endian uint32, one per ~0.124 s) for a video's first audio
 * stream. `matched_at` is null until a copy-detection pass has compared this fingerprint with
 * the rest of the library; re-extraction resets it.
 */
export const videoAudioFingerprintsTable = pgTable(
  "video_audio_fingerprints",
  {
    videoId: integer("video_id")
      .primaryKey()
      .references(() => videosTable.id, { onDelete: "cascade" }),
    revision: text("revision").notNull(),
    status: text("status").notNull(),
    sourceSize: bigint("source_size", { mode: "number" }).notNull(),
    sourceMtimeNs: text("source_mtime_ns").notNull(),
    itemCount: integer("item_count").notNull(),
    fingerprint: bytea("fingerprint"),
    extractedAt: timestamp("extracted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    matchedAt: timestamp("matched_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "video_audio_fingerprints_status_check",
      sql`${table.status} IN ('ready', 'no_audio')`
    ),
    check(
      "video_audio_fingerprints_payload_check",
      sql`(${table.status} = 'ready' AND ${table.fingerprint} IS NOT NULL AND octet_length(${table.fingerprint}) = 4 * ${table.itemCount}) OR (${table.status} = 'no_audio' AND ${table.fingerprint} IS NULL AND ${table.itemCount} = 0)`
    ),
    index("idx_video_audio_fingerprints_pending")
      .on(table.videoId)
      .where(sql`${table.matchedAt} IS NULL`),
  ]
);

/** One decided comparison; rejected pairs are kept so a resumed pass does not re-verify them. */
export const videoCopyPairsTable = pgTable(
  "video_copy_pairs",
  {
    videoA: integer("video_a")
      .notNull()
      .references(() => videosTable.id, { onDelete: "cascade" }),
    videoB: integer("video_b")
      .notNull()
      .references(() => videosTable.id, { onDelete: "cascade" }),
    revision: text("revision").notNull(),
    verdict: text("verdict").notNull(),
    status: text("status"),
    coverageA: real("coverage_a").notNull().default(0),
    coverageB: real("coverage_b").notNull().default(0),
    segments: jsonb("segments").$type<unknown[]>().notNull().default([]),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.videoA, table.videoB] }),
    check("video_copy_pairs_order_check", sql`${table.videoA} < ${table.videoB}`),
    check(
      "video_copy_pairs_verdict_check",
      sql`(${table.verdict} = 'match' AND ${table.status} IN ('verified', 'ambiguous')) OR (${table.verdict} = 'rejected' AND ${table.status} IS NULL)`
    ),
    index("idx_video_copy_pairs_video_b").on(table.videoB),
    index("idx_video_copy_pairs_matches")
      .on(table.checkedAt)
      .where(sql`${table.verdict} = 'match'`),
  ]
);
