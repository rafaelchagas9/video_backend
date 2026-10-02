import { describe, expect, test } from "bun:test";
import {
  collectionInput,
  removeCollection,
  updateCollectionDocument,
} from "../src/modules/creator-collections/creator-collections.domain";
const input = collectionInput.parse({
  title: "Summer",
  gallery_ids: [4, 2],
  video_ids: [3],
});
const members = { gallery: new Set([2, 4]), videos: new Set([3]) };
describe("creator collection sets", () => {
  test("keeps curated image order and source/date while updating one set", () => {
    const first = updateCollectionDocument(
      { revision: 0, sets: [] },
      input,
      0,
      members
    );
    const next = updateCollectionDocument(
      first,
      { ...input, title: "New title" },
      1,
      members,
      first.sets[0]!.id
    );
    expect(next.sets[0]!.gallery_ids).toEqual([4, 2]);
    expect(next.sets[0]!.created_at).toBe(first.sets[0]!.created_at);
    expect(next.sets).toHaveLength(1);
    expect(next.revision).toBe(2);
  });
  test("removes one set and advances the revision, guarding stale deletes", () => {
    const first = updateCollectionDocument(
      { revision: 0, sets: [] },
      input,
      0,
      members
    );
    const second = updateCollectionDocument(first, input, 1, members);
    const removed = removeCollection(second, 2, first.sets[0]!.id);
    expect(removed.sets.map((v) => v.id)).toEqual([second.sets[1]!.id]);
    expect(removed.revision).toBe(3);
    expect(() => removeCollection(second, 1, first.sets[0]!.id)).toThrow(
      "changed"
    );
    expect(() => removeCollection(removed, 3, first.sets[0]!.id)).toThrow(
      "no longer exists"
    );
  });
  test("rejects stale revisions so concurrent edits cannot overwrite another set", () =>
    expect(() =>
      updateCollectionDocument({ revision: 2, sets: [] }, input, 1, members)
    ).toThrow("changed"));
  test("rejects cross-creator images and videos", () => {
    expect(() =>
      updateCollectionDocument({ revision: 0, sets: [] }, input, 0, {
        ...members,
        gallery: new Set(),
      })
    ).toThrow("image");
    expect(() =>
      updateCollectionDocument({ revision: 0, sets: [] }, input, 0, {
        ...members,
        videos: new Set(),
      })
    ).toThrow("video");
  });
  test("requires unique image ordering and actual calendar dates", () => {
    expect(
      collectionInput.safeParse({ title: "Test", gallery_ids: [1, 1] }).success
    ).toBe(false);
    expect(
      collectionInput.safeParse({ title: "Test", release_date: "2026-02-30" })
        .success
    ).toBe(false);
  });
});
