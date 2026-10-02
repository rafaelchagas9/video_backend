import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { env } from "@/config/env";
import {
  getDemoSqlite,
  importDemoJsonFile,
  setDemoDatabasePathForTests,
} from "@/database/demo";
import { applyDemoMetadataOverlay } from "@/database/demo/metadata-overlay";
import { collectionDocument } from "@/modules/creator-collections/creator-collections.domain";

const fixture = `/tmp/collection-overlay-${process.pid}.sqlite`;
afterAll(() => {
  setDemoDatabasePathForTests(null);
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(fixture + suffix, { force: true });
});
// Local authorized metadata fixture is deliberately ignored by Git. Generic CI
// has no copy of real metadata and must not fabricate evidence of this overlay.
test.skipIf(
  !existsSync(join(process.cwd(), env.DEMO_ASSETS_DIR, "metadata-overlay.json"))
)(
  "optional SFW collection is member-valid, stable and never overwrites user documents",
  () => {
    setDemoDatabasePathForTests(fixture);
    importDemoJsonFile(undefined, { reset: true });
    applyDemoMetadataOverlay({ allowInTests: true });
    const db = getDemoSqlite();
    const row = db
      .query<{ key: string; value_json: string }, []>(
        "SELECT key,value_json FROM demo_settings WHERE key LIKE 'creator_collection_sets:%' ORDER BY key LIMIT 1"
      )
      .get()!;
    const document = collectionDocument.parse(
      JSON.parse(JSON.parse(row.value_json))
    );
    const creatorId = Number(row.key.split(":")[1]);
    expect(document.sets).toHaveLength(1);
    const set = document.sets[0];
    expect(set.gallery_ids).toHaveLength(2);
    expect(set.video_ids).toHaveLength(2);
    for (const id of set.gallery_ids)
      expect(
        db
          .query(
            "SELECT 1 FROM demo_creator_gallery WHERE id=? AND creator_id=?"
          )
          .get(id, creatorId)
      ).not.toBeNull();
    for (const id of set.video_ids)
      expect(
        db
          .query(
            "SELECT 1 FROM demo_video_creators WHERE video_id=? AND creator_id=?"
          )
          .get(id, creatorId)
      ).not.toBeNull();
    applyDemoMetadataOverlay({ allowInTests: true });
    expect(
      db
        .query<{ value_json: string }, [string]>(
          "SELECT value_json FROM demo_settings WHERE key=?"
        )
        .get(row.key)?.value_json
    ).toBe(row.value_json);
    const custom = JSON.stringify(JSON.stringify({ revision: 10, sets: [] }));
    db.run("UPDATE demo_settings SET value_json=? WHERE key=?", [
      custom,
      row.key,
    ]);
    applyDemoMetadataOverlay({ allowInTests: true });
    expect(
      db
        .query<{ value_json: string }, [string]>(
          "SELECT value_json FROM demo_settings WHERE key=?"
        )
        .get(row.key)?.value_json
    ).toBe(custom);
  }
);
