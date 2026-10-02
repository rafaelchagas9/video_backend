import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import Fastify from "fastify";
import { Readable } from "node:stream";
const secret = "vr-route-contract-test-secret-at-least-32-characters";
const video = {
  id: 7,
  file_name: "Sample_SBS_180.mp4",
  title: "Sample",
  description: "Description",
  duration_seconds: 12.25,
  width: 1920,
  height: 1080,
  file_size_bytes: 1000,
  created_at: "2026-10-01",
  is_favorite: true,
  is_available: true,
  thumbnail_id: null,
  creators: [{ id: 2, name: "Creator" }],
  tags: [],
};
const list = mock(async () => ({
  data: [video],
  pagination: { page: 1, limit: 200, total: 1, totalPages: 1 },
}));
const detail = mock(async () => video);
mock.module("@/config/env", () => ({
  env: {
    SESSION_SECRET: secret,
    DEMO_MODE: true,
    BASE_URL: "https://kura.example",
  },
}));
mock.module("@/modules/auth/auth.middleware", () => ({
  authenticateUser: async (request: {
    headers: Record<string, string>;
    user?: { id: number };
  }) => {
    if (request.headers["x-test-session"] !== "yes")
      throw Object.assign(new Error("Unauthenticated"), { statusCode: 401 });
    request.user = { id: 3 };
  },
}));
mock.module("@/modules/videos/videos.search.service", () => ({
  videosSearchService: { list },
}));
mock.module("@/modules/videos/videos.service", () => ({
  videosService: { findById: detail },
}));
mock.module("@/modules/videos/videos.metadata.service", () => ({
  videosMetadataService: { getMetadata: async () => [] },
}));
mock.module("@/modules/videos/streaming.service", () => ({
  streamingService: {
    createStream: async () => ({
      stream: Readable.from(Buffer.from("sample")),
      statusCode: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Range": "bytes 0-5/6",
        "Content-Length": 6,
        "Accept-Ranges": "bytes",
      },
    }),
  },
}));
mock.module("@/modules/artwork/artwork.service", () => ({
  artworkService: {
    getByVideoId: async () => ({ assets: [] }),
    getAssetById: async () => {
      throw new Error("No artwork expected");
    },
  },
}));
mock.module("@/modules/thumbnails/thumbnails.service", () => ({
  thumbnailsService: {
    findById: async () => {
      throw new Error("should not be called");
    },
  },
}));
mock.module("@/database/demo/assets", () => ({
  resolveDemoAssetPath: () => {
    throw new Error("should not be called");
  },
}));
const { vrRoutes } = await import("@/modules/vr/vr.routes");
const app = Fastify();
let token = "";
beforeAll(async () => {
  await app.register(vrRoutes, { prefix: "/api/vr" });
  await app.ready();
  const result = await app.inject({
    method: "POST",
    url: "/api/vr/access",
    headers: { "x-test-session": "yes" },
  });
  token = new URL(result.json().data.heresphere_url).searchParams.get("token")!;
});
afterAll(() => app.close());
describe("VR read-only catalog and streams", () => {
  it("uses the configured public HTTPS origin behind a plain HTTP proxy", async () => {
    const result = await app.inject({
      method: "POST",
      url: "/api/vr/access",
      headers: { "x-test-session": "yes" },
    });
    expect(new URL(result.json().data.heresphere_url).origin).toBe(
      "https://kura.example"
    );
  });
  it("requires a session to issue capabilities", async () => {
    expect(
      (await app.inject({ method: "POST", url: "/api/vr/access" })).statusCode
    ).toBe(401);
  });
  it("uses native HereSphere POST and discovery header without cookies", async () => {
    const result = await app.inject({
      method: "POST",
      url: `/api/vr/heresphere?token=${token}`,
      payload: { needsMediaSource: true },
    });
    expect(result.statusCode).toBe(200);
    expect(result.headers["heresphere-json-version"]).toBe("1");
    expect(result.json().library[0].name).toBe("Creator");
    const detailUrl = new URL(result.json().library[0].list[0]);
    const details = await app.inject({
      method: "POST",
      url: detailUrl.pathname + detailUrl.search,
      payload: { needsMediaSource: true },
    });
    expect(details.json().duration).toBe(12250);
    expect(details.json().projection).toBe("equirectangular");
    expect(details.json().stereo).toBe("sbs");
    expect(details.json().writeTags).toBe(false);
  });
  it("provides DeoVR selection then detail manifests", async () => {
    const result = await app.inject(`/api/vr/deovr?token=${token}`);
    const item = result.json().scenes[0].list[0];
    expect(item.videoLength).toBe(12.25);
    const url = new URL(item.video_url);
    const detail = await app.inject(url.pathname + url.search);
    expect(detail.json().encodings[0].videoSources[0].url).toContain(
      `/api/vr/stream/7?token=`
    );
  });
  it("preserves range headers for player streaming", async () => {
    const result = await app.inject({
      url: `/api/vr/stream/7?token=${token}`,
      headers: { range: "bytes=0-5" },
    });
    expect(result.statusCode).toBe(206);
    expect(result.headers["content-range"]).toBe("bytes 0-5/6");
    expect(result.body).toBe("sample");
  });
  it("rejects an invalid capability and invalid filter before reading data", async () => {
    expect((await app.inject("/api/vr/deovr?token=bad")).statusCode).toBe(401);
    expect(
      (await app.inject(`/api/vr/deovr?token=${token}&creatorId=abc`))
        .statusCode
    ).toBe(400);
  });
  it("supplies thumbnail fallback with no production file access", async () => {
    const result = await app.inject(`/api/vr/thumbnail/7?token=${token}`);
    expect(result.headers["content-type"]).toContain("image/png");
    expect(result.rawPayload.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    );
  });
});
