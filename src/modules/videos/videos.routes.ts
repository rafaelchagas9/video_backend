import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { videosService } from "./videos.service";
import { videosSearchService } from "./videos.search.service";
import { videosSuggestionsService } from "./videos.suggestions.service";
import { videosMetadataService } from "./videos.metadata.service";
import { videosBulkService } from "./videos.bulk.service";
import { streamingService } from "./streaming.service";
import { creatorsRelationshipsService } from "@/modules/creators/creators.relationships.service";
import { studiosRelationshipsService } from "@/modules/studios/studios.relationships.service";
import { tagsService } from "@/modules/tags/tags.service";
import { ratingsService } from "@/modules/ratings/ratings.service";
import { bookmarksService } from "@/modules/bookmarks/bookmarks.service";
import { createRatingSchema } from "@/modules/ratings/ratings.types";
import { createBookmarkSchema } from "@/modules/bookmarks/bookmarks.types";
import {
  idParamSchema,
  listVideosQuerySchema,
  nextVideoQuerySchema,
  nextVideoResponseSchema,
  triageQueueQuerySchema,
  triageQueueResponseSchema,
  compressionSuggestionsQuerySchema,
  compressionSuggestionsResponseSchema,
  creatorIdParamSchema,
  tagIdParamSchema,
  studioIdParamSchema,
  metadataKeyParamSchema,
  addCreatorBodySchema,
  addTagBodySchema,
  setMetadataBodySchema,
  updateVideoSchema,
  videoResponseSchema,
  videoListResponseSchema,
  creatorsResponseSchema,
  tagsResponseSchema,
  studiosResponseSchema,
  metadataResponseSchema,
  ratingsResponseSchema,
  ratingCreatedResponseSchema,
  bookmarksResponseSchema,
  bookmarkCreatedResponseSchema,
  messageResponseSchema,
  errorResponseSchema,
  bulkDeleteVideosSchema,
  bulkUpdateCreatorsSchema,
  bulkUpdateTagsSchema,
  bulkUpdateStudiosSchema,
  bulkUpdateFavoritesSchema,
  bulkConditionalApplySchema,
  bulkConditionalApplyResponseSchema,
  duplicatesResponseSchema,
} from "./videos.schemas";

export async function videosRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // All routes require authentication
  app.addHook("preHandler", authenticateUser);

  // List videos
  app.get(
    "/",
    {
      schema: {
        tags: ["videos"],
        summary: "List videos",
        description:
          "Returns a paginated list of videos with optional filtering and sorting.",
        querystring: listVideosQuerySchema,
        response: {
          200: videoListResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await videosSearchService.list(
        request.user!.id,
        request.query,
      );

      return reply.send({
        success: true,
        ...result,
      });
    },
  );

  // Compression suggestions
  app.get(
    "/compression-suggestions",
    {
      schema: {
        tags: ["videos", "compression"],
        summary: "List compression suggestions",
        description:
          "Returns a ranked list of videos that could benefit from compression or downscaling.",
        querystring: compressionSuggestionsQuerySchema,
        response: {
          200: compressionSuggestionsResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const suggestions =
        await videosSuggestionsService.getCompressionSuggestions(request.query);

      return reply.send({
        success: true,
        data: suggestions,
      });
    },
  );

  // Get next/previous video (triage navigation)
  app.get(
    "/next",
    {
      schema: {
        tags: ["videos", "triage"],
        summary: "Get next/previous video",
        description:
          "Navigate to next or previous video matching filter criteria with wrap-around support. Useful for triage workflows.",
        querystring: nextVideoQuerySchema,
        response: {
          200: nextVideoResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await videosSearchService.getNextVideo(
        request.user!.id,
        request.query,
      );

      return reply.send({
        success: true,
        data: result.video,
        meta: result.meta,
      });
    },
  );

  // Get triage queue (lightweight ID list)
  app.get(
    "/triage-queue",
    {
      schema: {
        tags: ["videos", "triage"],
        summary: "Get triage queue",
        description:
          "Returns a lightweight list of video IDs matching filter criteria for client-side navigation. Supports all filter options with configurable limit and offset.",
        querystring: triageQueueQuerySchema,
        response: {
          200: triageQueueResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await videosSearchService.getTriageQueue(
        request.user!.id,
        request.query,
      );

      return reply.send({
        success: true,
        ids: result.ids,
        total: result.total,
      });
    },
  );

  // Bulk Actions
  app.post(
    "/bulk/delete",
    {
      schema: {
        tags: ["videos"],
        summary: "Bulk delete videos",
        description: "Deletes multiple videos by ID.",
        body: bulkDeleteVideosSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await videosBulkService.bulkDelete(request.body.ids);

      return reply.send({
        success: true,
        message: "Videos deleted successfully",
      });
    },
  );

  app.post(
    "/bulk/creators",
    {
      schema: {
        tags: ["videos"],
        summary: "Bulk update creators",
        description: "Adds or removes creators for multiple videos.",
        body: bulkUpdateCreatorsSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await videosBulkService.bulkUpdateCreators(request.body);

      return reply.send({
        success: true,
        message: "Creators updated successfully",
      });
    },
  );

  app.post(
    "/bulk/tags",
    {
      schema: {
        tags: ["videos"],
        summary: "Bulk update tags",
        description: "Adds or removes tags for multiple videos.",
        body: bulkUpdateTagsSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await videosBulkService.bulkUpdateTags(request.body);

      return reply.send({
        success: true,
        message: "Tags updated successfully",
      });
    },
  );

  app.post(
    "/bulk/studios",
    {
      schema: {
        tags: ["videos"],
        summary: "Bulk update studios",
        description: "Adds or removes studios for multiple videos.",
        body: bulkUpdateStudiosSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await videosBulkService.bulkUpdateStudios(request.body);

      return reply.send({
        success: true,
        message: "Studios updated successfully",
      });
    },
  );

  app.post(
    "/bulk/favorites",
    {
      schema: {
        tags: ["videos"],
        summary: "Bulk update favorites",
        description: "Sets favorite status for multiple videos.",
        body: bulkUpdateFavoritesSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await videosBulkService.bulkUpdateFavorites(
        request.user!.id,
        request.body,
      );

      return reply.send({
        success: true,
        message: "Favorites updated successfully",
      });
    },
  );

  // Bulk conditional apply (apply actions to videos matching filter criteria)
  app.post(
    "/bulk/conditional-apply",
    {
      schema: {
        tags: ["videos"],
        summary: "Bulk apply actions with filter",
        description:
          "Applies creator, tag, and studio changes to all videos matching the provided filter criteria. Useful for bulk operations based on directory, tags, or other filters.",
        body: bulkConditionalApplySchema,
        response: {
          200: bulkConditionalApplyResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { filter, actions } = request.body;

      const result = await videosBulkService.bulkConditionalApply(
        request.user!.id,
        filter || {},
        actions || {},
      );

      return reply.send({
        success: true,
        data: {
          matched: result.matched,
          affected: result.affected,
          errors: result.errors,
          details: result.details,
        },
      });
    },
  );

  // Get random video
  app.get(
    "/random",
    {
      schema: {
        tags: ["videos"],
        summary: "Get random video",
        description:
          "Returns detailed information about a random available video.",
        response: {
          200: videoResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const video = await videosService.getRandomVideo(request.user!.id);
      return reply.send({
        success: true,
        data: video,
      });
    },
  );

  // Get duplicate videos
  app.get(
    "/duplicates",
    {
      schema: {
        tags: ["videos"],
        summary: "Get duplicate videos",
        description:
          "Returns groups of videos that share the same file hash, sorted by total size.",
        response: {
          200: duplicatesResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const duplicates = await videosBulkService.getDuplicates();
      return reply.send({
        success: true,
        data: duplicates,
      });
    },
  );

  // Get video by ID
  app.get(
    "/:id",
    {
      schema: {
        tags: ["videos"],
        summary: "Get video by ID",
        description: "Returns detailed information about a specific video.",
        params: idParamSchema,
        response: {
          200: videoResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const video = await videosService.findById(
        request.params.id,
        request.user!.id,
      );
      return reply.send({
        success: true,
        data: video,
      });
    },
  );

  // Update video metadata
  app.patch(
    "/:id",
    {
      schema: {
        tags: ["videos"],
        summary: "Update video metadata",
        description: "Updates the title, description, or themes of a video.",
        params: idParamSchema,
        body: updateVideoSchema,
        response: {
          200: videoResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const video = await videosService.update(request.params.id, request.body);

      return reply.send({
        success: true,
        data: video,
        message: "Video updated successfully",
      });
    },
  );

  // Delete video
  app.delete(
    "/:id",
    {
      schema: {
        tags: ["videos"],
        summary: "Delete video",
        description:
          "Removes a video from the database. Does not delete the file.",
        params: idParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await videosService.delete(request.params.id);

      return reply.send({
        success: true,
        message: "Video deleted successfully",
      });
    },
  );

  // Verify video availability
  app.post(
    "/:id/verify",
    {
      schema: {
        tags: ["videos"],
        summary: "Verify video availability",
        description: "Checks if the video file exists on disk.",
        params: idParamSchema,
        response: {
          200: videoResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const video = await videosService.verifyAvailability(request.params.id);

      return reply.send({
        success: true,
        data: video,
        message: video.is_available
          ? "Video is available"
          : "Video file not found on disk",
      });
    },
  );

  // Stream video with range request support (requires authentication)
  // Note: Response schema intentionally omits 200/206 because streaming returns raw bytes, not JSON
  app.get(
    "/:id/stream",
    {
      schema: {
        tags: ["videos"],
        summary: "Stream video",
        description:
          "Streams the video file with HTTP range request support. Requires authentication.",
        params: idParamSchema,
        // Only define error responses - success returns a stream, not JSON
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      const videoId = id;
      const rangeHeader = request.headers.range;

      // Queue storyboard generation if not already exists/processing
      const { storyboardsService } =
        await import("@/modules/storyboards/storyboards.service");
      // Non-blocking: queueGenerate handles deduplication and sequential processing
      storyboardsService.queueGenerate(videoId);

      const result = await streamingService.createStream({
        videoId,
        rangeHeader,
      });

      // Set CORS headers explicitly for streaming
      reply.header(
        "Access-Control-Allow-Origin",
        request.headers.origin || "*",
      );
      reply.header("Access-Control-Allow-Credentials", "true");
      reply.header(
        "Access-Control-Expose-Headers",
        "Content-Range, Accept-Ranges, Content-Length",
      );

      reply.status(result.statusCode);
      // Set each header individually (reply.headers() doesn't work as expected in Fastify)
      Object.entries(result.headers).forEach(([name, value]) => {
        reply.header(name, String(value));
      });
      return reply.send(result.stream);
    },
  );

  // ========== CREATOR ASSOCIATIONS ==========

  // Get creators for video
  app.get(
    "/:id/creators",
    {
      schema: {
        tags: ["videos"],
        summary: "Get video creators",
        description: "Returns all creators associated with a video.",
        params: idParamSchema,
        response: {
          200: creatorsResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await videosService.findById(request.params.id);
      const creators = await creatorsRelationshipsService.getCreatorsForVideo(
        request.params.id,
      );

      return reply.send({
        success: true,
        data: creators,
      });
    },
  );

  // Add creator to video
  app.post(
    "/:id/creators",
    {
      schema: {
        tags: ["videos"],
        summary: "Add creator to video",
        description: "Associates a creator with a video.",
        params: idParamSchema,
        body: addCreatorBodySchema,
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
      await creatorsRelationshipsService.addToVideo(
        request.params.id,
        request.body.creator_id,
      );

      return reply.status(201).send({
        success: true,
        message: "Creator added to video",
      });
    },
  );

  // Remove creator from video
  app.delete(
    "/:id/creators/:creator_id",
    {
      schema: {
        tags: ["videos"],
        summary: "Remove creator from video",
        description: "Removes the association between a creator and video.",
        params: creatorIdParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await creatorsRelationshipsService.removeFromVideo(
        request.params.id,
        request.params.creator_id,
      );

      return reply.send({
        success: true,
        message: "Creator removed from video",
      });
    },
  );

  // ========== TAG ASSOCIATIONS ==========

  // Get tags for video
  app.get(
    "/:id/tags",
    {
      schema: {
        tags: ["videos"],
        summary: "Get video tags",
        description: "Returns all tags associated with a video.",
        params: idParamSchema,
        response: {
          200: tagsResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await videosService.findById(request.params.id);
      const tags = await tagsService.getTagsForVideo(request.params.id);

      return reply.send({
        success: true,
        data: tags,
      });
    },
  );

  // Add tag to video
  app.post(
    "/:id/tags",
    {
      schema: {
        tags: ["videos"],
        summary: "Add tag to video",
        description: "Associates a tag with a video.",
        params: idParamSchema,
        body: addTagBodySchema,
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
      await tagsService.addToVideo(request.params.id, request.body.tag_id);

      return reply.status(201).send({
        success: true,
        message: "Tag added to video",
      });
    },
  );

  // Remove tag from video
  app.delete(
    "/:id/tags/:tag_id",
    {
      schema: {
        tags: ["videos"],
        summary: "Remove tag from video",
        description: "Removes the association between a tag and video.",
        params: tagIdParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await tagsService.removeFromVideo(
        request.params.id,
        request.params.tag_id,
      );

      return reply.send({
        success: true,
        message: "Tag removed from video",
      });
    },
  );

  // ========== CUSTOM METADATA ==========

  // Get all metadata for video
  app.get(
    "/:id/metadata",
    {
      schema: {
        tags: ["videos"],
        summary: "Get video metadata",
        description: "Returns all custom key-value metadata for a video.",
        params: idParamSchema,
        response: {
          200: metadataResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const metadata = await videosMetadataService.getMetadata(
        request.params.id,
      );

      return reply.send({
        success: true,
        data: metadata,
      });
    },
  );

  // Set metadata key-value
  app.post(
    "/:id/metadata",
    {
      schema: {
        tags: ["videos"],
        summary: "Set video metadata",
        description: "Sets a custom key-value pair for a video.",
        params: idParamSchema,
        body: setMetadataBodySchema,
        response: {
          201: messageResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await videosMetadataService.setMetadata(
        request.params.id,
        request.body.key,
        request.body.value,
      );

      return reply.status(201).send({
        success: true,
        message: "Metadata saved",
      });
    },
  );

  // Delete metadata key
  app.delete(
    "/:id/metadata/:key",
    {
      schema: {
        tags: ["videos"],
        summary: "Delete video metadata",
        description: "Deletes a custom metadata key from a video.",
        params: metadataKeyParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await videosMetadataService.deleteMetadata(
        request.params.id,
        request.params.key,
      );

      return reply.send({
        success: true,
        message: "Metadata deleted",
      });
    },
  );

  // ========== RATINGS ==========

  // Get ratings for video
  app.get(
    "/:id/ratings",
    {
      schema: {
        tags: ["videos"],
        summary: "Get video ratings",
        description: "Returns all ratings and average score for a video.",
        params: idParamSchema,
        response: {
          200: ratingsResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const ratings = await ratingsService.getRatingsForVideo(
        request.params.id,
      );
      const average = await ratingsService.getAverageRating(request.params.id);

      return reply.send({
        success: true,
        data: ratings,
        average,
      });
    },
  );

  // Add rating to video
  app.post(
    "/:id/ratings",
    {
      schema: {
        tags: ["videos"],
        summary: "Rate a video",
        description: "Adds a rating (1-5) with optional comment to a video.",
        params: idParamSchema,
        body: createRatingSchema,
        response: {
          201: ratingCreatedResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rating = await ratingsService.addRating(
        request.params.id,
        request.body,
      );

      return reply.status(201).send({
        success: true,
        data: rating,
        message: "Rating added successfully",
      });
    },
  );

  // ========== BOOKMARKS ==========

  // Get bookmarks for video
  app.get(
    "/:id/bookmarks",
    {
      schema: {
        tags: ["videos"],
        summary: "Get video bookmarks",
        description: "Returns all bookmarks for a video created by the user.",
        params: idParamSchema,
        response: {
          200: bookmarksResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const bookmarks = await bookmarksService.getBookmarksForVideo(
        request.params.id,
        request.user!.id,
      );

      return reply.send({
        success: true,
        data: bookmarks,
      });
    },
  );

  // Create bookmark for video
  app.post(
    "/:id/bookmarks",
    {
      schema: {
        tags: ["videos"],
        summary: "Create video bookmark",
        description: "Creates a bookmark at a specific timestamp in a video.",
        params: idParamSchema,
        body: createBookmarkSchema,
        response: {
          201: bookmarkCreatedResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const bookmark = await bookmarksService.create(
        request.params.id,
        request.user!.id,
        request.body,
      );

      return reply.status(201).send({
        success: true,
        data: bookmark,
        message: "Bookmark created successfully",
      });
    },
  );

  // Get studios for video
  app.get(
    "/:id/studios",
    {
      schema: {
        tags: ["videos"],
        summary: "Get studios for video",
        description: "Returns all studios associated with a video.",
        params: idParamSchema,
        response: {
          200: studiosResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const studios = await videosService.getStudios(request.params.id);

      return reply.send({
        success: true,
        data: studios,
      });
    },
  );

  // Link video to studio
  app.post(
    "/:id/studios/:studio_id",
    {
      schema: {
        tags: ["videos"],
        summary: "Link video to studio",
        description: "Associates a video with a studio.",
        params: studioIdParamSchema,
        response: {
          200: messageResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await studiosRelationshipsService.linkVideo(
        request.params.studio_id,
        request.params.id,
      );

      return reply.send({
        success: true,
        message: "Video linked to studio successfully",
      });
    },
  );

  // Unlink video from studio
  app.delete(
    "/:id/studios/:studio_id",
    {
      schema: {
        tags: ["videos"],
        summary: "Unlink video from studio",
        description: "Removes the association between a video and a studio.",
        params: studioIdParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await studiosRelationshipsService.unlinkVideo(
        request.params.studio_id,
        request.params.id,
      );

      return reply.send({
        success: true,
        message: "Video unlinked from studio successfully",
      });
    },
  );
}
