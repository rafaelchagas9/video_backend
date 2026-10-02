import { expect, it } from "bun:test";
import { creatorAge, utcDate } from "@/modules/creators/creators.attributes";

export const creatorFilterFixtures: Record<string, any>[] = [
  {
    name: "Facet Fixture Alpha",
    country: "US",
    gender: "FEMALE",
    ethnicity: "LATINA",
    hair_color: "BLOND",
    eye_color: "GREY",
    height_cm: 165,
    cup_size: "C",
    band_size: 32,
    waist_size: 26,
    hip_size: 36,
    breast_type: "FAKE",
    birth_date: "2000-02-29",
    career_start_year: 2018,
    career_end_year: 2023,
    external_ids: [
      { source: "The Porn DB", external_id: "alpha-t" },
      { source: "stashdb", external_id: "alpha-s" },
      { source: "stashdb", external_id: "alpha-s2" },
    ],
  },
  {
    name: "Facet Fixture Beta",
    country: "United States of America",
    gender: "Female",
    ethnicity: "LATIN",
    hair_color: "Brunette",
    eye_color: "Green",
    height_cm: 170,
    cup_size: "D",
    band_size: 34,
    waist_size: 28,
    hip_size: 38,
    breast_type: "natural",
    birth_date: "1990-01-01",
    career_start_year: 2010,
    external_ids: [{ source: "theporndb", external_id: "beta" }],
  },
  {
    name: "Facet Fixture Gamma",
    country: "Brazil",
    gender: "MALE",
    ethnicity: "Custom Heritage",
    hair_color: "BLACK",
    eye_color: "Brown",
    height_cm: 180,
    band_size: 36,
    waist_size: 30,
    hip_size: 40,
    birth_date: "1993",
    career_start_year: 2015,
    external_ids: [{ source: "stashdb", external_id: "gamma" }],
  },
  { name: "Facet Fixture Delta" },
  {
    name: "Facet Fixture Epsilon",
    country: "NA",
    hair_color: "Brown",
    eye_color: "BLUE",
    birth_date: "2001-02-29",
    height_cm: 0,
  },
  {
    name: "Facet Fixture Zeta",
    country: "France",
    hair_color: "REDHEAD",
    birth_date: "1980-05-10",
    death_date: "2020-05-09",
    height_cm: 160,
  },
];
type Response = { statusCode: number; body: string; json(): any };
export function creatorFilterContract(
  get: (query: string, facets?: boolean) => Promise<Response>
) {
  const expectedNames = (names: string[]) =>
    names.map((name) => `Facet Fixture ${name}`).sort();
  async function names(query: string, expected: string[]) {
    const response = await get(query);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.data.map((row: any) => row.name).sort(), query).toEqual(
      expectedNames(expected)
    );
    expect(body.pagination.total, query).toBe(expected.length);
  }
  it("filters normalized provider attributes, combinations, unknowns and numeric ranges", async () => {
    const cases: [string, string[]][] = [
      ["country=usa", ["Alpha", "Beta"]],
      ["country=Brazil,US&gender=female", ["Alpha", "Beta"]],
      ["country=US&hairColor=blonde,brown&minHeightCm=168", ["Beta"]],
      ["ethnicity=latino&eyeColor=gray", ["Alpha"]],
      ["hairColor=brunette", ["Beta", "Epsilon"]],
      ["country=Namibia", ["Epsilon"]],
      ["country=unknown", ["Delta"]],
      ["country=unknown,us", ["Alpha", "Beta", "Delta"]],
      ["breastType=enhanced&cupSize=c", ["Alpha"]],
      [
        "minBandSize=32&maxBandSize=34&minWaistSize=27&maxWaistSize=29&minHipSize=38&maxHipSize=38",
        ["Beta"],
      ],
      [
        "minCareerStartYear=2015&maxCareerStartYear=2018&minCareerEndYear=2023&maxCareerEndYear=2023",
        ["Alpha"],
      ],
      ["missingAttributes=age", ["Gamma", "Delta", "Epsilon"]],
      ["knownAttributes=heightCm&maxHeightCm=165", ["Alpha", "Zeta"]],
      ["missingAttributes=heightCm", ["Delta", "Epsilon"]],
      ["providers=TPDB,Stash%20DB&providerMatch=all", ["Alpha"]],
      ["providers=theporndb,stashdb", ["Alpha", "Beta", "Gamma"]],
      ["providers=unlinked", ["Delta", "Epsilon", "Zeta"]],
      [
        "providers=stashdb,unlinked",
        ["Alpha", "Gamma", "Delta", "Epsilon", "Zeta"],
      ],
      ["country=does-not-exist", []],
      ["hairColor=x%27%20OR%201%3D1--", []],
    ];
    for (const [query, expected] of cases) await names(query, expected);
    const age = creatorAge("2000-02-29", null, utcDate())!;
    await names(`country=US&minAge=${age}&maxAge=${age}`, ["Alpha"]);
    await names("minAge=39&maxAge=39&country=France", ["Zeta"]);
  });
  it("keeps counts and pagination stable across duplicate external identities", async () => {
    const first = await get(
      "providers=stashdb&sort=video_count&limit=1&page=1"
    );
    const second = await get(
      "providers=stashdb&sort=video_count&limit=1&page=2"
    );
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(first.json().pagination).toMatchObject({ total: 2, totalPages: 2 });
    expect(second.json().pagination).toMatchObject({ total: 2, totalPages: 2 });
    expect(first.json().data[0].id).not.toBe(second.json().data[0].id);
    const empty = await get("providers=stashdb&limit=1&page=3");
    expect(empty.json().data).toEqual([]);
    expect(empty.json().pagination.total).toBe(2);
  });
  it("returns disjunctive facets independent of pagination and excludes its own presence/range filters", async () => {
    const result = await get(
      "country=US&hairColor=blonde&limit=1&page=99",
      true
    );
    expect(result.statusCode, result.body).toBe(200);
    const { facets, total, asOf } = result.json().data;
    expect(total).toBe(1);
    expect(asOf).toBe(utcDate());
    expect(facets.hairColor.options).toEqual([
      { value: "blonde", label: "Blonde", count: 1 },
      { value: "brown", label: "Brown", count: 1 },
    ]);
    expect(facets.providers.options).toEqual([
      { value: "stashdb", label: "StashDB", count: 1 },
      { value: "theporndb", label: "ThePornDB", count: 1 },
    ]);
    expect(facets.heightCm).toEqual({
      type: "range",
      min: 165,
      max: 165,
      knownCount: 1,
      unknownCount: 0,
    });
    const ranges = await get("minHeightCm=175", true);
    expect(ranges.statusCode, ranges.body).toBe(200);
    expect(ranges.json().data.total).toBe(1);
    expect(ranges.json().data.facets.heightCm).toEqual({
      type: "range",
      min: 160,
      max: 180,
      knownCount: 4,
      unknownCount: 2,
    });
    const missing = await get("missingAttributes=heightCm", true);
    expect(missing.json().data.total).toBe(2);
    expect(missing.json().data.facets.heightCm).toEqual(
      ranges.json().data.facets.heightCm
    );
    const empty = await get("country=not-real&gender=not-real", true);
    expect(empty.json().data.facets.heightCm).toEqual({
      type: "range",
      min: null,
      max: null,
      knownCount: 0,
      unknownCount: 0,
    });
    expect(empty.json().data.facets.hairColor.options).toEqual([]);
  });
  it("retains existing booleans, completeness and video filters", async () => {
    await names(
      "isFavorite=false&hasProfilePicture=false&complete=false&maxVideoCount=0",
      ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"]
    );
    await names("isFavorite=true", []);
    await names("complete=true", []);
    await names("missing=platform", [
      "Alpha",
      "Beta",
      "Gamma",
      "Delta",
      "Epsilon",
      "Zeta",
    ]);
    const response = await get("complete=true", true);
    expect(response.json().data.total).toBe(0);
    expect(response.json().data.facets.country.options).toEqual([]);
  });
  it("rejects invalid filters identically on list and facets", async () => {
    for (const query of [
      "minAge=40&maxAge=20",
      "minHeightCm=",
      "minHipSize=-2",
      "providers=nope",
      "complete=falsey",
      "missingAttributes=age&minAge=20",
      "knownAttributes=hairColor&hairColor=unknown",
      "studioIds=1abc",
      "providers=unlinked,stashdb&providerMatch=all",
    ]) {
      for (const facets of [false, true]) {
        const result = await get(query, facets);
        expect(result.statusCode, `${query}: ${result.body}`).toBe(400);
      }
    }
  });
}
