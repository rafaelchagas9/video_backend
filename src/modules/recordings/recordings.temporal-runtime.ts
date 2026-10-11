/** User-selected cut policy. Numeric receipts and cached storyboard tiles only; never decodes recordings. */
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat, mkdir, writeFile, rename, chmod } from "node:fs/promises";
import { basename, resolve } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { env } from "@/config/env";
import { logger } from "@/utils/logger";
import type { Storyboard } from "@/modules/storyboards/storyboards.types";
import { type HighlightProbe } from "./recordings.probe";
import type { ModelFrames, ModelProposal } from "./recordings.model";
import type { RecordingTemporalVersions } from "./recordings.temporal-cache";
import { HttpRecordingFaceVisibilityAdapter } from "./recordings.face-visibility";
import { parseOfferedPreferenceHead } from "./recordings.offered-preference";
import { temporalFaceSampleIndices } from "./recordings.temporal-control";
import { proposeTemporalPreference, TEMPORAL_PREFERENCE_RECIPE, TEMPORAL_PREFERENCE_TARGET, TEMPORAL_STATE_PROBE_SHA256, TEMPORAL_DIAGNOSTIC_SOURCE_SHA256 } from "./recordings.temporal-preference";

export const TEMPORAL_CONTROL_SHA256 = "e681be589ec7778c7c09b0273a367012c8ba4278989edde41b576b7fe5495d43";
export const TEMPORAL_FACE_SHA256 = "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const policySchema = z.object({
  schema_version: z.literal(1), enabled: z.boolean(), version: z.string().min(1).max(120), activation_basis: z.literal("user_choice"),
  statistical_gate_passed: z.literal(false), automatic_action: z.literal(false), selector_recipe: z.literal(TEMPORAL_PREFERENCE_RECIPE),
  selector_source_sha256: z.literal(TEMPORAL_DIAGNOSTIC_SOURCE_SHA256), probe_sha256: z.literal(TEMPORAL_STATE_PROBE_SHA256),
  control_sha256: z.literal(TEMPORAL_CONTROL_SHA256), face_model_sha256: z.literal(TEMPORAL_FACE_SHA256),
  validation: z.object({ first_snapshot_sha256: hash, next_snapshot_sha256: hash, answered_pairs: z.literal(66),
    first_gate_passed: z.literal(false), next_gate_passed: z.literal(false), user_approved_at: z.string().datetime() }).strict(),
  control_path: z.string().min(1), probe_path: z.string().min(1),
}).strict();
export type RecordingTemporalPolicy = z.infer<typeof policySchema>;
export const parseRecordingTemporalPolicy = (raw: unknown) => policySchema.parse(raw);
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const defaultRoot = () => resolve(process.env.NODE_ENV === "test" ? process.env.TEST_STORAGE_ROOT ?? "/nonexistent-test-storage" : process.cwd(), "data/models/recording-temporal-cache");
const defaultPolicy = () => resolve(process.env.NODE_ENV === "test" ? process.env.TEST_STORAGE_ROOT ?? "/nonexistent-test-storage" : process.cwd(), "data/models/recording-temporal-policy.json");
export async function loadRecordingTemporalPolicy(path = defaultPolicy()): Promise<{ policy: RecordingTemporalPolicy; sha256: string } | null> {
  try { const bytes = await boundedRead(path, 64 * 1024); const policy = parseRecordingTemporalPolicy(JSON.parse(bytes.toString())); return policy.enabled ? { policy, sha256: digest(bytes) } : null; } catch { return null; }
}
export interface RecordingTemporalMetadata {
  videoId: number; analyzedAt: string; duration: number; proposals: readonly ModelProposal[]; source: { path: string; sizeBytes: number };
  index: { modelRevision: string; storyboardGeneratedAt: Date; indexedAt: Date; intervalSeconds: number; frameCount: number }; storyboard: Storyboard;
}
/** Legacy reviews retain original edges in detected; edited draft edges are never original inputs. */
export function recordingTemporalOriginalProposals(proposals: readonly ModelProposal[] | null, clips: readonly (ModelProposal & {detected?: {start_seconds:number;end_seconds:number}})[]): readonly ModelProposal[] | null {
  if (proposals) return proposals;
  const originals=clips.filter(c=>!c.id.startsWith("added-"));
  if (!originals.length || originals.some(c=>!c.detected)) return null;
  return originals.map(c=>({id:c.id,start_seconds:c.detected!.start_seconds,end_seconds:c.detected!.end_seconds,score:c.score}));
}
export interface RecordingTemporalRuntimeInput {
  metadata: () => Promise<RecordingTemporalMetadata | null>; frames: () => Promise<ModelFrames>;
  policyPath?: string; cacheRoot?: string; onReady?: (videoId: number) => void;
  /** Read-only callers/tests can inspect ready receipts without scheduling inference. */
  prepare?: boolean;
}
interface FileReceipt { path: string; fingerprint: string; sha256: string }
interface Generation { identity: string; identityJson: string; metadata: RecordingTemporalMetadata }
async function fingerprint(path: string): Promise<string> {
  const s = await stat(path, { bigint: true }); if (!s.isFile()) throw new Error("Regular cached file required");
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
}
async function boundedRead(path: string, limit: number): Promise<Buffer> {
  const a = await stat(path, { bigint: true }); if (!a.isFile() || a.size <= 0 || a.size > BigInt(limit)) throw new Error("Bounded regular cache required");
  const before = await fingerprint(path), bytes = await readFile(path); if (bytes.length > limit || before !== await fingerprint(path)) throw new Error("Cached file changed"); return bytes;
}
export async function recordingTemporalGeneration(metadata: RecordingTemporalMetadata): Promise<Generation> {
  const m = metadata, i = m.index, b = m.storyboard;
  if (!Number.isSafeInteger(m.videoId) || m.videoId <= 0 || !Number.isFinite(Date.parse(m.analyzedAt)) || !Number.isFinite(m.duration) || m.duration <= 0 ||
      i.modelRevision !== "siglip2/so400m-patch16-256" || i.intervalSeconds !== 5 || !Number.isInteger(i.frameCount) || i.frameCount < 1 || i.frameCount > 8000 || !(i.indexedAt instanceof Date) || !Number.isFinite(i.indexedAt.getTime()) ||
      Date.parse(b.generated_at) !== i.storyboardGeneratedAt.getTime() || b.tile_count !== i.frameCount || b.interval_seconds !== 5 || b.tile_width < 64 || b.tile_width > 512 || b.tile_height < 36 || b.tile_height > 288 ||
      !m.proposals.length || m.proposals.length > 60 || new Set(m.proposals.map(p => p.id)).size !== m.proposals.length || m.proposals.some(p => !p.id || p.id.startsWith("added-") || ![p.start_seconds,p.end_seconds,p.score].every(Number.isFinite) || p.start_seconds < 0 || p.end_seconds <= p.start_seconds || p.end_seconds > m.duration)) throw new Error("Unsupported temporal source generation");
  const source = await stat(m.source.path, { bigint: true }); if (!source.isFile() || Number(source.size) !== m.source.sizeBytes) throw new Error("Source changed");
  const value = { video_id: m.videoId, analyzed_at: m.analyzedAt, duration: m.duration,
    source: { path_sha256: digest(m.source.path), size_bytes: m.source.sizeBytes, mtime_ns: source.mtimeNs.toString() },
    index: { revision: i.modelRevision, storyboard_generated_at: i.storyboardGeneratedAt.toISOString(), indexed_at: i.indexedAt.toISOString(), interval: i.intervalSeconds, count: i.frameCount },
    storyboard: { sprite: b.sprite_path, vtt: b.vtt_path, width: b.tile_width, height: b.tile_height },
    proposals: m.proposals.map(p => [p.id,p.start_seconds,p.end_seconds,p.score]) };
  const identityJson = JSON.stringify(value); return { identity: digest(identityJson), identityJson, metadata: m };
}
const range = z.tuple([z.number().finite().nonnegative(),z.number().finite().nonnegative()]).refine(r => r[1] > r[0]);
const candidateSchema = z.object({ id: z.string(), candidate_id: hash, original: range, control: range, range,
  generation_identity: hash, frame_checkpoint_sha256: hash, face_checkpoint_sha256: hash, prior_control_receipt_sha256: hash, selector_report_sha256: hash, missing_face_is_unknown: z.literal(true) }).strict();
const cacheSchema = z.object({ schema_version: z.literal(1), identity: hash, identity_json: z.string().max(256 * 1024), policy_sha256: hash,
  files: z.array(z.object({ path: z.string(), fingerprint: z.string(), sha256: hash }).strict()).max(321),
  cuts: z.array(z.object({ id: z.string(), start_seconds: z.number().finite().nonnegative(), end_seconds: z.number().finite().positive() }).strict()).max(60),
  candidates: z.array(candidateSchema).max(60), model_sha256: z.literal(TEMPORAL_FACE_SHA256), providers: z.array(z.string()).min(1),
  observations: z.array(z.object({ index: z.number().int().nonnegative(), timestamp: z.number().finite().nonnegative(), detected: z.boolean(), max_confidence: z.number().finite().min(0).max(1) }).strict()).max(8000),
}).strict();
type Cache = z.infer<typeof cacheSchema>;
export interface RecordingTemporalRuntimeResult {
  versions: RecordingTemporalVersions; cuts: Cache["cuts"];
}
function checkedCache(raw: unknown, g: Generation, policySha: string): Cache {
  const c = cacheSchema.parse(raw);
  if (c.identity !== g.identity || c.identity_json !== g.identityJson || c.policy_sha256 !== policySha || digest(c.identity_json) !== c.identity || !c.providers.some(p => p !== "CPUExecutionProvider") ||
      new Set(c.cuts.map(p => p.id)).size !== c.cuts.length || new Set(c.candidates.map(p => p.id)).size !== c.candidates.length) throw new Error("Stale or incompatible temporal cache");
  for (const cut of c.cuts) { const p = g.metadata.proposals.find(p => p.id === cut.id); if (!p || cut.start_seconds < p.start_seconds || cut.end_seconds > p.end_seconds || cut.end_seconds - cut.start_seconds < 180) throw new Error("Invalid proposed cut"); }
  for (const candidate of c.candidates) {
    const p = g.metadata.proposals.find(p => p.id === candidate.id), cut = c.cuts.find(p => p.id === candidate.id);
    const seconds = candidate.control[1] - candidate.control[0], intersection = Math.max(0, Math.min(candidate.control[1],candidate.range[1]) - Math.max(candidate.control[0],candidate.range[0]));
    if (!p || !cut || candidate.generation_identity !== g.identity || candidate.original[0] !== p.start_seconds || candidate.original[1] !== p.end_seconds || candidate.control[0] < p.start_seconds || candidate.control[1] > p.end_seconds || candidate.range[0] !== cut.start_seconds || candidate.range[1] !== cut.end_seconds || Math.abs(seconds - (candidate.range[1] - candidate.range[0])) > 1e-6 || Math.abs(candidate.range[0] - candidate.control[0]) < 30 || intersection / (2 * seconds - intersection) > .8) throw new Error("Invalid temporal challenger");
  }
  return c;
}
const pending = new Map<string, () => Promise<void>>(), failures = new Map<string,number>();
let active = false;
async function drain(): Promise<void> {
  if (active) return; active = true;
  try { while (pending.size) { const [key, work] = pending.entries().next().value!; try { await work(); } catch { failures.set(key,Date.now()); if (failures.size > 64) failures.delete(failures.keys().next().value!); } finally { pending.delete(key); } } } finally { active = false; }
}
/** Returns ready numeric offers immediately; one bounded shared-service job prepares missing generations. */
export async function recordingTemporalReview(input: RecordingTemporalRuntimeInput): Promise<RecordingTemporalRuntimeResult | null> {
  if (env.DEMO_MODE) return null;
  try {
    const loaded = await loadRecordingTemporalPolicy(input.policyPath); if (!loaded) return null;
    const m = await input.metadata(); if (!m) return null; const g = await recordingTemporalGeneration(m), root = input.cacheRoot ?? defaultRoot(), path = resolve(root,`${g.identity}.${loaded.sha256}.json`), key = path;
    try {
      const bytes = await boundedRead(path,MAX_CACHE_BYTES), cache = checkedCache(JSON.parse(bytes.toString()),g,loaded.sha256);
      for (const file of cache.files) if (await fingerprint(file.path) !== file.fingerprint) throw new Error("Storyboard bytes changed");
      return { cuts: cache.cuts, versions: { version: loaded.policy.version, target: TEMPORAL_PREFERENCE_TARGET, scope: "current_generation_controls", analyzed_at: m.analyzedAt,
        selector_recipe: TEMPORAL_PREFERENCE_RECIPE, selector_source_sha256: TEMPORAL_DIAGNOSTIC_SOURCE_SHA256, probe_sha256: TEMPORAL_STATE_PROBE_SHA256, artifact_sha256: digest(bytes), probability_calibrated: false, automatic_action: false, candidates: cache.candidates } };
    } catch { /* Missing/invalid cache is prepared away from the review request. */ }
    if (input.prepare !== false && !pending.has(key) && pending.size < 8 && Date.now() - (failures.get(key) ?? 0) > 60_000) {
      pending.set(key,async () => {
        try { await buildRecordingTemporalCache(input,g,loaded,root,path); failures.delete(key); }
        catch (error) { logger.warn({ videoId: m.videoId, error: error instanceof Error ? error.message : "temporal inference failed" },"Recording cut selector could not prepare this generation"); throw error; }
      }); void drain();
    }
    return null;
  } catch { return null; }
}

interface Tile { index: number; timestamp: number; page: number; x: number; y: number }
export function recordingTemporalTiles(text: string, m: RecordingTemporalMetadata, times: readonly number[]): Tile[] {
  if (!text.startsWith("WEBVTT")) throw new Error("Invalid storyboard header");
  const blocks = text.trim().split(/\n\s*\n/).slice(1), result: Tile[] = [];
  const seconds = (value: string) => { const p = /^(\d+):(\d{2}):(\d{2})\.(\d{3})$/.exec(value); if (!p || Number(p[2]) >= 60 || Number(p[3]) >= 60) throw new Error("Invalid storyboard time"); return Number(p[1])*3600+Number(p[2])*60+Number(p[3])+Number(p[4])/1000; };
  for (const block of blocks) {
    const lines = block.trim().split(/\r?\n/), index = result.length; if (lines.length !== 2) throw new Error("Unsupported storyboard cue");
    const split = lines[0]!.split(" --> "); if (split.length !== 2) throw new Error("Invalid storyboard cue time");
    const time = seconds(split[0]!), end = seconds(split[1]!), u = new URL(lines[1]!,"http://local.invalid"), page = new RegExp(`^/api/videos/${m.videoId}/storyboard/pages/(\\d+)\\.(webp|jpg)$`).exec(u.pathname), box = /^#xywh=(\d+),(\d+),(\d+),(\d+)$/.exec(u.hash);
    if (u.origin !== "http://local.invalid" || !page || !box || u.searchParams.get("v") !== basename(m.storyboard.vtt_path) || u.searchParams.size !== 1 || !(end > time) || index >= times.length || Math.abs(time-times[index]!) > .001 || Number(page[1]) !== Math.floor(index/25) || Number(box[1]) !== index%5*m.storyboard.tile_width || Number(box[2]) !== Math.floor(index%25/5)*m.storyboard.tile_height || Number(box[3]) !== m.storyboard.tile_width || Number(box[4]) !== m.storyboard.tile_height) throw new Error("Storyboard/index/crop generation differs");
    result.push({ index, timestamp: times[index]!, page: Number(page[1]), x: Number(box[1]), y: Number(box[2]) });
  }
  if (result.length !== times.length) throw new Error("Incomplete storyboard timeline"); return result;
}
export async function runRecordingTemporalNumeric(head: ReturnType<typeof parseOfferedPreferenceHead>, probe: HighlightProbe, frames: ModelFrames, m: Pick<RecordingTemporalMetadata,"duration"|"proposals">, signal: AbortSignal): Promise<{controls:{p:ModelProposal;range:[number,number];score:number}[];probabilities:Float32Array[];frameHash:string}> {
  const worker=new Worker(new URL("./recordings.temporal-numeric.worker.ts",import.meta.url).href,{smol:true,name:"recording-cut-numeric"});
  return await new Promise((done,reject)=>{
    const close=()=>{signal.removeEventListener("abort",abort);worker.terminate();};
    const abort=()=>{close();reject(new Error("Bounded numeric cut inference expired"));};
    signal.addEventListener("abort",abort,{once:true});
    worker.onerror=()=>{close();reject(new Error("Numeric cut worker failed"));};
    worker.onmessage=event=>{close();if(event.data.error)reject(new Error(event.data.error));else done(event.data);};
    if(signal.aborted){abort();return;}worker.postMessage({head,probe,frames,proposals:m.proposals,duration:m.duration});
  });
}
async function buildRecordingTemporalCache(input: RecordingTemporalRuntimeInput, g: Generation, loaded: {policy: RecordingTemporalPolicy;sha256:string}, root: string, path: string): Promise<void> {
  const signal = AbortSignal.timeout(240_000), m = g.metadata, policy = loaded.policy;
  const headBytes = await boundedRead(resolve(policy.control_path),256*1024), probeBytes = await boundedRead(resolve(policy.probe_path),256*1024);
  if (digest(headBytes) !== policy.control_sha256 || digest(probeBytes) !== policy.probe_sha256) throw new Error("Pinned cut head/probe changed");
  const head = parseOfferedPreferenceHead(JSON.parse(headBytes.toString()).heads.primary), rawProbe = JSON.parse(probeBytes.toString());
  if (rawProbe.dimension !== 1152 || rawProbe.context_radius !== 2 || rawProbe.classes.join() !== "idle,tease,nude,explicit") throw new Error("Pinned full-context state probe unavailable");
  const probe: HighlightProbe = {version:rawProbe.version,modelRevision:rawProbe.model_revision,dimension:rawProbe.dimension,contextRadius:rawProbe.context_radius,classes:rawProbe.classes,weights:rawProbe.weights.map((row:number[])=>Float32Array.from(row)),bias:rawProbe.bias,labelledFrames:rawProbe.labelled_frames,labelledRecordings:rawProbe.labelled_recordings,metrics:rawProbe.metrics};
  const frames = await input.frames();
  if (frames.timestamps.length !== m.index.frameCount || frames.vectors.length !== m.index.frameCount || frames.vectors.some(v => v.length !== 1152 || v.some(x => !Number.isFinite(x))) || frames.timestamps[0]! > 5.001 || frames.timestamps.at(-1)! + 10 < m.duration || frames.timestamps.at(-1)! > m.duration || frames.timestamps.some((t,i) => !Number.isFinite(t) || t < 0 || i > 0 && Math.abs(t-frames.timestamps[i-1]!-5) > .001)) throw new Error("Incomplete full numeric generation");
  const {controls,probabilities,frameHash}=await runRecordingTemporalNumeric(head,probe,frames,m,signal);
  if (!controls.length) throw new Error("No supported cut durations");
  const selected = [...new Set(controls.flatMap(c => temporalFaceSampleIndices(frames.timestamps,[c.p.start_seconds,c.p.end_seconds],c.range)))].sort((a,b)=>a-b);
  if (selected.length > 8000) throw new Error("Face sampling budget exceeded"); signal.throwIfAborted();
  await mkdir(root,{recursive:true,mode:0o700}); await chmod(root,0o700); const device = (await stat(root,{bigint:true})).dev;
  let readBytes = 0; const files: FileReceipt[] = [];
  const readCached = async (p: string,limit: number) => { p=resolve(p); if ((await stat(p,{bigint:true})).dev !== device) throw new Error("Storyboard is not on cache SSD"); const bytes=await boundedRead(p,limit); readBytes+=bytes.length; if (readBytes > 512*1024*1024) throw new Error("Cached tile read budget exceeded"); files.push({path:p,fingerprint:await fingerprint(p),sha256:digest(bytes)}); return bytes; };
  const vtt = await readCached(m.storyboard.vtt_path,2*1024*1024), tiles = recordingTemporalTiles(vtt.toString(),m,frames.timestamps), pattern = /^(.*)\.p0\.(webp|jpg)$/.exec(resolve(m.storyboard.sprite_path));
  if (!pattern) throw new Error("Paged cached storyboard required");
  const adapter = new HttpRecordingFaceVisibilityAdapter({baseUrl:env.VISION_SERVICE_URL,internalSecret:env.VISION_SERVICE_SECRET,timeoutMs:120_000});
  const observations: Cache["observations"] = []; let providers: string[] = [];
  for (const page of [...new Set(selected.map(index => tiles[index]!.page))].sort((a,b)=>a-b)) {
    signal.throwIfAborted(); const bytes=await readCached(`${pattern[1]}.p${page}.${pattern[2]}`,32*1024*1024), image=sharp(bytes,{limitInputPixels:8*1024*1024}), info=await image.metadata();
    const rows = Math.min(5,Math.ceil((m.index.frameCount-page*25)/5)); if (info.width !== m.storyboard.tile_width*5 || info.height !== m.storyboard.tile_height*rows) throw new Error("Cached page geometry changed");
    const pageTiles=selected.map(index=>tiles[index]!).filter(tile=>tile.page===page);
    for (let offset=0;offset<pageTiles.length;offset+=4) {
      signal.throwIfAborted(); const items=await Promise.all(pageTiles.slice(offset,offset+4).map(async tile => { const png=await sharp(bytes,{limitInputPixels:8*1024*1024}).extract({left:tile.x,top:tile.y,width:m.storyboard.tile_width,height:m.storyboard.tile_height}).png().toBuffer(); return {index:tile.index,timestampSeconds:tile.timestamp,image:new Blob([new Uint8Array(png)],{type:"image/png"})}; }));
      const result=await adapter.observe({generationIdentity:g.identity,items},signal);
      if (!result.policy || result.frames.some(f=>f.detected===null || f.max_confidence===null)) throw new Error("Incomplete face observations remain unknown");
      if (result.policy.model_sha256 !== TEMPORAL_FACE_SHA256 || result.policy.input_size.join() !== "640,640" || result.policy.confidence !== .5 || result.policy.nms !== .4 || !result.policy.providers.some(p=>p!=="CPUExecutionProvider")) throw new Error("Pinned shared GPU face detector unavailable");
      providers=[...new Set([...providers,...result.policy.providers])];
      for (const f of result.frames) if (f.detected !== null && f.max_confidence !== null) observations.push({index:f.index,timestamp:f.timestamp,detected:f.detected,max_confidence:f.max_confidence});
    }
  }
  if (observations.length !== selected.length || new Set(observations.map(f=>f.index)).size !== selected.length || observations.some(f=>!selected.includes(f.index) || f.timestamp!==frames.timestamps[f.index])) throw new Error("Complete planned face observations required");
  observations.sort((a,b)=>a.index-b.index);
  const faceHash=digest(JSON.stringify(observations)), candidates: Cache["candidates"] = [], cuts: Cache["cuts"] = [];
  for (const c of controls) {
    const result=proposeTemporalPreference({generationIdentity:g.identity,stateGenerationIdentity:g.identity,faceGenerationIdentity:g.identity,probeSha256:policy.probe_sha256,timestamps:frames.timestamps,probabilities,faces:observations,original:[c.p.start_seconds,c.p.end_seconds],control:c.range});
    const bounds=result.candidate_range??c.range; cuts.push({id:c.p.id,start_seconds:bounds[0],end_seconds:bounds[1]});
    if (result.candidate_range) candidates.push({id:c.p.id,candidate_id:digest(JSON.stringify([g.identity,c.p.id,bounds,loaded.sha256])),original:[c.p.start_seconds,c.p.end_seconds],control:c.range,range:bounds,generation_identity:g.identity,frame_checkpoint_sha256:frameHash,face_checkpoint_sha256:faceHash,prior_control_receipt_sha256:digest(JSON.stringify([g.identity,policy.control_sha256,c.range,c.score])),selector_report_sha256:digest(JSON.stringify(result)),missing_face_is_unknown:true});
  }
  signal.throwIfAborted(); const current=await input.metadata(), nowPolicy=await loadRecordingTemporalPolicy(input.policyPath);
  if (!current || (await recordingTemporalGeneration(current)).identity !== g.identity || nowPolicy?.sha256 !== loaded.sha256) throw new Error("Generation/policy changed during inference");
  for (const file of files) if (await fingerprint(file.path) !== file.fingerprint) throw new Error("Storyboard changed during inference");
  const cache=checkedCache({schema_version:1,identity:g.identity,identity_json:g.identityJson,policy_sha256:loaded.sha256,files,cuts,candidates,model_sha256:TEMPORAL_FACE_SHA256,providers,observations},g,loaded.sha256), bytes=JSON.stringify(cache);
  if (Buffer.byteLength(bytes) > MAX_CACHE_BYTES) throw new Error("Temporal numeric output budget exceeded");
  const temporary=`${path}.${randomUUID()}.tmp`; await writeFile(temporary,bytes,{mode:0o600,flag:"wx"}); await rename(temporary,path); input.onReady?.(m.videoId);
}
