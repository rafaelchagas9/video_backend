import { describe, expect, it } from "bun:test";
import { oshashBlocks } from "@/modules/enrichment/enrichment.fingerprint";
import {
  parseExactExternalReference,
  externalProfileUrl,
} from "@/modules/enrichment/enrichment.reference";

describe("Stash fingerprints and extensible metadata references", () => {
  it("uses the OpenSubtitles little-endian additive algorithm", () => {
    const first = Buffer.alloc(65536);
    const last = Buffer.alloc(65536);
    first.writeBigUInt64LE(0xffffffffffffffffn, 0);
    last.writeBigUInt64LE(3n, 0);
    expect(oshashBlocks(131072, first, last)).toBe("0000000000020002");
  });
  it("refuses incomplete boundary blocks", () => {
    expect(() =>
      oshashBlocks(131072, Buffer.alloc(10), Buffer.alloc(65536))
    ).toThrow();
  });
  it("recognizes FansDB creator profiles and custom scoped IDs", () => {
    expect(
      parseExactExternalReference(
        "https://fansdb.cc/performers/creator-id",
        "creator"
      )
    ).toEqual({ source: "fansdb", externalId: "creator-id" });
    expect(
      parseExactExternalReference("custom-id", "creator", ["privatebox"])
    ).toEqual({ source: "privatebox", externalId: "custom-id" });
    expect(externalProfileUrl("fansdb", "creator-id")).toBe(
      "https://fansdb.cc/performers/creator-id"
    );
  });
});
