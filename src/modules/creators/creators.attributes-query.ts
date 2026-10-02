import { sql, type SQL } from "drizzle-orm";
import {
  attributeAliases,
  attributeNames,
  categoricalAttributes,
  numericAttributes,
  unknownTokens,
  facetNames,
  rangeKeys,
  type Category,
  type Facet,
  type NumericAttribute,
  type AttributeFilters,
} from "./creators.attributes";
import type { ListCreatorsOptions } from "./creators.types";
import { creatorDirectoryQuery } from "./creators.directory-query";

const quoted = (name: string) => sql.identifier(name);
const projected = (name: string) => sql`a.${quoted(name)}`;
const inValues = (values: readonly unknown[]) =>
  sql`(${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `
  )})`;
function tokenSql(value: SQL) {
  return sql`btrim(regexp_replace(lower(btrim(COALESCE(${value}, ''))), '[[:space:]_-]+', ' ', 'g'))`;
}
function categorySql(field: Category) {
  const token = tokenSql(sql`c.${quoted(categoricalAttributes[field])}`);
  const unknown = unknownTokens.filter(
    (value) =>
      !(field === "country" && value === "na") &&
      !(field === "breastType" && ["na", "n/a"].includes(value))
  );
  return sql`CASE WHEN ${token} IN ${inValues(unknown)} THEN NULL
    ELSE COALESCE(${JSON.stringify(attributeAliases[field])}::jsonb ->> ${token}, ${token}) END`;
}
/** Guard casts and construct only a valid first of month, then validate the day. */
function fullDateSql(column: SQL) {
  const value = sql`btrim(${column})`;
  const year = sql`substring(${value}, 1, 4)::integer`;
  const month = sql`substring(${value}, 6, 2)::integer`;
  const day = sql`substring(${value}, 9, 2)::integer`;
  const date = sql`(make_date(${year}, ${month}, 1) + (${day} - 1))`;
  return sql`CASE WHEN ${value} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    CASE WHEN ${year} BETWEEN 1 AND 9999 AND ${month} BETWEEN 1 AND 12 AND ${day} BETWEEN 1 AND 31 THEN
      CASE WHEN to_char(${date}, 'YYYY-MM-DD') = ${value} THEN ${date} END
    END END`;
}
function providerExists(provider: string) {
  const aliases =
    provider === "theporndb" ? ["theporndb", "tpdb"] : ["stashdb"];
  return sql`EXISTS (SELECT 1 FROM creator_external_ids cei WHERE cei.creator_id = c.id
    AND btrim(cei.external_id) <> ''
    AND replace(${tokenSql(sql`cei.source`)}, ' ', '') IN ${inValues(aliases)})`;
}
export function creatorCandidatesQuery(
  options: ListCreatorsOptions,
  userId: number | undefined,
  asOf: string,
  selected: readonly Facet[] = facetNames
): SQL {
  const { baseFrom, studioJoin, platformSearchJoin, whereClause } =
    creatorDirectoryQuery(options, userId);
  const fields: SQL[] = Object.keys(categoricalAttributes)
    .filter((field) => selected.includes(field as Facet))
    .map((field) => sql`${categorySql(field as Category)} AS ${quoted(field)}`);
  for (const [field, column] of Object.entries(numericAttributes)) {
    if (field === "age" || !selected.includes(field as Facet)) continue;
    fields.push(
      sql`CASE WHEN c.${quoted(column)} > 0 THEN c.${quoted(column)} END AS ${quoted(field)}`
    );
  }
  if (selected.includes("age"))
    fields.push(sql`CASE WHEN dates.born <= dates.ended AND dates.ended <= ${asOf}::date THEN
    extract(year FROM dates.ended)::integer - extract(year FROM dates.born)::integer
    - CASE WHEN to_char(dates.ended, 'MM-DD') < to_char(dates.born, 'MM-DD') THEN 1 ELSE 0 END
    END AS age`);
  if (selected.includes("providers"))
    fields.push(
      sql`${providerExists("theporndb")} AS theporndb`,
      sql`${providerExists("stashdb")} AS stashdb`
    );
  const dates = selected.includes("age")
    ? sql`LEFT JOIN LATERAL (SELECT ${fullDateSql(sql`c.birth_date`)} AS born,
      CASE WHEN ${tokenSql(sql`c.death_date`)} IN ${inValues(unknownTokens)} THEN ${asOf}::date
      ELSE ${fullDateSql(sql`c.death_date`)} END AS ended) dates ON true`
    : sql``;
  return sql`SELECT DISTINCT c.id ${fields.length ? sql`, ${sql.join(fields, sql`, `)}` : sql``}
    ${baseFrom} ${studioJoin} ${platformSearchJoin} ${dates} ${whereClause}`;
}
export function attributeWhereSql(
  filters: AttributeFilters,
  omit?: Facet
): SQL {
  const conditions: SQL[] = [];
  for (const field of attributeNames) {
    if (field === omit) continue;
    const value = projected(field);
    if (filters.missingAttributes?.includes(field))
      conditions.push(sql`${value} IS NULL`);
    if (filters.knownAttributes?.includes(field))
      conditions.push(sql`${value} IS NOT NULL`);
    if (field in categoricalAttributes) {
      const values = filters[field as Category];
      if (values?.length)
        conditions.push(
          sql`COALESCE(${value}, 'unknown') IN ${inValues(values)}`
        );
    } else {
      const [min, max] = rangeKeys(field as NumericAttribute);
      if (filters[min] !== undefined)
        conditions.push(sql`${value} >= ${filters[min]}`);
      if (filters[max] !== undefined)
        conditions.push(sql`${value} <= ${filters[max]}`);
    }
  }
  if (omit !== "providers" && filters.providers?.length) {
    const providers = filters.providers.map((provider) =>
      provider === "unlinked"
        ? sql`(NOT a.theporndb AND NOT a.stashdb)`
        : projected(provider)
    );
    conditions.push(
      sql`(${sql.join(providers, filters.providerMatch === "all" ? sql` AND ` : sql` OR `)})`
    );
  }
  return conditions.length ? sql.join(conditions, sql` AND `) : sql`true`;
}
/** One snapshot and one normalized candidate scan for all disjunctive facets. */
export function creatorFacetsSql(
  options: ListCreatorsOptions,
  userId: number | undefined,
  asOf: string
): SQL {
  const queries: SQL[] = [
    sql`SELECT '_total'::text AS field, NULL::text AS value, COUNT(*) AS count,
    NULL::integer AS min, NULL::integer AS max, 0::bigint AS unknown_count
    FROM candidates a WHERE ${attributeWhereSql(options)}`,
  ];
  for (const field of facetNames) {
    const where = attributeWhereSql(options, field);
    if (field in numericAttributes) {
      const value = projected(field);
      queries.push(sql`SELECT ${field}::text AS field, NULL::text AS value, COUNT(${value}) AS count,
        MIN(${value}) AS min, MAX(${value}) AS max, COUNT(*) FILTER (WHERE ${value} IS NULL) AS unknown_count
        FROM candidates a WHERE ${where}`);
    } else if (field === "providers") {
      queries.push(sql`SELECT 'providers'::text AS field, p.value, COUNT(*) AS count,
        NULL::integer AS min, NULL::integer AS max, 0::bigint AS unknown_count
        FROM candidates a CROSS JOIN LATERAL (
          SELECT 'theporndb'::text AS value WHERE a.theporndb
          UNION ALL SELECT 'stashdb' WHERE a.stashdb
          UNION ALL SELECT 'unlinked' WHERE NOT a.theporndb AND NOT a.stashdb
        ) p WHERE ${where} GROUP BY p.value`);
    } else {
      queries.push(sql`SELECT ${field}::text AS field, COALESCE(${projected(field)}, 'unknown') AS value,
        COUNT(*) AS count, NULL::integer AS min, NULL::integer AS max, 0::bigint AS unknown_count
        FROM candidates a WHERE ${where} GROUP BY ${projected(field)}`);
    }
  }
  return sql`WITH candidates AS MATERIALIZED (${creatorCandidatesQuery(options, userId, asOf)})
    ${sql.join(queries, sql` UNION ALL `)}`;
}
