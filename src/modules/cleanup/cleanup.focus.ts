import type { CleanupCandidate, CleanupFocusGroup } from "./cleanup.types";
export interface CleanupFocusMembership {
  video_id: number;
  kind: CleanupFocusGroup["kind"];
  id: number;
  name: string;
}
/** Each file counts once within a group; groups can overlap and are not additive. */
export function buildCleanupFocusGroups(
  candidates: CleanupCandidate[],
  memberships: CleanupFocusMembership[]
): CleanupFocusGroup[] {
  const videos = new Map(candidates.map((video) => [video.id, video]));
  const groups = new Map<string, CleanupFocusGroup>();
  const seen = new Set<string>();
  for (const member of memberships) {
    const video = videos.get(member.video_id);
    if (!video || (video.disposition === "unreviewed" && !video.eligible))
      continue;
    const key = `${member.kind}:${member.id}`;
    const membership = `${key}:${video.id}`;
    if (seen.has(membership)) continue;
    seen.add(membership);
    const group = groups.get(key) ?? {
      kind: member.kind,
      id: member.id,
      name: member.name,
      remaining_count: 0,
      remaining_bytes: 0,
      reviewed_count: 0,
    };
    if (video.disposition === "unreviewed") {
      group.remaining_count++;
      group.remaining_bytes += video.file_size_bytes;
    } else group.reviewed_count++;
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.remaining_count > 0 || group.reviewed_count > 0)
    .sort(
      (a, b) =>
        b.remaining_bytes - a.remaining_bytes ||
        a.name.localeCompare(b.name) ||
        a.id - b.id
    );
}
