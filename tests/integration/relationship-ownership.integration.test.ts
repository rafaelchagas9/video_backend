import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import {
  applyTestDatabaseEnv,
  assertTestDatabaseEnvironment,
  migrateTestDatabase,
  startTestDatabase,
} from "../helpers/test-database";

let pictureDirectory: string;
let imageCreatorId: number;
let database: Awaited<ReturnType<typeof startTestDatabase>>;
let db: typeof import("@/config/drizzle").db;
let closeDatabase: typeof import("@/config/drizzle").closeDrizzleDatabase;
let cases: Array<{
  name: string;
  update: (parent: number) => Promise<unknown>;
  remove: (parent: number) => Promise<unknown>;
  owner: number;
  wrong: number;
}>;
beforeAll(async () => {
  pictureDirectory = await mkdtemp(join(tmpdir(), "creator-image-safety-"));
  process.env.PROFILE_PICTURES_DIR = pictureDirectory;
  database = await startTestDatabase();
  applyTestDatabaseEnv(database);
  assertTestDatabaseEnvironment(database, (await import("@/config/env")).env);
  await migrateTestDatabase();
  ({ db, closeDrizzleDatabase: closeDatabase } =
    await import("@/config/drizzle"));
  const s = await import("@/database/schema");
  const creators = await db
    .insert(s.creatorsTable)
    .values([{ name: "Owner" }, { name: "Other" }])
    .returning();
  imageCreatorId = creators[0].id;
  const studios = await db
    .insert(s.studiosTable)
    .values([{ name: "Owner studio" }, { name: "Other studio" }])
    .returning();
  const [platform] = await db
    .insert(s.platformsTable)
    .values({ name: "Test platform" })
    .returning();
  const [social] = await db
    .insert(s.creatorSocialLinksTable)
    .values({
      creatorId: creators[0].id,
      platformName: "Website",
      url: "https://example.com",
    })
    .returning();
  const [alias] = await db
    .insert(s.creatorAliasesTable)
    .values({ creatorId: creators[0].id, name: "Alias" })
    .returning();
  const [profile] = await db
    .insert(s.creatorPlatformsTable)
    .values({
      creatorId: creators[0].id,
      platformId: platform.id,
      username: "owner",
      profileUrl: "https://example.com",
    })
    .returning();
  const [studioSocial] = await db
    .insert(s.studioSocialLinksTable)
    .values({
      studioId: studios[0].id,
      platformName: "Website",
      url: "https://example.com",
    })
    .returning();
  const { creatorsSocialService: cs } =
    await import("@/modules/creators/creators.social.service");
  const { creatorsAliasesService: ca } =
    await import("@/modules/creators/creators.aliases.service");
  const { creatorsPlatformsService: cp } =
    await import("@/modules/creators/creators.platforms.service");
  const { studiosSocialService: ss } =
    await import("@/modules/studios/studios.social.service");
  cases = [
    {
      name: "creator social",
      owner: creators[0].id,
      wrong: creators[1].id,
      update: (id) =>
        cs.updateSocialLink(social.id, { url: "https://updated.example" }, id),
      remove: (id) => cs.deleteSocialLink(social.id, id),
    },
    {
      name: "creator alias",
      owner: creators[0].id,
      wrong: creators[1].id,
      update: (id) => ca.updateAlias(alias.id, { name: "Updated alias" }, id),
      remove: (id) => ca.deleteAlias(alias.id, id),
    },
    {
      name: "creator platform",
      owner: creators[0].id,
      wrong: creators[1].id,
      update: (id) =>
        cp.updatePlatformProfile(profile.id, { username: "updated" }, id),
      remove: (id) => cp.deletePlatformProfile(profile.id, id),
    },
    {
      name: "studio social",
      owner: studios[0].id,
      wrong: studios[1].id,
      update: (id) =>
        ss.updateSocialLink(
          studioSocial.id,
          { url: "https://updated.example" },
          id
        ),
      remove: (id) => ss.deleteSocialLink(studioSocial.id, id),
    },
  ];
}, 60_000);
afterAll(async () => {
  await closeDatabase?.();
  await database?.stop();
  if (pictureDirectory)
    await rm(pictureDirectory, { recursive: true, force: true });
});

test("rejects cross-parent changes without changing or deleting the owner's relationships", async () => {
  for (const item of cases) {
    await expect(item.update(item.wrong), item.name).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(item.remove(item.wrong), item.name).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(item.update(item.owner), item.name).resolves.toBeDefined();
    await item.remove(item.owner);
    await expect(item.update(item.owner), item.name).rejects.toMatchObject({
      statusCode: 404,
    });
  }
});

test("concurrent gallery uploads cannot overwrite another image with the same timestamp", async () => {
  const { creatorsSocialService } =
    await import("@/modules/creators/creators.social.service");
  const red = await sharp({
    create: { width: 40, height: 40, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const blue = await sharp({
    create: { width: 40, height: 40, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();
  const clock = spyOn(Date, "now").mockReturnValue(123456789);
  let uploads;
  try {
    uploads = await Promise.all([
      creatorsSocialService.addGalleryMedia(imageCreatorId, red),
      creatorsSocialService.addGalleryMedia(imageCreatorId, blue),
    ]);
  } finally {
    clock.mockRestore();
  }
  expect(uploads[0].file_path).not.toBe(uploads[1].file_path);
  const files = await Promise.all(
    uploads.map((upload) => readFile(upload.file_path))
  );
  expect(files[0]).not.toEqual(files[1]);
});

test("failed profile publication preserves the previous image role and file", async () => {
  const { creatorsSocialService } =
    await import("@/modules/creators/creators.social.service");
  const { sql } = await import("drizzle-orm");
  const input = await sharp({
    create: { width: 40, height: 40, channels: 3, background: "green" },
  })
    .png()
    .toBuffer();
  await creatorsSocialService.uploadProfilePicture(
    imageCreatorId,
    input,
    "main.png",
    "main"
  );
  const before = (
    await creatorsSocialService.listGalleryMedia(imageCreatorId)
  ).find((media) => media.is_main_picture)!;
  const bytes = await readFile(before.file_path);
  await db.execute(
    sql`CREATE FUNCTION reject_gallery_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced insert failure'; END; $$`
  );
  await db.execute(
    sql`CREATE TRIGGER reject_gallery_insert BEFORE INSERT ON creator_gallery_media FOR EACH ROW EXECUTE FUNCTION reject_gallery_insert()`
  );
  try {
    await expect(
      creatorsSocialService.uploadProfilePicture(
        imageCreatorId,
        input,
        "replacement.png",
        "main"
      )
    ).rejects.toThrow();
  } finally {
    await db.execute(
      sql`DROP TRIGGER reject_gallery_insert ON creator_gallery_media`
    );
    await db.execute(sql`DROP FUNCTION reject_gallery_insert()`);
  }
  const after = (
    await creatorsSocialService.listGalleryMedia(imageCreatorId)
  ).find((media) => media.is_main_picture);
  expect(after?.id).toBe(before.id);
  expect(await readFile(before.file_path)).toEqual(bytes);
});

test("switching or removing portrait roles clears stale face metadata without deleting the derivative", async () => {
  const { creatorsSocialService } =
    await import("@/modules/creators/creators.social.service");
  const { creatorsTable, creatorGalleryMediaTable } =
    await import("@/database/schema");
  const { eq } = await import("drizzle-orm");
  const { writeFile } = await import("node:fs/promises");
  const gallery = await creatorsSocialService.listGalleryMedia(imageCreatorId);
  const [oldPortrait, nextPortrait] = gallery;
  const thumbnail = join(pictureDirectory, "old-face.webp");
  await writeFile(thumbnail, "existing derivative fixture");
  await db
    .update(creatorGalleryMediaTable)
    .set({ isProfilePicture: true })
    .where(eq(creatorGalleryMediaTable.id, oldPortrait.id));
  await db
    .update(creatorsTable)
    .set({ faceThumbnailPath: thumbnail })
    .where(eq(creatorsTable.id, imageCreatorId));
  await creatorsSocialService.updateGalleryMediaRoles(
    imageCreatorId,
    nextPortrait.id,
    { is_profile_picture: true }
  );
  const creator = () =>
    db.query.creatorsTable.findFirst({
      where: eq(creatorsTable.id, imageCreatorId),
    });
  expect((await creator())?.faceThumbnailPath).toBeNull();
  expect(await readFile(thumbnail, "utf8")).toBe("existing derivative fixture");

  await db
    .update(creatorsTable)
    .set({ faceThumbnailPath: thumbnail })
    .where(eq(creatorsTable.id, imageCreatorId));
  await creatorsSocialService.updateGalleryMediaRoles(
    imageCreatorId,
    nextPortrait.id,
    { is_profile_picture: false }
  );
  expect((await creator())?.faceThumbnailPath).toBeNull();
  expect(await readFile(thumbnail, "utf8")).toBe("existing derivative fixture");

  await creatorsSocialService.updateGalleryMediaRoles(
    imageCreatorId,
    nextPortrait.id,
    { is_profile_picture: true }
  );
  await db
    .update(creatorsTable)
    .set({ faceThumbnailPath: thumbnail })
    .where(eq(creatorsTable.id, imageCreatorId));
  await creatorsSocialService.deleteGalleryMedia(
    imageCreatorId,
    nextPortrait.id
  );
  expect((await creator())?.faceThumbnailPath).toBeNull();
  expect(await readFile(thumbnail, "utf8")).toBe("existing derivative fixture");
});
