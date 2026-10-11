import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createTestApp, seedVideoFixture, type TestApp } from "../helpers/test-app";

describe("label answers against disposable PostgreSQL", () => {
  let ctx: TestApp;
  beforeAll(async () => {
    ctx = await createTestApp();
    const { db } = await import("@/config/drizzle");
    const [existing] = await db.execute<{ present: string | null }>(sql`SELECT to_regclass('recording_label_tasks') AS present`);
    // Apply the checked-in lab migrations if the test schema push omitted them.
    if (!existing?.present) {
      const migration = await Bun.file("src/database/drizzle-migrations/0056_stage2_labels.sql").text();
      await db.execute(sql.raw(migration.split("--> statement-breakpoint")[0]!));
      await db.execute(sql.raw(await Bun.file("src/database/drizzle-migrations/0057_label_task_detail.sql").text()));
    }
  }, 60_000);
  afterAll(async () => { await ctx?.close(); });

  async function seedTask(kind: "recall-audit" | "versus", crossCreator = false) {
    const { db } = await import("@/config/drizzle");
    const { recordingLabelTasksTable } = await import("@/database/schema");
    const a = await seedVideoFixture(`label-${kind}${crossCreator ? "-cross" : ""}-a.mp4`);
    const b = kind === "versus" ? await seedVideoFixture(`label-versus${crossCreator ? "-cross" : ""}-b.mp4`) : null;
    const [task] = await db.insert(recordingLabelTasksTable).values({
      kind, batch: crossCreator ? "connected-label-save-test" : "label-save-test", videoId: a.videoId,
      startSeconds: 10, endSeconds: 40, stratum: "test",
      context: b ? {
        ...(crossCreator ? { comparison_scope: "cross_channel" } : {}),
        a: { video_id: a.videoId, ...(crossCreator ? { channel: "creator-a" } : {}) },
        b: { video_id: b.videoId, ...(crossCreator ? { channel: "creator-b" } : {}) },
      } : {},
    }).returning({ id: recordingLabelTasksTable.id });
    return task!.id;
  }

  async function stored(id: number) {
    const { db } = await import("@/config/drizzle");
    const { recordingLabelTasksTable } = await import("@/database/schema");
    const [row] = await db.select().from(recordingLabelTasksTable).where(eq(recordingLabelTasksTable.id, id));
    return row!;
  }

  it("persists audit answers, reasons and timestamp, then clears them on reopen", async () => {
    const id = await seedTask("recall-audit");
    for (const answer of ["skip", "keep"]) {
      const reasons = answer === "keep" ? ["audit_sound"] : [];
      const response = await ctx.authInject({
        method: "PUT", url: `/api/recordings/label-tasks/${id}`, payload: { answer, reasons },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({ id, answer, reasons, detail: null });
      expect(response.json().data.answered_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      const row = await stored(id);
      expect(row.answer).toBe(answer);
      expect(row.reasons).toEqual(reasons);
      expect(row.answeredAt).toBeInstanceOf(Date);
      expect(Math.abs(row.answeredAt!.getTime() - Date.now())).toBeLessThan(10_000);
    }
    const reopen = await ctx.authInject({
      method: "PUT", url: `/api/recordings/label-tasks/${id}`, payload: { answer: null },
    });
    expect(reopen.statusCode).toBe(200);
    expect(await stored(id)).toMatchObject({ answer: null, reasons: [], detail: null, answeredAt: null });
  });

  it("persists every versus choice with its cuts and returns it in the task list", async () => {
    const id = await seedTask("versus");
    for (const answer of ["a", "b", "both", "neither"]) {
      const best = {
        ...(answer === "a" || answer === "both" ? { a: { start_seconds: 10, end_seconds: 20, accepted: true } } : {}),
        ...(answer === "b" || answer === "both" ? { b: { start_seconds: 30, end_seconds: 40, accepted: false } } : {}),
      };
      const detail = answer === "neither" ? undefined : { best };
      const response = await ctx.authInject({
        method: "PUT", url: `/api/recordings/label-tasks/${id}`, payload: { answer, ...(detail ? { detail } : {}) },
      });
      expect(response.statusCode).toBe(200);
      expect(await stored(id)).toMatchObject({ answer, detail: detail ?? null });
      const list = await ctx.authInject({ method: "GET", url: "/api/recordings/label-tasks" });
      const task = list.json().data.tasks.find((entry: { id: number }) => entry.id === id);
      expect(task).toMatchObject({ answer, detail: detail ?? null });
      expect(task.answered_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    }
    const reopen = await ctx.authInject({
      method: "PUT", url: `/api/recordings/label-tasks/${id}`, payload: { answer: null },
    });
    expect(reopen.statusCode).toBe(200);
    expect(await stored(id)).toMatchObject({ answer: null, reasons: [], detail: null, answeredAt: null });
  });
  it("persists isolated version choices and viewing context without generating cuts or changing other answers", async () => {
    const { db } = await import("@/config/drizzle");
    const { recordingLabelTasksTable } = await import("@/database/schema");
    const video = await seedVideoFixture("neutral-version-pilot.mp4");
    const side = (best: number[]) => ({ video_id: video.videoId, clip: [0, 1800], best,
      previews: [0.1, 0.5, 0.9].map((fraction) => { const middle = best[0]! + fraction * (best[1]! - best[0]!); return [middle - 7.5, middle + 7.5]; }),
    });
    const [task] = await db.insert(recordingLabelTasksTable).values({ kind: "version-versus", batch: "neutral-version-test",
      videoId: video.videoId, startSeconds: 0, endSeconds: 1800, stratum: "test",
      context: { blind_version_comparison: true, target_semantics: "preferred_version_if_keep_one", a: side([0, 1800]), b: side([300, 900]) },
    }).returning({ id: recordingLabelTasksTable.id });
    const id = task!.id;
    const detail = { viewing: { a: { preview_started: [0, 1, 2], preview_completed: [0, 1, 2], full_opened: false, full_completed: false },
      b: { preview_started: [0], preview_completed: [], full_opened: true, full_completed: false } } };
    for (const answer of ["a", "b", "both", "neither"]) {
      const response = await ctx.authInject({ method: "PUT", url: `/api/recordings/label-tasks/${id}`, payload: { answer, detail } });
      expect(response.statusCode).toBe(200);
      expect(await stored(id)).toMatchObject({ answer, detail });
      expect(response.json().data.detail.best).toBeUndefined();
    }
    const invalid = await ctx.authInject({ method: "PUT", url: `/api/recordings/label-tasks/${id}`, payload: { answer: "a", detail: { best: {} } } });
    expect(invalid.statusCode).toBe(400);
    expect((await stored(id)).answer).toBe("neither");
    const list = await ctx.authInject({ method: "GET", url: "/api/recordings/label-tasks" });
    expect(list.json().data.tasks.find((row: { id: number }) => row.id === id).kind).toBe("version-versus");
    const reopen = await ctx.authInject({ method: "PUT", url: `/api/recordings/label-tasks/${id}`, payload: { answer: null } });
    expect(reopen.statusCode).toBe(200);
    expect(await stored(id)).toMatchObject({ answer: null, detail: null, answeredAt: null });
  });
  it("saves cross-creator answers while repeated anchors retain distinct pair identities", async () => {
    const id = await seedTask("versus", true);
    const original = await stored(id);
    const { db } = await import("@/config/drizzle");
    const { recordingLabelTasksTable } = await import("@/database/schema");
    const [second] = await db.insert(recordingLabelTasksTable).values({
      kind: "versus", batch: original.batch, videoId: original.videoId,
      startSeconds: original.startSeconds, endSeconds: original.endSeconds,
      position: 1, stratum: "test", context: original.context,
    }).returning({ id: recordingLabelTasksTable.id });
    const detail = { best: { a: { start_seconds: 10, end_seconds: 20, accepted: false } } };
    const answer = await ctx.authInject({
      method: "PUT", url: `/api/recordings/label-tasks/${id}`, payload: { answer: "a", detail },
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.json().data).toMatchObject({ channel: null, answer: "a", detail,
      context: { comparison_scope: "cross_channel", a: { channel: "creator-a" }, b: { channel: "creator-b" } },
    });
    expect(await stored(second!.id)).toMatchObject({ answer: null, detail: null, answeredAt: null });
    const list = await ctx.authInject({ method: "GET", url: "/api/recordings/label-tasks" });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.tasks.filter((task: { batch: string }) => task.batch === original.batch)).toHaveLength(2);
  });
  it("persists every whole-recording choice independently, rejects clip details, and reopens without feedback changes", async () => {
    const { db } = await import("@/config/drizzle");
    const { recordingLabelTasksTable, recordingClipFeedbackTable } = await import("@/database/schema");
    const [feedbackTable] = await db.execute<{ present: string | null }>(sql`SELECT to_regclass('recording_clip_feedback') AS present`);
    if (!feedbackTable?.present) {
      for (const file of ["0053_recording_clip_feedback.sql", "0055_recording_feedback_generations.sql", "0056_stage2_labels.sql"]) {
        const statements = (await Bun.file(`src/database/drizzle-migrations/${file}`).text()).split("--> statement-breakpoint");
        for (const statement of statements) if (file === "0053_recording_clip_feedback.sql" || statement.trim().startsWith('ALTER TABLE "recording_clip_feedback"')) await db.execute(sql.raw(statement));
      }
    }
    const video = await seedVideoFixture("whole-recording-fixture.mp4");
    const [feedback] = await db.insert(recordingClipFeedbackTable).values({ videoId: video.videoId, analyzedAt: new Date("2026-10-10T00:00:00Z"), clipId: "whole-sentinel", detector: "fixture", verdict: "keep", reasons: ["existing"], startSeconds: 20, endSeconds: 40, peakSeconds: 30, score: .5, label: "existing" }).returning();
    const context = { target: "current_whole_recording_review", reserved_fine_holdout: false, fine_data_role: "training", candidate: {
      video_id: video.videoId, analyzed_at: "2026-10-10T00:00:00Z", duration_seconds: 300, channel: "creator", channel_key: "creator",
      index: { model_revision: "siglip2/so400m-patch16-256", frame_count: 60, interval_seconds: 5, storyboard_generated_at: "2026-10-10T00:00:00Z", indexed_at: "2026-10-10T00:00:00Z" },
      source_fingerprint: { size_bytes: 1, mtime_ns: "10", path_identity_sha256: "a".repeat(64) },
    }, original_range: [0, 300] };
    const [task] = await db.insert(recordingLabelTasksTable).values({ kind: "whole-verdict", batch: "whole-verdict-test", videoId: video.videoId, startSeconds: 0, endSeconds: 300, stratum: "test", channel: "creator", context }).returning({ id: recordingLabelTasksTable.id });
    for (const answer of ["keep_entire", "edited_parts_only", "nothing_worth_keeping", "unsure"]) {
      const response = await ctx.authInject({ method: "PUT", url: `/api/recordings/label-tasks/${task!.id}`, payload: { answer } });
      expect(response.statusCode).toBe(200);
      expect(await stored(task!.id)).toMatchObject({ answer, detail: null, reasons: [] });
      expect(response.json().data.answered_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    }
    for (const payload of [{ answer: "a" }, { answer: "keep" }, { answer: "keep_entire", detail: { best: {} } }, { answer: "keep_entire", reasons: ["keep_whole"] }, { answer: null, detail: {} }, { answer: null, reasons: ["keep_whole"] }]) {
      expect((await ctx.authInject({ method: "PUT", url: `/api/recordings/label-tasks/${task!.id}`, payload })).statusCode).toBe(400);
      expect((await stored(task!.id)).answer).toBe("unsure");
    }
    const reopen = await ctx.authInject({ method: "PUT", url: `/api/recordings/label-tasks/${task!.id}`, payload: { answer: null } });
    expect(reopen.statusCode).toBe(200);
    expect(await stored(task!.id)).toMatchObject({ answer: null, reasons: [], detail: null, answeredAt: null });
    expect((await db.select().from(recordingClipFeedbackTable).where(eq(recordingClipFeedbackTable.id, feedback!.id)))[0]).toEqual(feedback);
  });

});
