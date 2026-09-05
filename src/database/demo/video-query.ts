import type { ListVideosOptions } from "@/modules/videos/videos.types";

/** SQLite selection happens before the repository hydrates page relationships. */
export function buildDemoVideoQuery(
  options: ListVideosOptions,
  userId: number
) {
  const conditions: string[] = [];
  const parameters: Array<string | number> = [];
  const add = (expression: string, ...values: Array<string | number>) => {
    conditions.push(expression);
    parameters.push(...values);
  };
  const placeholders = (ids: number[]) => ids.map(() => "?").join(",");
  if (options.isAvailable !== undefined)
    add("v.is_available = ?", Number(options.isAvailable));
  else if (!options.include_hidden) add("v.is_available = 1");
  if (options.directory_id) add("v.directory_id = ?", options.directory_id);
  if (options.ids?.length)
    add(`v.id IN (${placeholders(options.ids)})`, ...options.ids);
  if (options.search) {
    const fields = [
      "v.title",
      "v.description",
      "v.file_name",
      ...(options.searchFullPath ? ["v.file_path"] : []),
    ];
    add(
      `(${fields.map((field) => `${field} LIKE ?`).join(" OR ")})`,
      ...fields.map(() => `%${options.search}%`)
    );
  }
  for (const [option, column, operator] of [
    ["minWidth", "width", ">="],
    ["maxWidth", "width", "<="],
    ["minHeight", "height", ">="],
    ["maxHeight", "height", "<="],
    ["minFileSize", "file_size_bytes", ">="],
    ["maxFileSize", "file_size_bytes", "<="],
    ["minDuration", "duration_seconds", ">="],
    ["maxDuration", "duration_seconds", "<="],
    ["minBitrate", "bitrate", ">="],
    ["maxBitrate", "bitrate", "<="],
    ["minFps", "fps", ">="],
    ["maxFps", "fps", "<="],
  ] as const)
    if (options[option] !== undefined)
      add(`v.${column} ${operator} ?`, options[option]!);
  for (const [option, column] of [
    ["codec", "codec"],
    ["audioCodec", "audio_codec"],
  ] as const)
    if (options[option]) add(`LOWER(v.${column}) = LOWER(?)`, options[option]!);
  for (const [option, operator] of [
    ["createdFrom", ">="],
    ["createdBefore", "<"],
  ] as const)
    if (options[option] !== undefined)
      add(`julianday(v.created_at) ${operator} julianday(?)`, options[option]!);

  for (const [option, table] of [
    ["hasCreator", "demo_video_creators"],
    ["hasTags", "demo_video_tags"],
    ["hasStudio", "demo_video_studios"],
    ["hasRating", "demo_ratings"],
    ["hasThumbnail", "demo_thumbnails"],
  ] as const) {
    if (options[option] !== undefined)
      add(
        `${options[option] ? "" : "NOT "}EXISTS (SELECT 1 FROM ${table} r WHERE r.video_id = v.id)`
      );
  }
  if (options.isFavorite !== undefined)
    add(
      `${options.isFavorite ? "" : "NOT "}EXISTS (SELECT 1 FROM demo_favorites f WHERE f.video_id = v.id AND f.user_id = ?)`,
      userId
    );
  if (options.studioAssignmentStatus) {
    const linked =
      "EXISTS (SELECT 1 FROM demo_video_studios s WHERE s.video_id = v.id)";
    add(
      options.studioAssignmentStatus === "assigned"
        ? linked
        : `NOT ${linked} AND v.studio_absence_confirmed_at IS ${options.studioAssignmentStatus === "unknown" ? "" : "NOT "}NULL`
    );
  }
  for (const [option, table, column] of [
    ["creatorIds", "demo_video_creators", "creator_id"],
    ["studioIds", "demo_video_studios", "studio_id"],
  ] as const) {
    const ids = [...new Set(options[option] ?? [])];
    if (!ids.length) continue;
    const where = `r.video_id = v.id AND r.${column} IN (${placeholders(ids)})`;
    if (options.matchMode === "all")
      add(
        `(SELECT COUNT(DISTINCT r.${column}) FROM ${table} r WHERE ${where}) = ?`,
        ...ids,
        ids.length
      );
    else add(`EXISTS (SELECT 1 FROM ${table} r WHERE ${where})`, ...ids);
  }
  const tagIds = [...new Set(options.tagIds ?? [])];
  if (tagIds.length) {
    add(
      `v.id IN (
      WITH RECURSIVE selected_tags(id, root_id) AS (
        SELECT id, id FROM demo_tags WHERE id IN (${placeholders(tagIds)})
        UNION SELECT child.id, selected_tags.root_id FROM demo_tags child JOIN selected_tags ON child.parent_id = selected_tags.id
      )
      SELECT r.video_id FROM demo_video_tags r JOIN selected_tags ON selected_tags.id = r.tag_id
      ${options.matchMode === "all" ? "GROUP BY r.video_id HAVING COUNT(DISTINCT selected_tags.root_id) = ?" : ""}
    )`,
      ...tagIds,
      ...(options.matchMode === "all" ? [tagIds.length] : [])
    );
  }
  const average =
    "(SELECT AVG(r.rating) FROM demo_ratings r WHERE r.video_id = v.id)";
  if (options.minRating !== undefined)
    add(`${average} >= ?`, options.minRating);
  if (options.maxRating !== undefined)
    add(`${average} <= ?`, options.maxRating);
  for (const [option, operator] of [
    ["minPlayCount", ">="],
    ["maxPlayCount", "<="],
  ] as const)
    if (options[option] !== undefined)
      add(
        `COALESCE((SELECT play_count FROM demo_video_stats s WHERE s.video_id = v.id AND s.user_id = ?), 0) ${operator} ?`,
        userId,
        options[option]!
      );
  for (const [option, operator] of [
    ["lastPlayedBefore", "<"],
    ["lastPlayedAfter", ">="],
  ] as const)
    if (options[option] !== undefined)
      add(
        `EXISTS (SELECT 1 FROM demo_video_stats s WHERE s.video_id = v.id AND s.user_id = ? AND julianday(s.last_played_at) ${operator} julianday(?))`,
        userId,
        options[option]!
      );

  const columns = [
    "created_at",
    "file_name",
    "duration_seconds",
    "file_size_bytes",
    "indexed_at",
    "width",
    "height",
    "bitrate",
    "fps",
  ];
  const sort = columns.includes(options.sort ?? "")
    ? options.sort
    : "created_at";
  const direction = options.order === "asc" ? "ASC" : "DESC";
  return {
    where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    parameters,
    orderBy: `v.${sort} ${direction} NULLS ${direction === "ASC" ? "LAST" : "FIRST"}, v.id ${direction}`,
  };
}
