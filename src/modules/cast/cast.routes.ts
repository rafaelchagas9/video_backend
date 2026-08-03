import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { captureTelemetryEvent } from "@/utils/telemetry";
import { castTranscodingService } from "./cast-transcoding.service";
import {
  castErrorResponseSchema,
  castPlaybackParamsSchema,
  castSessionDeletedResponseSchema,
  castSessionParamsSchema,
  castSessionResponseSchema,
  castVideoParamsSchema,
  createCastSessionSchema,
} from "./cast.schemas";

export async function videoCastSessionRoutes(
  fastify: FastifyInstance
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", authenticateUser);

  app.post(
    "/:id/cast-sessions",
    {
      schema: {
        tags: ["videos"],
        summary: "Create Cast HLS session",
        description:
          "Starts a short-lived VAAPI-first HLS transcode for a Cast receiver.",
        params: castVideoParamsSchema,
        body: createCastSessionSchema,
        response: {
          201: castSessionResponseSchema,
          401: castErrorResponseSchema,
          404: castErrorResponseSchema,
          410: castErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const status = await castTranscodingService.createSession({
        videoId: request.params.id,
        ownerUserId: request.user!.id,
        profile: request.body.profile,
        requestedStartSeconds: request.body.start_time_seconds,
        ...(request.body.request_key
          ? { requestKey: request.body.request_key }
          : {}),
      });
      return reply.status(201).send({ success: true, data: status });
    }
  );

  app.get(
    "/:id/cast-sessions/:sessionId",
    {
      schema: {
        tags: ["videos"],
        summary: "Get Cast HLS session",
        params: castSessionParamsSchema,
        response: {
          200: castSessionResponseSchema,
          401: castErrorResponseSchema,
          404: castErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const status = await castTranscodingService.getStatus(
        request.params.id,
        request.params.sessionId,
        request.user!.id
      );
      return reply.send({ success: true, data: status });
    }
  );

  app.delete(
    "/:id/cast-sessions/:sessionId",
    {
      schema: {
        tags: ["videos"],
        summary: "Delete Cast HLS session",
        params: castSessionParamsSchema,
        response: {
          200: castSessionDeletedResponseSchema,
          401: castErrorResponseSchema,
          404: castErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await castTranscodingService.deleteSession(
        request.params.id,
        request.params.sessionId,
        request.user!.id
      );
      return reply.send({ success: true, message: "Cast session deleted" });
    }
  );
}

export async function castPlaybackRoutes(
  fastify: FastifyInstance
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/:token/:asset",
    {
      schema: {
        tags: ["videos"],
        summary: "Read signed Cast HLS media",
        description:
          "Serves a manifest or media segment for a short-lived Cast session token.",
        params: castPlaybackParamsSchema,
      },
    },
    async (request, reply) => {
      const asset = await castTranscodingService.getMediaAsset(
        request.params.token,
        request.params.asset,
        request.headers.range
      );
      reply.code(asset.statusCode);
      reply.header("Access-Control-Allow-Origin", "*");
      reply.removeHeader("Access-Control-Allow-Credentials");
      reply.header(
        "Access-Control-Expose-Headers",
        "Accept-Ranges, Content-Length, Content-Range"
      );
      reply.header("Accept-Ranges", "bytes");
      reply.header("X-Accel-Buffering", "no");
      reply.header("Content-Type", asset.contentType);
      reply.header("Content-Length", asset.contentLength);
      if (asset.contentRange) {
        reply.header("Content-Range", asset.contentRange);
      }
      reply.header("Cache-Control", asset.cacheControl);
      captureTelemetryEvent("cast asset served", {
        assetKind: asset.assetKind,
        statusCode: asset.statusCode,
        contentLength: asset.contentLength,
        rangeRequested: Boolean(request.headers.range),
      });
      return reply.send(asset.stream);
    }
  );
}
