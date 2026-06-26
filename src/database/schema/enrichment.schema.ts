import {
  pgTable,
  serial,
  text,
  integer,
  real,
  jsonb,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";

/**
 * Enrichment is polymorphic across entity types: a suggestion targets a creator,
 * studio, scene (video), or tag via `(entityType, entityId)`. `entityId` is not a
 * foreign key — orphan cleanup happens app-side in each entity's delete path (see
 * `enrichmentService.deleteForEntity`).
 */
export type EnrichmentEntityType = "creator" | "studio" | "scene" | "tag";

/**
 * Candidate metadata discovered by the enrichment service, surfaced for manual
 * review. Nothing here is ever auto-applied — accepting a suggestion is always an
 * explicit user action that delegates to the existing entity writers.
 */
export const enrichmentSuggestionsTable = pgTable(
  "enrichment_suggestions",
  {
    id: serial("id").primaryKey(),
    // creator | studio | scene | tag
    entityType: text("entity_type").notNull(),
    entityId: integer("entity_id").notNull(),
    // image | platform | social | bio | alias | field | external_id |
    // performer | studio | tag | category | parent
    type: text("type").notNull(),
    // For `field` suggestions this holds the target column name (e.g. "gender").
    fieldKey: text("field_key"),
    // The suggested value (URL for image, handle, bio text, alias name, ...).
    value: text("value").notNull(),
    source: text("source").notNull(), // theporndb | stashdb | ...
    sourceUrl: text("source_url"),
    confidence: real("confidence"),
    faceMatchScore: real("face_match_score"),
    cachedPreviewPath: text("cached_preview_path"),
    // pending | accepted | rejected | superseded
    status: text("status").default("pending").notNull(),
    dedupHash: text("dedup_hash").notNull(),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    entityStatusIdx: index("idx_enrichment_suggestions_entity_status").on(
      table.entityType,
      table.entityId,
      table.status,
    ),
    typeIdx: index("idx_enrichment_suggestions_type").on(table.type),
    // Dedup per entity: the same candidate is never inserted twice.
    uniqueEntityDedup: unique("unique_enrichment_suggestion_dedup").on(
      table.entityType,
      table.entityId,
      table.dedupHash,
    ),
  }),
);

/**
 * Per-entity enrichment run log: lets us track outcomes, count suggestions, and
 * (later) skip recently-scraped entities / re-run on demand.
 */
export const enrichmentRunsTable = pgTable(
  "enrichment_runs",
  {
    id: serial("id").primaryKey(),
    entityType: text("entity_type").notNull(),
    entityId: integer("entity_id").notNull(),
    status: text("status").notNull(), // running | success | error
    sourcesUsed: jsonb("sources_used"),
    suggestionCount: integer("suggestion_count").default(0).notNull(),
    errors: jsonb("errors"),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => ({
    entityIdx: index("idx_enrichment_runs_entity").on(
      table.entityType,
      table.entityId,
    ),
    finishedAtIdx: index("idx_enrichment_runs_finished_at").on(
      table.finishedAt,
    ),
  }),
);

export type EnrichmentSuggestion =
  typeof enrichmentSuggestionsTable.$inferSelect;
export type NewEnrichmentSuggestion =
  typeof enrichmentSuggestionsTable.$inferInsert;
export type EnrichmentRun = typeof enrichmentRunsTable.$inferSelect;
export type NewEnrichmentRun = typeof enrichmentRunsTable.$inferInsert;
