import { describe, expect, it } from "bun:test";
import { isDemoRequestAllowed } from "@/utils/demo-mode-policy";

describe("demo mode request policy", () => {
  it("allows only POST for the reviewed creator merge endpoint", () => {
    expect(isDemoRequestAllowed("POST", "/api/creators/12/merge")).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/creators/12/merge")).toBe(false);
    expect(isDemoRequestAllowed("DELETE", "/api/creators/12/merge")).toBe(
      false
    );
  });

  it("gives generated HEAD routes the same classification as GET", () => {
    for (const url of [
      "/health",
      "/docs/json",
      "/api/videos?page=2",
      "/api/videos/1/stream",
      "/api/directories",
      "/api/new-private-feature",
    ]) {
      expect(isDemoRequestAllowed("HEAD", url)).toBe(
        isDemoRequestAllowed("GET", url)
      );
    }
  });

  it("allows established demo-backed reads and SQLite mutations", () => {
    expect(isDemoRequestAllowed("GET", "/api/videos?page=2")).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/videos/1/stream")).toBe(true);
    expect(isDemoRequestAllowed("POST", "/api/videos/1/cast-sessions")).toBe(
      true
    );
    expect(
      isDemoRequestAllowed(
        "GET",
        `/api/videos/1/cast-sessions/${"a".repeat(64)}`
      )
    ).toBe(true);
    expect(
      isDemoRequestAllowed("GET", `/api/cast/${"a".repeat(64)}/index.m3u8`)
    ).toBe(true);
    expect(
      isDemoRequestAllowed("GET", `/api/cast/${"a".repeat(64)}/master.m3u8`)
    ).toBe(true);
    expect(
      isDemoRequestAllowed(
        "GET",
        `/api/cast/${"a".repeat(64)}/segment-000000.ts`
      )
    ).toBe(true);
    expect(
      isDemoRequestAllowed("GET", "/api/cast/not-a-token/index.m3u8")
    ).toBe(false);
    expect(
      isDemoRequestAllowed("GET", `/api/cast/${"a".repeat(64)}/unexpected.json`)
    ).toBe(false);
    expect(isDemoRequestAllowed("GET", "/api/videos/1/thumbnails.vtt")).toBe(
      true
    );
    expect(isDemoRequestAllowed("GET", "/api/videos/1/storyboard.jpg")).toBe(
      true
    );
    expect(isDemoRequestAllowed("GET", "/api/creators/1/platforms")).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/creators/1/social-links")).toBe(
      true
    );
    expect(isDemoRequestAllowed("GET", "/api/creators/1/gallery")).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/creators/1/gallery/1/image")).toBe(
      true
    );
    expect(isDemoRequestAllowed("GET", "/api/creators/1/aliases")).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/creators/1/face-embeddings")).toBe(
      true
    );
    expect(
      isDemoRequestAllowed("GET", "/api/creators/1/face-embeddings/2/thumbnail")
    ).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/enrichment/suggestions")).toBe(
      true
    );
    expect(
      isDemoRequestAllowed("POST", "/api/enrichment/suggestions/3/accept")
    ).toBe(true);
    expect(
      isDemoRequestAllowed("POST", "/api/enrichment/suggestions/3/reject")
    ).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/enrichment/creator/1/runs")).toBe(
      true
    );
    expect(isDemoRequestAllowed("POST", "/api/enrichment/creator/1/run")).toBe(
      true
    );
    expect(isDemoRequestAllowed("GET", "/api/studios/1/social-links")).toBe(
      true
    );
    expect(isDemoRequestAllowed("POST", "/api/videos/1/watch")).toBe(true);
    expect(isDemoRequestAllowed("PATCH", "/api/settings")).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/conversions/active")).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/conversions/queue/status")).toBe(
      true
    );
    expect(isDemoRequestAllowed("GET", "/api/conversions/history")).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/videos/1/conversions")).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/videos/1/artwork")).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/artwork/11/image")).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/cleanup/overview")).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/cleanup/candidates")).toBe(true);
    expect(isDemoRequestAllowed("PUT", "/api/cleanup/reviews/1")).toBe(true);
    expect(isDemoRequestAllowed("POST", "/api/playlists/1/videos/bulk")).toBe(
      true
    );
  });

  it("allows reviewed SQLite-only operations without broadening siblings", () => {
    expect(isDemoRequestAllowed("GET", "/api/directories")).toBe(true);
    expect(isDemoRequestAllowed("POST", "/api/directories/1/scan")).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/backup")).toBe(true);
    expect(isDemoRequestAllowed("POST", "/api/conversions")).toBe(true);
    expect(isDemoRequestAllowed("POST", "/api/conversions/queue/clear")).toBe(
      true
    );
    expect(isDemoRequestAllowed("GET", "/api/edits/jobs")).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/conversions/1")).toBe(true);
    expect(isDemoRequestAllowed("POST", "/api/videos/1/faces/extract")).toBe(
      true
    );
    expect(isDemoRequestAllowed("POST", "/api/enrichment/scene/1/run")).toBe(
      true
    );
    expect(isDemoRequestAllowed("POST", "/api/enrichment/studio/1/run")).toBe(
      true
    );
    expect(isDemoRequestAllowed("GET", "/api/enrichment/tag/1/runs")).toBe(
      true
    );
    expect(
      isDemoRequestAllowed("POST", "/api/creators/1/face-embeddings")
    ).toBe(true);
    expect(
      isDemoRequestAllowed("DELETE", "/api/creators/1/face-embeddings/2")
    ).toBe(true);
    expect(isDemoRequestAllowed("POST", "/api/creators/1/aliases")).toBe(true);
    expect(isDemoRequestAllowed("POST", "/api/creators/1/picture")).toBe(true);
    expect(isDemoRequestAllowed("POST", "/api/creators/1/gallery")).toBe(true);
    expect(isDemoRequestAllowed("POST", "/api/videos/1/storyboard")).toBe(true);
    expect(isDemoRequestAllowed("POST", "/api/videos/1/artwork")).toBe(true);
    expect(isDemoRequestAllowed("POST", "/api/artwork/batch")).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/multiplayer-remote/ws")).toBe(
      true
    );

    expect(isDemoRequestAllowed("POST", "/api/directories/1/watch")).toBe(
      false
    );
    expect(isDemoRequestAllowed("POST", "/api/faces/1/delete")).toBe(false);
    expect(
      isDemoRequestAllowed("POST", "/api/multiplayer-remote/sessions/1/reopen")
    ).toBe(false);
  });

  it("blocks unknown future routes by default", () => {
    expect(isDemoRequestAllowed("GET", "/api/new-private-feature")).toBe(false);
    expect(isDemoRequestAllowed("POST", "/api/videos/new-action")).toBe(false);
  });
});
