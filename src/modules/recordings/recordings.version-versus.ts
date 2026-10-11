/** Frozen-version choices express preference, independently of keep/skip or cut labels. */
import { BadRequestError } from "@/utils/errors";

function range(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => typeof n === "number" && Number.isFinite(n)) || value[0] < 0 || value[1] <= value[0])
    throw new BadRequestError("Invalid version playback range");
  return [value[0], value[1]];
}

export function validateVersionPreference(context: Record<string, unknown>, detail: Record<string, unknown> | null): void {
  if (context.blind_version_comparison !== true || (context.target_semantics ?? context.target) !== "preferred_version_if_keep_one")
    throw new BadRequestError("This task requires a frozen version comparison");
  const sides = [context.a, context.b];
  let video: number | undefined;
  let original: [number, number] | undefined;
  for (const raw of sides) {
    if (!raw || typeof raw !== "object") throw new BadRequestError("Missing version");
    const side = raw as Record<string, unknown>;
    if (typeof side.video_id !== "number" || !Number.isInteger(side.video_id) || side.video_id <= 0 || (video !== undefined && video !== side.video_id))
      throw new BadRequestError("Versions must belong to the same recording");
    video = side.video_id;
    const clip = range(side.original_range ?? side.clip), offered = range(side.best);
    if (original && (original[0] !== clip[0] || original[1] !== clip[1])) throw new BadRequestError("Versions must share an original range");
    original = clip;
    if (offered[0] < clip[0] || offered[1] > clip[1]) throw new BadRequestError("Version outside original range");
    const previews = side.preview_windows ?? side.previews;
    if (!Array.isArray(previews) || previews.length !== 3) throw new BadRequestError("Three fixed preview windows required");
    for (const item of previews) {
      const window = range(item);
      if (window[0] < offered[0] || window[1] > offered[1] || window[1] - window[0] > 15.001) throw new BadRequestError("Preview outside version or over budget");
    }
  }
  if (detail && Object.keys(detail).some((key) => key !== "viewing")) throw new BadRequestError("Version preferences only record playback context");
  const viewing = detail?.viewing;
  if (viewing === undefined) return;
  if (!viewing || typeof viewing !== "object" || Array.isArray(viewing)) throw new BadRequestError("Invalid playback context");
  for (const [key, raw] of Object.entries(viewing)) {
    if (key !== "a" && key !== "b") throw new BadRequestError("Invalid version side");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BadRequestError("Invalid version playback context");
    const seen = raw as Record<string, unknown>;
    const fields = ["preview_started", "preview_completed", "full_opened", "full_completed"];
    if (Object.keys(seen).length !== fields.length || fields.some((key) => !(key in seen))) throw new BadRequestError("Exact version playback fields required");
    for (const field of ["preview_started", "preview_completed"]) {
      const indices = seen[field];
      if (!Array.isArray(indices) || indices.length > 3 || new Set(indices).size !== indices.length || !indices.every((n) => Number.isInteger(n) && n >= 0 && n < 3))
        throw new BadRequestError("Invalid preview coverage");
    }
    if (!(seen.preview_completed as number[]).every((n) => (seen.preview_started as number[]).includes(n)) || typeof seen.full_opened !== "boolean" || typeof seen.full_completed !== "boolean" || (seen.full_completed && !seen.full_opened))
      throw new BadRequestError("Inconsistent playback context");
  }
}
