import { sql } from "drizzle-orm";

// Count catalog videos, not orphaned relationships left by legacy deletions.
export function creatorVideoCountsSql() {
  return sql`SELECT vc.creator_id, COUNT(*) AS video_count
    FROM video_creators vc
    INNER JOIN videos v ON v.id = vc.video_id
    GROUP BY vc.creator_id`;
}
