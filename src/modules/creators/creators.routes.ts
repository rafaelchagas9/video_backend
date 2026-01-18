import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { readFileSync } from "fs";
import { join } from "path";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { creatorsService } from "./creators.service";
import { creatorsPlatformsService } from "./creators.platforms.service";
import { creatorsSocialService } from "./creators.social.service";
import { creatorsRelationshipsService } from "./creators.relationships.service";
import { creatorsBulkService } from "./creators.bulk.service";
import {
  idParamSchema,
  listCreatorsQuerySchema,
  createCreatorSchema,
  updateCreatorSchema,
  createCreatorPlatformSchema,
  updateCreatorPlatformSchema,
  createSocialLinkSchema,
  updateSocialLinkSchema,
  creatorResponseSchema,
  creatorListResponseSchema,
  creatorVideosResponseSchema,
  platformProfileResponseSchema,
  platformProfileListResponseSchema,
  socialLinkResponseSchema,
  socialLinkListResponseSchema,
  studioListResponseSchema,
  messageResponseSchema,
  errorResponseSchema,
  bulkPlatformsSchema,
  bulkSocialLinksSchema,
  pictureFromUrlSchema,
  pictureQuerySchema,
  bulkOperationResponseSchema,
  bulkImportQuerySchema,
  bulkCreatorImportSchema,
  bulkImportResponseSchema,
  autocompleteQuerySchema,
  autocompleteResponseSchema,
  recentQuerySchema,
  recentResponseSchema,
  quickCreateCreatorSchema,
  quickCreateResponseSchema,
} from "./creators.schemas";

export async function creatorsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // All routes require authentication
  app.addHook("preHandler", authenticateUser);

  // List all creators
  app.get(
    "/",
    {
      schema: {
        tags: ["creators"],
        summary: "List all creators",
        description: "Returns a paginated, filterable list of creators.",
        querystring: listCreatorsQuerySchema,
        response: {
          200: creatorListResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await creatorsService.list(request.query);

      return reply.send({
        success: true,
        ...result,
      });
    },
  );

  // Get creator by ID
  app.get(
    "/:id",
    {
      schema: {
        tags: ["creators"],
        summary: "Get creator by ID",
        description: "Returns details of a specific creator.",
        params: idParamSchema,
        response: {
          200: creatorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const creator = await creatorsService.findById(request.params.id);

      return reply.send({
        success: true,
        data: creator,
      });
    },
  );

  // Create new creator
  app.post(
    "/",
    {
      schema: {
        tags: ["creators"],
        summary: "Create a new creator",
        description: "Creates a new creator with the provided details.",
        body: createCreatorSchema,
        response: {
          201: creatorResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const creator = await creatorsService.create(request.body);

      return reply.status(201).send({
        success: true,
        data: creator,
        message: "Creator created successfully",
      });
    },
  );

  // Bulk import creators
  app.post(
    "/bulk",
    {
      schema: {
        tags: ["creators"],
        summary: "Bulk import creators",
        description:
          "Creates or updates multiple creators with their platforms, social links, and video associations. Use dry_run=true to preview changes without applying.",
        querystring: bulkImportQuerySchema,
        body: bulkCreatorImportSchema,
        response: {
          200: bulkImportResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { dry_run } = request.query;
      const { items, mode } = request.body;

      const result = await creatorsBulkService.bulkImport(items, mode, dry_run);

      return reply.send({
        success: true,
        data: result,
        message: dry_run
          ? `Preview: ${result.summary.will_create} to create, ${result.summary.will_update} to update, ${result.summary.errors} errors`
          : `Imported: ${result.summary.will_create} created, ${result.summary.will_update} updated`,
      });
    },
  );

  // Update creator
  app.patch(
    "/:id",
    {
      schema: {
        tags: ["creators"],
        summary: "Update a creator",
        description: "Updates an existing creator's details.",
        params: idParamSchema,
        body: updateCreatorSchema,
        response: {
          200: creatorResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const creator = await creatorsService.update(
        request.params.id,
        request.body,
      );

      return reply.send({
        success: true,
        data: creator,
        message: "Creator updated successfully",
      });
    },
  );

  // Delete creator
  app.delete(
    "/:id",
    {
      schema: {
        tags: ["creators"],
        summary: "Delete a creator",
        description: "Permanently deletes a creator.",
        params: idParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await creatorsService.delete(request.params.id);

      return reply.send({
        success: true,
        message: "Creator deleted successfully",
      });
    },
  );

  // Get videos by creator
  app.get(
    "/:id/videos",
    {
      schema: {
        tags: ["creators"],
        summary: "Get videos by creator",
        description: "Returns all videos associated with a creator.",
        params: idParamSchema,
        response: {
          200: creatorVideosResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const videos = await creatorsRelationshipsService.getVideos(
        request.params.id,
      );

      return reply.send({
        success: true,
        data: videos,
      });
    },
  );

  // Upload profile picture
  fastify.post(
    "/:id/picture",
    {
      schema: {
        tags: ["creators"],
        summary: "Upload profile picture",
        description:
          "Uploads a profile picture for the creator. Accepts JPEG, PNG, or WebP images.",
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
      const { id } = request.params as { id: number };
      const creator = await creatorsSocialService.uploadProfilePicture(
        id,
        buffer,
        data.filename,
      );

      return reply.send({
        success: true,
        data: creator,
        message: "Profile picture uploaded successfully",
      });
    },
  );

  // Get profile picture
  fastify.get(
    "/:id/picture",
    {
      schema: {
        tags: ["creators"],
        summary: "Get profile picture",
        description:
          "Serves the creator's profile picture or default avatar if none is set. Use ?type=face to request the face thumbnail.",
        params: idParamSchema,
        querystring: pictureQuerySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const creator = await creatorsService.findById(Number(id));
      const { type } = request.query as { type?: "face" };

      let filePath: string;
      let contentType: string;

      if (type === "face") {
        filePath =
          creator.face_thumbnail_path ??
          creator.profile_picture_path ??
          join(process.cwd(), "public", "pfp.png");
      } else if (!creator.profile_picture_path) {
        // Return default profile picture
        filePath = join(process.cwd(), "public", "pfp.png");
      } else {
        filePath = creator.profile_picture_path;
      }

      const ext = filePath.split(".").pop()?.toLowerCase();
      contentType =
        ext === "png"
          ? "image/png"
          : ext === "webp"
            ? "image/webp"
            : "image/jpeg";

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
        tags: ["creators"],
        summary: "Delete profile picture",
        description: "Deletes the creator's profile picture.",
        params: idParamSchema,
        response: {
          200: creatorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const creator = await creatorsSocialService.deleteProfilePicture(
        request.params.id,
      );

      return reply.send({
        success: true,
        data: creator,
        message: "Profile picture deleted successfully",
      });
    },
  );

  // Add platform profile
  app.post(
    "/:id/platforms",
    {
      schema: {
        tags: ["creators"],
        summary: "Add platform profile",
        description:
          "Adds a platform profile for the creator (e.g., Patreon, OnlyFans).",
        params: idParamSchema,
        body: createCreatorPlatformSchema,
        response: {
          201: platformProfileResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const profile = await creatorsPlatformsService.addPlatformProfile(
        request.params.id,
        request.body,
      );

      return reply.status(201).send({
        success: true,
        data: profile,
        message: "Platform profile added successfully",
      });
    },
  );

  // Get platform profiles
  app.get(
    "/:id/platforms",
    {
      schema: {
        tags: ["creators"],
        summary: "Get platform profiles",
        description: "Returns all platform profiles for the creator.",
        params: idParamSchema,
        response: {
          200: platformProfileListResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const profiles = await creatorsPlatformsService.getPlatformProfiles(
        request.params.id,
      );

      return reply.send({
        success: true,
        data: profiles,
      });
    },
  );

  // Update platform profile
  app.patch(
    "/:id/platforms/:platformId",
    {
      schema: {
        tags: ["creators"],
        summary: "Update platform profile",
        description: "Updates an existing platform profile.",
        body: updateCreatorPlatformSchema,
        response: {
          200: platformProfileResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { platformId } = request.params as { platformId: string };
      const profile = await creatorsPlatformsService.updatePlatformProfile(
        Number(platformId),
        request.body,
      );

      return reply.send({
        success: true,
        data: profile,
        message: "Platform profile updated successfully",
      });
    },
  );

  // Delete platform profile
  app.delete(
    "/:id/platforms/:platformId",
    {
      schema: {
        tags: ["creators"],
        summary: "Delete platform profile",
        description: "Deletes a platform profile.",
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { platformId } = request.params as { platformId: string };
      await creatorsPlatformsService.deletePlatformProfile(Number(platformId));

      return reply.send({
        success: true,
        message: "Platform profile deleted successfully",
      });
    },
  );

  // Add social link
  app.post(
    "/:id/social-links",
    {
      schema: {
        tags: ["creators"],
        summary: "Add social link",
        description: "Adds a social media link for the creator.",
        params: idParamSchema,
        body: createSocialLinkSchema,
        response: {
          201: socialLinkResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const link = await creatorsSocialService.addSocialLink(
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

  // Bulk upsert platforms
  app.post(
    "/:id/platforms/bulk",
    {
      schema: {
        tags: ["creators"],
        summary: "Bulk upsert platform profiles",
        description:
          "Creates or updates multiple platform profiles for a creator. Upserts by platform_id + username.",
        params: idParamSchema,
        body: bulkPlatformsSchema,
        response: {
          200: bulkOperationResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await creatorsPlatformsService.bulkUpsertPlatforms(
        request.params.id,
        request.body.items,
      );

      return reply.send({
        success: true,
        data: result,
        message: `Created ${result.created.length}, updated ${result.updated.length}, errors ${result.errors.length}`,
      });
    },
  );

  // Bulk upsert social links
  app.post(
    "/:id/social-links/bulk",
    {
      schema: {
        tags: ["creators"],
        summary: "Bulk upsert social links",
        description:
          "Creates or updates multiple social links for a creator. Upserts by platform_name.",
        params: idParamSchema,
        body: bulkSocialLinksSchema,
        response: {
          200: bulkOperationResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await creatorsSocialService.bulkUpsertSocialLinks(
        request.params.id,
        request.body.items,
      );

      return reply.send({
        success: true,
        data: result,
        message: `Created ${result.created.length}, updated ${result.updated.length}, errors ${result.errors.length}`,
      });
    },
  );

  // Set picture from URL
  app.post(
    "/:id/picture-from-url",
    {
      schema: {
        tags: ["creators"],
        summary: "Set profile picture from URL",
        description:
          "Downloads an image from the given URL and sets it as the creator's profile picture.",
        params: idParamSchema,
        body: pictureFromUrlSchema,
        response: {
          200: creatorResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const creator = await creatorsSocialService.setPictureFromUrl(
        request.params.id,
        request.body.url,
      );

      return reply.send({
        success: true,
        data: creator,
        message: "Profile picture set from URL successfully",
      });
    },
  );

  // Get social links
  app.get(
    "/:id/social-links",
    {
      schema: {
        tags: ["creators"],
        summary: "Get social links",
        description: "Returns all social media links for the creator.",
        params: idParamSchema,
        response: {
          200: socialLinkListResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const links = await creatorsSocialService.getSocialLinks(
        request.params.id,
      );

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
        tags: ["creators"],
        summary: "Update social link",
        description: "Updates an existing social link.",
        body: updateSocialLinkSchema,
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
      const link = await creatorsSocialService.updateSocialLink(
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
        tags: ["creators"],
        summary: "Delete social link",
        description: "Deletes a social link.",
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { linkId } = request.params as { linkId: string };
      await creatorsSocialService.deleteSocialLink(Number(linkId));

      return reply.send({
        success: true,
        message: "Social link deleted successfully",
      });
    },
  );

  // Link creator to studio
  app.post(
    "/:id/studios/:studioId",
    {
      schema: {
        tags: ["creators"],
        summary: "Link creator to studio",
        description: "Associates a creator with a studio.",
        response: {
          200: messageResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id, studioId } = request.params as {
        id: string;
        studioId: string;
      };
      await creatorsRelationshipsService.linkStudio(
        Number(id),
        Number(studioId),
      );

      return reply.send({
        success: true,
        message: "Creator linked to studio successfully",
      });
    },
  );

  // Get studios for creator
  app.get(
    "/:id/studios",
    {
      schema: {
        tags: ["creators"],
        summary: "Get studios for creator",
        description: "Returns all studios associated with the creator.",
        params: idParamSchema,
        response: {
          200: studioListResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const studios = await creatorsRelationshipsService.getStudios(
        request.params.id,
      );

      return reply.send({
        success: true,
        data: studios,
      });
    },
  );

  // Unlink creator from studio
  app.delete(
    "/:id/studios/:studioId",
    {
      schema: {
        tags: ["creators"],
        summary: "Unlink creator from studio",
        description: "Removes the association between a creator and a studio.",
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id, studioId } = request.params as {
        id: string;
        studioId: string;
      };
      await creatorsRelationshipsService.unlinkStudio(
        Number(id),
        Number(studioId),
      );

      return reply.send({
        success: true,
        message: "Creator unlinked from studio successfully",
      });
    },
  );

  // Autocomplete creators by name
  app.get(
    "/autocomplete",
    {
      schema: {
        tags: ["creators"],
        summary: "Autocomplete creator names",
        description:
          "Returns a list of creators matching the search query. Useful for type-ahead selection in tagging UI.",
        querystring: autocompleteQuerySchema,
        response: {
          200: autocompleteResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { q, limit } = request.query;

      const creators = await creatorsService.autocomplete(q, limit);

      return reply.send({
        success: true,
        data: creators,
      });
    },
  );

  // Get recent creators
  app.get(
    "/recent",
    {
      schema: {
        tags: ["creators"],
        summary: "Get recently created creators",
        description:
          "Returns a list of recently created creators, ordered by creation date descending.",
        querystring: recentQuerySchema,
        response: {
          200: recentResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { limit } = request.query;

      const creators = await creatorsService.getRecent(limit);

      return reply.send({
        success: true,
        data: creators,
      });
    },
  );

  // Quick create creator (minimal fields)
  app.post(
    "/quick-create",
    {
      schema: {
        tags: ["creators"],
        summary: "Quick create a creator",
        description:
          "Creates a new creator with just a name and optional description. Useful for rapid tagging workflows.",
        body: quickCreateCreatorSchema,
        response: {
          201: quickCreateResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { name, description } = request.body;

      const creator = await creatorsService.quickCreate(name, description);

      return reply.status(201).send({
        success: true,
        data: creator,
        message: "Creator created successfully",
      });
    },
  );
}
