import {
  COPY_DETECTION_REVISION,
  PERCEPTUAL_ASSESSMENT_REVISION,
  intervalCoverage,
  type CopyMatch,
  type CopyDetectionResults,
} from "@/modules/copy-detection/copy-detection.schemas";
import { assessPerceptualMatch } from "@/modules/copy-detection/copy-detection.relevance";

type Video = {
  id: number;
  durationSeconds: number | null;
  title: string | null;
  fileName: string;
};
type Kind =
  | "partial_overlap"
  | "near_duplicate"
  | "contained_clip"
  | "similarity"
  | "shared_fragment";

// Aggregate-only calibration from the completed 2026-09-26 library pass:
// 200 matches, 98 visible groups, at most 8 matches/group. No private IDs,
// titles, paths, fingerprints or original timestamps are included here.
const MIX: Array<[Kind, number]> = [
  ["partial_overlap", 131],
  ["near_duplicate", 39],
  ["contained_clip", 6],
  ["similarity", 4],
  ["shared_fragment", 20],
];
const SEGMENT_COUNTS = [
  194,
  40,
  34,
  33,
  31,
  30,
  25,
  24,
  20,
  17,
  15,
  13,
  9,
  9,
  7,
  6,
  5,
  5,
  5,
  5,
  5,
  4,
  4,
  3,
  3,
  3,
  3,
  ...Array<number>(14).fill(2),
];

/** Synthetic review evidence, scaled to playable demo durations. It does not
 * claim that unrelated demo footage is a real detected copy. Rebuild from the
 * current catalog so deleted/unavailable videos never leave dangling links. */
export function buildDemoCopyResults(
  catalog: Video[],
  {
    limit,
    offset,
    view = "copies",
  }: { limit: number; offset: number; view?: "copies" | "similarity" }
): CopyDetectionResults {
  const videos = catalog
    .filter((v) => (v.durationSeconds ?? 0) >= 10)
    .sort((a, b) => a.id - b.id);
  const pairs: Array<[Video, Video]> = [];
  for (let i = 0; i < videos.length; i++) {
    for (let j = i + 1; j < videos.length; j++)
      pairs.push([videos[i], videos[j]]);
  }
  const longestVideo = [...videos].sort(
    (a, b) => b.durationSeconds! - a.durationSeconds! || a.id - b.id
  )[0];
  const used = new Set<string>();
  const ownerCounts = new Map<number, number>();
  const groups = new Map<number, CopyDetectionResults["items"][number]>();
  let suppressed = 0;
  let sequence = 0;
  for (const [kind, count] of MIX) {
    for (let index = 0; index < count; index++, sequence++) {
      const segmentCount = SEGMENT_COUNTS[sequence] ?? 1;
      // Rotate the search deterministically to spread results over many owners,
      // with dense groups as well as single pairs and enough groups to paginate.
      for (let step = 0; step < pairs.length; step++) {
        const [a, b] = pairs[(sequence * 7919 + step) % pairs.length];
        const key = `${a.id}:${b.id}`;
        if (used.has(key)) continue;
        const da = a.durationSeconds!;
        const db = b.durationSeconds!;
        const shorter = Math.min(da, db);
        const longer = Math.max(da, db);
        const owner = da >= db ? a.id : b.id;
        if (sequence < 8 && owner !== longestVideo?.id) continue;
        if ((ownerCounts.get(owner) ?? 0) >= 8) continue;
        if (kind === "near_duplicate" && shorter / longer < 0.94) continue;
        if (kind === "contained_clip" && shorter / longer > 0.7) continue;
        const span =
          kind === "near_duplicate" || kind === "contained_clip"
            ? shorter * 0.98
            : kind === "shared_fragment"
              ? Math.min(6, shorter * 0.1)
              : shorter * (0.32 + (index % 5) * 0.075);
        if (
          kind === "partial_overlap" &&
          (span * 0.99 < 60 || span / longer < 0.06)
        )
          continue;
        // Even the dense example has meaningful fingerprint evidence per segment.
        if (span / segmentCount < 0.7) continue;
        const startA = (da - span) * (0.2 + (index % 4) * 0.15);
        const startB = (db - span) * (0.15 + (index % 3) * 0.2);
        const status =
          kind === "similarity" || kind === "shared_fragment"
            ? "ambiguous"
            : "verified";
        const segments: CopyMatch["segments"] = Array.from(
          { length: segmentCount },
          (_, i) => {
            const start = (span * i) / segmentCount;
            const end = (span * (i + 0.995)) / segmentCount;
            return {
              a_start: startA + start,
              a_end: startA + end,
              b_start: startB + start,
              b_end: startB + end,
              speed: 1,
              matched_frames: Math.max(5, Math.floor((end - start) * 8.075)),
              spatial_inliers:
                status === "verified" ? 24 + ((index * 37 + i * 11) % 480) : 0,
              status,
              motion: status === "verified" ? 0.92 : 0,
              timing_error_seconds: 0.0619,
            };
          }
        );
        const match: CopyMatch = {
          video_a: a.id,
          video_b: b.id,
          status,
          segments,
          coverage_a: intervalCoverage(
            segments.map((s) => [s.a_start, s.a_end]),
            da
          ),
          coverage_b: intervalCoverage(
            segments.map((s) => [s.b_start, s.b_end]),
            db
          ),
        };
        const assessment = assessPerceptualMatch(match, da, db);
        if (assessment.classification !== kind) continue;
        used.add(key);
        ownerCounts.set(owner, (ownerCounts.get(owner) ?? 0) + 1);
        if (assessment.group === "suppressed") suppressed++;
        if (assessment.group === view) {
          const group = groups.get(owner) ?? {
            version: 1,
            revision: COPY_DETECTION_REVISION,
            video_id: owner,
            compared_videos: catalog.length,
            retrieval_truncated: false,
            skipped_references: 0,
            match_count: 0,
            matches: [],
            truncated_matches: false,
            candidate_limited_pairs: 0,
          };
          group.matches.push({ ...match, assessment });
          group.match_count++;
          groups.set(owner, group);
        }
        break;
      }
    }
  }
  const items = [...groups.values()];
  const page = items.slice(offset, offset + limit);
  const visible = new Set(
    page.flatMap((g) => g.matches.flatMap((m) => [m.video_a, m.video_b]))
  );
  return {
    items: page,
    video_labels: Object.fromEntries(
      videos
        .filter((v) => visible.has(v.id))
        .map((v) => [String(v.id), v.title?.trim() || v.fileName])
    ),
    total: items.length,
    limit,
    offset,
    assessment_revision: PERCEPTUAL_ASSESSMENT_REVISION,
    diagnostics: {
      candidate_limited_pairs: 0,
      truncated_videos: 0,
      suppressed_matches: suppressed,
      retrieval_limited_videos: 0,
    },
  };
}
