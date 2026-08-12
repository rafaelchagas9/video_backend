import { BadRequestError } from "@/utils/errors";
import type { EntityType } from "./enrichment.types";

export type EnrichmentSource = "theporndb" | "stashdb";

export interface ExactExternalReference {
  source: EnrichmentSource;
  externalId: string;
}

const SOURCE_BY_HOST: Record<string, EnrichmentSource> = {
  "theporndb.net": "theporndb",
  "stashdb.org": "stashdb",
};

const ENTITY_BY_PATH_SEGMENT: Record<string, EntityType> = {
  performer: "creator",
  performers: "creator",
  creator: "creator",
  creators: "creator",
  scene: "scene",
  scenes: "scene",
  video: "scene",
  videos: "scene",
  studio: "studio",
  studios: "studio",
  tag: "tag",
  tags: "tag",
};

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function validateExternalId(value: string): string {
  const externalId = value.trim();
  if (
    externalId.length === 0 ||
    externalId.length > 255 ||
    /[\s/?#]/.test(externalId)
  ) {
    throw new BadRequestError("Invalid enrichment external ID");
  }
  return externalId;
}

function asKnownUrl(reference: string): URL | null {
  const withScheme = /^(?:www\.)?(?:theporndb\.net|stashdb\.org)\//i.test(
    reference,
  )
    ? `https://${reference}`
    : reference;

  if (!/^https?:\/\//i.test(withScheme)) return null;

  try {
    return new URL(withScheme);
  } catch {
    throw new BadRequestError("Invalid enrichment URL");
  }
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new BadRequestError("Invalid enrichment URL path");
  }
}

/**
 * Resolve a pasted StashDB/ThePornDB URL or a raw source-scoped ID without ever
 * requesting the pasted URL. Only the extracted ID is sent to the configured
 * GraphQL source.
 */
export function parseExactExternalReference(
  reference: string,
  entityType: EntityType,
  requestedSources?: string[],
): ExactExternalReference {
  const trimmed = reference.trim();
  if (!trimmed) {
    throw new BadRequestError("External URL or ID is required");
  }

  const url = asKnownUrl(trimmed);
  if (!url) {
    const sources = [...new Set(requestedSources ?? [])];
    if (sources.length !== 1) {
      throw new BadRequestError(
        "Select exactly one enrichment source when using a raw external ID",
      );
    }
    const source = sources[0];
    if (source !== "theporndb" && source !== "stashdb") {
      throw new BadRequestError("Unsupported enrichment source");
    }
    return { source, externalId: validateExternalId(trimmed) };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BadRequestError("Unsupported enrichment URL protocol");
  }

  const source = SOURCE_BY_HOST[normalizeHost(url.hostname)];
  if (!source) {
    throw new BadRequestError(
      "External URL must be from theporndb.net or stashdb.org",
    );
  }

  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map(decodePathSegment);
  const entityIndex = segments.findIndex(
    (segment) => ENTITY_BY_PATH_SEGMENT[segment.toLowerCase()] !== undefined,
  );
  if (entityIndex < 0) {
    throw new BadRequestError(
      "Enrichment URL does not identify a supported entity",
    );
  }

  const referencedEntity =
    ENTITY_BY_PATH_SEGMENT[segments[entityIndex]!.toLowerCase()];
  if (referencedEntity !== entityType) {
    throw new BadRequestError(
      `Enrichment URL targets ${referencedEntity}, not ${entityType}`,
    );
  }

  const externalId = segments[entityIndex + 1];
  if (!externalId) {
    throw new BadRequestError("Enrichment URL is missing its external ID");
  }

  return { source, externalId: validateExternalId(externalId) };
}
