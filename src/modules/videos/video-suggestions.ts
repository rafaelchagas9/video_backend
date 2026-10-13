/**
 * Ranking for "who / what is this video?" suggestions. Pure: the service gathers the evidence
 * (catalog names, faces, look-alike videos, folder siblings) and these functions weigh it.
 */

export type SuggestionKind = "creator" | "studio" | "tag";
/** Why something is suggested, strongest first in the order clients read them. */
export type SuggestionReason = "face" | "copy" | "title" | "themes" | "folder" | "similar";

export interface CatalogEntity {
  id: number;
  name: string;
  aliases?: string[];
  profile_picture_url?: string | null;
  color?: string | null;
}

export interface Candidate {
  id: number;
  reason: SuggestionReason;
  /** 0..1 */
  confidence: number;
  detail: string;
}

export interface Suggestion {
  id: number;
  name: string;
  profile_picture_url: string | null;
  color: string | null;
  confidence: number;
  reasons: SuggestionReason[];
  /** One human line for the strongest reason, e.g. "Seen in 4 frames". */
  detail: string;
}

/** Lowercase ASCII words separated by single spaces, padded so `includes(" x ")` is a word match. */
export function normalizeText(value: string): string {
  const words = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return words ? ` ${words} ` : " ";
}

/** Too short or too common a single word matches titles by accident. */
const MIN_NAME_LENGTH: Record<SuggestionKind, number> = { creator: 4, studio: 4, tag: 4 };
const MIN_SINGLE_WORD_CREATOR = 5;
const NAME_CONFIDENCE: Record<SuggestionKind, { phrase: number; word: number }> = {
  creator: { phrase: 0.8, word: 0.55 },
  studio: { phrase: 0.7, word: 0.55 },
  tag: { phrase: 0.5, word: 0.45 },
};

/** Catalog entries whose name or alias appears as whole words in `text` (a title, file or folder name). */
export function nameMatches(
  kind: SuggestionKind,
  text: string,
  catalog: CatalogEntity[],
  reason: "title" | "folder" = "title"
): Candidate[] {
  const haystack = normalizeText(text);
  if (haystack.trim().length === 0) return [];
  const out: Candidate[] = [];
  for (const entity of catalog) {
    for (const name of [entity.name, ...(entity.aliases ?? [])]) {
      const needle = normalizeText(name).trim();
      if (needle.length < MIN_NAME_LENGTH[kind]) continue;
      const phrase = needle.includes(" ");
      if (kind === "creator" && !phrase && needle.length < MIN_SINGLE_WORD_CREATOR) continue;
      if (!haystack.includes(` ${needle} `)) continue;
      const base = NAME_CONFIDENCE[kind][phrase ? "phrase" : "word"];
      out.push({
        id: entity.id,
        reason,
        confidence: reason === "folder" ? base * 0.85 : base,
        detail: reason === "folder" ? `Folder is named “${name}”` : `“${name}” is in the title`,
      });
      break;
    }
  }
  return out;
}

/** Tags named exactly like one of the video's themes (the comma list scraped with it). */
export function themeMatches(themes: string | null | undefined, catalog: CatalogEntity[]): Candidate[] {
  if (!themes) return [];
  const wanted = new Set(
    themes.split(/[\n,;|]+/).map((theme) => normalizeText(theme).trim()).filter(Boolean)
  );
  if (!wanted.size) return [];
  const out: Candidate[] = [];
  for (const entity of catalog) {
    const names = [entity.name, ...(entity.aliases ?? [])].map((name) => normalizeText(name).trim());
    if (names.some((name) => wanted.has(name)))
      out.push({ id: entity.id, reason: "themes", confidence: 0.7, detail: "Listed in its themes" });
  }
  return out;
}

export interface VoteGroup {
  /** How much this neighbour counts (its similarity, or 1 for a folder sibling). */
  weight: number;
  ids: number[];
}

/**
 * Entities most neighbours agree on. `share` is the weighted fraction of neighbours that carry it;
 * a lone neighbour never decides.
 */
export function voteMatches(
  groups: VoteGroup[],
  reason: "similar" | "folder",
  options: { minSupport: number; minShare: number; maxConfidence: number; noun: string }
): Candidate[] {
  const total = groups.reduce((sum, group) => sum + group.weight, 0);
  if (total <= 0) return [];
  const support = new Map<number, { count: number; weight: number }>();
  for (const group of groups)
    for (const id of new Set(group.ids)) {
      const entry = support.get(id) ?? { count: 0, weight: 0 };
      entry.count += 1;
      entry.weight += group.weight;
      support.set(id, entry);
    }
  const out: Candidate[] = [];
  for (const [id, { count, weight }] of support) {
    const share = weight / total;
    if (count < options.minSupport || share < options.minShare) continue;
    out.push({
      id,
      reason,
      confidence: Math.min(options.maxConfidence, 0.3 + share * 0.5),
      detail: `On ${count} of ${groups.length} ${options.noun}`,
    });
  }
  return out;
}

const REASON_ORDER: SuggestionReason[] = ["face", "copy", "title", "themes", "folder", "similar"];
/** Two independent reasons agreeing are worth more than either alone. */
const AGREEMENT_BONUS = 0.1;

/** Merge candidates per entity, drop what is already linked, best first. */
export function rankSuggestions(
  candidates: Candidate[],
  catalog: Map<number, CatalogEntity>,
  linked: Set<number>,
  limit: number
): Suggestion[] {
  const byId = new Map<number, Candidate[]>();
  for (const candidate of candidates) {
    if (linked.has(candidate.id) || !catalog.has(candidate.id)) continue;
    byId.set(candidate.id, [...(byId.get(candidate.id) ?? []), candidate]);
  }
  const out: Suggestion[] = [];
  for (const [id, list] of byId) {
    const entity = catalog.get(id)!;
    const strongest = [...list].sort((a, b) => b.confidence - a.confidence)[0]!;
    const reasons = [...new Set(list.map((item) => item.reason))].sort(
      (a, b) => REASON_ORDER.indexOf(a) - REASON_ORDER.indexOf(b)
    );
    out.push({
      id,
      name: entity.name,
      profile_picture_url: entity.profile_picture_url ?? null,
      color: entity.color ?? null,
      confidence: Math.min(1, Number((strongest.confidence + AGREEMENT_BONUS * (reasons.length - 1)).toFixed(3))),
      reasons,
      detail: strongest.detail,
    });
  }
  return out
    .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name))
    .slice(0, limit);
}
