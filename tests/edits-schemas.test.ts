import { describe, expect, it } from "bun:test";
import {
  createEditJobBodySchema,
  listEditJobsQuerySchema,
  normalizedCropSchema,
  timelineSegmentSchema,
} from "@/modules/edits/edits.schemas";

const validRequest = () => ({
  output: {
    directory_id: 1,
    file_name: "edited clip",
  },
  timeline: {
    segments: [{ start: 0, end: 10 }],
  },
});

describe("edit route schemas", () => {
  it("applies the truthful fixed-profile defaults", () => {
    const parsed = createEditJobBodySchema.parse(validRequest());

    expect(parsed.output).toEqual({
      directory_id: 1,
      file_name: "edited clip",
      format: "mkv",
      video_codec: "av1",
      audio_codec: "opus",
    });
    expect(parsed.timeline.segments).toEqual([{ start: 0, end: 10, speed: 1 }]);
  });

  it("accepts supported transform and global audio controls", () => {
    const request = validRequest();
    const parsed = createEditJobBodySchema.parse({
      ...request,
      output: { ...request.output, audio_codec: "aac" },
      timeline: {
        ...request.timeline,
        transform: {
          crop: { x: 0.1, y: 0.2, width: 0.6, height: 0.7 },
          rotate: 270,
        },
        audio: {
          muted: false,
          volume: 1.5,
          fade_in_seconds: 0.5,
          fade_out_seconds: 2,
        },
      },
    });

    expect(parsed.output.audio_codec).toBe("aac");
    expect(parsed.timeline.transform?.rotate).toBe(270);
    expect(parsed.timeline.audio).toEqual({
      muted: false,
      volume: 1.5,
      fade_in_seconds: 0.5,
      fade_out_seconds: 2,
    });
  });

  it("accepts optional transform and audio effects on individual segments", () => {
    const request = validRequest();
    const parsed = createEditJobBodySchema.parse({
      ...request,
      timeline: {
        segments: [
          {
            start: 2,
            end: 8,
            speed: 2,
            transform: {
              crop: { x: 0.1, y: 0.15, width: 0.75, height: 0.7 },
              rotate: 270,
            },
            audio: {
              muted: false,
              volume: 0.75,
              fade_in_seconds: 0.5,
              fade_out_seconds: 1,
            },
          },
        ],
      },
    });

    expect(parsed.timeline.segments[0]).toEqual({
      start: 2,
      end: 8,
      speed: 2,
      transform: {
        crop: { x: 0.1, y: 0.15, width: 0.75, height: 0.7 },
        rotate: 270,
      },
      audio: {
        muted: false,
        volume: 0.75,
        fade_in_seconds: 0.5,
        fade_out_seconds: 1,
      },
    });
  });

  it("validates segment fades against post-speed segment duration", () => {
    const request = validRequest();
    const valid = {
      ...request,
      timeline: {
        segments: [
          {
            start: 0,
            end: 4,
            speed: 2,
            audio: { fade_in_seconds: 2, fade_out_seconds: 2 },
          },
        ],
      },
    };
    expect(createEditJobBodySchema.safeParse(valid).success).toBe(true);

    for (const field of ["fade_in_seconds", "fade_out_seconds"] as const) {
      const parsed = createEditJobBodySchema.safeParse({
        ...request,
        timeline: {
          segments: [
            {
              start: 0,
              end: 4,
              speed: 2,
              audio: { [field]: 2.01 },
            },
          ],
        },
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]?.message).toBe(
          `Segment audio ${field} must fit within the edited segment duration`
        );
      }
    }
  });

  it("rejects empty, backwards, zero-length, and non-finite segments", () => {
    for (const segment of [
      { start: 1, end: 1 },
      { start: 10, end: 5 },
      { start: -1, end: 5 },
      { start: 0, end: Number.POSITIVE_INFINITY },
      { start: Number.NaN, end: 5 },
      { start: 0, end: 5, speed: Number.POSITIVE_INFINITY },
    ]) {
      expect(timelineSegmentSchema.safeParse(segment).success).toBe(false);
    }

    const emptyTimeline = validRequest();
    emptyTimeline.timeline.segments = [];
    expect(createEditJobBodySchema.safeParse(emptyTimeline).success).toBe(
      false
    );
  });

  it("requires normalized crops to stay inside the source frame", () => {
    expect(
      normalizedCropSchema.safeParse({
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      }).success
    ).toBe(true);

    for (const crop of [
      { x: 0.5, y: 0, width: 0.6, height: 1 },
      { x: 0, y: 0.5, width: 1, height: 0.6 },
      { x: -0.1, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: 0, height: 1 },
    ]) {
      expect(normalizedCropSchema.safeParse(crop).success).toBe(false);
    }
  });

  it("rejects unsupported rotations and audio ranges", () => {
    for (const invalidTimeline of [
      { transform: { rotate: 45 } },
      { audio: { volume: 4.01 } },
      { audio: { volume: -0.01 } },
      { audio: { fade_in_seconds: -1 } },
      { audio: { fade_out_seconds: Number.NaN } },
    ]) {
      const request = validRequest();
      expect(
        createEditJobBodySchema.safeParse({
          ...request,
          timeline: { ...request.timeline, ...invalidTimeline },
        }).success
      ).toBe(false);
    }

    for (const invalidSegmentEffect of [
      { transform: { rotate: 45 } },
      { transform: { crop: { x: 0.8, y: 0, width: 0.3, height: 1 } } },
      { audio: { volume: 4.01 } },
      { audio: { fade_in_seconds: -0.1 } },
    ]) {
      const request = validRequest();
      expect(
        createEditJobBodySchema.safeParse({
          ...request,
          timeline: {
            segments: [
              {
                start: 0,
                end: 5,
                ...invalidSegmentEffect,
              },
            ],
          },
        }).success
      ).toBe(false);
    }
  });

  it("rejects unsafe file names, unsupported codecs, and obsolete fields", () => {
    for (const fileName of [
      "../escape.mkv",
      "nested/output.mkv",
      "nested\\output.mkv",
      ".",
      "..",
      "bad\u0000name.mkv",
      "bad\nname.mkv",
    ]) {
      const request = validRequest();
      request.output.file_name = fileName;
      expect(createEditJobBodySchema.safeParse(request).success).toBe(false);
    }

    const request = validRequest();
    expect(
      createEditJobBodySchema.safeParse({
        ...request,
        output: { ...request.output, audio_codec: "copy" },
      }).success
    ).toBe(false);
    expect(
      createEditJobBodySchema.safeParse({
        ...request,
        output: { ...request.output, preserve: { resolution: true } },
      }).success
    ).toBe(false);
    expect(
      createEditJobBodySchema.safeParse({
        ...request,
        timeline: { ...request.timeline, snap_to_clips: true },
      }).success
    ).toBe(false);
  });

  it("coerces and validates edit-job recovery filters", () => {
    expect(
      listEditJobsQuerySchema.parse({
        page: "2",
        limit: "50",
        video_id: "7",
        status: "running",
      })
    ).toEqual({ page: 2, limit: 50, video_id: 7, status: "running" });
    expect(listEditJobsQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
    expect(listEditJobsQuerySchema.safeParse({ limit: 101 }).success).toBe(
      false
    );
    expect(
      listEditJobsQuerySchema.safeParse({ status: "unknown" }).success
    ).toBe(false);
  });
});
