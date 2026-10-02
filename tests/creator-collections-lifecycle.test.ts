import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  collectionInput,
  collectionDocument,
  mergeCollectionDocuments,
  reconcileCollectionDocument,
  updateCollectionDocument,
} from "@/modules/creator-collections/creator-collections.domain";

const members = { gallery: new Set([1, 2]), videos: new Set([3, 4]) };
describe("collection lifecycle without metadata loss", () => {
  test("read reconciliation preserves revision and evidence; stale saves still conflict", () => {
    const stored = updateCollectionDocument(
      { revision: 0, sets: [] },
      collectionInput.parse({
        title: "Edition",
        gallery_ids: [2, 1],
        video_ids: [3, 4],
      }),
      0,
      members
    );
    const live = { gallery: new Set([1]), videos: new Set([3]) };
    const listed = reconcileCollectionDocument(stored, live);
    expect(listed.revision).toBe(1);
    expect(stored.sets[0].gallery_ids).toEqual([2, 1]);
    expect(listed.sets[0]).toMatchObject({
      gallery_ids: [1],
      video_ids: [3],
      removed_gallery_ids: [2],
      removed_video_ids: [4],
    });
    const saved = updateCollectionDocument(
      stored,
      { ...collectionInput.parse(listed.sets[0]), title: "Renamed" },
      1,
      live,
      stored.sets[0].id
    );
    expect(saved.sets[0]).toMatchObject({
      title: "Renamed",
      removed_gallery_ids: [2],
      removed_video_ids: [4],
    });
    expect(() =>
      updateCollectionDocument(
        saved,
        collectionInput.parse(listed.sets[0]),
        1,
        live,
        stored.sets[0].id
      )
    ).toThrow("changed");
    expect(() =>
      updateCollectionDocument(
        saved,
        collectionInput.parse({ ...saved.sets[0], gallery_ids: [99] }),
        2,
        live,
        saved.sets[0].id
      )
    ).toThrow("image");
  });
  test("merge keeps edition IDs and order, advances revision and remaps scoped demo gallery IDs", () => {
    const into = updateCollectionDocument(
      { revision: 8, sets: [] },
      collectionInput.parse({ title: "Into", gallery_ids: [1] }),
      8,
      members
    );
    const from = updateCollectionDocument(
      { revision: 2, sets: [] },
      collectionInput.parse({
        title: "From",
        gallery_ids: [2, 1],
        video_ids: [4, 3],
      }),
      2,
      members
    );
    const merged = mergeCollectionDocuments(
      into,
      from,
      new Map([
        [1, 10],
        [2, 20],
      ])
    );
    expect(merged.revision).toBe(10);
    expect(merged.sets.map((s) => s.id)).toEqual([
      into.sets[0].id,
      from.sets[0].id,
    ]);
    expect(merged.sets[1].gallery_ids).toEqual([20, 10]);
    expect(merged.sets[1].video_ids).toEqual([4, 3]);
    expect(from.sets[0].gallery_ids).toEqual([2, 1]);
    expect(() => mergeCollectionDocuments(into, into)).toThrow("overlap");
  });
  test("merging two full libraries does not silently truncate editions", () => {
    const make = (prefix: string) =>
      collectionDocument.parse({
        revision: 200,
        sets: Array.from({ length: 200 }, (_, i) => ({
          id: crypto.randomUUID(),
          title: `${prefix}${i}`,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        })),
      });
    const merged = mergeCollectionDocuments(make("Target"), make("Source"));
    expect(collectionDocument.parse(merged).sets).toHaveLength(400);
    expect(() =>
      updateCollectionDocument(
        merged,
        collectionInput.parse({ title: "Extra" }),
        merged.revision,
        members
      )
    ).toThrow("200");
  });
});

describe("demo collection merge and removed members", () => {
  const path = `/tmp/creator-collections-lifecycle-${process.pid}.sqlite`;
  let previous = false;
  beforeAll(async () => {
    const { env } = await import("@/config/env");
    previous = env.DEMO_MODE;
    env.DEMO_MODE = true;
    const demo = await import("@/database/demo");
    demo.setDemoDatabasePathForTests(path);
    demo.importDemoJsonFile(undefined, { reset: true });
  });
  afterAll(async () => {
    const demo = await import("@/database/demo");
    demo.setDemoDatabasePathForTests(null);
    const { env } = await import("@/config/env");
    env.DEMO_MODE = previous;
    for (const suffix of ["", "-wal", "-shm"])
      rmSync(path + suffix, { force: true });
  });
  test("both creators keep their editions after an actual isolated SQLite merge with colliding gallery IDs", async () => {
    const { getDemoSqlite } = await import("@/database/demo");
    const client = getDemoSqlite();
    const add = (name: string) =>
      client
        .query<{ id: number }, [string]>(
          "INSERT INTO demo_creators(name,created_at,updated_at) VALUES (?,'2026-01-01','2026-01-01') RETURNING id"
        )
        .get(name)!.id;
    const into = add("Target collection fixture"),
      from = add("Source collection fixture");
    for (const id of [into, from])
      for (const image of [1, 2])
        client.run(
          "INSERT INTO demo_creator_gallery(id,creator_id,label,file_path,is_profile_picture,is_main_picture,created_at,updated_at) VALUES (?,?,?,'demo_mode/seeded/fixture.png',0,0,'2026-01-01','2026-01-01')",
          [image, id, `Image${id}:${image}`]
        );
    const video = client
      .query<{ id: number }, []>("SELECT id FROM demo_videos LIMIT 1")
      .get()!.id;
    for (const id of [into, from])
      client.run(
        "INSERT INTO demo_video_creators(video_id,creator_id) VALUES (?,?)",
        [video, id]
      );
    const { creatorCollectionsService: service } =
      await import("@/modules/creator-collections/creator-collections.service");
    const target = await service.save(
      into,
      collectionInput.parse({
        title: "Target set",
        gallery_ids: [2, 1],
        video_ids: [video],
      }),
      0
    );
    const source = await service.save(
      from,
      collectionInput.parse({
        title: "Source set",
        gallery_ids: [1, 2],
        video_ids: [video],
      }),
      0
    );
    const { creatorsMergeDemoService } =
      await import("@/modules/creators/creators.merge.demo.service");
    creatorsMergeDemoService.mergeCreators(from, into, "isolated fixture");
    const merged = await service.list(into);
    expect(merged.sets.map((s) => s.id)).toEqual([
      target.sets[0].id,
      source.sets[0].id,
    ]);
    expect(merged.sets[0].gallery_ids).toEqual([2, 1]);
    expect(merged.sets[1].gallery_ids).toEqual([3, 4]);
    expect(
      client
        .query("SELECT 1 FROM demo_settings WHERE key=?")
        .get(`creator_collection_sets:${from}`)
    ).toBeNull();
    expect(
      client
        .query(
          "SELECT label FROM demo_creator_gallery WHERE creator_id=? AND id=3"
        )
        .get(into)
    ).toMatchObject({ label: `Image${from}:1` });
    await expect(
      service.save(
        into,
        collectionInput.parse(target.sets[0]),
        target.revision,
        target.sets[0].id
      )
    ).rejects.toThrow("changed");
    client.run("DELETE FROM demo_creator_gallery WHERE creator_id=? AND id=3", [
      into,
    ]);
    const listed = await service.list(into);
    expect(listed.sets[1].gallery_ids).toEqual([4]);
    expect(listed.sets[1].removed_gallery_ids).toEqual([3]);
    const saved = await service.save(
      into,
      collectionInput.parse({ ...listed.sets[1], title: "Still editable" }),
      listed.revision,
      listed.sets[1].id
    );
    expect(saved.sets[1].title).toBe("Still editable");
    expect(saved.sets[1].removed_gallery_ids).toEqual([3]);
    expect(client.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
