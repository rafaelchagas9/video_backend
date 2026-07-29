import { describe, expect, it } from "bun:test";
import {
  createVideoEventContext,
} from "@/modules/events/events.types";
import { DEFAULT_SETTINGS } from "@/modules/settings/settings.service";

describe("in-app notification contract", () => {
  it("enriches video events with a recognizable title and compatible id fields", () => {
    expect(
      createVideoEventContext({
        id: 43,
        title: "  Demo Film  ",
        file_name: "demo-film.mp4",
      }),
    ).toEqual({
      videoId: 43,
      video_id: 43,
      videoTitle: "Demo Film",
      video_title: "Demo Film",
      fileName: "demo-film.mp4",
      file_name: "demo-film.mp4",
    });
  });

  it("falls back to the filename when a video has no curated title", () => {
    expect(
      createVideoEventContext({
        id: 7,
        title: null,
        file_name: "archive-clip.webm",
      }).videoTitle,
    ).toBe("archive-clip.webm");
  });

  it("keeps noisy start alerts off while enabling meaningful milestones by default", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      notifications_in_app_enabled: true,
      notifications_task_started: false,
      notifications_conversion_completed: true,
      notifications_conversion_failed: true,
      notifications_storyboard_ready: true,
      notifications_storyboard_failed: true,
      notifications_face_extraction_completed: true,
      notifications_face_extraction_failed: true,
    });
  });
});
