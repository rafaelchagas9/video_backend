import { describe, expect, it } from "bun:test";
import {
  buildAtempoChain,
  buildEditFfmpegArgs,
  buildEditFilterComplex,
} from "@/modules/edits/edits.processor";
import {
  calculateExpectedDuration,
  canonicalizeOutputFileName,
  validateEditRequest,
} from "@/modules/edits/edits.service";
import type {
  CreateEditJobInput,
  EditTimelineConfig,
} from "@/modules/edits/edits.types";

const timeline: EditTimelineConfig = {
  segments: [
    { start: 0, end: 10, speed: 2 },
    { start: 20, end: 25, speed: 0.5 },
  ],
  transform: {
    crop: { x: 0.1, y: 0.2, width: 0.8, height: 0.6 },
    rotate: 90,
  },
  audio: {
    volume: 1.5,
    fade_in_seconds: 1,
    fade_out_seconds: 2,
  },
};

const request = (overrides: Partial<CreateEditJobInput> = {}) => ({
  output: {
    directory_id: 1,
    file_name: "edited.mkv",
    format: "mkv" as const,
    video_codec: "av1" as const,
    audio_codec: "opus" as const,
  },
  timeline,
  ...overrides,
});

describe("edit processor helpers", () => {
  it("chains atempo filters across FFmpeg's supported range", () => {
    expect(buildAtempoChain(1)).toEqual([]);
    expect(buildAtempoChain(0.1)).toEqual([
      "atempo=0.5",
      "atempo=0.5",
      "atempo=0.5",
      "atempo=0.8",
    ]);
    expect(buildAtempoChain(10)).toEqual([
      "atempo=2",
      "atempo=2",
      "atempo=2",
      "atempo=1.25",
    ]);
  });

  it("calculates the edited duration after segment speed", () => {
    expect(calculateExpectedDuration(timeline)).toBe(15);
  });

  it("builds trim, reorder, speed, crop, rotation, gain, and fade filters", () => {
    const graph = buildEditFilterComplex(timeline, true);

    expect(graph.videoOutputLabel).toBe("[vout]");
    expect(graph.audioOutputLabel).toBe("[aout]");
    expect(graph.filterComplex).toContain(
      "[0:v]trim=duration=10,setpts=(PTS-STARTPTS)/2[v0]"
    );
    expect(graph.filterComplex).toContain(
      "[1:v]trim=duration=5,setpts=(PTS-STARTPTS)/0.5[v1]"
    );
    expect(graph.filterComplex).toContain("atempo=2[a0]");
    expect(graph.filterComplex).toContain("atempo=0.5[a1]");
    expect(graph.filterComplex).toContain("concat=n=2:v=1:a=1");
    expect(graph.filterComplex).toContain(
      "crop=w=max(2\\,trunc(iw*0.8/2)*2):h=max(2\\,trunc(ih*0.6/2)*2):x=min(trunc(iw*0.1/2)*2\\,iw-ow):y=min(trunc(ih*0.2/2)*2\\,ih-oh)"
    );
    expect(graph.filterComplex).toContain("transpose=clock");
    expect(graph.filterComplex).toContain("volume=1.5");
    expect(graph.filterComplex).toContain("afade=t=in:st=0:d=1");
    expect(graph.filterComplex).toContain("afade=t=out:st=13:d=2");
  });

  it("normalizes mixed segment transforms before concat and composes audio effects", () => {
    const segmentEffectsTimeline: EditTimelineConfig = {
      segments: [
        {
          start: 0,
          end: 10,
          speed: 2,
          transform: {
            crop: { x: 0.1, y: 0, width: 0.5, height: 1 },
            rotate: 90,
          },
          audio: {
            volume: 0.5,
            fade_in_seconds: 0.5,
            fade_out_seconds: 1,
          },
        },
        {
          start: 20,
          end: 24,
          speed: 1,
          audio: { muted: true },
        },
      ],
      transform: { rotate: 180 },
      audio: { volume: 1.25, fade_out_seconds: 2 },
    };
    const graph = buildEditFilterComplex(segmentEffectsTimeline, true, {
      sourceWidth: 1921,
      sourceHeight: 1081,
    });

    expect(graph.filterComplex).toContain(
      "[v0]hwdownload,format=nv12,crop=w=max(2\\,trunc(iw*0.5/2)*2):h=max(2\\,trunc(ih*1/2)*2):x=min(trunc(iw*0.1/2)*2\\,iw-ow):y=min(trunc(ih*0/2)*2\\,ih-oh),transpose=clock,scale=w=1920:h=1080:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=w=1920:h=1080:x=(ow-iw)/2:y=(oh-ih)/2:color=black,setsar=1,settb=AVTB,format=yuv420p[vsegment0]"
    );
    expect(graph.filterComplex).toContain(
      "[v1]hwdownload,format=nv12,scale=w=1920:h=1080:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=w=1920:h=1080:x=(ow-iw)/2:y=(oh-ih)/2:color=black,setsar=1,settb=AVTB,format=yuv420p[vsegment1]"
    );
    expect(graph.filterComplex).toContain(
      "[a0]volume=0.5,afade=t=in:st=0:d=0.5,afade=t=out:st=4:d=1[asegment0]"
    );
    expect(graph.filterComplex).toContain("[a1]volume=0[asegment1]");
    expect(graph.filterComplex).toContain(
      "[vsegment0][asegment0][vsegment1][asegment1]concat=n=2:v=1:a=1[vconcat][aconcat]"
    );
    expect(graph.filterComplex).toContain(
      "[vconcat]hflip,vflip,format=nv12,hwupload[vout]"
    );
    expect(graph.filterComplex).toContain(
      "[aconcat]volume=1.25,afade=t=out:st=7:d=2[aout]"
    );

    expect(graph.filterComplex.indexOf("[v0]crop=")).toBeLessThan(
      graph.filterComplex.indexOf("[vsegment0][asegment0]")
    );
    expect(graph.filterComplex.indexOf("[a0]volume=0.5")).toBeLessThan(
      graph.filterComplex.indexOf("[aconcat]volume=1.25")
    );
  });

  it("keeps segment video effects but omits all audio for silent input", () => {
    const graph = buildEditFilterComplex(
      {
        segments: [
          {
            start: 0,
            end: 3,
            transform: { rotate: 270 },
            audio: {
              muted: true,
              volume: 2,
              fade_in_seconds: 1,
            },
          },
          { start: 5, end: 8, audio: { volume: 0.5 } },
        ],
        audio: { volume: 1.5 },
      },
      false,
      { sourceWidth: 1280, sourceHeight: 720 }
    );

    expect(graph.audioOutputLabel).toBeNull();
    expect(graph.filterComplex).not.toContain("[0:a]");
    expect(graph.filterComplex).not.toContain("[asegment");
    expect(graph.filterComplex).toContain("transpose=cclock");
    expect(graph.filterComplex).toContain(
      "[vsegment0][vsegment1]concat=n=2:v=1:a=0[vconcat]"
    );
  });

  it("builds video-only graphs for silent and muted sources", () => {
    const silent = buildEditFilterComplex(timeline, false);
    expect(silent.audioOutputLabel).toBeNull();
    expect(silent.filterComplex).not.toContain("[0:a]");
    expect(silent.filterComplex).toContain("concat=n=2:v=1:a=0");

    const muted = buildEditFilterComplex(
      { ...timeline, audio: { ...timeline.audio, muted: true } },
      true
    );
    expect(muted.audioOutputLabel).toBeNull();
    expect(muted.filterComplex).not.toContain("[0:a]");
  });

  it("maps the advertised Opus and AAC profiles into FFmpeg arguments", () => {
    const common = {
      inputPath: "/input/source.mkv",
      outputPath: "/output/edited.mkv",
      timeline,
      hasSourceAudio: true,
      vaapiDevice: "/dev/dri/renderD128",
      bitrate: "4M",
      maxrate: "5M",
      bufsize: "10M",
    };
    const opus = buildEditFfmpegArgs({
      ...common,
      output: request().output,
    });
    expect(opus).toContain("av1_vaapi");
    expect(opus).toContain("libopus");
    expect(opus).toContain("matroska");
    const fpsModeIndex = opus.indexOf("-fps_mode:v");
    expect(opus.slice(fpsModeIndex, fpsModeIndex + 4)).toEqual([
      "-fps_mode:v",
      "passthrough",
      "-enc_time_base:v",
      "filter",
    ]);
    expect(opus.at(-1)).toBe("/output/edited.mkv");

    const aac = buildEditFfmpegArgs({
      ...common,
      output: { ...request().output, audio_codec: "aac" },
    });
    expect(aac).toContain("aac");
    expect(aac).not.toContain("libopus");

    const silent = buildEditFfmpegArgs({
      ...common,
      output: request().output,
      hasSourceAudio: false,
    });
    expect(silent).not.toContain("-c:a");
  });

  it("seeks a job-4996-shaped late segment before opening the input", () => {
    const lateTimeline: EditTimelineConfig = {
      segments: [{ start: 10903.296536, end: 11265.161984 }],
    };
    const args = buildEditFfmpegArgs({
      inputPath: "/input/video-4996.mkv",
      outputPath: "/output/clip.mkv",
      timeline: lateTimeline,
      output: request().output,
      hasSourceAudio: true,
      vaapiDevice: "/dev/dri/renderD128",
      bitrate: "4M",
      maxrate: "5M",
      bufsize: "10M",
    });
    const seekIndex = args.indexOf("-ss");
    const inputIndex = args.indexOf("-i");
    const filterIndex = args.indexOf("-filter_complex");

    expect(seekIndex).toBeGreaterThan(-1);
    expect(seekIndex).toBeLessThan(inputIndex);
    expect(args.slice(seekIndex, inputIndex + 2)).toEqual([
      "-ss",
      "10903.296536",
      "-t",
      "361.865448",
      "-i",
      "/input/video-4996.mkv",
    ]);
    expect(args[filterIndex + 1]).toContain(
      "[0:v]trim=duration=361.865448,setpts=PTS-STARTPTS[v0]"
    );
    expect(args[filterIndex + 1]).not.toContain("10903.296536");
  });

  it("independently seeks and labels reordered distant segments", () => {
    const reorderedTimeline: EditTimelineConfig = {
      segments: [
        { start: 10800, end: 10807 },
        { start: 12, end: 15, speed: 2 },
      ],
    };
    const inputPath = "/input/source.mkv";
    const args = buildEditFfmpegArgs({
      inputPath,
      outputPath: "/output/reordered.mkv",
      timeline: reorderedTimeline,
      output: request().output,
      hasSourceAudio: true,
      vaapiDevice: "/dev/dri/renderD128",
      bitrate: "4M",
      maxrate: "5M",
      bufsize: "10M",
    });
    const inputIndices = args.flatMap((argument, index) =>
      argument === "-i" ? [index] : []
    );

    expect(inputIndices).toHaveLength(2);
    expect(args.slice(inputIndices[0] - 10, inputIndices[0] + 2)).toEqual([
      "-hwaccel",
      "vaapi",
      "-hwaccel_device",
      "va",
      "-hwaccel_output_format",
      "vaapi",
      "-ss",
      "10800",
      "-t",
      "7",
      "-i",
      inputPath,
    ]);
    expect(args.slice(inputIndices[1] - 10, inputIndices[1] + 2)).toEqual([
      "-hwaccel",
      "vaapi",
      "-hwaccel_device",
      "va",
      "-hwaccel_output_format",
      "vaapi",
      "-ss",
      "12",
      "-t",
      "3",
      "-i",
      inputPath,
    ]);

    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("[0:v]trim=duration=7,setpts=PTS-STARTPTS[v0]");
    expect(graph).toContain("[1:v]trim=duration=3,setpts=(PTS-STARTPTS)/2[v1]");
    expect(graph).toContain(
      "[v0][a0][v1][a1]concat=n=2:v=1:a=1[vconcat][aconcat]"
    );
  });

  it("keeps hardware frames on the fast path and bridges software spatial filters", () => {
    const fastPath = buildEditFilterComplex(
      { segments: [{ start: 10, end: 20 }] },
      false,
      { encodingMode: "hw" }
    );
    expect(fastPath.filterComplex).not.toContain("hwdownload");
    expect(fastPath.filterComplex).not.toContain("hwupload");
    expect(fastPath.filterComplex).toContain("[vconcat]null[vout]");

    const spatialPath = buildEditFilterComplex(
      {
        segments: [{ start: 10, end: 20 }],
        transform: {
          crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
          rotate: 90,
        },
      },
      false,
      { encodingMode: "hw" }
    );
    expect(spatialPath.filterComplex).toContain(
      "[vconcat]hwdownload,format=nv12,crop="
    );
    expect(spatialPath.filterComplex).toContain(
      "transpose=clock,format=nv12,hwupload[vout]"
    );
  });

  it("falls back to software decode while retaining VAAPI encoding", () => {
    const args = buildEditFfmpegArgs({
      inputPath: "/input/source.mkv",
      outputPath: "/output/fallback.mkv",
      timeline: {
        segments: [{ start: 3600, end: 3607 }],
        transform: { rotate: 90 },
      },
      output: request().output,
      hasSourceAudio: true,
      vaapiDevice: "/dev/dri/renderD128",
      bitrate: "4M",
      maxrate: "5M",
      bufsize: "10M",
      encodingMode: "sw_decode",
    });

    expect(args).toContain("-init_hw_device");
    expect(args).toContain("-filter_hw_device");
    expect(args).toContain("-threads");
    expect(args).not.toContain("-hwaccel");
    expect(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2)).toEqual([
      "-c:v",
      "av1_vaapi",
    ]);
    expect(args.slice(args.indexOf("-ss"), args.indexOf("-i") + 2)).toEqual([
      "-ss",
      "3600",
      "-t",
      "7",
      "-i",
      "/input/source.mkv",
    ]);

    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).not.toContain("hwdownload");
    expect(graph).toContain("format=nv12,hwupload[vout]");
  });

  it("canonicalizes safe output basenames and rejects unsafe ones", () => {
    expect(canonicalizeOutputFileName("clip")).toBe("clip.mkv");
    expect(canonicalizeOutputFileName("clip.MKV")).toBe("clip.mkv");

    for (const fileName of [
      "",
      " clip",
      ".",
      "..",
      "../clip",
      "nested/clip",
      "nested\\clip",
      "bad\u0000clip",
    ]) {
      expect(() => canonicalizeOutputFileName(fileName)).toThrow();
    }
  });

  it("rejects source-bound and audio-duration violations before queueing", () => {
    expect(() => validateEditRequest(request(), 25)).not.toThrow();
    expect(() => validateEditRequest(request(), 24)).toThrow(
      "exceeds the source duration"
    );
    expect(() =>
      validateEditRequest(
        request({
          timeline: {
            segments: [{ start: 0, end: 5 }],
            audio: { fade_out_seconds: 6 },
          },
        }),
        10
      )
    ).toThrow("must fit within the edited duration");

    expect(() =>
      validateEditRequest(
        request({
          timeline: {
            segments: [
              {
                start: 0,
                end: 4,
                speed: 2,
                audio: { fade_out_seconds: 2.01 },
              },
            ],
          },
        }),
        10
      )
    ).toThrow(
      "Timeline segment 0 audio fade_out_seconds must fit within the edited segment duration"
    );

    expect(() =>
      validateEditRequest(
        request({
          timeline: {
            segments: [
              {
                start: 0,
                end: 4,
                transform: {
                  crop: { x: 0.75, y: 0, width: 0.5, height: 1 },
                },
              },
            ],
          },
        }),
        10
      )
    ).toThrow(
      "Timeline segment 0 crop must fit within normalized video bounds"
    );
  });
});
