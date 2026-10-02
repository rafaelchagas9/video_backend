/** Canonical search values; raw accepted facts are deliberately preserved. */
export const categoricalAttributes = {
  country: "country",
  gender: "gender",
  ethnicity: "ethnicity",
  hairColor: "hair_color",
  eyeColor: "eye_color",
  cupSize: "cup_size",
  breastType: "breast_type",
} as const;
export const numericAttributes = {
  heightCm: "height_cm",
  age: "age",
  bandSize: "band_size",
  waistSize: "waist_size",
  hipSize: "hip_size",
  careerStartYear: "career_start_year",
  careerEndYear: "career_end_year",
} as const;
export type Category = keyof typeof categoricalAttributes;
export type NumericAttribute = keyof typeof numericAttributes;
export type Attribute = Category | NumericAttribute;
export const attributeNames = [
  ...Object.keys(categoricalAttributes),
  ...Object.keys(numericAttributes),
] as Attribute[];
export const facetNames = [...attributeNames, "providers"] as const;
export type Facet = Attribute | "providers";
export type Provider = "theporndb" | "stashdb" | "unlinked";
export type AttributeFilters = Partial<Record<Category, string[]>> &
  Partial<
    Record<
      | `min${Capitalize<NumericAttribute>}`
      | `max${Capitalize<NumericAttribute>}`,
      number
    >
  > & {
    providers?: Provider[];
    providerMatch?: "any" | "all";
    missingAttributes?: Attribute[];
    knownAttributes?: Attribute[];
  };
export const unknownTokens = [
  "",
  "unknown",
  "n/a",
  "na",
  "null",
  "unspecified",
  "not specified",
  "not known",
];
export function valueToken(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .trim();
}
const countries =
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(
    " "
  );
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const countryAliases: Record<string, string> = {};
for (const code of countries) {
  countryAliases[valueToken(code)] = code.toLowerCase();
  countryAliases[valueToken(regionNames.of(code))] = code.toLowerCase();
}
Object.assign(countryAliases, {
  usa: "us",
  "u.s.": "us",
  "u.s.a.": "us",
  "united states of america": "us",
  american: "us",
  uk: "gb",
  "u.k.": "gb",
  "great britain": "gb",
  british: "gb",
  brazilian: "br",
  brasil: "br",
  canadian: "ca",
  french: "fr",
  german: "de",
  russian: "ru",
  japanese: "jp",
  czech: "cz",
  "czech republic": "cz",
  australian: "au",
  italian: "it",
  spanish: "es",
  mexican: "mx",
  colombian: "co",
  ukrainian: "ua",
  "south korea": "kr",
  "north korea": "kp",
});
export const attributeAliases: Record<Category, Record<string, string>> = {
  country: countryAliases,
  gender: {
    woman: "female",
    women: "female",
    man: "male",
    men: "male",
    "trans female": "transgender female",
    "trans woman": "transgender female",
    "transgender woman": "transgender female",
    "trans male": "transgender male",
    "trans man": "transgender male",
    "transgender man": "transgender male",
    nonbinary: "non binary",
  },
  ethnicity: { latina: "latin", latino: "latin" },
  hairColor: {
    blond: "blonde",
    brunette: "brown",
    grey: "gray",
    redhead: "red",
  },
  eyeColor: { grey: "gray" },
  cupSize: {},
  breastType: {
    na: "not applicable",
    "n/a": "not applicable",
    fake: "augmented",
    enhanced: "augmented",
    implants: "augmented",
    silicone: "augmented",
    real: "natural",
  },
};
export function normalizeAttribute(
  field: Category,
  value: unknown
): string | null {
  const token = valueToken(value);
  // NA is Namibia's ISO code, so do not interpret it as missing country data.
  if (
    unknownTokens.includes(token) &&
    !(field === "country" && token === "na") &&
    !(field === "breastType" && ["na", "n/a"].includes(token))
  )
    return null;
  return Object.hasOwn(attributeAliases[field], token)
    ? attributeAliases[field][token]!
    : token;
}
export function normalizeProvider(value: unknown): Provider | null {
  const token = valueToken(value).replace(/ /g, "");
  return token === "theporndb" || token === "tpdb"
    ? "theporndb"
    : token === "stashdb"
      ? "stashdb"
      : token === "unlinked"
        ? "unlinked"
        : null;
}
export function rangeKeys(field: NumericAttribute) {
  const capitalized = field[0]!.toUpperCase() + field.slice(1);
  return [`min${capitalized}`, `max${capitalized}`] as const as readonly [
    `min${Capitalize<NumericAttribute>}`,
    `max${Capitalize<NumericAttribute>}`,
  ];
}
export function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}
function fullDate(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || text.startsWith("0000")) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === text
    ? text
    : null;
}
/** Full dates only. For deceased creators use age at death, otherwise age today. */
export function creatorAge(
  birth: unknown,
  death: unknown,
  asOf: string
): number | null {
  const born = fullDate(birth);
  const end = unknownTokens.includes(valueToken(death))
    ? asOf
    : fullDate(death);
  if (!born || !end || born > end || end > asOf) return null;
  return (
    Number(end.slice(0, 4)) -
    Number(born.slice(0, 4)) -
    Number(end.slice(5) < born.slice(5))
  );
}
export type AttributeValues = Record<Category, string | null> &
  Record<NumericAttribute, number | null> & { providers: Provider[] };
export function creatorAttributeValues(
  row: Record<string, any>,
  asOf: string
): AttributeValues {
  const result: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(categoricalAttributes))
    result[field] = normalizeAttribute(field as Category, row[column]);
  for (const [field, column] of Object.entries(numericAttributes)) {
    const value = row[column];
    result[field] =
      typeof value === "number" && Number.isInteger(value) && value > 0
        ? value
        : null;
  }
  result.age = creatorAge(row.birth_date, row.death_date, asOf);
  const linked = new Set<Provider>();
  for (const identity of Array.isArray(row.external_ids)
    ? row.external_ids
    : []) {
    const source = normalizeProvider(identity?.source);
    if (
      source &&
      source !== "unlinked" &&
      String(identity?.external_id ?? "").trim()
    )
      linked.add(source);
  }
  result.providers = linked.size ? [...linked].sort() : ["unlinked"];
  return result as AttributeValues;
}
export function activeAttributeFacets(filters: AttributeFilters): Facet[] {
  return facetNames.filter((field) => {
    if (field === "providers") return Boolean(filters.providers?.length);
    if (
      filters.missingAttributes?.includes(field) ||
      filters.knownAttributes?.includes(field)
    )
      return true;
    if (field in categoricalAttributes)
      return Boolean(filters[field as Category]?.length);
    const [min, max] = rangeKeys(field as NumericAttribute);
    return filters[min] !== undefined || filters[max] !== undefined;
  });
}
export function matchesAttributes(
  values: AttributeValues,
  filters: AttributeFilters,
  omit?: Facet
): boolean {
  for (const field of attributeNames) {
    if (field === omit) continue;
    const value = values[field];
    if (filters.missingAttributes?.includes(field) && value !== null)
      return false;
    if (filters.knownAttributes?.includes(field) && value === null)
      return false;
    if (field in categoricalAttributes) {
      const selected = filters[field as Category];
      if (
        selected?.length &&
        !selected.includes(value === null ? "unknown" : String(value))
      )
        return false;
    } else {
      const [min, max] = rangeKeys(field as NumericAttribute);
      if (
        filters[min] !== undefined &&
        (value === null || Number(value) < filters[min]!)
      )
        return false;
      if (
        filters[max] !== undefined &&
        (value === null || Number(value) > filters[max]!)
      )
        return false;
    }
  }
  if (omit !== "providers" && filters.providers?.length) {
    const check = (provider: Provider) => values.providers.includes(provider);
    if (
      !(filters.providerMatch === "all"
        ? filters.providers.every(check)
        : filters.providers.some(check))
    )
      return false;
  }
  return true;
}
export function facetLabel(field: Facet, value: string): string {
  if (value === "unknown") return "Unknown";
  if (field === "country" && countries.includes(value.toUpperCase()))
    return regionNames.of(value.toUpperCase())!;
  if (field === "cupSize") return value.toUpperCase();
  if (field === "providers")
    return (
      (
        {
          theporndb: "ThePornDB",
          stashdb: "StashDB",
          unlinked: "Unlinked",
        } as Record<string, string>
      )[value] ?? value
    );
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}
export type CategoryFacet = {
  type: "categorical";
  options: { value: string; label: string; count: number }[];
};
export type RangeFacet = {
  type: "range";
  min: number | null;
  max: number | null;
  knownCount: number;
  unknownCount: number;
};
export type CreatorFacets = {
  asOf: string;
  total: number;
  facets: Record<Category | "providers", CategoryFacet> &
    Record<NumericAttribute, RangeFacet>;
};
export function assembleFacets(
  rows: {
    field: string;
    value: string | null;
    count: number | string;
    min: number | null;
    max: number | null;
    unknown_count: number | string;
  }[],
  total: number,
  asOf: string
): CreatorFacets {
  const facets: Record<string, CategoryFacet | RangeFacet> = {};
  for (const field of facetNames) {
    const matches = rows.filter((row) => row.field === field);
    if (field in numericAttributes) {
      const row = matches[0];
      facets[field] = {
        type: "range",
        min: row?.min == null ? null : Number(row.min),
        max: row?.max == null ? null : Number(row.max),
        knownCount: Number(row?.count ?? 0),
        unknownCount: Number(row?.unknown_count ?? 0),
      };
    } else {
      facets[field] = {
        type: "categorical",
        options: matches
          .map((row) => ({
            value: row.value ?? "unknown",
            label: facetLabel(field, row.value ?? "unknown"),
            count: Number(row.count),
          }))
          .sort(
            (a, b) =>
              a.label.localeCompare(b.label, "en") ||
              a.value.localeCompare(b.value, "en")
          ),
      };
    }
  }
  return { asOf, total, facets: facets as CreatorFacets["facets"] };
}
export function demoAttributeFacets(
  values: AttributeValues[],
  filters: AttributeFilters,
  asOf: string
): CreatorFacets {
  const rows: Parameters<typeof assembleFacets>[0] = [];
  for (const field of facetNames) {
    const eligible = values.filter((value) =>
      matchesAttributes(value, filters, field)
    );
    if (field in numericAttributes) {
      const known = eligible
        .map((value) => value[field as NumericAttribute])
        .filter((value): value is number => value !== null);
      rows.push({
        field,
        value: null,
        count: known.length,
        min: known.length ? known.reduce((a, b) => Math.min(a, b)) : null,
        max: known.length ? known.reduce((a, b) => Math.max(a, b)) : null,
        unknown_count: eligible.length - known.length,
      });
    } else {
      const counts = new Map<string, number>();
      for (const value of eligible)
        for (const key of field === "providers"
          ? value.providers
          : [value[field as Category] ?? "unknown"])
          counts.set(key, (counts.get(key) ?? 0) + 1);
      for (const [value, count] of counts)
        rows.push({
          field,
          value,
          count,
          min: null,
          max: null,
          unknown_count: 0,
        });
    }
  }
  return assembleFacets(
    rows,
    values.filter((value) => matchesAttributes(value, filters)).length,
    asOf
  );
}
