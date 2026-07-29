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
    expect(isDemoRequestAllowed("POST", "/api/creators/1/picture")).toBe(false);
    expect(isDemoRequestAllowed("POST", "/api/creators/1/gallery")).toBe(false);
    expect(isDemoRequestAllowed("POST", "/api/videos/1/storyboard")).toBe(
      false,
    );
  });

  it("blocks unknown future routes by default", () => {
    expect(isDemoRequestAllowed("GET", "/api/new-private-feature")).toBe(false);
    expect(isDemoRequestAllowed("POST", "/api/videos/new-action")).toBe(false);
  });
});
