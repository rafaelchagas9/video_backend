import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { selectTemporalControl, temporalFaceSampleIndices, type TemporalControlInput } from "@/modules/recordings/recordings.temporal-control";
import { parseOfferedPreferenceHead, type OfferedPreferenceHead } from "@/modules/recordings/recordings.offered-preference";
const head = (): OfferedPreferenceHead => parseOfferedPreferenceHead({ schema_version: 1, kind: "offered_version_preference_linear", numeric_weights: Array(13).fill(0), visual_weights: Array(1152).fill(0), duration_weights: [0, 0], bias: 0, soft_preferred_seconds: [180, 900], duration_recipe: "log_hinges_180_900_v1", feature_recipe: "recording-v1-replace_exact_offered_proposal", visual_recipe: "unit_mean_unit_frames_inside_exact_offered_range", target: "preferred_version_if_keep_one", probability_calibrated: false, automatic_action: false });
function input(start = 2.5, end = 402.5): TemporalControlInput {
  const timestamps = Array.from({ length: Math.floor((end - start) / 5) + 1 }, (_, i) => start + 5 * i);
  return { originalProposalId: "c1", proposals: [{ id: "c1", start_seconds: start, end_seconds: end, score: .8 }], recordingDuration: end + 5, frames: { timestamps, vectors: timestamps.map(() => { const value = new Float32Array(1152); value[0] = 1; return value; }) } };
}
describe("fixed generic old-C control and face sample", () => {
  it("breaks equal-utility ties by shortest duration then earliest start without mutating source", () => {
    const source = input(), before = structuredClone(source);
    expect(selectTemporalControl(head(), source)).toEqual({ range: [2.5, 182.5], score: 0 });
    expect(source).toEqual(before);
  });
  it("retains the exact last endpoint even when it is off the five-second grid", () => {
    const model = head(); model.numeric_weights[5] = 1;
    const found = selectTemporalControl(model, input(2.5, 405));
    expect(found.range).toEqual([225, 405]);
    expect(found.score).toBeCloseTo(315 / 410, 12);
  });
  it("uses ties-to-even at interior half-grid starts, matching Python rather than Math.round", () => {
    const source = input(0, 300), model = head(); model.visual_weights[0] = 1; model.numeric_weights[5] = -.0001;
    source.frames.vectors = source.frames.timestamps.map(time => { const value = new Float32Array(1152); value[time === 205 ? 0 : 1] = 1; return value; });
    // For 180s span, j=3 is 22.5s ->20s; rounding up would incorrectly introduce25s.
    expect(selectTemporalControl(model, source).range).toEqual([30, 210]);
  });
  it("includes the whole original beyond fifteen minutes rather than imposing a duration cap", () => {
    const model = head(); model.numeric_weights[0] = 1;
    const source = input(0, 1200);
    source.frames.timestamps = Array.from({length:49}, (_, i) => i * 25);
    source.frames.vectors = source.frames.vectors.slice(0,49);
    expect(selectTemporalControl(model, source).range).toEqual([0, 1200]);
  });
  it("fails closed for unknown originals, short bounds, malformed frames and invalid head", () => {
    const source = input();
    expect(() => selectTemporalControl(head(), { ...source, originalProposalId: "missing" })).toThrow();
    expect(() => selectTemporalControl(head(), input(0, 179))).toThrow();
    expect(() => selectTemporalControl(head(), { ...source, proposals: [...source.proposals, source.proposals[0]!] })).toThrow();
    expect(() => selectTemporalControl(head(), { ...source, frames: { timestamps: [], vectors: [] } })).toThrow();
    expect(() => selectTemporalControl({ ...head(), probability_calibrated: true }, source)).toThrow();
  });
  it("matches independently generated NumPy truncating-linspace sampling with inclusive bounds", () => {
    // Python np.flatnonzero / np.linspace / astype(int), generated before this helper.
    const expected = [0,1,2,3,4,5,6,8,9,10,11,12,13,15,16,17,18,19,20,21,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,45,46,47,48,49,50,51,52,53,54,55,56,57,58,60,61,62,63,64,65,66,68,69,70,71,72,73,75,76,77,78,79,80,82];
    expect(temporalFaceSampleIndices(Array.from({ length: 83 }, (_, i) => i * 5), [0,410], [100,280])).toEqual(expected);
    expect(temporalFaceSampleIndices([0,5,10,15], [0,15], [5,10])).toEqual([0,1,2,3]);
    expect(temporalFaceSampleIndices(new Float64Array([0,5,10]), [0,10], [0,5])).toEqual([0,1,2]);
  });
  it("rejects invalid timelines, impossible control bounds and empty observed support", () => {
    for (const t of [[], [0,0], [5,0], [NaN], [-1,5]]) expect(() => temporalFaceSampleIndices(t, [0,10], [0,5])).toThrow();
    expect(() => temporalFaceSampleIndices([0,5,10], [0,10], [5,11])).toThrow();
    expect(() => temporalFaceSampleIndices([0,10], [0,10], [2,5])).toThrow();
  });
});

const realRoot = process.env.TEMPORAL_CONTROL_REAL_PARITY_ROOT;
(realRoot ? it : it.skip)("matches frozen Python old-C controls, utility and exact planned samples on three real numeric generations", () => {
  const backend = resolve(realRoot!);
  const python = String.raw`import hashlib,json,sys
from pathlib import Path
import numpy as np
root=Path(sys.argv[1]); artifacts=root/'vision-lab/data/model-completion-20261010'
head_path=artifacts/'combined-blind-preference/frozen_candidate.json'
assert hashlib.sha256(head_path.read_bytes()).hexdigest()=='e681be589ec7778c7c09b0273a367012c8ba4278989edde41b576b7fe5495d43'
head=json.loads(head_path.read_text())['heads']['primary']
records=json.loads((artifacts/'temporal-validation-nextwave-v1/controls_and_face_request.json').read_text())['records']
chosen=[]; seen=set()
for r in sorted(records,key=lambda r:(r['numeric_identity']['index']['frame_count'],r['source_key'])):
 if r['source_key'] in seen:continue
 seen.add(r['source_key']);chosen.append(r)
 if len(chosen)==3:break
cases=[]
for r in chosen:
 p=Path(r['frame_checkpoint']['path']); assert hashlib.sha256(p.read_bytes()).hexdigest()==r['frame_checkpoint']['sha256']
 with np.load(p,allow_pickle=False) as z:
  t=z['t'];v=z['v']; assert str(z['identity_sha256'])==r['source_key']
  identity=r['numeric_identity'];ranges=r['old_candidate_grid'];scores=r['old_candidate_scores']
  winner=min(range(len(ranges)),key=lambda i:(-scores[i]['primary'],ranges[i][1]-ranges[i][0],ranges[i][0]))
  assert ranges[winner]==r['control_range']
  cases.append({'input':{'originalProposalId':r['original_proposal_id'],'recordingDuration':identity['duration'],'proposals':[{'id':p['id'],'start_seconds':p['start'],'end_seconds':p['end'],'score':p['score']} for p in identity['proposals']],'frames':{'timestamps':t.tolist(),'vectors':v.tolist()}},'range':r['control_range'],'score':scores[winner]['primary'],'indices':r['planned_face_indices'],'original':r['original_range']})
print(json.dumps({'head':head,'cases':cases},allow_nan=False))`;
  const result = JSON.parse(execFileSync(resolve(backend, "vision-lab/.venv/bin/python"), ["-B", "-c", python, backend], { encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1", PYTHONDONTWRITEBYTECODE: "1" } }));
  expect(result.cases.length).toBe(3);
  for (const row of result.cases) {
    const source: TemporalControlInput = { ...row.input, frames: { timestamps: row.input.frames.timestamps, vectors: row.input.frames.vectors.map((v: number[]) => Float32Array.from(v)) } };
    const found = selectTemporalControl(result.head, source);
    expect(found.range).toEqual(row.range);
    expect(Math.abs(found.score - row.score)).toBeLessThan(1e-8);
    expect(temporalFaceSampleIndices(source.frames.timestamps, row.original, found.range)).toEqual(row.indices);
  }
}, 120000);
