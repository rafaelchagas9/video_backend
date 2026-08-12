import { describe, expect, it } from "bun:test";
import { parseExactExternalReference } from "@/modules/enrichment/enrichment.reference";
import { BadRequestError } from "@/utils/errors";

describe("exact enrichment external references", () => {
  it("infers ThePornDB and extracts a performer ID from a URL", () => {
    expect(
      parseExactExternalReference(
        "https://www.theporndb.net/performers/tpdb-uuid-123?tab=images",
        "creator",
        ["stashdb"],
      ),
    ).toEqual({ source: "theporndb", externalId: "tpdb-uuid-123" });
  });

  it("accepts a StashDB URL without an explicit scheme", () => {
    expect(
      parseExactExternalReference(
        "stashdb.org/scenes/scene-uuid-456",
        "scene",
      ),
    ).toEqual({ source: "stashdb", externalId: "scene-uuid-456" });
  });

  it("uses the selected source for a raw external ID", () => {
    expect(
      parseExactExternalReference("raw-id-789", "scene", ["stashdb"]),
    ).toEqual({ source: "stashdb", externalId: "raw-id-789" });
  });

  it("rejects an ambiguous raw external ID", () => {
    expect(() =>
      parseExactExternalReference("raw-id-789", "creator", [
        "theporndb",
        "stashdb",
      ]),
    ).toThrow(
      "Select exactly one enrichment source when using a raw external ID",
    );
  });

  it("rejects URLs for a different entity type", () => {
    expect(() =>
      parseExactExternalReference(
        "https://stashdb.org/performers/performer-id",
        "scene",
      ),
    ).toThrow("Enrichment URL targets creator, not scene");
  });

  it("rejects arbitrary external hosts", () => {
    expect(() =>
      parseExactExternalReference(
        "https://example.com/scenes/scene-id",
        "scene",
      ),
    ).toThrow(BadRequestError);
  });
});
