import { describe, expect, it } from "bun:test";
import { isDemoRequestAllowed } from "@/utils/demo-mode-policy";

describe("demo mode request policy", () => {
  it("allows demo-backed reads and in-memory mutations", () => {
    expect(isDemoRequestAllowed("GET", "/api/videos?page=2")).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/videos/1/stream")).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/videos/1/thumbnails.vtt")).toBe(
      true,
    );
    expect(isDemoRequestAllowed("GET", "/api/videos/1/storyboard.jpg")).toBe(
      true,
    );
    expect(isDemoRequestAllowed("GET", "/api/creators/1/platforms")).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/creators/1/social-links")).toBe(
      true,
    );
    expect(isDemoRequestAllowed("GET", "/api/creators/1/gallery")).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/creators/1/gallery/1/image")).toBe(
      true,
    );
    expect(isDemoRequestAllowed("GET", "/api/creators/1/aliases")).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/creators/1/face-embeddings")).toBe(
      true,
    );
    expect(
      isDemoRequestAllowed("GET", "/api/creators/1/face-embeddings/2/thumbnail"),
    ).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/enrichment/suggestions")).toBe(
      true,
    );
    expect(
      isDemoRequestAllowed("POST", "/api/enrichment/suggestions/3/accept"),
    ).toBe(true);
    expect(
      isDemoRequestAllowed("POST", "/api/enrichment/suggestions/3/reject"),
    ).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/enrichment/creator/1/runs")).toBe(
      true,
    );
    expect(isDemoRequestAllowed("POST", "/api/enrichment/creator/1/run")).toBe(
      true,
    );
    expect(isDemoRequestAllowed("GET", "/api/studios/1/social-links")).toBe(
      true,
    );
    expect(isDemoRequestAllowed("POST", "/api/videos/1/watch")).toBe(true);
    expect(isDemoRequestAllowed("PATCH", "/api/settings")).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/conversions/active")).toBe(true);
    expect(
      isDemoRequestAllowed("GET", "/api/conversions/queue/status"),
    ).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/conversions/history")).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/videos/1/conversions")).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/videos/1/artwork")).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/artwork/11/image")).toBe(true);
    expect(isDemoRequestAllowed("POST", "/api/playlists/1/videos/bulk")).toBe(
      true,
    );
  });

  it("blocks personal-library and external-service features", () => {
    expect(isDemoRequestAllowed("GET", "/api/directories")).toBe(false);
    expect(isDemoRequestAllowed("POST", "/api/directories/1/scan")).toBe(false);
    expect(isDemoRequestAllowed("GET", "/api/backup")).toBe(false);
    expect(isDemoRequestAllowed("POST", "/api/conversions")).toBe(false);
    expect(isDemoRequestAllowed("POST", "/api/conversions/queue/clear")).toBe(
      false,
    );
    expect(isDemoRequestAllowed("GET", "/api/conversions/1")).toBe(false);
    expect(isDemoRequestAllowed("POST", "/api/videos/1/faces/extract")).toBe(
      false,
    );
    expect(isDemoRequestAllowed("POST", "/api/enrichment/scene/1/run")).toBe(
      false,
    );
    // Only creators have seeded proposals; the other entity types would fall
    // through to a live scan, so they stay shut.
    expect(isDemoRequestAllowed("POST", "/api/enrichment/studio/1/run")).toBe(
      false,
    );
    expect(isDemoRequestAllowed("GET", "/api/enrichment/tag/1/runs")).toBe(
      false,
    );
    // Face references are readable but never writable in demo mode.
    expect(isDemoRequestAllowed("POST", "/api/creators/1/face-embeddings")).toBe(
      false,
    );
    expect(
      isDemoRequestAllowed("DELETE", "/api/creators/1/face-embeddings/2"),
    ).toBe(false);
    expect(isDemoRequestAllowed("POST", "/api/creators/1/aliases")).toBe(false);
    expect(isDemoRequestAllowed("POST", "/api/creators/1/picture")).toBe(false);
    expect(isDemoRequestAllowed("POST", "/api/creators/1/gallery")).toBe(false);
    expect(isDemoRequestAllowed("POST", "/api/videos/1/storyboard")).toBe(
      false,
    );
    expect(isDemoRequestAllowed("POST", "/api/videos/1/artwork")).toBe(false);
    expect(isDemoRequestAllowed("POST", "/api/artwork/batch")).toBe(false);
  });

  it("blocks unknown future routes by default", () => {
    expect(isDemoRequestAllowed("GET", "/api/new-private-feature")).toBe(false);
    expect(isDemoRequestAllowed("POST", "/api/videos/new-action")).toBe(false);
  });
});
