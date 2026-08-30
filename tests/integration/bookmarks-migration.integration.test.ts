import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  applyTestDatabaseEnv,
  startTestDatabase,
} from "../helpers/test-database";

type TestDatabase = Awaited<ReturnType<typeof startTestDatabase>>;
type BookmarkCategoriesService =
  typeof import("@/modules/bookmarks/bookmark-categories.service").bookmarkCategoriesService;

const migrationsSource = resolve(
  process.cwd(),
  "src/database/drizzle-migrations"
);

describe("bookmark migration 0038 on its pre-migration contract", () => {
  let bookmarkCategoriesService: BookmarkCategoriesService;
  let closeDrizzleDatabase: () => Promise<void>;
  let database: TestDatabase;
  let legacyBookmarkId: number;
  let migrationsDirectory: string;
  let ownerId: number;
  let otherUserId: number;
  let sql: ReturnType<typeof postgres>;

  async function expectConstraintViolation(
    run: (isolatedSql: ReturnType<typeof postgres>) => Promise<unknown>
  ): Promise<void> {
    const isolatedSql = postgres(database.connectionString, { max: 1 });
    let caught: unknown;
    try {
      await run(isolatedSql);
    } catch (error) {
      caught = error;
    } finally {
      await isolatedSql.end({ timeout: 5 });
    }
    expect(caught).toBeDefined();
  }

  async function stageBookmarkMigration(): Promise<void> {
    await mkdir(join(migrationsDirectory, "meta"), { recursive: true });
    const journal = JSON.parse(
      await readFile(join(migrationsSource, "meta/_journal.json"), "utf8")
    ) as {
      version: string;
      dialect: string;
      entries: Array<{ idx: number; tag: string }>;
    };
    const entry = journal.entries.find(({ idx }) => idx === 38);
    if (!entry) throw new Error("Migration 0038 is missing from the journal");
    await writeFile(
      join(migrationsDirectory, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: [entry] }, null, 2)
    );
    await copyFile(
      join(migrationsSource, `${entry.tag}.sql`),
      join(migrationsDirectory, `${entry.tag}.sql`)
    );
  }

  beforeAll(async () => {
    database = await startTestDatabase();
    applyTestDatabaseEnv(database);
    migrationsDirectory = await mkdtemp(
      join(tmpdir(), "conversor-video-bookmark-migration-")
    );
    sql = postgres(database.connectionString, { max: 4 });

    await sql`
      CREATE TABLE users (
        id serial PRIMARY KEY,
        name text NOT NULL,
        email text NOT NULL UNIQUE
      )
    `;
    await sql`
      CREATE TABLE bookmarks (
        id serial PRIMARY KEY,
        video_id integer NOT NULL,
        user_id integer NOT NULL REFERENCES users(id) ON DELETE cascade,
        timestamp_seconds real NOT NULL,
        name text NOT NULL,
        description text,
        created_at timestamp DEFAULT now() NOT NULL,
        updated_at timestamp DEFAULT now() NOT NULL
      )
    `;
    const [owner] = await sql<{ id: number }[]>`
      INSERT INTO users (name, email)
      VALUES ('Bookmark owner', 'bookmark-owner@example.test')
      RETURNING id
    `;
    const [otherUser] = await sql<{ id: number }[]>`
      INSERT INTO users (name, email)
      VALUES ('Other user', 'other-user@example.test')
      RETURNING id
    `;
    ownerId = owner!.id;
    otherUserId = otherUser!.id;
    const [bookmark] = await sql<{ id: number }[]>`
      INSERT INTO bookmarks (
        video_id, user_id, timestamp_seconds, name, description
      )
      VALUES (1, ${ownerId}, 12, 'Legacy bookmark', NULL)
      RETURNING id
    `;
    legacyBookmarkId = bookmark!.id;

    await stageBookmarkMigration();
    await migrate(drizzle(sql), { migrationsFolder: migrationsDirectory });

    ({ bookmarkCategoriesService } =
      await import("@/modules/bookmarks/bookmark-categories.service"));
    ({ closeDrizzleDatabase } = await import("@/config/drizzle"));
  }, 120_000);

  afterAll(async () => {
    await closeDrizzleDatabase?.();
    await sql?.end({ timeout: 5 });
    if (migrationsDirectory) {
      await rm(migrationsDirectory, { recursive: true, force: true });
    }
    await database?.stop();
  }, 30_000);

  it("backfills legacy bookmarks and seeds the exact system taxonomy", async () => {
    const [legacy] = await sql<
      Array<{
        origin: string;
        end_timestamp_seconds: number | null;
        peak_timestamp_seconds: number | null;
        analysis_run_id: number | null;
        user_modified_at: Date | null;
      }>
    >`
      SELECT
        origin,
        end_timestamp_seconds,
        peak_timestamp_seconds,
        analysis_run_id,
        user_modified_at
      FROM bookmarks
      WHERE id = ${legacyBookmarkId}
    `;
    expect(legacy).toEqual({
      origin: "manual",
      end_timestamp_seconds: null,
      peak_timestamp_seconds: null,
      analysis_run_id: null,
      user_modified_at: null,
    });

    const categories = await sql<Array<{ key: string }>>`
      SELECT key
      FROM bookmark_categories
      WHERE kind = 'system' AND user_id IS NULL
      ORDER BY key
    `;
    expect(categories.map(({ key }) => key)).toEqual([
      "ANUS_COVERED",
      "ANUS_EXPOSED",
      "ARMPITS_EXPOSED",
      "BELLY_EXPOSED",
      "BUTTOCKS_EXPOSED",
      "FEET_EXPOSED",
      "FEMALE_BREAST_EXPOSED",
      "FEMALE_GENITALIA_COVERED",
      "FEMALE_GENITALIA_EXPOSED",
      "MALE_BREAST_EXPOSED",
      "MALE_GENITALIA_EXPOSED",
    ]);
  });

  it("enforces provenance, interval, timestamp, ownership, and reserved keys", async () => {
    await expectConstraintViolation(
      (isolatedSql) => isolatedSql`
        INSERT INTO bookmark_categories (key, name, kind, user_id)
        VALUES ('BUTTOCKS_EXPOSED', 'Collision', 'custom', ${ownerId})
      `
    );
    await expectConstraintViolation(
      (isolatedSql) => isolatedSql`
        INSERT INTO bookmarks (
          video_id, user_id, timestamp_seconds, origin, analysis_run_id, name
        )
        VALUES (1, ${ownerId}, 10, 'automatic', NULL, 'Invalid provenance')
      `
    );
    await expectConstraintViolation(
      (isolatedSql) => isolatedSql`
        INSERT INTO bookmarks (
          video_id, user_id, timestamp_seconds,
          peak_timestamp_seconds, end_timestamp_seconds, name
        )
        VALUES (1, ${ownerId}, 20, 10, 30, 'Invalid interval')
      `
    );
    await expectConstraintViolation(
      (isolatedSql) => isolatedSql`
        INSERT INTO bookmarks (video_id, user_id, timestamp_seconds, name)
        VALUES (1, ${ownerId}, -1, 'Invalid timestamp')
      `
    );
    await expectConstraintViolation(
      (isolatedSql) => isolatedSql`
        INSERT INTO bookmark_categories (key, name, kind, user_id)
        VALUES ('invalid-owner', 'Invalid owner', 'custom', NULL)
      `
    );
  });

  it("keeps category ownership and assignment checks in the PostgreSQL service", async () => {
    const owned = await bookmarkCategoriesService.create(ownerId, {
      key: "owner-category",
      name: "Owner category",
    });
    const foreign = await bookmarkCategoriesService.create(otherUserId, {
      key: "foreign-category",
      name: "Foreign category",
    });

    await expect(
      bookmarkCategoriesService.assertAssignable(ownerId, [foreign.id])
    ).rejects.toThrow("unavailable");
    await expect(
      bookmarkCategoriesService.update(owned.id, otherUserId, {
        name: "Stolen",
      })
    ).rejects.toThrow("permission");
  });

  it("filters many-to-many assignments and marks automatic bookmarks before category deletion", async () => {
    const category = await bookmarkCategoriesService.create(ownerId, {
      key: "review-category",
      name: "Review category",
    });
    const [automatic] = await sql<{ id: number }[]>`
      INSERT INTO bookmarks (
        video_id, user_id, timestamp_seconds, peak_timestamp_seconds,
        end_timestamp_seconds, origin, analysis_run_id, name
      )
      VALUES (1, ${ownerId}, 40, 45, 50, 'automatic', 99, 'Automatic')
      RETURNING id
    `;
    await sql`
      INSERT INTO bookmark_category_assignments (bookmark_id, category_id)
      VALUES (${automatic!.id}, ${category.id})
    `;

    const filtered = await sql<Array<{ id: number }>>`
      SELECT bookmark.id
      FROM bookmarks bookmark
      WHERE bookmark.user_id = ${ownerId}
        AND bookmark.origin = 'automatic'
        AND EXISTS (
          SELECT 1
          FROM bookmark_category_assignments assignment
          INNER JOIN bookmark_categories category
            ON category.id = assignment.category_id
          WHERE assignment.bookmark_id = bookmark.id
            AND category.key = 'review-category'
        )
    `;
    expect(filtered.map(({ id }) => id)).toEqual([automatic!.id]);

    await bookmarkCategoriesService.delete(category.id, ownerId);

    const [edited] = await sql<
      Array<{ user_modified_at: string | null; assignments: number }>
    >`
      SELECT
        bookmark.user_modified_at,
        count(assignment.bookmark_id)::int AS assignments
      FROM bookmarks bookmark
      LEFT JOIN bookmark_category_assignments assignment
        ON assignment.bookmark_id = bookmark.id
      WHERE bookmark.id = ${automatic!.id}
      GROUP BY bookmark.id
    `;
    expect(edited!.user_modified_at).not.toBeNull();
    expect(Number.isNaN(Date.parse(edited!.user_modified_at!))).toBe(false);
    expect(edited!.assignments).toBe(0);
  });
});
