/** Bounded local deployment proof; read-only database, numeric cache writes only. */
import { sql } from "drizzle-orm";
import { db, closeDrizzleDatabase } from "../../src/config/drizzle";
import { visualSearchStore } from "../../src/modules/visual-search/visual-search.service";
import { recordingTemporalReview, recordingTemporalOriginalProposals, type RecordingTemporalMetadata } from "../../src/modules/recordings/recordings.temporal-runtime";
import { readFile,writeFile,mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const out="vision-lab/data/model-completion-20261010/temporal-production-v1",policyPath=`${out}/preflight-policy.json`;
const p=JSON.parse(await readFile("data/models/recording-temporal-policy.json","utf8"));p.enabled=true;await mkdir(out,{recursive:true,mode:0o700});await writeFile(policyPath,JSON.stringify(p,null,2)+"\n",{mode:0o600});
const requested=Number(process.argv[2]??6209);
const rows=await db.execute<{video_id:number}>(sql`SELECT r.video_id FROM recording_reviews r JOIN videos v ON v.id=r.video_id JOIN video_visual_index i ON i.video_id=v.id JOIN storyboards s ON s.video_id=v.id WHERE v.is_available=true AND i.frame_count<=1200 AND i.frame_count>80 AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(r.proposals,r.clips)) p WHERE CASE WHEN r.proposals IS NOT NULL THEN (p->>'end_seconds')::float-(p->>'start_seconds')::float ELSE (p->'detected'->>'end_seconds')::float-(p->'detected'->>'start_seconds')::float END >=240) ORDER BY CASE WHEN r.video_id=${requested} THEN 0 ELSE 1 END, i.frame_count LIMIT 1`);
const videoId=Number(rows[0]?.video_id);if(!videoId)throw new Error("No eligible existing generation");
let completion=false;
const utc=(value:unknown):Date=>{if(value instanceof Date)return value;const text=String(value).replace(" ","T");return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text)?text:text+"Z");};
const metadata=async():Promise<RecordingTemporalMetadata|null>=>{
  const [r]=await db.execute<Record<string,any>>(sql`SELECT r.analyzed_at,r.proposals,r.clips,r.saved_at,v.file_path,v.file_size_bytes,v.duration_seconds,i.model_revision,i.storyboard_generated_at,i.indexed_at,i.interval_seconds AS index_interval,i.frame_count,s.id AS storyboard_id,s.sprite_path,s.vtt_path,s.tile_width,s.tile_height,s.tile_count,s.interval_seconds,s.sprite_size_bytes,s.generated_at FROM recording_reviews r JOIN videos v ON v.id=r.video_id JOIN video_visual_index i ON i.video_id=v.id JOIN storyboards s ON s.video_id=v.id WHERE r.video_id=${videoId} AND v.is_available=true`);
  if(!r)return null;return{videoId,analyzedAt:utc(r.analyzed_at).toISOString(),duration:Number(r.duration_seconds),proposals:recordingTemporalOriginalProposals(r.proposals,r.clips)!,source:{path:r.file_path,sizeBytes:Number(r.file_size_bytes)},index:{modelRevision:r.model_revision,storyboardGeneratedAt:utc(r.storyboard_generated_at),indexedAt:utc(r.indexed_at),intervalSeconds:Number(r.index_interval),frameCount:Number(r.frame_count)},storyboard:{id:r.storyboard_id,video_id:videoId,sprite_path:r.sprite_path,vtt_path:r.vtt_path,tile_width:r.tile_width,tile_height:r.tile_height,tile_count:r.tile_count,interval_seconds:Number(r.interval_seconds),sprite_size_bytes:r.sprite_size_bytes,generated_at:utc(r.generated_at).toISOString()}};
};
const saved=async()=>{const [r]=await db.execute(sql`SELECT analyzed_at,proposals,clips,saved_at,status FROM recording_reviews WHERE video_id=${videoId}`);return createHash("sha256").update(JSON.stringify(r)).digest("hex");};
const before=await saved(),start=Date.now(),input={metadata,frames:()=>visualSearchStore().videoFrames(videoId),policyPath,onReady:()=>{completion=true;}};
let result=await recordingTemporalReview(input);const deadline=Date.now()+270_000;
while(!result&&Date.now()<deadline){await new Promise(done=>setTimeout(done,1000));result=await recordingTemporalReview({...input,prepare:false});}
const after=await saved(), report={status:result?"passed":"unavailable",video_id:videoId,seconds:(Date.now()-start)/1000,ready_event:completion,source_review_unchanged:before===after,cut_count:result?.cuts.length??0,challenger_count:result?.versions.candidates.length??0,scope:result?.versions.scope??null,selector_version:result?.versions.version??null,artifact_sha256:result?.versions.artifact_sha256??null,raw_recording_reads:0,cloud_uploads:0};
await writeFile(`${out}/live-generation-preflight.${videoId}.json`,JSON.stringify(report,null,2)+"\n",{mode:0o600});console.log(JSON.stringify(report));await closeDrizzleDatabase();process.exit(result&&before===after?0:1);
