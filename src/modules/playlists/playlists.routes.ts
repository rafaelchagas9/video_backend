import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { playlistsService } from "./playlists.service";
import {
  idParamSchema,
  videoIdParamSchema,
  createPlaylistSchema,
  updatePlaylistSchema,
  addVideoToPlaylistSchema,
  reorderPlaylistSchema,
  playlistResponseSchema,
  playlistListResponseSchema,
  playlistVideosResponseSchema,
  messageResponseSchema,
  errorResponseSchema,
  bulkUpdatePlaylistVideosSchema,
} from "./playlists.schemas";

export async function playlistsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // All routes require authentication
  app.addHook("preHandler", authenticateUser);

  // Create playlist
  app.post(
    "/",
    {
      schema: {
        tags: ["playlists"],
        summary: "Create a playlist",
        description: "Creates a new playlist for the user.",
        body: createPlaylistSchema,
        response: {
          201: playlistResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const playlist = await playlistsService.create(
        request.user!.id,
        request.body,
      );

      return reply.status(201).send({
        success: true,
        data: playlist,
        message: "Playlist created successfully",
      });
    },
  );

  // List user's playlists
  app.get(
    "/",
    {
      schema: {
        tags: ["playlists"],
        summary: "List playlists",
        description: "Returns all playlists owned by the user.",
        response: {
          200: playlistListResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const playlists = await playlistsService.list(request.user!.id);

      return reply.send({
        success: true,
        data: playlists,
      });
    },
  );

  // Get playlist details
  app.get(
    "/:id",
    {
      schema: {
        tags: ["playlists"],
        summary: "Get playlist by ID",
        description: "Returns details of a specific playlist.",
        params: idParamSchema,
        response: {
          200: playlistResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const playlist = await playlistsService.findById(request.params.id);

      return reply.send({
        success: true,
        data: playlist,
      });
    },
  );

  // Update playlist
  app.patch(
    "/:id",
    {
      schema: {
        tags: ["playlists"],
        summary: "Update a playlist",
        description: "Updates playlist name or description.",
        params: idParamSchema,
        body: updatePlaylistSchema,
        response: {
          200: playlistResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const playlist = await playlistsService.update(
        request.params.id,
        request.user!.id,
        request.body,
      );

      return reply.send({
        success: true,
        data: playlist,
        message: "Playlist updated successfully",
      });
    },
  );

  // Delete playlist
  app.delete(
    "/:id",
    {
      schema: {
        tags: ["playlists"],
        summary: "Delete a playlist",
        description:
          "Permanently deletes a playlist and its video associations.",
        params: idParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await playlistsService.delete(request.params.id, request.user!.id);

      return reply.send({
        success: true,
        message: "Playlist deleted successfully",
      });
    },
  );

  // Get videos in playlist
  app.get(
    "/:id/videos",
    {
      schema: {
        tags: ["playlists"],
        summary: "Get videos in playlist",
        description: "Returns all videos in the playlist, ordered by position.",
        params: idParamSchema,
        response: {
          200: playlistVideosResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const videos = await playlistsService.getVideos(
        request.params.id,
        request.user!.id,
      );

      return reply.send({
        success: true,
        data: videos as any,
      });
    },
  );

  // Bulk update videos in playlist
  app.post(
    "/:id/videos/bulk",
    {
      schema: {
        tags: ["playlists"],
        summary: "Bulk update videos in playlist",
        description:
          "Adds or removes multiple videos for this playlist. For 'add', videos are appended to the end.",
        params: idParamSchema,
        body: bulkUpdatePlaylistVideosSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      await playlistsService.bulkUpdateVideos(
        id,
        request.user!.id,
        request.body,
      );

      return reply.send({
        success: true,
        message: "Playlist videos updated successfully",
      });
    },
  );

  // Add video to playlist
  app.post(
    "/:id/videos",
    {
      schema: {
        tags: ["playlists"],
        summary: "Add video to playlist",
        description: "Adds a video to the playlist at the specified position.",
        params: idParamSchema,
        body: addVideoToPlaylistSchema,
        response: {
          201: messageResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await playlistsService.addVideo(
        request.params.id,
        request.user!.id,
        request.body.video_id,
        request.body.position,
      );

      return reply.status(201).send({
        success: true,
        message: "Video added to playlist",
      });
    },
  );

  // Remove video from playlist
  app.delete(
    "/:id/videos/:video_id",
    {
      schema: {
        tags: ["playlists"],
        summary: "Remove video from playlist",
        description: "Removes a video from the playlist.",
        params: videoIdParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await playlistsService.removeVideo(
        request.params.id,
        request.user!.id,
        request.params.video_id,
      );

      return reply.send({
        success: true,
        message: "Video removed from playlist",
      });
    },
  );

  // Reorder videos in playlist
  app.patch(
    "/:id/videos/reorder",
    {
      schema: {
        tags: ["playlists"],
        summary: "Reorder playlist videos",
        description: "Updates the position of videos in the playlist.",
        params: idParamSchema,
        body: reorderPlaylistSchema,
        response: {
          200: messageResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await playlistsService.reorderVideos(
        request.params.id,
        request.user!.id,
        request.body.videos,
      );

      return reply.send({
        success: true,
        message: "Playlist reordered successfully",
      });
    },
  );
}
