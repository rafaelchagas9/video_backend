import type { FastifyInstance, FastifyRequest } from "fastify";
import { createReadStream } from "node:fs";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { env } from "@/config/env";
import { API_PREFIX } from "@/config/constants";
import { videosSearchService } from "@/modules/videos/videos.search.service";
import { videosService } from "@/modules/videos/videos.service";
import { videosMetadataService } from "@/modules/videos/videos.metadata.service";
import { streamingService } from "@/modules/videos/streaming.service";
import { thumbnailsService } from "@/modules/thumbnails/thumbnails.service";
import { resolveDemoAssetPath } from "@/database/demo/assets";
import { artworkService } from "@/modules/artwork/artwork.service";
import { resolveVrThumbnail, VR_PLACEHOLDER_PNG } from "./vr.thumbnail";
import { AppError } from "@/utils/errors";
import type { Video } from "@/modules/videos/videos.types";
import {
  issueVrToken,
  verifyVrToken,
  groupByCreator,
  deoVideo,
  hereVideo,
} from "./vr.protocol";

export async function vrRoutes(app: FastifyInstance) {
  const secret = process.env.VR_TOKEN_SECRET || env.SESSION_SECRET;
  const query = (request: FastifyRequest) =>
    request.query as Record<string, string | undefined>;
  // Reverse proxies terminate TLS without Fastify trustProxy. Reuse the configured
  // public API origin, while keeping unconfigured LAN installs reachable by IP.
  const publicOrigin =
    process.env.VR_PUBLIC_BASE_URL ||
    (env.BASE_URL &&
    !["localhost", "127.0.0.1", "0.0.0.0"].includes(
      new URL(env.BASE_URL).hostname
    )
      ? env.BASE_URL
      : undefined);
  const base = (request: FastifyRequest) =>
    `${publicOrigin ? new URL(publicOrigin).origin : `${request.protocol}://${request.host}`}${API_PREFIX}/vr`;
  const access = async (request: FastifyRequest) => {
    const token = query(request).token;
    if (token) {
      const lease = verifyVrToken(token, secret);
      if (!lease)
        throw new AppError(
          401,
          "VR link expired or invalid. Generate a new link in Kura."
        );
      return { userId: lease.userId, token };
    }
    await authenticateUser(request, {} as never);
    return {
      userId: request.user!.id,
      token: issueVrToken(request.user!.id, secret),
    };
  };
  app.post("/access", { preHandler: authenticateUser }, async (request) => {
    const token = issueVrToken(request.user!.id, secret);
    return {
      success: true,
      data: {
        expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
        heresphere_url: `${base(request)}/heresphere?token=${token}`,
        deovr_url: `${base(request)}/deovr?token=${token}`,
      },
    };
  });
  const catalog = async (
    request: FastifyRequest,
    kind: "heresphere" | "deovr"
  ) => {
    const { userId, token } = await access(request);
    const q = query(request);
    const creatorId = q.creatorId ? Number(q.creatorId) : undefined;
    if (
      creatorId !== undefined &&
      (!Number.isInteger(creatorId) || creatorId <= 0)
    )
      throw new AppError(400, "Invalid creatorId");
    const videos: Video[] = [];
    let page = 1,
      totalPages = 1;
    do {
      const result = await videosSearchService.list(userId, {
        page,
        limit: 200,
        isAvailable: true,
        include: ["creators"],
        ...(creatorId ? { creatorIds: [creatorId] } : {}),
        ...(q.favorites === "true" ? { isFavorite: true } : {}),
      });
      videos.push(...result.data.filter((v) => v.is_available));
      totalPages = result.pagination.totalPages;
      page++;
    } while (page <= totalPages);
    const root = base(request);
    const url = (id: number) =>
      `${root}/${kind}/videos/${id}?token=${encodeURIComponent(token)}`;
    if (kind === "heresphere")
      return {
        access: 1,
        library: groupByCreator(videos).map(([name, list]) => ({
          name,
          list: list.map((v) => url(v.id)),
        })),
      };
    return {
      authorized: "1",
      scenes: groupByCreator(videos).map(([name, list]) => ({
        name,
        list: list.map((v) => ({
          title: v.title || v.file_name,
          videoLength: v.duration_seconds || 0,
          thumbnailUrl: `${root}/thumbnail/${v.id}?token=${encodeURIComponent(token)}`,
          video_url: url(v.id),
        })),
      })),
    };
  };
  for (const kind of ["heresphere", "deovr"] as const) {
    app.route({
      method: ["GET", "POST"],
      url: `/${kind}`,
      handler: async (request, reply) => {
        if (kind === "heresphere") reply.header("HereSphere-JSON-Version", "1");
        return catalog(request, kind);
      },
    });
    app.route<{ Params: { id: string } }>({
      method: ["GET", "POST"],
      url: `/${kind}/videos/:id`,
      handler: async (request, reply) => {
        if (kind === "heresphere") reply.header("HereSphere-JSON-Version", "1");
        const { userId, token } = await access(request);
        const id = Number(request.params.id);
        if (!Number.isInteger(id) || id <= 0)
          throw new AppError(400, "Invalid video ID");
        const video = await videosService.findById(id, userId, [
          "creators",
          "tags",
        ]);
        if (!video.is_available) throw new AppError(410, "Video unavailable");
        const metadata = await videosMetadataService.getMetadata(id);
        return kind === "heresphere"
          ? hereVideo(video, base(request), token, metadata)
          : deoVideo(video, base(request), token, metadata);
      },
    });
  }
  app.get<{ Params: { id: string } }>("/stream/:id", async (request, reply) => {
    await access(request);
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0)
      throw new AppError(400, "Invalid video ID");
    const stream = await streamingService.createStream({
      videoId: id,
      rangeHeader: request.headers.range,
    });
    reply
      .code(stream.statusCode)
      .headers(stream.headers)
      .header("Access-Control-Allow-Origin", "*");
    return reply.send(stream.stream);
  });
  app.get<{ Params: { id: string } }>(
    "/thumbnail/:id",
    async (request, reply) => {
      const { userId } = await access(request);
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0)
        throw new AppError(400, "Invalid video ID");
      const video = await videosService.findById(id, userId);
      const resolvePath = (path: string) =>
        env.DEMO_MODE ? resolveDemoAssetPath(path) : path;
      const path = await resolveVrThumbnail({
        artwork: async () => (await artworkService.getByVideoId(id)).assets,
        assetPath: async (assetId) =>
          resolvePath((await artworkService.getAssetById(assetId)).filePath),
        legacyPath: async () =>
          video.thumbnail_id
            ? resolvePath(
                (await thumbnailsService.findById(video.thumbnail_id)).file_path
              )
            : null,
      });
      if (!path) return reply.type("image/png").send(VR_PLACEHOLDER_PNG);
      reply.type(
        path.endsWith(".png")
          ? "image/png"
          : path.endsWith(".webp")
            ? "image/webp"
            : "image/jpeg"
      );
      return reply.send(createReadStream(path));
    }
  );
}
