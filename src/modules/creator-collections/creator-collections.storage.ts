import { asc, eq, inArray } from "drizzle-orm";
import type { DrizzleTransaction } from "@/config/drizzle";
import { appSettingsTable } from "@/database/schema";
import { getDemoSqlite } from "@/database/demo";
import {
  collectionDocument,
  mergeCollectionDocuments,
  type CollectionDocument,
} from "./creator-collections.domain";

export const emptyCollectionDocument = (): CollectionDocument => ({
  revision: 0,
  sets: [],
});
export const collectionKey = (id: number) => `creator_collection_sets:${id}`;
export const decodeCollectionDocument = (value?: string | null) =>
  value
    ? collectionDocument.parse(JSON.parse(value))
    : emptyCollectionDocument();
export function readDemoCollections(id: number) {
  const row = getDemoSqlite()
    .query<{ value_json: string }, [string]>(
      "SELECT value_json FROM demo_settings WHERE key=?"
    )
    .get(collectionKey(id));
  return decodeCollectionDocument(row ? JSON.parse(row.value_json) : null);
}
export function writeDemoCollections(id: number, document: CollectionDocument) {
  getDemoSqlite().run(
    "INSERT INTO demo_settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
    [
      collectionKey(id),
      JSON.stringify(JSON.stringify(document)),
      new Date().toISOString(),
    ]
  );
}

export function mergeDemoCollections(
  fromId: number,
  intoId: number,
  galleryIds: Map<number, number>
) {
  const source = readDemoCollections(fromId),
    target = readDemoCollections(intoId);
  if (!source.sets.length && !target.sets.length) return null;
  const merged = mergeCollectionDocuments(target, source, galleryIds);
  writeDemoCollections(intoId, merged);
  getDemoSqlite().run("DELETE FROM demo_settings WHERE key=?", [
    collectionKey(fromId),
  ]);
  return { source, target, merged };
}

/** Caller holds creator row locks; settings locks always follow that same order. */
export async function mergeProductionCollections(
  tx: DrizzleTransaction,
  fromId: number,
  intoId: number
) {
  const keys = [collectionKey(fromId), collectionKey(intoId)].sort();
  await tx
    .insert(appSettingsTable)
    .values(
      keys.map((key) => ({
        key,
        value: JSON.stringify(emptyCollectionDocument()),
      }))
    )
    .onConflictDoNothing();
  const rows = await tx
    .select()
    .from(appSettingsTable)
    .where(inArray(appSettingsTable.key, keys))
    .orderBy(asc(appSettingsTable.key))
    .for("update");
  const source = decodeCollectionDocument(
    rows.find((r) => r.key === collectionKey(fromId))?.value
  );
  const target = decodeCollectionDocument(
    rows.find((r) => r.key === collectionKey(intoId))?.value
  );
  const merged = mergeCollectionDocuments(target, source);
  await tx
    .update(appSettingsTable)
    .set({ value: JSON.stringify(merged), updatedAt: new Date() })
    .where(eq(appSettingsTable.key, collectionKey(intoId)));
  await tx
    .delete(appSettingsTable)
    .where(eq(appSettingsTable.key, collectionKey(fromId)));
  return { source, target, merged };
}
