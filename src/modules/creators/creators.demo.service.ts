import { and, asc, eq, max } from "drizzle-orm";
import {
  demoSchema,
  getDemoDatabase,
  withDemoTransaction,
} from "@/database/demo";
import { ConflictError, NotFoundError } from "@/utils/errors";
import type { CreatorPlatform } from "@/modules/platforms/platforms.types";
import type {
  Alias,
  CreateAliasInput,
  CreateCreatorInput,
  CreateSocialLinkInput,
  Creator,
  CreatorGalleryMedia,
  SocialLink,
  UpdateAliasInput,
  UpdateCreatorInput,
  UpdateSocialLinkInput,
} from "./creators.types";

const {
  demoCreatorAliasesTable,
  demoCreatorFavoritesTable,
  demoCreatorGalleryTable,
  demoCreatorPlatformsTable,
  demoCreatorSocialLinksTable,
  demoCreatorStudiosTable,
  demoCreatorsTable,
  demoStudiosTable,
} = demoSchema;

function now(): string {
  return new Date().toISOString();
}

function nextScopedId(
  table:
    | typeof demoCreatorAliasesTable
    | typeof demoCreatorPlatformsTable
    | typeof demoCreatorSocialLinksTable
    | typeof demoCreatorGalleryTable,
  creatorId: number
): number {
  const row = getDemoDatabase()
    .select({ value: max(table.id) })
    .from(table)
    .where(eq(table.creatorId, creatorId))
    .get();
  return Number(row?.value ?? 0) + 1;
}

export class CreatorsDemoService {
  findById(id: number, userId = 1): Creator {
    const row = getDemoDatabase()
      .select()
      .from(demoCreatorsTable)
      .where(eq(demoCreatorsTable.id, id))
      .get();
    if (!row) throw new NotFoundError(`Creator not found with id: ${id}`);
    const favorite = getDemoDatabase()
      .select({ creatorId: demoCreatorFavoritesTable.creatorId })
      .from(demoCreatorFavoritesTable)
      .where(
        and(
          eq(demoCreatorFavoritesTable.creatorId, id),
          eq(demoCreatorFavoritesTable.userId, userId)
        )
      )
      .get();
    const extra = row.extraJson
      ? (JSON.parse(row.extraJson) as Record<string, unknown>)
      : {};
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      profile_picture_path: row.profilePicturePath,
      main_picture_path: row.mainPicturePath,
      face_thumbnail_path: row.faceThumbnailPath,
      profile_picture_url: row.profilePicturePath
        ? `/api/creators/${row.id}/picture`
        : undefined,
      main_picture_url: row.mainPicturePath
        ? `/api/creators/${row.id}/picture?variant=main`
        : undefined,
      face_thumbnail_url: row.faceThumbnailPath
        ? `/api/creators/${row.id}/picture?type=face`
        : undefined,
      gallery_media: this.listGallery(id),
      is_favorite: Boolean(favorite),
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      ...extra,
    };
  }

  create(input: CreateCreatorInput): Creator {
    const duplicate = getDemoDatabase()
      .select({ id: demoCreatorsTable.id })
      .from(demoCreatorsTable)
      .where(eq(demoCreatorsTable.name, input.name))
      .get();
    if (duplicate)
      throw new ConflictError(
        `Creator with name "${input.name}" already exists`
      );
    const id =
      Number(
        getDemoDatabase()
          .select({ value: max(demoCreatorsTable.id) })
          .from(demoCreatorsTable)
          .get()?.value ?? 0
      ) + 1;
    const timestamp = now();
    getDemoDatabase()
      .insert(demoCreatorsTable)
      .values({
        id,
        name: input.name,
        description: input.description ?? null,
        profilePicturePath: null,
        mainPicturePath: null,
        faceThumbnailPath: null,
        extraJson: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    return this.findById(id);
  }

  update(id: number, input: UpdateCreatorInput): Creator {
    const existing = this.findById(id);
    if (input.name && input.name !== existing.name) {
      const duplicate = getDemoDatabase()
        .select({ id: demoCreatorsTable.id })
        .from(demoCreatorsTable)
        .where(eq(demoCreatorsTable.name, input.name))
        .get();
      if (duplicate)
        throw new ConflictError(
          `Creator with name "${input.name}" already exists`
        );
    }
    getDemoDatabase()
      .update(demoCreatorsTable)
      .set({
        name: input.name ?? existing.name,
        description:
          input.description !== undefined
            ? input.description
            : existing.description,
        updatedAt: now(),
      })
      .where(eq(demoCreatorsTable.id, id))
      .run();
    return this.findById(id);
  }

  delete(id: number): void {
    this.findById(id);
    getDemoDatabase()
      .delete(demoCreatorsTable)
      .where(eq(demoCreatorsTable.id, id))
      .run();
  }

  addAlias(creatorId: number, input: CreateAliasInput): Alias {
    this.findById(creatorId);
    const id = nextScopedId(demoCreatorAliasesTable, creatorId);
    const createdAt = now();
    getDemoDatabase()
      .insert(demoCreatorAliasesTable)
      .values({
        id,
        creatorId,
        name: input.name,
        note: input.note ?? null,
        createdAt,
      })
      .run();
    return {
      id,
      creator_id: creatorId,
      name: input.name,
      note: input.note ?? null,
      created_at: createdAt,
    };
  }

  updateAlias(creatorId: number, id: number, input: UpdateAliasInput): Alias {
    const existing = this.getAliases(creatorId).find(
      (alias) => alias.id === id
    );
    if (!existing) throw new NotFoundError(`Alias not found with id: ${id}`);
    const updated = {
      ...existing,
      name: input.name ?? existing.name,
      note: input.note !== undefined ? input.note : existing.note,
    };
    getDemoDatabase()
      .update(demoCreatorAliasesTable)
      .set({ name: updated.name, note: updated.note })
      .where(
        and(
          eq(demoCreatorAliasesTable.creatorId, creatorId),
          eq(demoCreatorAliasesTable.id, id)
        )
      )
      .run();
    return updated;
  }

  deleteAlias(creatorId: number, id: number): void {
    this.updateAlias(creatorId, id, {});
    getDemoDatabase()
      .delete(demoCreatorAliasesTable)
      .where(
        and(
          eq(demoCreatorAliasesTable.creatorId, creatorId),
          eq(demoCreatorAliasesTable.id, id)
        )
      )
      .run();
  }

  getAliases(creatorId: number): Alias[] {
    this.findByIdWithoutChildren(creatorId);
    return getDemoDatabase()
      .select()
      .from(demoCreatorAliasesTable)
      .where(eq(demoCreatorAliasesTable.creatorId, creatorId))
      .orderBy(asc(demoCreatorAliasesTable.id))
      .all()
      .map((row) => ({
        id: row.id,
        creator_id: row.creatorId,
        name: row.name,
        note: row.note,
        created_at: row.createdAt,
      }));
  }

  addPlatform(
    creatorId: number,
    input: {
      platform_id: number;
      platform_name?: string;
      username: string;
      profile_url: string;
      is_primary?: boolean;
    }
  ): CreatorPlatform {
    this.findByIdWithoutChildren(creatorId);
    const id = nextScopedId(demoCreatorPlatformsTable, creatorId);
    const timestamp = now();
    getDemoDatabase()
      .insert(demoCreatorPlatformsTable)
      .values({
        id,
        creatorId,
        platformId: input.platform_id,
        platformName: input.platform_name ?? `Platform ${input.platform_id}`,
        username: input.username,
        profileUrl: input.profile_url,
        isPrimary: input.is_primary ?? false,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    return this.getPlatforms(creatorId).find((platform) => platform.id === id)!;
  }

  updatePlatform(
    creatorId: number,
    id: number,
    input: Partial<
      Pick<CreatorPlatform, "username" | "profile_url" | "is_primary">
    >
  ): CreatorPlatform {
    const existing = this.getPlatforms(creatorId).find(
      (platform) => platform.id === id
    );
    if (!existing)
      throw new NotFoundError(`Creator platform not found with id: ${id}`);
    getDemoDatabase()
      .update(demoCreatorPlatformsTable)
      .set({
        username: input.username ?? existing.username,
        profileUrl: input.profile_url ?? existing.profile_url,
        isPrimary: input.is_primary ?? existing.is_primary,
        updatedAt: now(),
      })
      .where(
        and(
          eq(demoCreatorPlatformsTable.creatorId, creatorId),
          eq(demoCreatorPlatformsTable.id, id)
        )
      )
      .run();
    return this.getPlatforms(creatorId).find((platform) => platform.id === id)!;
  }

  deletePlatform(creatorId: number, id: number): void {
    if (!this.getPlatforms(creatorId).some((platform) => platform.id === id)) {
      throw new NotFoundError(`Creator platform not found with id: ${id}`);
    }
    getDemoDatabase()
      .delete(demoCreatorPlatformsTable)
      .where(
        and(
          eq(demoCreatorPlatformsTable.creatorId, creatorId),
          eq(demoCreatorPlatformsTable.id, id)
        )
      )
      .run();
  }

  getPlatforms(creatorId: number): CreatorPlatform[] {
    this.findByIdWithoutChildren(creatorId);
    return getDemoDatabase()
      .select()
      .from(demoCreatorPlatformsTable)
      .where(eq(demoCreatorPlatformsTable.creatorId, creatorId))
      .orderBy(asc(demoCreatorPlatformsTable.id))
      .all()
      .map((row) => ({
        id: row.id,
        creator_id: row.creatorId,
        platform_id: row.platformId,
        platform_name: row.platformName,
        username: row.username,
        profile_url: row.profileUrl,
        is_primary: row.isPrimary,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      }));
  }

  addSocialLink(creatorId: number, input: CreateSocialLinkInput): SocialLink {
    this.findByIdWithoutChildren(creatorId);
    const id = nextScopedId(demoCreatorSocialLinksTable, creatorId);
    const createdAt = now();
    getDemoDatabase()
      .insert(demoCreatorSocialLinksTable)
      .values({
        id,
        creatorId,
        platformName: input.platform_name,
        url: input.url,
        createdAt,
      })
      .run();
    return {
      id,
      creator_id: creatorId,
      platform_name: input.platform_name,
      url: input.url,
      created_at: createdAt,
    };
  }

  updateSocialLink(
    creatorId: number,
    id: number,
    input: UpdateSocialLinkInput
  ): SocialLink {
    const existing = this.getSocialLinks(creatorId).find(
      (link) => link.id === id
    );
    if (!existing)
      throw new NotFoundError(`Social link not found with id: ${id}`);
    const updated = {
      ...existing,
      platform_name: input.platform_name ?? existing.platform_name,
      url: input.url ?? existing.url,
    };
    getDemoDatabase()
      .update(demoCreatorSocialLinksTable)
      .set({ platformName: updated.platform_name, url: updated.url })
      .where(
        and(
          eq(demoCreatorSocialLinksTable.creatorId, creatorId),
          eq(demoCreatorSocialLinksTable.id, id)
        )
      )
      .run();
    return updated;
  }

  deleteSocialLink(creatorId: number, id: number): void {
    this.updateSocialLink(creatorId, id, {});
    getDemoDatabase()
      .delete(demoCreatorSocialLinksTable)
      .where(
        and(
          eq(demoCreatorSocialLinksTable.creatorId, creatorId),
          eq(demoCreatorSocialLinksTable.id, id)
        )
      )
      .run();
  }

  getSocialLinks(creatorId: number): SocialLink[] {
    this.findByIdWithoutChildren(creatorId);
    return getDemoDatabase()
      .select()
      .from(demoCreatorSocialLinksTable)
      .where(eq(demoCreatorSocialLinksTable.creatorId, creatorId))
      .orderBy(asc(demoCreatorSocialLinksTable.id))
      .all()
      .map((row) => ({
        id: row.id,
        creator_id: row.creatorId,
        platform_name: row.platformName,
        url: row.url,
        created_at: row.createdAt,
      }));
  }

  listGallery(creatorId: number): CreatorGalleryMedia[] {
    this.findByIdWithoutChildren(creatorId);
    return getDemoDatabase()
      .select()
      .from(demoCreatorGalleryTable)
      .where(eq(demoCreatorGalleryTable.creatorId, creatorId))
      .orderBy(asc(demoCreatorGalleryTable.id))
      .all()
      .map((row) => ({
        id: row.id,
        creator_id: row.creatorId,
        label: row.label,
        description: row.description,
        file_path: row.filePath,
        is_profile_picture: row.isProfilePicture,
        is_main_picture: row.isMainPicture,
        url: `/api/creators/${row.creatorId}/gallery/${row.id}/image`,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      }));
  }

  updateGalleryRoles(
    creatorId: number,
    id: number,
    input: {
      label?: string | null;
      description?: string | null;
      is_profile_picture?: boolean;
      is_main_picture?: boolean;
    }
  ): CreatorGalleryMedia {
    const existing = this.listGallery(creatorId).find(
      (media) => media.id === id
    );
    if (!existing)
      throw new NotFoundError(`Gallery media not found with id: ${id}`);
    withDemoTransaction(() => {
      if (input.is_profile_picture) {
        getDemoDatabase()
          .update(demoCreatorGalleryTable)
          .set({ isProfilePicture: false })
          .where(eq(demoCreatorGalleryTable.creatorId, creatorId))
          .run();
      }
      if (input.is_main_picture) {
        getDemoDatabase()
          .update(demoCreatorGalleryTable)
          .set({ isMainPicture: false })
          .where(eq(demoCreatorGalleryTable.creatorId, creatorId))
          .run();
      }
      getDemoDatabase()
        .update(demoCreatorGalleryTable)
        .set({
          label: input.label !== undefined ? input.label : existing.label,
          description:
            input.description !== undefined
              ? input.description
              : existing.description,
          isProfilePicture:
            input.is_profile_picture ?? existing.is_profile_picture,
          isMainPicture: input.is_main_picture ?? existing.is_main_picture,
          updatedAt: now(),
        })
        .where(
          and(
            eq(demoCreatorGalleryTable.creatorId, creatorId),
            eq(demoCreatorGalleryTable.id, id)
          )
        )
        .run();
    });
    return this.listGallery(creatorId).find((media) => media.id === id)!;
  }

  deleteGallery(creatorId: number, id: number): void {
    if (!this.listGallery(creatorId).some((media) => media.id === id))
      throw new NotFoundError(`Gallery media not found with id: ${id}`);
    getDemoDatabase()
      .delete(demoCreatorGalleryTable)
      .where(
        and(
          eq(demoCreatorGalleryTable.creatorId, creatorId),
          eq(demoCreatorGalleryTable.id, id)
        )
      )
      .run();
  }

  linkStudio(creatorId: number, studioId: number): void {
    this.findByIdWithoutChildren(creatorId);
    const studio = getDemoDatabase()
      .select({ id: demoStudiosTable.id })
      .from(demoStudiosTable)
      .where(eq(demoStudiosTable.id, studioId))
      .get();
    if (!studio)
      throw new NotFoundError(`Studio not found with id: ${studioId}`);
    getDemoDatabase()
      .insert(demoCreatorStudiosTable)
      .values({ creatorId, studioId })
      .onConflictDoNothing()
      .run();
  }

  unlinkStudio(creatorId: number, studioId: number): void {
    getDemoDatabase()
      .delete(demoCreatorStudiosTable)
      .where(
        and(
          eq(demoCreatorStudiosTable.creatorId, creatorId),
          eq(demoCreatorStudiosTable.studioId, studioId)
        )
      )
      .run();
  }

  getStudioIds(creatorId: number): number[] {
    this.findByIdWithoutChildren(creatorId);
    return getDemoDatabase()
      .select({ id: demoCreatorStudiosTable.studioId })
      .from(demoCreatorStudiosTable)
      .where(eq(demoCreatorStudiosTable.creatorId, creatorId))
      .all()
      .map((row) => row.id);
  }

  private findByIdWithoutChildren(id: number): void {
    const row = getDemoDatabase()
      .select({ id: demoCreatorsTable.id })
      .from(demoCreatorsTable)
      .where(eq(demoCreatorsTable.id, id))
      .get();
    if (!row) throw new NotFoundError(`Creator not found with id: ${id}`);
  }
}

export const creatorsDemoService = new CreatorsDemoService();
