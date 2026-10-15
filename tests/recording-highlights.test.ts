import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectHighlights, detectWithProbe, isLikelySkip, joinStretches } from "@/modules/recordings/recordings.highlights";
import { classifyFrames, loadHighlightProbe, probeThreshold, type HighlightProbe } from "@/modules/recordings/recordings.probe";
import { LIVE_HIGHLIGHT_STATES, liveClipOptions } from "@/modules/recordings/recordings.sessions.policy";

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

  it("never proposes a clip that ends before it starts when the duration is short", () => {
    const input = recording((t) => (t >= 1800 && t < 1920 ? v(1, 0.1, 0.2) : v(0.05 + (t % 7) * 0.01, 1, 0.2)), 3600);
    const result = detectHighlights({ ...input, durationSeconds: 23, ...prompts });
    expect(result.clips.every((clip) => clip.end_seconds > clip.start_seconds)).toBe(true);
  });

  it("finds nothing in an evenly idle stream", () => {
    const input = recording((t) => v(0.02 * (t % 3), 1, 0.1), 1200);
    expect(detectHighlights({ ...input, ...prompts }).clips.length).toBeLessThanOrEqual(1);
  });
});

/**
 * A 3-d probe: x reads as explicit, y as idle, z as tease. Context weights are zero except
 * where a test needs the neighbourhood.
 */
function probe(context = 0): HighlightProbe {
  const row = (frame: number[], ctx: number[]) => Float32Array.from([...frame, ...ctx.map((value) => value * context)]);
  return {
    version: "test",
    modelRevision: "siglip2/so400m-patch16-256",
    classes: ["idle", "tease", "nude", "explicit"],
    contextRadius: 2,
    dimension: 3,
    weights: [row([0, 6, 0], [0, 6, 0]), row([0, 0, 6], [0, 0, 6]), row([0, 0, 0], [0, 0, 0]), row([6, 0, 0], [6, 0, 0])],
    bias: [0, 0, -2, 0],
    labelledFrames: 10,
    labelledRecordings: 1,
    metrics: null,
  };
}

describe("trained highlight detection", () => {
  it("clips the frames the probe calls a highlight state, named after that state", () => {
    const input = recording((t) => (t >= 600 && t < 720 ? v(1, 0, 0) : v(0, 1, 0)), 1800);
    const result = detectWithProbe({ ...input, probe: probe(), states: ["nude", "explicit"], threshold: 0.55 });
    expect(result.clips).toHaveLength(1);
    expect(result.clips[0]!.label).toBe("Explicit");
    expect(result.clips[0]!.start_seconds).toBeGreaterThanOrEqual(580);
    expect(result.clips[0]!.end_seconds).toBeLessThanOrEqual(745);
  });

  it("proposes nothing for a stream that never leaves idle, unlike the baseline-relative prompts", () => {
    const input = recording((t) => v(0.05 * (t % 3), 1, 0.05), 1800);
    expect(detectWithProbe({ ...input, probe: probe(), states: ["nude", "explicit"], threshold: 0.55 }).clips).toHaveLength(0);
  });

  it("only clips the states asked for", () => {
    const input = recording((t) => (t >= 300 && t < 420 ? v(0, 0, 1) : v(0, 1, 0)), 900);
    const args = { ...input, probe: probe(), threshold: 0.55 };
    expect(detectWithProbe({ ...args, states: ["nude", "explicit"] }).clips).toHaveLength(0);
    expect(detectWithProbe({ ...args, states: ["tease", "nude", "explicit"] }).clips[0]?.label).toBe("Tease");
  });

  it("judges a frame with its neighbours", () => {
    // One explicit-looking frame among idle ones: the neighbourhood mean outvotes it.
    const vectors = [v(0, 1, 0), v(0, 1, 0), v(1, 0, 0), v(0, 1, 0), v(0, 1, 0)];
    const alone = classifyFrames(probe(0), vectors)[2]!;
    const withContext = classifyFrames(probe(1), vectors)[2]!;
    expect(alone[3]!).toBeGreaterThan(0.9);
    expect(withContext[3]!).toBeLessThan(alone[3]!);
  });

  // Live cuts: x = action, y = brb / idle, z = naked on the phone (anything that isn't action).
  const action = v(1, 0, 0);
  const brb = v(0, 1, 0);
  const phone = v(0, 0, 1);
  const cut = (pattern: (minute: number) => Float32Array, minutes: number) =>
    detectWithProbe({ ...recording((t) => pattern(t / 60), minutes * 60), probe: probe(), states: LIVE_HIGHLIGHT_STATES, threshold: 0.55, options: liveClipOptions(0.55) }).clips;
  const minutesOf = (clip: { start_seconds: number; end_seconds: number }) => (clip.end_seconds - clip.start_seconds) / 60;

  it("splits a long segment into its action, leaving out brb and phone time", () => {
    const clips = cut((m) => (m < 25 ? action : m < 30 ? brb : m < 35 ? action : m < 40 ? phone : action), 45);
    expect(clips.map((clip) => Math.round(minutesOf(clip)))).toEqual([25, 5, 5]);
  });

  it("lets a lull stay inside a long scene but ends a short one at it", () => {
    // `before` minutes of action, half a minute away, two more minutes of action.
    const lull = (before: number) => (m: number) => (m < before ? action : m < before + 0.5 ? brb : m < before + 2.5 ? action : brb);
    expect(cut(lull(20), 30)).toHaveLength(1);
    expect(cut(lull(2), 10)).toHaveLength(2);
  });

  it("keeps a moment going through a dip in confidence", () => {
    const unsure = v(1, 1, 0);
    expect(cut((m) => (m < 5 ? action : m < 6 ? unsure : m < 11 ? action : brb), 15)).toHaveLength(1);
  });

  it("maps the sensitivity presets onto probability thresholds", () => {
    expect(probeThreshold(1.4)).toBeCloseTo(0.55);
    expect(probeThreshold(1.0)).toBeLessThan(probeThreshold(1.4));
    expect(probeThreshold(2.0)).toBeGreaterThan(probeThreshold(1.4));
    expect(probeThreshold(4)).toBeLessThanOrEqual(0.9);
  });
});

describe("loadHighlightProbe", () => {
  it("reads an exported probe and rejects a malformed one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "probe-"));
    try {
      const path = join(dir, "probe.json");
      const exported = {
        version: "1", model_revision: "siglip2/so400m-patch16-256", classes: ["idle", "tease", "nude", "explicit"],
        context_radius: 2, dimension: 2, weights: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
        bias: [0, 0, 0, 0], labelled_frames: 5, labelled_recordings: 1, metrics: null,
      };
      await writeFile(path, JSON.stringify(exported));
      expect((await loadHighlightProbe(path))?.weights[3]![3]).toBe(1);
      await writeFile(join(dir, "bad.json"), JSON.stringify({ ...exported, weights: [[1, 0]] }));
      expect(await loadHighlightProbe(join(dir, "bad.json"))).toBeNull();
      expect(await loadHighlightProbe(join(dir, "missing.json"))).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

describe("isLikelySkip", () => {
  it("starts short weak highlights skipped and keeps long or confident ones", () => {
    expect(isLikelySkip({ start_seconds: 0, end_seconds: 120, score: 0.6 })).toBe(true);
    expect(isLikelySkip({ start_seconds: 0, end_seconds: 120, score: 0.92 })).toBe(false);
    expect(isLikelySkip({ start_seconds: 0, end_seconds: 900, score: 0.6 })).toBe(false);
  });
});
