import {
  demoRepository,
  getDemoSqlite,
  withDemoTransaction,
} from "@/database/demo";
import { BadRequestError, ConflictError, NotFoundError } from "@/utils/errors";

type DemoRow = Record<string, unknown>;

const SCOPED_CHILD_TABLES = [
  "demo_creator_aliases",
  "demo_creator_social_links",
  "demo_creator_gallery",
  "demo_creator_face_embeddings",
] as const;

const SOURCE_REFERENCE_TABLES = [
  "demo_video_creators",
  "demo_creator_studios",
  "demo_creator_favorites",
  "demo_creator_aliases",
  "demo_creator_platforms",
  "demo_creator_social_links",
  "demo_creator_gallery",
  "demo_creator_face_embeddings",
] as const;

function rows(table: string, creatorId: number): DemoRow[] {
  return getDemoSqlite()
    .query(`SELECT * FROM ${table} WHERE creator_id = ? ORDER BY rowid`)
    .all(creatorId) as DemoRow[];
}

function creatorRow(id: number): DemoRow | null {
  return (
    (getDemoSqlite()
      .query("SELECT * FROM demo_creators WHERE id = ?")
      .get(id) as DemoRow | null) ?? null
  );
}

function mergeJsonValues(target: unknown, source: unknown): unknown {
  if (target === null || target === undefined || target === "") return source;
  if (source === null || source === undefined || source === "") return target;

  if (Array.isArray(target) && Array.isArray(source)) {
    const seen = new Set(target.map((value) => JSON.stringify(value)));
    return [
      ...target,
      ...source.filter((value) => {
        const key = JSON.stringify(value);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    ];
  }

  if (
    typeof target === "object" &&
    !Array.isArray(target) &&
    typeof source === "object" &&
    !Array.isArray(source)
  ) {
    const merged = { ...(target as Record<string, unknown>) };
    for (const [key, value] of Object.entries(
      source as Record<string, unknown>
    )) {
      merged[key] = mergeJsonValues(merged[key], value);
    }
    return merged;
  }

  return target;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function copyScopedRows(
  table: (typeof SCOPED_CHILD_TABLES)[number],
  fromId: number,
  intoId: number,
  transform: (row: DemoRow, index: number) => DemoRow = (row) => row
): void {
  const sqlite = getDemoSqlite();
  const sourceRows = rows(table, fromId);
  const maxRow = sqlite
    .query(
      `SELECT COALESCE(MAX(id), 0) AS max_id FROM ${table} WHERE creator_id = ?`
    )
    .get(intoId) as { max_id: number };
  let nextId = Number(maxRow.max_id);

  for (const sourceRow of sourceRows) {
    const copied = transform(
      { ...sourceRow, id: ++nextId, creator_id: intoId },
      nextId
    );
    const columns = Object.keys(copied);
    const placeholders = columns.map(() => "?").join(", ");
    sqlite
      .query(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`
      )
      .run(...columns.map((column) => copied[column] as never));
  }

  sqlite.query(`DELETE FROM ${table} WHERE creator_id = ?`).run(fromId);
}

function moveJunction(
  table:
    | "demo_video_creators"
    | "demo_creator_studios"
    | "demo_creator_favorites",
  scopeColumn: "video_id" | "studio_id" | "user_id",
  fromId: number,
  intoId: number
): void {
  const sqlite = getDemoSqlite();
  sqlite
    .query(
      `INSERT OR IGNORE INTO ${table} (${scopeColumn}, creator_id)
       SELECT ${scopeColumn}, ? FROM ${table} WHERE creator_id = ?`
    )
    .run(intoId, fromId);
  sqlite.query(`DELETE FROM ${table} WHERE creator_id = ?`).run(fromId);
}

function assertCompatiblePlatforms(fromId: number, intoId: number): void {
  const sourceRows = rows("demo_creator_platforms", fromId);
  const targetByPlatform = new Map(
    rows("demo_creator_platforms", intoId).map((row) => [
      Number(row.platform_id),
      row,
    ])
  );

  for (const source of sourceRows) {
    const target = targetByPlatform.get(Number(source.platform_id));
    if (!target) continue;
    const sameProfile =
      source.username === target.username &&
      source.profile_url === target.profile_url;
    if (!sameProfile) {
      throw new ConflictError(
        `Creators have different profiles for platform ${source.platform_id}; resolve that profile before merging`
      );
    }
  }
}

function movePlatforms(fromId: number, intoId: number): void {
  const sqlite = getDemoSqlite();
  const targetPlatformIds = new Set(
    rows("demo_creator_platforms", intoId).map((row) => Number(row.platform_id))
  );
  const sourceRows = rows("demo_creator_platforms", fromId);
  const maxRow = sqlite
    .query(
      "SELECT COALESCE(MAX(id), 0) AS max_id FROM demo_creator_platforms WHERE creator_id = ?"
    )
    .get(intoId) as { max_id: number };
  let nextId = Number(maxRow.max_id);

  for (const row of sourceRows) {
    if (targetPlatformIds.has(Number(row.platform_id))) continue;
    sqlite
      .query(
        `INSERT INTO demo_creator_platforms
          (id, creator_id, platform_id, platform_name, username, profile_url,
           is_primary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ++nextId,
        intoId,
        row.platform_id as never,
        row.platform_name as never,
        row.username as never,
        row.profile_url as never,
        row.is_primary as never,
        row.created_at as never,
        row.updated_at as never
      );
  }
  sqlite
    .query("DELETE FROM demo_creator_platforms WHERE creator_id = ?")
    .run(fromId);
}

function normalizeScopedRole(
  table: "demo_creator_gallery" | "demo_creator_face_embeddings",
  roleColumn: "is_profile_picture" | "is_main_picture" | "is_primary",
  creatorId: number,
  preferredId: number | null
): void {
  const sqlite = getDemoSqlite();
  const first = sqlite
    .query(
      `SELECT id FROM ${table}
       WHERE creator_id = ? AND ${roleColumn} = 1
       ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, id
       LIMIT 1`
    )
    .get(creatorId, preferredId ?? -1) as { id: number } | null;
  if (!first) return;
  sqlite
    .query(
      `UPDATE ${table} SET ${roleColumn} = CASE WHEN id = ? THEN 1 ELSE 0 END
       WHERE creator_id = ? AND ${roleColumn} = 1`
    )
    .run(first.id, creatorId);
}

function rewriteFaceResources(fromId: number, intoId: number): void {
  const targetHasPrimary = demoRepository
    .listResources("face-embedding")
    .some(
      (item) => Number(item.creatorId) === intoId && Boolean(item.isPrimary)
    );
  let keptSourcePrimary = targetHasPrimary;

  for (const item of demoRepository.listResources("face-embedding")) {
    if (Number(item.creatorId) !== fromId) continue;
    const keepPrimary = Boolean(item.isPrimary) && !keptSourcePrimary;
    if (keepPrimary) keptSourcePrimary = true;
    demoRepository.putResource("face-embedding", item.id, {
      ...item,
      creatorId: intoId,
      isPrimary: keepPrimary,
      updatedAt: new Date(),
    });
  }

  for (const item of demoRepository.listResources("face-detection")) {
    if (Number(item.matchedCreatorId) !== fromId) continue;
    demoRepository.putResource("face-detection", item.id, {
      ...item,
      matchedCreatorId: intoId,
      updatedAt: new Date(),
    });
  }
}

function findPriorMerge(fromId: number): Record<string, unknown> | null {
  for (const item of demoRepository.listResources("creator-merge")) {
    if (Number(item.fromCreatorId) === fromId) return item;
  }
  return null;
}

export class CreatorsMergeDemoService {
  mergeCreators(
    fromId: number,
    intoId: number,
    reason?: string
  ): { id: number } {
    if (fromId === intoId) {
      throw new BadRequestError("Cannot merge a creator into itself");
    }

    return withDemoTransaction(() => {
      const sqlite = getDemoSqlite();
      const source = creatorRow(fromId);
      const target = creatorRow(intoId);

      if (!source) {
        const prior = findPriorMerge(fromId);
        if (prior && Number(prior.intoCreatorId) === intoId && target) {
          return { id: intoId };
        }
        throw new NotFoundError(`Creator not found with id: ${fromId}`);
      }
      if (!target) {
        throw new NotFoundError(`Creator not found with id: ${intoId}`);
      }

      assertCompatiblePlatforms(fromId, intoId);

      const sourceGraph = Object.fromEntries(
        SOURCE_REFERENCE_TABLES.map((table) => [table, rows(table, fromId)])
      );
      const sourceSuggestions = sqlite
        .query(
          "SELECT * FROM demo_enrichment_suggestions WHERE entity_type = 'creator' AND entity_id = ? ORDER BY id"
        )
        .all(fromId);
      const sourceRuns = sqlite
        .query(
          "SELECT * FROM demo_enrichment_runs WHERE entity_type = 'creator' AND entity_id = ? ORDER BY id"
        )
        .all(fromId);
      const sourceFaceResources = [
        ...demoRepository
          .listResources("face-embedding")
          .filter((item) => Number(item.creatorId) === fromId),
        ...demoRepository
          .listResources("face-detection")
          .filter((item) => Number(item.matchedCreatorId) === fromId),
      ];

      const targetExtra = parseJsonObject(target.extra_json);
      const sourceExtra = parseJsonObject(source.extra_json);
      sqlite
        .query(
          `UPDATE demo_creators SET
             description = COALESCE(description, ?),
             profile_picture_path = COALESCE(profile_picture_path, ?),
             main_picture_path = COALESCE(main_picture_path, ?),
             face_thumbnail_path = COALESCE(face_thumbnail_path, ?),
             extra_json = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          source.description as never,
          source.profile_picture_path as never,
          source.main_picture_path as never,
          source.face_thumbnail_path as never,
          JSON.stringify(mergeJsonValues(targetExtra, sourceExtra)),
          new Date().toISOString(),
          intoId
        );

      moveJunction("demo_video_creators", "video_id", fromId, intoId);
      moveJunction("demo_creator_studios", "studio_id", fromId, intoId);
      moveJunction("demo_creator_favorites", "user_id", fromId, intoId);

      const preferredProfile = (
        sqlite
          .query(
            "SELECT id FROM demo_creator_gallery WHERE creator_id = ? AND is_profile_picture = 1 ORDER BY id LIMIT 1"
          )
          .get(intoId) as { id: number } | null
      )?.id;
      const preferredMain = (
        sqlite
          .query(
            "SELECT id FROM demo_creator_gallery WHERE creator_id = ? AND is_main_picture = 1 ORDER BY id LIMIT 1"
          )
          .get(intoId) as { id: number } | null
      )?.id;
      const preferredFace = (
        sqlite
          .query(
            "SELECT id FROM demo_creator_face_embeddings WHERE creator_id = ? AND is_primary = 1 ORDER BY id LIMIT 1"
          )
          .get(intoId) as { id: number } | null
      )?.id;

      for (const table of SCOPED_CHILD_TABLES) {
        copyScopedRows(table, fromId, intoId);
      }
      movePlatforms(fromId, intoId);

      const existingSourceNameAlias = sqlite
        .query(
          "SELECT 1 FROM demo_creator_aliases WHERE creator_id = ? AND name = ? LIMIT 1"
        )
        .get(intoId, source.name as string);
      if (!existingSourceNameAlias && source.name !== target.name) {
        const nextAlias = sqlite
          .query(
            "SELECT COALESCE(MAX(id), 0) + 1 AS id FROM demo_creator_aliases WHERE creator_id = ?"
          )
          .get(intoId) as { id: number };
        sqlite
          .query(
            `INSERT INTO demo_creator_aliases
              (id, creator_id, name, note, created_at)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(
            nextAlias.id,
            intoId,
            source.name as string,
            `Merged from creator #${fromId}`,
            new Date().toISOString()
          );
      }

      normalizeScopedRole(
        "demo_creator_gallery",
        "is_profile_picture",
        intoId,
        preferredProfile ?? null
      );
      normalizeScopedRole(
        "demo_creator_gallery",
        "is_main_picture",
        intoId,
        preferredMain ?? null
      );
      normalizeScopedRole(
        "demo_creator_face_embeddings",
        "is_primary",
        intoId,
        preferredFace ?? null
      );

      sqlite
        .query(
          "UPDATE demo_enrichment_suggestions SET entity_id = ?, updated_at = ? WHERE entity_type = 'creator' AND entity_id = ?"
        )
        .run(intoId, new Date().toISOString(), fromId);
      sqlite
        .query(
          "UPDATE demo_enrichment_runs SET entity_id = ? WHERE entity_type = 'creator' AND entity_id = ?"
        )
        .run(intoId, fromId);
      rewriteFaceResources(fromId, intoId);

      const auditId = `${fromId}:${intoId}:${Date.now()}`;
      demoRepository.putResource("creator-merge", auditId, {
        version: 2,
        fromCreatorId: fromId,
        intoCreatorId: intoId,
        reason: reason ?? null,
        mergedAt: new Date().toISOString(),
        source,
        targetBefore: target,
        sourceGraph,
        sourceSuggestions,
        sourceRuns,
        sourceFaceResources,
      });

      for (const table of SOURCE_REFERENCE_TABLES) {
        const remaining = sqlite
          .query(`SELECT COUNT(*) AS count FROM ${table} WHERE creator_id = ?`)
          .get(fromId) as { count: number };
        if (Number(remaining.count) !== 0) {
          throw new Error(`Creator merge left references in ${table}`);
        }
      }
      const remainingPolymorphic = sqlite
        .query(
          `SELECT
             (SELECT COUNT(*) FROM demo_enrichment_suggestions WHERE entity_type = 'creator' AND entity_id = ?) +
             (SELECT COUNT(*) FROM demo_enrichment_runs WHERE entity_type = 'creator' AND entity_id = ?) AS count`
        )
        .get(fromId, fromId) as { count: number };
      if (Number(remainingPolymorphic.count) !== 0) {
        throw new Error("Creator merge left enrichment references behind");
      }

      sqlite.query("DELETE FROM demo_creators WHERE id = ?").run(fromId);
      return { id: intoId };
    });
  }
}

export const creatorsMergeDemoService = new CreatorsMergeDemoService();
