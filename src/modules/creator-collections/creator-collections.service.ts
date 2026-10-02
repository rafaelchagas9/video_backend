import { eq } from "drizzle-orm";
import { env } from "@/config/env";
import { db } from "@/config/drizzle";
import { getDemoSqlite, withDemoTransaction } from "@/database/demo";
import {
  appSettingsTable,
  videoCreatorsTable,
  creatorsTable,
  creatorGalleryMediaTable,
} from "@/database/schema";
import { NotFoundError } from "@/utils/errors";
import {
  reconcileCollectionDocument,
  removeCollection,
  updateCollectionDocument,
  type CollectionInput,
} from "./creator-collections.domain";
import {
  collectionKey,
  decodeCollectionDocument,
  emptyCollectionDocument,
  readDemoCollections,
  writeDemoCollections,
} from "./creator-collections.storage";

function demoMembers(creatorId: number) {
  const client = getDemoSqlite();
  if (!client.query("SELECT 1 FROM demo_creators WHERE id=?").get(creatorId))
    throw new NotFoundError(`Creator not found with id: ${creatorId}`);
  return {
    gallery: new Set(
      client
        .query<{ id: number }, [number]>(
          "SELECT id FROM demo_creator_gallery WHERE creator_id=?"
        )
        .all(creatorId)
        .map((v) => v.id)
    ),
    videos: new Set(
      client
        .query<{ video_id: number }, [number]>(
          "SELECT video_id FROM demo_video_creators WHERE creator_id=?"
        )
        .all(creatorId)
        .map((v) => v.video_id)
    ),
  };
}

export const creatorCollectionsService = {
  async list(creatorId: number) {
    if (env.DEMO_MODE)
      return withDemoTransaction(() =>
        reconcileCollectionDocument(
          readDemoCollections(creatorId),
          demoMembers(creatorId)
        )
      );
    return db.transaction(async (tx) => {
      const [creator] = await tx
        .select({ id: creatorsTable.id })
        .from(creatorsTable)
        .where(eq(creatorsTable.id, creatorId))
        .for("share");
      if (!creator)
        throw new NotFoundError(`Creator not found with id: ${creatorId}`);
      const [row] = await tx
        .select()
        .from(appSettingsTable)
        .where(eq(appSettingsTable.key, collectionKey(creatorId)));
      const gallery = await tx
        .select({ id: creatorGalleryMediaTable.id })
        .from(creatorGalleryMediaTable)
        .where(eq(creatorGalleryMediaTable.creatorId, creatorId));
      const links = await tx
        .select({ id: videoCreatorsTable.videoId })
        .from(videoCreatorsTable)
        .where(eq(videoCreatorsTable.creatorId, creatorId));
      return reconcileCollectionDocument(decodeCollectionDocument(row?.value), {
        gallery: new Set(gallery.map((v) => v.id)),
        videos: new Set(links.map((v) => v.id)),
      });
    });
  },
  async save(
    creatorId: number,
    input: CollectionInput,
    revision: number,
    id?: string
  ) {
    if (env.DEMO_MODE)
      return withDemoTransaction(() => {
        const members = demoMembers(creatorId);
        const updated = updateCollectionDocument(
          readDemoCollections(creatorId),
          input,
          revision,
          members,
          id
        );
        writeDemoCollections(creatorId, updated);
        return reconcileCollectionDocument(updated, members);
      });
    return db.transaction(async (tx) => {
      // Stabilize creator identity before settings locks, matching the merge path.
      const [creator] = await tx
        .select({ id: creatorsTable.id })
        .from(creatorsTable)
        .where(eq(creatorsTable.id, creatorId))
        .for("share");
      if (!creator)
        throw new NotFoundError(`Creator not found with id: ${creatorId}`);
      const key = collectionKey(creatorId);
      await tx
        .insert(appSettingsTable)
        .values({ key, value: JSON.stringify(emptyCollectionDocument()) })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(appSettingsTable)
        .where(eq(appSettingsTable.key, key))
        .for("update");
      // Row locks block gallery deletion/unlink until this save commits. No files
      // are accessed; later removals are reconciled on every collection read.
      const gallery = await tx
        .select({ id: creatorGalleryMediaTable.id })
        .from(creatorGalleryMediaTable)
        .where(eq(creatorGalleryMediaTable.creatorId, creatorId))
        .for("share");
      const links = await tx
        .select({ id: videoCreatorsTable.videoId })
        .from(videoCreatorsTable)
        .where(eq(videoCreatorsTable.creatorId, creatorId))
        .for("share");
      const members = {
        gallery: new Set(gallery.map((v) => v.id)),
        videos: new Set(links.map((v) => v.id)),
      };
      const updated = updateCollectionDocument(
        decodeCollectionDocument(row?.value),
        input,
        revision,
        members,
        id
      );
      await tx
        .update(appSettingsTable)
        .set({ value: JSON.stringify(updated), updatedAt: new Date() })
        .where(eq(appSettingsTable.key, key));
      return reconcileCollectionDocument(updated, members);
    });
  },
  async remove(creatorId: number, revision: number, id: string) {
    if (env.DEMO_MODE)
      return withDemoTransaction(() => {
        const members = demoMembers(creatorId);
        const updated = removeCollection(
          readDemoCollections(creatorId),
          revision,
          id
        );
        writeDemoCollections(creatorId, updated);
        return reconcileCollectionDocument(updated, members);
      });
    return db.transaction(async (tx) => {
      const [creator] = await tx
        .select({ id: creatorsTable.id })
        .from(creatorsTable)
        .where(eq(creatorsTable.id, creatorId))
        .for("share");
      if (!creator)
        throw new NotFoundError(`Creator not found with id: ${creatorId}`);
      const key = collectionKey(creatorId);
      const [row] = await tx
        .select()
        .from(appSettingsTable)
        .where(eq(appSettingsTable.key, key))
        .for("update");
      const updated = removeCollection(
        decodeCollectionDocument(row?.value),
        revision,
        id
      );
      await tx
        .update(appSettingsTable)
        .set({ value: JSON.stringify(updated), updatedAt: new Date() })
        .where(eq(appSettingsTable.key, key));
      const gallery = await tx
        .select({ id: creatorGalleryMediaTable.id })
        .from(creatorGalleryMediaTable)
        .where(eq(creatorGalleryMediaTable.creatorId, creatorId));
      const links = await tx
        .select({ id: videoCreatorsTable.videoId })
        .from(videoCreatorsTable)
        .where(eq(videoCreatorsTable.creatorId, creatorId));
      return reconcileCollectionDocument(updated, {
        gallery: new Set(gallery.map((v) => v.id)),
        videos: new Set(links.map((v) => v.id)),
      });
    });
  },
};
