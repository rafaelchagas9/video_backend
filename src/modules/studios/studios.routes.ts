import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { readFileSync } from "fs";
import { join } from "path";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { studiosService } from "./studios.service";
import {
  idParamSchema,
  creatorIdParamSchema,
  videoIdParamSchema,
  linkIdParamSchema,
  createStudioSchema,
  updateStudioSchema,
  createStudioSocialLinkSchema,
  updateStudioSocialLinkSchema,
  studioResponseSchema,
  studioListResponseSchema,
  creatorListResponseSchema,
  videoListResponseSchema,
  socialLinkResponseSchema,
  socialLinkListResponseSchema,
  messageResponseSchema,
  errorResponseSchema,
  bulkUpdateCreatorsSchema,
} from "./studios.schemas";

export async function studiosRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // All routes require authentication
  app.addHook("preHandler", authenticateUser);

  // List all studios
  app.get(
    "/",
    {
      schema: {
        tags: ["studios"],
        summary: "List all studios",
        description: "Returns a list of all studios.",
        response: {
          200: studioListResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const studios = await studiosService.list();

      return reply.send({
        success: true,
        data: studios,
      });
    },
  );

  // Get studio by ID
  app.get(
    "/:id",
    {
      schema: {
        tags: ["studios"],
        summary: "Get studio by ID",
        description: "Returns details of a specific studio.",
        params: idParamSchema,
        response: {
          200: studioResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const studio = await studiosService.findById(request.params.id);

      return reply.send({
        success: true,
        data: studio,
      });
    },
  );

  // Create new studio
  app.post(
    "/",
    {
      schema: {
        tags: ["studios"],
        summary: "Create a new studio",
        description: "Creates a new studio with the provided details.",
        body: createStudioSchema,
        response: {
          201: studioResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const studio = await studiosService.create(request.body);

      return reply.status(201).send({
        success: true,
        data: studio,
        message: "Studio created successfully",
      });
    },
  );

  // Update studio
  app.patch(
    "/:id",
    {
      schema: {
        tags: ["studios"],
        summary: "Update a studio",
        description: "Updates an existing studio's details.",
        params: idParamSchema,
        body: updateStudioSchema,
        response: {
          200: studioResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const studio = await studiosService.update(
        request.params.id,
        request.body,
      );

      return reply.send({
        success: true,
        data: studio,
        message: "Studio updated successfully",
      });
    },
  );

  // Delete studio
  app.delete(
    "/:id",
    {
      schema: {
        tags: ["studios"],
        summary: "Delete a studio",
        description: "Permanently deletes a studio.",
        params: idParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await studiosService.delete(request.params.id);

      return reply.send({
        success: true,
        message: "Studio deleted successfully",
      });
    },
  );

  // Upload profile picture
  fastify.post(
    "/:id/picture",
    {
      schema: {
        tags: ["studios"],
        summary: "Upload profile picture",
        description: "Uploads a profile picture for the studio. Accepts JPEG, PNG, or WebP images.",
        params: idParamSchema,
      },
    },
    async (request, reply) => {
      const data = await request.file();

      if (!data) {
        return reply.status(400).send({
          success: false,
          error: {
            message: "No file provided",
            statusCode: 400,
          },
        });
      }

      const buffer = await data.toBuffer();
      const studio = await studiosService.uploadProfilePicture(
        request.params.id,
        buffer,
        data.filename,
      );

      return reply.send({
        success: true,
        data: studio,
        message: "Profile picture uploaded successfully",
      });
    },
  );

  // Get profile picture
  fastify.get(
    "/:id/picture",
    {
      schema: {
        tags: ["studios"],
        summary: "Get profile picture",
        description: "Serves the studio's profile picture or default avatar if none is set.",
        params: idParamSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const studio = await studiosService.findById(Number(id));

      let filePath: string;
      let contentType: string;

      if (!studio.profile_picture_path) {
        // Return default profile picture
        filePath = join(process.cwd(), 'public', 'studio.png');
        contentType = 'image/png';
      } else {
        filePath = studio.profile_picture_path;
        const ext = filePath.split('.').pop()?.toLowerCase();
        contentType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      }

      reply.header("Content-Type", contentType);
      const buffer = readFileSync(filePath);
      return reply.send(buffer);
    },
  );

  // Delete profile picture
  app.delete(
    "/:id/picture",
    {
      schema: {
        tags: ["studios"],
        summary: "Delete profile picture",
        description: "Deletes the studio's profile picture.",
        params: idParamSchema,
        response: {
          200: studioResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const studio = await studiosService.deleteProfilePicture(request.params.id);

      return reply.send({
        success: true,
        data: studio,
        message: "Profile picture deleted successfully",
      });
    },
  );

  // Add social link
  app.post(
    "/:id/social-links",
    {
      schema: {
        tags: ["studios"],
        summary: "Add social link",
        description: "Adds a social media link for the studio.",
        params: idParamSchema,
        body: createStudioSocialLinkSchema,
        response: {
          201: socialLinkResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const link = await studiosService.addSocialLink(
        request.params.id,
        request.body,
      );

      return reply.status(201).send({
        success: true,
        data: link,
        message: "Social link added successfully",
      });
    },
  );

  // Get social links
  app.get(
    "/:id/social-links",
    {
      schema: {
        tags: ["studios"],
        summary: "Get social links",
        description: "Returns all social media links for the studio.",
        params: idParamSchema,
        response: {
          200: socialLinkListResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const links = await studiosService.getSocialLinks(request.params.id);

      return reply.send({
        success: true,
        data: links,
      });
    },
  );

  // Update social link
  app.patch(
    "/:id/social-links/:linkId",
    {
      schema: {
        tags: ["studios"],
        summary: "Update social link",
        description: "Updates an existing social link.",
        params: linkIdParamSchema,
        body: updateStudioSocialLinkSchema,
        response: {
          200: socialLinkResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { linkId } = request.params as { linkId: string };
      const link = await studiosService.updateSocialLink(
        Number(linkId),
        request.body,
      );

      return reply.send({
        success: true,
        data: link,
        message: "Social link updated successfully",
      });
    },
  );

  // Delete social link
  app.delete(
    "/:id/social-links/:linkId",
    {
      schema: {
        tags: ["studios"],
        summary: "Delete social link",
        description: "Deletes a social link.",
        params: linkIdParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { linkId } = request.params as { linkId: string };
      await studiosService.deleteSocialLink(Number(linkId));

      return reply.send({
        success: true,
        message: "Social link deleted successfully",
      });
    },
  );

  // Bulk update creators for studio
  app.post(
    "/:id/creators/bulk",
    {
      schema: {
        tags: ["studios"],
        summary: "Bulk update creators",
        description: "Adds or removes multiple creators for this studio.",
        params: idParamSchema,
        body: bulkUpdateCreatorsSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await studiosService.bulkUpdateCreators(Number(id), request.body);

      return reply.send({
        success: true,
        message: "Creators updated successfully",
      });
    },
  );

  // Link creator to studio
  app.post(
    "/:id/creators/:creatorId",
    {
      schema: {
        tags: ["studios"],
        summary: "Link creator to studio",
        description: "Associates a creator with this studio.",
        params: creatorIdParamSchema,
        response: {
          200: messageResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id, creatorId } = request.params as { id: string; creatorId: string };
      await studiosService.linkCreator(Number(id), Number(creatorId));

      return reply.send({
        success: true,
        message: "Creator linked to studio successfully",
      });
    },
  );

  // Get creators for studio
  app.get(
    "/:id/creators",
    {
      schema: {
        tags: ["studios"],
        summary: "Get creators for studio",
        description: "Returns all creators associated with this studio.",
        params: idParamSchema,
        response: {
          200: creatorListResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const creators = await studiosService.getCreators(request.params.id);

      return reply.send({
        success: true,
        data: creators,
      });
    },
  );

  // Unlink creator from studio
  app.delete(
    "/:id/creators/:creatorId",
    {
      schema: {
        tags: ["studios"],
        summary: "Unlink creator from studio",
        description: "Removes the association between a creator and this studio.",
        params: creatorIdParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id, creatorId } = request.params as { id: string; creatorId: string };
      await studiosService.unlinkCreator(Number(id), Number(creatorId));

      return reply.send({
        success: true,
        message: "Creator unlinked from studio successfully",
      });
    },
  );

  // Link video to studio
  app.post(
    "/:id/videos/:videoId",
    {
      schema: {
        tags: ["studios"],
        summary: "Link video to studio",
        description: "Associates a video with this studio.",
        params: videoIdParamSchema,
        response: {
          200: messageResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id, videoId } = request.params as { id: string; videoId: string };
      await studiosService.linkVideo(Number(id), Number(videoId));

      return reply.send({
        success: true,
        message: "Video linked to studio successfully",
      });
    },
  );

  // Get videos for studio
  app.get(
    "/:id/videos",
    {
      schema: {
        tags: ["studios"],
        summary: "Get videos for studio",
        description: "Returns all videos associated with this studio.",
        params: idParamSchema,
        response: {
          200: videoListResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const videos = await studiosService.getVideos(request.params.id);

      return reply.send({
        success: true,
        data: videos,
      });
    },
  );

  // Unlink video from studio
  app.delete(
    "/:id/videos/:videoId",
    {
      schema: {
        tags: ["studios"],
        summary: "Unlink video from studio",
        description: "Removes the association between a video and this studio.",
        params: videoIdParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id, videoId } = request.params as { id: string; videoId: string };
      await studiosService.unlinkVideo(Number(id), Number(videoId));

      return reply.send({
        success: true,
        message: "Video unlinked from studio successfully",
      });
    },
  );
}
