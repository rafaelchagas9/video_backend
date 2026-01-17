import { basename, dirname, extname } from "path";

export interface PathParseResult {
  fileName: string;
  extension: string;
  directory: string;
  parentDirectory: string;
  grandparentDirectory: string;
  extracted: {
    creator: string | null;
    studio: string | null;
    series: string | null;
    episode: string | null;
    tags: string[];
    custom: Record<string, string>;
  };
  confidence: "high" | "medium" | "low";
  matchedPatterns: string[];
}

export interface PathPattern {
  name: string;
  pattern: string;
  creatorGroup?: string;
  studioGroup?: string;
  seriesGroup?: string;
  episodeGroup?: string;
  tagGroups?: string[];
  confidence: "high" | "medium" | "low";
}

export interface PathParserConfig {
  patterns: PathPattern[];
  customGroups?: string[];
}

const DEFAULT_PATTERNS: PathPattern[] = [
  {
    name: "OnlyFans Creator Folder",
    pattern: "/(?:onlyfans|OF)/(?<creator>[^/]+)/?",
    creatorGroup: "creator",
    confidence: "high",
  },
  {
    name: "Fansly Creator Folder",
    pattern: "/(?:fansly|FS)/(?<creator>[^/]+)/?",
    creatorGroup: "creator",
    confidence: "high",
  },
  {
    name: "Creator Series Episode",
    pattern:
      "/(?<creator>[^/]+)/(?<series>[^/]+)/(?:[Ee]p?[-_]?(?<episode>\\d+)|(?<episode>\\d+))",
    creatorGroup: "creator",
    seriesGroup: "series",
    episodeGroup: "episode",
    confidence: "high",
  },
  {
    name: "Creator Folder",
    pattern: "/videos/(?<creator>[^/]+)/?",
    creatorGroup: "creator",
    confidence: "high",
  },
  {
    name: "Studio Creator Folder",
    pattern: "/(?<studio>[^/]+)/(?<creator>[^/]+)/?",
    studioGroup: "studio",
    creatorGroup: "creator",
    confidence: "high",
  },
  {
    name: "Platform Prefix",
    pattern:
      "(?i)(?:onlyfans|fansly|pornhub|ph|chaturbate|cb)[_\\-\\s]*(?<creator>[a-z0-9_]+)",
    creatorGroup: "creator",
    confidence: "medium",
  },
  {
    name: "Date Pattern",
    pattern: "(?<year>\\d{4})[-_](?<month>\\d{2})[-_](?<day>\\d{2})",
    confidence: "low",
  },
  {
    name: "Resolution Tag",
    pattern:
      "(?:^|[_\\-\\s])(?<resolution>4K|1080p|720p|480p|360p)(?:[_\\-\\s]|$)",
    confidence: "medium",
  },
];

export function parseVideoPath(
  filePath: string,
  config?: Partial<PathParserConfig>,
): PathParseResult {
  const patterns = config?.patterns || DEFAULT_PATTERNS;
  const customGroups = config?.customGroups || [];

  const fileName = basename(filePath);
  const extension = extname(filePath).replace(".", "").toLowerCase();
  const directory = dirname(filePath);
  const dirParts = directory.split("/").filter(Boolean);
  const parentDirectory = dirParts[dirParts.length - 1] || "";
  const grandparentDirectory = dirParts[dirParts.length - 2] || "";

  const result: PathParseResult = {
    fileName,
    extension,
    directory,
    parentDirectory,
    grandparentDirectory,
    extracted: {
      creator: null,
      studio: null,
      series: null,
      episode: null,
      tags: [],
      custom: {},
    },
    confidence: "low",
    matchedPatterns: [],
  };

  let bestMatch: PathParseResult["extracted"] | null = null;
  let bestConfidence: PathParseResult["confidence"] = "low";
  const allMatchedPatterns: string[] = [];

  for (const patternConfig of patterns) {
    try {
      const regex = new RegExp(patternConfig.pattern);
      const match = regex.exec(filePath);

      if (match) {
        allMatchedPatterns.push(patternConfig.name);

        const extracted: PathParseResult["extracted"] = {
          creator: null,
          studio: null,
          series: null,
          episode: null,
          tags: [],
          custom: {},
        };

        if (
          patternConfig.creatorGroup &&
          match.groups?.[patternConfig.creatorGroup]
        ) {
          extracted.creator = match.groups[patternConfig.creatorGroup];
        }

        if (
          patternConfig.studioGroup &&
          match.groups?.[patternConfig.studioGroup]
        ) {
          extracted.studio = match.groups[patternConfig.studioGroup];
        }

        if (
          patternConfig.seriesGroup &&
          match.groups?.[patternConfig.seriesGroup]
        ) {
          extracted.series = match.groups[patternConfig.seriesGroup];
        }

        if (
          patternConfig.episodeGroup &&
          match.groups?.[patternConfig.episodeGroup]
        ) {
          extracted.episode = match.groups[patternConfig.episodeGroup];
        }

        if (patternConfig.tagGroups) {
          for (const tagGroup of patternConfig.tagGroups) {
            if (match.groups?.[tagGroup]) {
              extracted.tags.push(match.groups[tagGroup]);
            }
          }
        }

        for (const customGroup of customGroups) {
          if (match.groups?.[customGroup]) {
            extracted.custom[customGroup] = match.groups[customGroup];
          }
        }

        if (patternConfig.confidence === "high") {
          bestMatch = extracted;
          bestConfidence = "high";
          result.matchedPatterns = [patternConfig.name];
          break;
        } else if (
          patternConfig.confidence === "medium" &&
          bestConfidence !== "high"
        ) {
          bestMatch = extracted;
          bestConfidence = "medium";
          result.matchedPatterns = [patternConfig.name];
        } else if (
          patternConfig.confidence === "low" &&
          bestConfidence === "low"
        ) {
          if (!bestMatch) {
            bestMatch = extracted;
          }
        }
      }
    } catch (error) {
      console.warn(`Invalid regex pattern: ${patternConfig.pattern}`, error);
    }
  }

  if (bestMatch) {
    result.extracted = bestMatch;
    result.confidence = bestConfidence;
  }

  if (allMatchedPatterns.length > 0 && result.matchedPatterns.length === 0) {
    result.matchedPatterns = allMatchedPatterns;
  }

  if (result.extracted.tags.length === 0) {
    const resolutionMatch = fileName.match(
      /(?:^|[_-\s])(4K|1080p|720p|480p|360p)(?:[_-\s]|$)/i,
    );
    if (resolutionMatch) {
      result.extracted.tags.push(resolutionMatch[1].toUpperCase());
    }

    if (fileName.match(/[._-]hdr[._-]/i)) {
      result.extracted.tags.push("HDR");
    }

    if (fileName.match(/[._-]vr[._-]/i)) {
      result.extracted.tags.push("VR");
    }
  }

  return result;
}

export function extractCreatorFromPath(filePath: string): string | null {
  const result = parseVideoPath(filePath);
  return result.extracted.creator;
}

export function extractStudioFromPath(filePath: string): string | null {
  const result = parseVideoPath(filePath);
  return result.extracted.studio;
}

export function extractTagsFromPath(filePath: string): string[] {
  const result = parseVideoPath(filePath);
  return result.extracted.tags;
}

export function extractSeriesFromPath(filePath: string): string | null {
  const result = parseVideoPath(filePath);
  return result.extracted.series;
}

export function extractEpisodeFromPath(filePath: string): string | null {
  const result = parseVideoPath(filePath);
  return result.extracted.episode;
}

export function parsePathWithPatterns(
  filePath: string,
  patterns: Array<{ pattern: string; group: string }>,
): Record<string, string | null> {
  const result: Record<string, string | null> = {};

  for (const { pattern, group } of patterns) {
    try {
      const regex = new RegExp(pattern);
      const match = regex.exec(filePath);
      if (match?.groups?.[group]) {
        result[group] = match.groups[group];
      } else {
        result[group] = null;
      }
    } catch {
      result[group] = null;
    }
  }

  return result;
}
