import { describe, expect, it } from "bun:test";
import { capRecordingClips, usableVideoDuration } from "@/modules/recordings/recordings.duration";

const probe = {
  format: { duration: "2068.808" },
  streams: [
    { codec_type: "video", start_time: "0", tags: { DURATION: "00:34:27.200000000" } },
    { codec_type: "audio", tags: { DURATION: "00:34:28.808000000" } },
  ],
};
const clip = { id: "c4", keep: true, start_seconds: 1138, end_seconds: 2068.808, peak_seconds: 1240, score: 1, label: "highlight", job_id: null };

describe("recording video duration", () => {
  it("caps the existing failed review at video EOF rather than the audio-only tail", () => {
    const duration = usableVideoDuration(probe, 2068.808);
    expect(duration).toBe(2067.2);
    const [bounded] = capRecordingClips([clip], duration);
    expect(bounded!.end_seconds - bounded!.start_seconds).toBeCloseTo(929.2);
    expect(bounded!.job_id).toBeNull();
    expect(clip.end_seconds).toBe(2068.808);
  });
  it("uses direct stream duration plus its start, and falls back when a stream duration is absent", () => {
    expect(usableVideoDuration({ format: { duration: 12 }, streams: [{ codec_type: "video", start_time: 1, duration: 9 }] }, 12)).toBe(10);
    expect(usableVideoDuration({ format: { duration: 12 }, streams: [{ codec_type: "video" }] }, 11)).toBe(11);
    expect(() => usableVideoDuration({ streams: [] }, 12)).toThrow("no video stream");
  });
  it("preserves earlier, rendered and running clips and rejects kept audio-only ranges", () => {
    const earlier = { ...clip, end_seconds: 1300 };
    const rendered = { ...clip, output_video_id: 6000 };
    const running = { ...clip, job_id: 51 };
    expect(capRecordingClips([earlier, rendered, running], 2067.2)).toEqual([earlier, rendered, running]);
    expect(() => capRecordingClips([{ ...clip, start_seconds: 2068 }], 2067.2)).toThrow("starts after");
    expect(capRecordingClips([{ ...clip, keep: false, start_seconds: 2068 }], 2067.2)[0]!.keep).toBe(false);
  });
});
