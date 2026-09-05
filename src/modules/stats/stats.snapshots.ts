import { sql } from "drizzle-orm";

type SnapshotTable =
  | "stats_storage_snapshots"
  | "stats_library_snapshots"
  | "stats_content_snapshots"
  | "stats_usage_snapshots";

export function snapshotHistoryQuery(
  table: SnapshotTable,
  days: number,
  limit: number
) {
  // Multi-day ranges retain the latest snapshot per day so intraday volume
  // cannot crowd older days out of charts. A single day keeps all snapshots.
  const selection =
    days <= 1
      ? sql`
          SELECT * FROM ${sql.identifier(table)}
          WHERE created_at >= NOW() - INTERVAL '1 day' * ${days}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `
      : sql`
          SELECT DISTINCT ON (date_trunc('day', created_at)) *
          FROM ${sql.identifier(table)}
          WHERE created_at >= NOW() - INTERVAL '1 day' * ${days}
          ORDER BY date_trunc('day', created_at) DESC, created_at DESC
          LIMIT ${limit}
        `;

  return sql`SELECT * FROM (${selection}) t ORDER BY created_at ASC`;
}

export function snapshotDateToISOString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date().toISOString();
}
