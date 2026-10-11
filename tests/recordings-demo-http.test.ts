import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { LabelTask } from "@/modules/recordings/recordings.label-tasks";
import { useSeededDemoDatabase } from "./helpers/demo-database";

process.env.NODE_ENV = "test";
process.env.DEMO_MODE = "true";
process.env.POSTHOG_API_KEY = "";

describe("demo recording labels and highlight reviews", () => {
  useSeededDemoDatabase();
  let app: Awaited<ReturnType<typeof import("@/server").buildServer>>;
  beforeAll(async () => {
    const { env } = await import("@/config/env");
    env.DEMO_MODE = true;
    env.DEMO_RESET_MODE = "manual";
    app = await (await import("@/server")).buildServer();
    await app.ready();
  });
  afterAll(async () => { await app?.close(); });

  async function list(): Promise<LabelTask[]> {
    const response = await app.inject({ method: "GET", url: "/api/recordings/label-tasks" });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().data.tasks;
  }
  const answer = (id: number, payload: Record<string, unknown>) => app.inject({ method: "PUT", url: `/api/recordings/label-tasks/${id}`, payload });

  it("provides playable demo references for all active kinds, with open and answered examples", async () => {
    const tasks = await list();
    expect(tasks).toHaveLength(16);
    expect(new Set(tasks.map(task => task.id)).size).toBe(tasks.length);
    expect(tasks.some(task => task.kind === "versus" && task.context.comparison_scope === "cross_channel")).toBe(true);
    for (const kind of ["recall-audit", "versus", "version-versus", "whole-verdict"]) {
      const group = tasks.filter(task => task.kind === kind);
      expect(group.some(task => task.answer === null)).toBe(true);
      expect(group.some(task => task.answer !== null)).toBe(true);
      for (const task of group) {
        expect(task.start_seconds).toBeGreaterThanOrEqual(0);
        expect(task.end_seconds).toBeLessThanOrEqual(task.duration_seconds!);
        const video = await app.inject({ method: "GET", url: `/api/videos/${task.video_id}` });
        expect(video.statusCode, video.body).toBe(200);
      }
    }
    const { validateVersionPreference } = await import("@/modules/recordings/recordings.version-versus");
    for (const task of tasks.filter(task => task.kind === "version-versus")) validateVersionPreference(task.context, null);
    const { isProductionDatabaseClientInitialized } = await import("@/config/drizzle");
    expect(isProductionDatabaseClientInitialized()).toBe(false);
  });

  it("answers each kind, keeps IDs stable on refresh, and clears answers when reopened", async () => {
    const tasks = await list();
    for (const [kind, choice] of [["recall-audit", "keep"], ["versus", "a"], ["version-versus", "both"], ["whole-verdict", "keep_entire"]]) {
      const task = tasks.find(task => task.kind === kind && task.answer === null)!;
      const reasons = kind === "recall-audit" ? ["sound"] : [];
      const detail = kind === "versus" ? { best: { a: { start_seconds: 60, end_seconds: 240, accepted: true } } } : undefined;
      const saved = await answer(task.id, { answer: choice, reasons, ...(detail ? { detail } : {}) });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().data).toMatchObject({ id: task.id, answer: choice, reasons, detail: detail ?? null, answered_at: expect.any(String) });
      expect((await list()).find(row => row.id === task.id)?.answer).toBe(choice);
      const reopened = await answer(task.id, { answer: null });
      expect(reopened.statusCode, reopened.body).toBe(200);
      expect(reopened.json().data).toMatchObject({ id: task.id, answer: null, reasons: [], detail: null, answered_at: null });
    }
    expect((await list()).map(task => task.id)).toEqual(tasks.map(task => task.id));
  });

  it("retains answer validation and missing-task errors in demo mode", async () => {
    const tasks = await list();
    expect((await answer(tasks[0]!.id, { answer: "invalid" })).statusCode).toBe(400);
    expect((await answer(999_999_999, { answer: "keep" })).statusCode).toBe(404);
    const version = tasks.find(task => task.kind === "version-versus")!;
    expect((await answer(version.id, { answer: "a", detail: { best: { a: { start_seconds: 1, end_seconds: 2, accepted: true } } } })).statusCode).toBe(400);
    const whole = tasks.find(task => task.kind === "whole-verdict")!;
    expect((await answer(whole.id, { answer: "keep_entire", reasons: ["sound"] })).statusCode).toBe(400);
  });

  it("finds highlights without a visual index or GPU and produces a new generation on Find again", async () => {
    const id = (await list())[0]!.video_id;
    const find = () => app.inject({ method: "POST", url: `/api/recordings/${id}/analyze` });
    const first = await find();
    expect(first.statusCode, first.body).toBe(200);
    const review = first.json().data;
    expect(review.status).toBe("proposed");
    expect(review.clips).toHaveLength(3);
    expect(review.curve.length).toBeGreaterThan(0);
    expect(review.clips.some((clip: { keep: boolean }) => clip.keep)).toBe(true);
    expect(review.clips.some((clip: { keep: boolean }) => !clip.keep)).toBe(true);
    for (const clip of review.clips) {
      expect(clip.end_seconds).toBeGreaterThan(clip.start_seconds);
      expect(clip.end_seconds).toBeLessThanOrEqual(review.video.duration_seconds);
    }
    const second = await find();
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().data.analyzed_at).not.toBe(review.analyzed_at);
    const loaded = await app.inject({ method: "GET", url: `/api/recordings/${id}` });
    expect(loaded.json().data.clips).toEqual(second.json().data.clips);
    expect((await import("@/config/drizzle")).isProductionDatabaseClientInitialized()).toBe(false);
  });

  it("bounds fixtures for short media and does not expose mutable stored objects", async () => {
    const { demoHighlightAnalysis, demoLabelTasks } = await import("@/modules/recordings/recordings.demo-fixtures");
    for (const duration of [10, 60, 95]) {
      const analysis = demoHighlightAnalysis(duration);
      expect(analysis.clips).toHaveLength(3);
      for (const clip of analysis.clips) expect(clip.end_seconds).toBeLessThanOrEqual(duration);
    }
    const task = demoLabelTasks()[0]!;
    task.context.private_mutation = true;
    expect(demoLabelTasks()[0]!.context.private_mutation).toBeUndefined();
  });

  it("keeps label and review screens populated with the incoming short cloud-demo media", async () => {
    const demo = await import("@/database/demo");
    const { validateVersionPreference } = await import("@/modules/recordings/recordings.version-versus");
    for (const duration of [5, 6]) {
      demo.getDemoSqlite().run("UPDATE demo_videos SET duration_seconds = ?", [duration]);
      const tasks = await list();
      expect(tasks).toHaveLength(16);
      for (const task of tasks) {
        expect(task.end_seconds).toBeGreaterThan(task.start_seconds);
        expect(task.end_seconds).toBeLessThanOrEqual(duration);
        if (task.kind === "version-versus") validateVersionPreference(task.context, null);
      }
    }
    const overview = await app.inject({ method: "GET", url: "/api/recordings/" });
    expect(overview.statusCode, overview.body).toBe(200);
    expect(overview.json().data.recordings.length).toBeGreaterThan(0);
    const id = overview.json().data.recordings[0].video.id;
    const find = await app.inject({ method: "POST", url: `/api/recordings/${id}/analyze` });
    expect(find.statusCode, find.body).toBe(200);
    expect(find.json().data.clips).toHaveLength(3);
    expect((await import("@/config/drizzle")).isProductionDatabaseClientInitialized()).toBe(false);
  });
});
