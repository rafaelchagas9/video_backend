import { describe, expect, it } from "bun:test";
import {
  getVideoQuerySchema,
  listVideosQuerySchema,
  randomVideoQuerySchema,
} from "@/modules/videos/videos.schemas";

describe("video route schemas", () => {
  it("coerces and normalizes list query parameters", () => {
    const parsed = listVideosQuerySchema.parse({
      page: "3",
      limit: "25",
      searchFullPath: "true",
      include_hidden: "false",
      creatorIds: "1, 2, invalid, 3",
      tagIds: ["4", 5],
      studioIds: "7",
      include: "collection, creators, tags",
      sort: "file_name",
      order: "asc",
    });

    expect(parsed).toMatchObject({
      page: 3,
      limit: 25,
      searchFullPath: true,
      include_hidden: false,
      creatorIds: [1, 2, 3],
      tagIds: [4, 5],
      studioIds: [7],
      include: ["collection", "creators", "tags"],
      sort: "file_name",
      order: "asc",
      matchMode: "any",
    });
  });

  it("rejects inverted numeric ranges in list queries", () => {
    const result = listVideosQuerySchema.safeParse({
      minDuration: "120",
      maxDuration: "60",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        "Minimum value cannot be greater than maximum value",
      );
    }
  });

  it("coerces random video filters and rejects invalid play count ranges", () => {
    expect(
      randomVideoQuerySchema.parse({
        include_hidden: "true",
        hasTags: "false",
        creatorIds: "9,10",
        minPlayCount: "0",
        maxPlayCount: "5",
        limit: "4",
      }),
    ).toMatchObject({
      include_hidden: true,
      hasTags: false,
      creatorIds: [9, 10],
      minPlayCount: 0,
      maxPlayCount: 5,
      limit: 4,
    });

    expect(
      randomVideoQuerySchema.safeParse({
        minPlayCount: "6",
        maxPlayCount: "2",
      }).success,
    ).toBe(false);
  });

  it("parses include lists for video detail queries", () => {
    expect(
      getVideoQuerySchema.parse({
        include: "collection, collection_neighbors, creators",
      }),
    ).toEqual({
      include: ["collection", "collection_neighbors", "creators"],
    });

    expect(getVideoQuerySchema.safeParse({ include: "invalid" }).success).toBe(
      false,
    );
  });
});
