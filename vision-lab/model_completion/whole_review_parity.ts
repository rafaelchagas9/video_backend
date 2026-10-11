/** Standalone synthetic Python/Bun parity; never imports live services or model activation. */
import { readFileSync } from "node:fs";
import { parseWholeReviewHead, recordingWholeInputs, scoreWholeReview } from "../../src/modules/recordings/recordings.whole-preference";
interface Fixture { synthetic_only: boolean; head: unknown; cases: Array<{ inputs: { proposals: Array<{ id: string; start: number; end: number; score: number }>; duration_seconds: number; timestamps: number[]; vectors: number[][] }; expected: { features: number[]; visual_mean: number[]; score: number } }> }
const fixture = JSON.parse(readFileSync(new URL("./fixtures/whole_review_parity.json", import.meta.url), "utf8")) as Fixture;
if (!fixture.synthetic_only || fixture.cases.length !== 2) throw new Error("Exactly two synthetic cases required");
let maxDifference = 0;
for (const c of fixture.cases) {
  const input = recordingWholeInputs(c.inputs.proposals.map(p => ({ id: p.id, start_seconds: p.start, end_seconds: p.end, score: p.score })), c.inputs.duration_seconds, { timestamps: c.inputs.timestamps, vectors: c.inputs.vectors.map(v => Float32Array.from(v)) });
  const actual = [...input.features, ...input.visualMean!, scoreWholeReview(parseWholeReviewHead(fixture.head), input)];const expected = [...c.expected.features, ...c.expected.visual_mean, c.expected.score];
  if (actual.length !== expected.length) throw new Error("Parity output width changed");
  for (let i = 0; i < actual.length; i++) { const error = Math.abs(actual[i]! - expected[i]!);if (!Number.isFinite(error) || error > 1e-12) throw new Error("Whole-recording Python/Bun parity failed");maxDifference = Math.max(maxDifference, error); }
}
console.log(JSON.stringify({ status: "PASS_synthetic_whole_recording_parity", fixtures: 2, max_difference: maxDifference, DB: false, media: false, fit: false, activation: false }));
