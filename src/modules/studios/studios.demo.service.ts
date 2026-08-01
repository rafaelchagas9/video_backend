import { and, asc, eq, max } from "drizzle-orm";
import {
  demoSchema,
  getDemoDatabase,
  withDemoTransaction,
} from "@/database/demo";
import { ConflictError, NotFoundError } from "@/utils/errors";
import type { Creator } from "@/modules/creators/creators.types";
import type {
  CreateStudioInput,
  CreateStudioSocialLinkInput,
  Studio,
  StudioSocialLink,
  UpdateStudioInput,
  UpdateStudioSocialLinkInput,
} from "./studios.types";

const {
  demoCreatorsTable,
  demoCreatorStudiosTable,
  demoStudioSocialLinksTable,
  demoStudiosTable,
  demoVideosTable,
  demoVideoStudiosTable,
} = demoSchema;

const now = (): string => new Date().toISOString();

export class StudiosDemoService {
  findById(id: number): Studio {
    const row = getDemoDatabase()
      .select()
      .from(demoStudiosTable)
      .where(eq(demoStudiosTable.id, id))
      .get();
    if (!row) throw new NotFoundError(`Studio not found with id: ${id}`);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      profile_picture_path: row.profilePicturePath,
      profile_picture_url: row.profilePicturePath
        ? `/api/studios/${row.id}/picture`
        : undefined,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }

  create(input: CreateStudioInput): Studio {
    this.assertNameAvailable(input.name);
    const id =
      Number(
        getDemoDatabase()
          .select({ value: max(demoStudiosTable.id) })
          .from(demoStudiosTable)
          .get()?.value ?? 0
      ) + 1;
    const timestamp = now();
    getDemoDatabase()
      .insert(demoStudiosTable)
      .values({
        id,
        name: input.name,
        description: input.description ?? null,
        profilePicturePath: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    return this.findById(id);
  }

  update(id: number, input: UpdateStudioInput): Studio {
    const existing = this.findById(id);
    if (input.name && input.name !== existing.name) {
      this.assertNameAvailable(input.name);
    }
    getDemoDatabase()
      .update(demoStudiosTable)
      .set({
        name: input.name ?? existing.name,
        description:
          input.description !== undefined
            ? input.description
            : existing.description,
        updatedAt: now(),
      })
      .where(eq(demoStudiosTable.id, id))
      .run();
    return this.findById(id);
  }

  delete(id: number): void {
    this.findById(id);
    getDemoDatabase()
      .delete(demoStudiosTable)
      .where(eq(demoStudiosTable.id, id))
      .run();
  }

  listSocialLinks(studioId: number): StudioSocialLink[] {
    this.findById(studioId);
    return getDemoDatabase()
      .select()
      .from(demoStudioSocialLinksTable)
      .where(eq(demoStudioSocialLinksTable.studioId, studioId))
      .orderBy(asc(demoStudioSocialLinksTable.id))
      .all()
      .map((row) => ({
        id: row.id,
        studio_id: row.studioId,
        platform_name: row.platformName,
        url: row.url,
        created_at: row.createdAt,
      }));
  }

  addSocialLink(
    studioId: number,
    input: CreateStudioSocialLinkInput
  ): StudioSocialLink {
    this.findById(studioId);
    const id =
      Number(
        getDemoDatabase()
          .select({ value: max(demoStudioSocialLinksTable.id) })
          .from(demoStudioSocialLinksTable)
          .where(eq(demoStudioSocialLinksTable.studioId, studioId))
          .get()?.value ?? 0
      ) + 1;
    const createdAt = now();
    getDemoDatabase()
      .insert(demoStudioSocialLinksTable)
      .values({
        id,
        studioId,
        platformName: input.platform_name,
        url: input.url,
        createdAt,
      })
      .run();
    return {
      id,
      studio_id: studioId,
      platform_name: input.platform_name,
      url: input.url,
      created_at: createdAt,
    };
  }

  updateSocialLink(
    studioId: number,
    id: number,
    input: UpdateStudioSocialLinkInput
  ): StudioSocialLink {
    const existing = this.listSocialLinks(studioId).find(
      (link) => link.id === id
    );
    if (!existing)
      throw new NotFoundError(`Studio social link not found with id: ${id}`);
    getDemoDatabase()
      .update(demoStudioSocialLinksTable)
      .set({
        platformName: input.platform_name ?? existing.platform_name,
        url: input.url ?? existing.url,
      })
      .where(
        and(
          eq(demoStudioSocialLinksTable.studioId, studioId),
          eq(demoStudioSocialLinksTable.id, id)
        )
      )
      .run();
    return this.listSocialLinks(studioId).find((link) => link.id === id)!;
  }

  deleteSocialLink(studioId: number, id: number): void {
    this.updateSocialLink(studioId, id, {});
    getDemoDatabase()
      .delete(demoStudioSocialLinksTable)
      .where(
        and(
          eq(demoStudioSocialLinksTable.studioId, studioId),
          eq(demoStudioSocialLinksTable.id, id)
        )
      )
      .run();
  }

  linkCreator(studioId: number, creatorId: number): void {
    this.findById(studioId);
    this.assertCreator(creatorId);
    const existing = getDemoDatabase()
      .select({ id: demoCreatorStudiosTable.creatorId })
      .from(demoCreatorStudiosTable)
      .where(
        and(
          eq(demoCreatorStudiosTable.studioId, studioId),
          eq(demoCreatorStudiosTable.creatorId, creatorId)
        )
      )
      .get();
    if (existing)
      throw new ConflictError("Creator is already linked to this studio");
    getDemoDatabase()
      .insert(demoCreatorStudiosTable)
      .values({ studioId, creatorId })
      .run();
  }

  unlinkCreator(studioId: number, creatorId: number): void {
    this.findById(studioId);
    getDemoDatabase()
      .delete(demoCreatorStudiosTable)
      .where(
        and(
          eq(demoCreatorStudiosTable.studioId, studioId),
          eq(demoCreatorStudiosTable.creatorId, creatorId)
        )
      )
      .run();
  }

  bulkUpdateCreators(
    studioId: number,
    input: { creatorIds: number[]; action: "add" | "remove" }
  ): void {
    this.findById(studioId);
    withDemoTransaction(() => {
      for (const creatorId of input.creatorIds) {
        if (input.action === "add") {
          this.assertCreator(creatorId);
          getDemoDatabase()
            .insert(demoCreatorStudiosTable)
            .values({ studioId, creatorId })
            .onConflictDoNothing()
            .run();
        } else {
          this.unlinkCreator(studioId, creatorId);
        }
      }
    });
  }

  getCreators(studioId: number): Creator[] {
    this.findById(studioId);
    return getDemoDatabase()
      .select({ creator: demoCreatorsTable })
      .from(demoCreatorStudiosTable)
      .innerJoin(
        demoCreatorsTable,
        eq(demoCreatorsTable.id, demoCreatorStudiosTable.creatorId)
      )
      .where(eq(demoCreatorStudiosTable.studioId, studioId))
      .orderBy(asc(demoCreatorsTable.name))
      .all()
      .map(({ creator }) => ({
        id: creator.id,
        name: creator.name,
        description: creator.description,
        profile_picture_path: creator.profilePicturePath,
        main_picture_path: creator.mainPicturePath,
        face_thumbnail_path: creator.faceThumbnailPath,
        profile_picture_url: creator.profilePicturePath
          ? `/api/creators/${creator.id}/picture`
          : undefined,
        main_picture_url: creator.mainPicturePath
          ? `/api/creators/${creator.id}/picture?variant=main`
          : undefined,
        face_thumbnail_url: creator.faceThumbnailPath
          ? `/api/creators/${creator.id}/picture?type=face`
          : undefined,
        is_favorite: false,
        created_at: creator.createdAt,
        updated_at: creator.updatedAt,
      }));
  }

  linkVideo(studioId: number, videoId: number): void {
    this.findById(studioId);
    const video = getDemoDatabase()
      .select({ id: demoVideosTable.id })
      .from(demoVideosTable)
      .where(eq(demoVideosTable.id, videoId))
      .get();
    if (!video) throw new NotFoundError(`Video not found with id: ${videoId}`);
    const existing = getDemoDatabase()
      .select({ id: demoVideoStudiosTable.videoId })
      .from(demoVideoStudiosTable)
      .where(
        and(
          eq(demoVideoStudiosTable.studioId, studioId),
          eq(demoVideoStudiosTable.videoId, videoId)
        )
      )
      .get();
    if (existing)
      throw new ConflictError("Video is already linked to this studio");
    getDemoDatabase()
      .insert(demoVideoStudiosTable)
      .values({ studioId, videoId })
      .run();
  }

  unlinkVideo(studioId: number, videoId: number): void {
    this.findById(studioId);
    getDemoDatabase()
      .delete(demoVideoStudiosTable)
      .where(
        and(
          eq(demoVideoStudiosTable.studioId, studioId),
          eq(demoVideoStudiosTable.videoId, videoId)
        )
      )
      .run();
  }

  getVideoIds(studioId: number): number[] {
    this.findById(studioId);
    return getDemoDatabase()
      .select({ id: demoVideoStudiosTable.videoId })
      .from(demoVideoStudiosTable)
      .where(eq(demoVideoStudiosTable.studioId, studioId))
      .all()
      .map((row) => row.id);
  }

  private assertNameAvailable(name: string): void {
    const duplicate = getDemoDatabase()
      .select({ id: demoStudiosTable.id })
      .from(demoStudiosTable)
      .where(eq(demoStudiosTable.name, name))
      .get();
    if (duplicate)
      throw new ConflictError(`Studio with name "${name}" already exists`);
  }

  private assertCreator(id: number): void {
    const creator = getDemoDatabase()
      .select({ id: demoCreatorsTable.id })
      .from(demoCreatorsTable)
      .where(eq(demoCreatorsTable.id, id))
      .get();
    if (!creator) throw new NotFoundError(`Creator not found with id: ${id}`);
  }
}

export const studiosDemoService = new StudiosDemoService();
