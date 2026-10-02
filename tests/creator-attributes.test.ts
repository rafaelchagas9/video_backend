import { describe, expect, it } from "bun:test";
import {
  creatorAge,
  normalizeAttribute,
  creatorAttributeValues,
  matchesAttributes,
  demoAttributeFacets,
} from "@/modules/creators/creators.attributes";
import { listCreatorsQuerySchema } from "@/modules/creators/creators.schemas";

const parse = (value: unknown) => listCreatorsQuerySchema.parse(value);
describe("creator attribute normalization and validation", () => {
  it("normalizes provider spellings without destroying unknown categories", () => {
    for (const country of [
      "US",
      "usa",
      "United States",
      "United States of America",
      "American",
    ])
      expect(normalizeAttribute("country", country)).toBe("us");
    expect(normalizeAttribute("country", "Namibia")).toBe("na");
    expect(normalizeAttribute("country", "NA")).toBe("na");
    expect(normalizeAttribute("country", "N/A")).toBeNull();
    expect(normalizeAttribute("breastType", "NA")).toBe("not applicable");
    expect(normalizeAttribute("country", "Brazil")).toBe("br");
    expect(normalizeAttribute("hairColor", "BRUNETTE")).toBe("brown");
    expect(normalizeAttribute("hairColor", "blond")).toBe("blonde");
    expect(normalizeAttribute("eyeColor", "GREY")).toBe("gray");
    expect(normalizeAttribute("gender", "TRANSGENDER_FEMALE")).toBe(
      "transgender female"
    );
    expect(normalizeAttribute("breastType", "FAKE")).toBe("augmented");
    expect(normalizeAttribute("ethnicity", "not specified")).toBeNull();
    expect(normalizeAttribute("hairColor", "New Colour")).toBe("new colour");
    expect(normalizeAttribute("hairColor", "constructor")).toBe("constructor");
    expect(
      parse({
        hairColor: ["Blond,BLONDE", "Brown"],
        providers: "TPDB,Stash DB",
      })
    ).toMatchObject({
      hairColor: ["blonde", "brown"],
      providers: ["theporndb", "stashdb"],
    });
  });
  it("parses false as false and rejects malformed or contradictory filters", () => {
    expect(
      parse({
        isFavorite: "false",
        complete: "false",
        hasProfilePicture: "false",
      })
    ).toMatchObject({
      isFavorite: false,
      complete: false,
      hasProfilePicture: false,
    });
    for (const input of [
      { isFavorite: "0" },
      { complete: "no" },
      { hairColor: "" },
      { hairColor: "brown,,blonde" },
      { minHeightCm: "" },
      { minAge: "NaN" },
      { minAge: "-1" },
      { minAge: "1.5" },
      { minAge: "10000" },
      { minHeightCm: 180, maxHeightCm: 160 },
      { minWaistSize: 30, maxWaistSize: 20 },
      { missingAttributes: "age", minAge: 20 },
      { missingAttributes: "country", country: "US" },
      { missingAttributes: "age", knownAttributes: "age" },
      { knownAttributes: "country", country: "unknown" },
      { providers: "untrusted" },
      { providerMatch: "all" },
      { providers: "unlinked,stashdb", providerMatch: "all" },
      { studioIds: "1abc" },
      { studioIds: "1,,2" },
      { missingAttributes: "notAField" },
      { minCareerStartYear: 2025, maxCareerStartYear: 2000 },
    ])
      expect(
        listCreatorsQuerySchema.safeParse(input).success,
        JSON.stringify(input)
      ).toBe(false);
  });
  it("computes exact age with leap-day, birthday and death boundaries", () => {
    expect(creatorAge("2000-02-29", null, "2025-02-28")).toBe(24);
    expect(creatorAge("2000-02-29", null, "2025-03-01")).toBe(25);
    expect(creatorAge("1980-05-10", "2020-05-09", "2026-09-27")).toBe(39);
    expect(creatorAge("2000-09-27", null, "2026-09-26")).toBe(25);
    expect(creatorAge("2000-09-27", null, "2026-09-27")).toBe(26);
    for (const date of [
      "2000",
      "2000-01",
      "2001-02-29",
      "2020-04-31",
      "0000-01-01",
      "2000-13-01",
      "garbage",
      "9999-12-31",
    ])
      expect(creatorAge(date, null, "2026-09-27")).toBeNull();
    expect(creatorAge("2000-01-01", "2020", "2026-09-27")).toBeNull();
    expect(creatorAge("2000-01-01", "1999-01-01", "2026-09-27")).toBeNull();
  });
  it("uses OR within fields, AND across fields, and self-excluding facet counts", () => {
    const rows = [
      {
        country: "US",
        hair_color: "BLONDE",
        height_cm: 165,
        external_ids: [
          { source: "The Porn DB", external_id: "a" },
          { source: "stashdb", external_id: "a" },
        ],
      },
      { country: "United States", hair_color: "Brunette", height_cm: 170 },
      { country: "Brazil", hair_color: "Blonde", height_cm: 180 },
      {},
    ].map((row) => creatorAttributeValues(row, "2026-09-27"));
    const filters = parse({
      country: "US",
      hairColor: "blond,brown",
      minHeightCm: 168,
    });
    expect(rows.map((row) => matchesAttributes(row, filters))).toEqual([
      false,
      true,
      false,
      false,
    ]);
    expect(
      matchesAttributes(
        rows[0]!,
        parse({ providers: "theporndb,stashdb", providerMatch: "all" })
      )
    ).toBe(true);
    const facets = demoAttributeFacets(
      rows,
      parse({ country: "US", hairColor: "blonde" }),
      "2026-09-27"
    );
    expect(facets.total).toBe(1);
    expect(
      facets.facets.hairColor.options.map((item) => [item.value, item.count])
    ).toEqual([
      ["blonde", 1],
      ["brown", 1],
    ]);
    expect(
      facets.facets.country.options.map((item) => [item.value, item.count])
    ).toEqual([
      ["br", 1],
      ["us", 1],
    ]);
  });
});
