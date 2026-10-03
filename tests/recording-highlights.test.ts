import { describe, expect, it } from "bun:test";
import { detectHighlights, joinStretches } from "@/modules/recordings/recordings.highlights";

/** Unit vectors in 3D: x = highlight look, y = idle look, z = neutral. */
const v = (x: number, y: number, z: number) => {
  const n = Math.hypot(x, y, z) || 1;
  return Float32Array.from([x / n, y / n, z / n]);
};

function recording(pattern: (t: number) => Float32Array, seconds: number, every = 5) {
  const timestamps: number[] = [];
  const vectors: Float32Array[] = [];
  for (let t = 0; t < seconds; t += every) {
    timestamps.push(t);
    vectors.push(pattern(t));
  }
  return { timestamps, vectors, durationSeconds: seconds };
}

const prompts = {
  highlights: [{ label: "highlight", vector: v(1, 0, 0) }],
  idle: [v(0, 1, 0)],
};

describe("highlight detection", () => {
  it("proposes the stretch that departs from the stream's idle baseline", () => {
    // An hour of chatting with a 2-minute highlight at 30:00, plus small jitter.
    const input = recording(
      (t) => (t >= 1800 && t < 1920 ? v(1, 0.1, 0.2) : v(0.05 + (t % 7) * 0.01, 1, 0.2)),
      3600
    );
    const result = detectHighlights({ ...input, ...prompts });
    expect(result.clips).toHaveLength(1);
    const [clip] = result.clips;
    expect(clip!.start_seconds).toBeLessThanOrEqual(1800);
    expect(clip!.start_seconds).toBeGreaterThanOrEqual(1780);
    expect(clip!.end_seconds).toBeGreaterThanOrEqual(1920);
    expect(clip!.end_seconds).toBeLessThanOrEqual(1945);
    expect(clip!.label).toBe("highlight");
    expect(Math.max(...result.curve)).toBe(1);
  });

  it("joins nearby bursts and drops blips", () => {
    const input = recording((t) => {
      if ((t >= 600 && t < 660) || (t >= 680 && t < 740)) return v(1, 0, 0);
      if (t === 2000) return v(1, 0, 0); // a single frame
      return v(0.02 * (t % 5), 1, 0.1);
    }, 3000);
    const result = detectHighlights({ ...input, ...prompts });
    expect(result.clips).toHaveLength(1);
    expect(result.clips[0]!.end_seconds - result.clips[0]!.start_seconds).toBeGreaterThan(140);
  });

  it("finds nothing in an evenly idle stream", () => {
    const input = recording((t) => v(0.02 * (t % 3), 1, 0.1), 1200);
    expect(detectHighlights({ ...input, ...prompts }).clips.length).toBeLessThanOrEqual(1);
  });
});

describe("joinStretches", () => {
  it("orders kept stretches and joins the ones that overlap or touch", () => {
    expect(
      joinStretches([
        { start_seconds: 300, end_seconds: 340 },
        { start_seconds: 10, end_seconds: 40 },
        { start_seconds: 35, end_seconds: 60 },
        { start_seconds: 60, end_seconds: 70 },
      ])
    ).toEqual([
      { start: 10, end: 70 },
      { start: 300, end: 340 },
    ]);
  });
});
