/** Freeze existing numeric training data and a bounded recording archive inventory. No media decoding/deletion. */
import { createHash } from 'node:crypto';
import { mkdir, writeFile, stat, realpath } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { db, closeDrizzleDatabase } from '../../src/config/drizzle';
import { videosTable, recordingReviewsTable, videoVisualIndexTable } from '../../src/database/schema';
import { preserveRecordingReviewsBeforeDeletion } from '../../src/modules/recordings/recordings.deletion-preflight';
import { encodeSnapshotFeatures, snapshotFeatureIdentity, type SnapshotSource, type SnapshotIndex } from '../../src/modules/recordings/recordings.snapshots';
import { recordingScope } from '../../src/modules/recordings/recordings.scope';
import { usernameFromFileName, goondvr } from '../../src/modules/recordings/recordings.goondvr';
const root=resolve('vision-lab/data/recording-storage-archive-20261010');
const nas='/mnt/nas/backup/kura/recordings-20261010';
const hash=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
async function save(name:string,data:unknown){await writeFile(resolve(root,name),JSON.stringify(data,null,2)+'\n',{mode:0o600,flag:'wx'});}
try {
  await mkdir(root,{recursive:true,mode:0o700});await mkdir(resolve(root,'visual-features'),{recursive:true,mode:0o700});
  const scope=await recordingScope();if(scope.directoryId!==67 || scope.clipsDirectoryId!==1)throw new Error('Recording scope changed');
  const active=await db.execute(sql`SELECT id FROM edit_jobs WHERE active_video_id IS NOT NULL`);if(active.length)throw new Error('Active edits; retry after completion');
  const videos=await db.select().from(videosTable).where(eq(videosTable.directoryId,scope.directoryId));
  const reviews=await db.select().from(recordingReviewsTable);
  const allOutputs=await db.select().from(videosTable).where(eq(videosTable.directoryId,scope.clipsDirectoryId));
  const outputs=new Map(allOutputs.map(v=>[v.id,v]));
  const owned=await goondvr.recordings();
  const inventory=[];const protectedIds=[];const missingOutputs=[];
  for(const v of videos){
    const source=await realpath(v.filePath).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return null;throw e;});if(source&&!source.startsWith('/mnt/hd4tb/goondvr/videos/completed/'))throw new Error('Unexpected recording root');
    const s=source?await stat(source,{bigint:true}):null;if(s&&(!s.isFile()||s.size!==BigInt(v.fileSizeBytes)))throw new Error(`Source mismatch ${v.id}`);
    const r=reviews.find(r=>r.videoId===v.id);const incomplete=[];
    for(const c of r?.clips??[]){if(!c.keep)continue;
      const out=c.output_video_id?outputs.get(c.output_video_id):null;
      const present=out?await stat(out.filePath).then(s=>s.isFile()&&s.size===out.fileSizeBytes&&s.size>0).catch(()=>false):false;
      if(!present){incomplete.push(c.id);if(c.output_video_id)missingOutputs.push({video_id:v.id,clip_id:c.id,output_video_id:c.output_video_id});}
    }
    const confirmed=!!r&&(r.savedAt!==null||r.status==='done'||r.status==='rendering'||r.clips.some(c=>!!c.output_video_id||!!c.job_id));
    if(confirmed&&incomplete.length)protectedIds.push(v.id);
    const g=owned.find(x=>x.name===v.fileName);if(g?.active)throw new Error(`Active recording ${v.id}`);
    inventory.push({video_id:v.id,source_path:v.filePath,real_path:source,source_exists:!!s,file_name:v.fileName,size_bytes:v.fileSizeBytes,mtime_ns:s?.mtimeNs.toString()??null,ctime_ns:s?.ctimeNs.toString()??null,inode:s?.ino.toString()??null,device:s?.dev.toString()??null,review_status:r?.status??null,review_confirmed:confirmed,analyzed_at:r?.analyzedAt?.toISOString()??null,incomplete_keep_ids:incomplete,goondvr_id:g?.id??null,nas_relative_path:`originals/${v.id}/${basename(v.fileName)}`,remove_after_verified_archive:!!s&&!(confirmed&&incomplete.length)});
  }
  await save('inventory.json',{format:'kura-private-recording-archive',version:1,created_at:new Date().toISOString(),recordings_directory_id:scope.directoryId,clips_directory_id:scope.clipsDirectoryId,nas_destination:nas,total_bytes:inventory.reduce((sum,x)=>sum+x.size_bytes,0),protected_recording_ids:protectedIds,missing_rendered_outputs:missingOutputs,recordings:inventory});
  const confirmations=inventory.filter(x=>x.review_confirmed).map(x=>x.video_id);const snapshotFailures=[];
  for(const id of confirmations){try{await preserveRecordingReviewsBeforeDeletion([id]);}catch(e){snapshotFailures.push({video_id:id,error:e instanceof Error?e.message:String(e)});}}
  await save('snapshot-preservation.json',{confirmed:confirmations.length,passed:confirmations.length-snapshotFailures.length,failures:snapshotFailures});
  console.log(JSON.stringify({phase:'review_snapshots',confirmed:confirmations.length,failed:snapshotFailures.length,protected:protectedIds}));
  const exported=[];
  for(const v of videos){
    const result=await db.transaction(async tx=>{
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      const [i]=await tx.select().from(videoVisualIndexTable).where(eq(videoVisualIndexTable.videoId,v.id));if(!i)throw new Error(`Index missing ${v.id}`);
      const index:SnapshotIndex={modelRevision:i.modelRevision,storyboardGeneratedAt:i.storyboardGeneratedAt.toISOString(),indexedAt:i.indexedAt.toISOString(),intervalSeconds:i.intervalSeconds,frameCount:i.frameCount};
      const source:SnapshotSource={videoId:v.id,fileName:v.fileName,fileHash:v.fileHash,fileSizeBytes:v.fileSizeBytes,durationSeconds:v.durationSeconds,width:v.width,height:v.height,codec:v.codec,audioCodec:v.audioCodec,fps:v.fps,channel:usernameFromFileName(v.fileName)};
      const rows=await tx.execute<{frame_index:number;timestamp_seconds:number;embedding:string}>(sql`SELECT frame_index,timestamp_seconds,embedding::text AS embedding FROM video_frame_embeddings WHERE video_id=${v.id} ORDER BY frame_index LIMIT ${i.frameCount+1}`);
      if(rows.length!==i.frameCount||rows.some((f,n)=>Number(f.frame_index)!==n))throw new Error(`Incomplete frames ${v.id}`);
      const frames={timestamps:rows.map(f=>Number(f.timestamp_seconds)),vectors:rows.map(f=>Float32Array.from(JSON.parse(f.embedding)))};
      const identity=snapshotFeatureIdentity(source,index);return {source,index,identity,bytes:encodeSnapshotFeatures(identity,index,frames)};
    });
    const file=`visual-features/${v.id}.bin`;await writeFile(resolve(root,file),result.bytes,{mode:0o600,flag:'wx'});
    exported.push({source:result.source,index:result.index,identity:result.identity,file,sha256:hash(result.bytes),bytes:result.bytes.length,dimension:1152,review_confirmed:inventory.find(x=>x.video_id===v.id)!.review_confirmed});
    if(exported.length%25===0)console.log(JSON.stringify({phase:'visual_features',completed:exported.length,total:videos.length}));
  }
  await save('visual-features.json',{format:'kura-archived-visual-generations',version:1,note:'Feature coverage is not a human label. Only explicitly confirmed reviews/answers may supply labels.',recordings:exported});
  const ids=sql.join(videos.map(v=>sql`${v.id}`),sql`, `);
  const tables=['watched_directories','videos','edit_jobs','recording_reviews','recording_clip_feedback','recording_label_tasks'];
  const scoped=['video_visual_index','storyboards','video_face_detections','video_classifications','video_audio_fingerprints','video_creators','video_tags'];
  await mkdir(resolve(root,'catalog'),{mode:0o700});const tablesSaved=[];
  for(const table of [...tables,...scoped]){
    const exists=await db.execute(sql`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=${table}`);if(!exists.length)continue;
    const rows=await db.execute(scoped.includes(table)?sql`SELECT * FROM ${sql.identifier(table)} WHERE video_id IN (${ids})`:sql`SELECT * FROM ${sql.identifier(table)}`);
    await save(`catalog/${table}.json`,rows);tablesSaved.push({table,rows:rows.length});
  }
  await save('catalog-tables.json',tablesSaved);
  await save('preparation-complete.json',{status:snapshotFailures.length?'snapshot_failures':'ready',recordings:videos.length,confirmed_reviews:confirmations.length,visual_generations:exported.length,frames:exported.reduce((n,r)=>n+r.index.frameCount,0),protected_recording_ids:protectedIds,snapshot_failures:snapshotFailures,raw_media_reads:0,database_writes:0,originals_removed:0});
  console.log(JSON.stringify({phase:'ready',recordings:videos.length,visual_generations:exported.length,frames:exported.reduce((n,r)=>n+r.index.frameCount,0),snapshot_failures:snapshotFailures}));
}finally{await closeDrizzleDatabase();}
