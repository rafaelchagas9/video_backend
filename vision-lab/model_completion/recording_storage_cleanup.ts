/** Removes only exact verified archived originals; keeps rendered clips and never changes verdicts. */
import {createHash} from 'node:crypto';
import {readFile,writeFile,open,stat,mkdir,cp,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {eq,sql} from 'drizzle-orm';
import {db,closeDrizzleDatabase} from '../../src/config/drizzle';
import {videosTable,recordingReviewsTable} from '../../src/database/schema';
import {videosBulkService} from '../../src/modules/videos/videos.bulk.service';
import {goondvr} from '../../src/modules/recordings/recordings.goondvr';
import {preserveRecordingReviewsBeforeDeletion} from '../../src/modules/recordings/recordings.deletion-preflight';
const root=resolve('vision-lab/data/recording-storage-archive-20261010');
const bytes=await readFile(resolve(root,'inventory.json'));
const inventory=JSON.parse(bytes.toString());
if(process.argv[2]!==createHash('sha256').update(bytes).digest('hex'))throw new Error('Exact reviewed inventory digest required');
const nas=resolve(inventory.nas_destination);
if(nas!=='/mnt/nas/backup/kura/recordings-20261010')throw new Error('Unexpected NAS root');
const forbidden=new Set<number>(inventory.protected_recording_ids);
const done=new Set<number>();const retained=new Map<number,string>();
let removedBytes=0,removed=0;
async function journal(row:unknown){const line=JSON.stringify(row)+'\n';for(const path of [resolve(root,'cleanup-receipts.jsonl'),resolve(nas,'cleanup-receipts.jsonl')]){const file=await open(path,'a',0o600);try{await file.writeFile(line);await file.sync();}finally{await file.close();}}}
async function state(status:string){await writeFile(resolve(root,'cleanup-state.json'),JSON.stringify({status,updated_at:new Date().toISOString(),removed_recordings:removed,removed_bytes:removedBytes,protected_recording_ids:[...forbidden],retained:[...retained].map(([id,reason])=>({id,reason}))},null,2)+'\n',{mode:0o600});}
function match(s:Awaited<ReturnType<typeof stat>>,expected:any):boolean{return s.isFile()&&s.size===BigInt(expected.size_bytes)&&s.mtimeNs===BigInt(expected.mtime_ns)&&s.ctimeNs===BigInt(expected.ctime_ns)&&s.ino===BigInt(expected.inode)&&s.dev===BigInt(expected.device);}
async function receipts():Promise<any[]>{try{return (await readFile(resolve(root,'archive-receipts.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));}catch(e:any){if(e.code==='ENOENT')return [];throw e;}}
const started=Date.now();
try{
  if(process.argv.includes('--check')){
    const eligible=inventory.recordings.filter((r:any)=>r.remove_after_verified_archive);
    for(const item of eligible){
      const [r]=await db.select().from(recordingReviewsTable).where(eq(recordingReviewsTable.videoId,item.video_id));
      if(!r||!['done','dismissed'].includes(r.status))throw new Error('Handled scope changed during preflight');
      const rows=await db.execute(sql`SELECT id FROM videos WHERE id=${item.video_id} AND file_path=${item.source_path} AND directory_id=${inventory.recordings_directory_id} AND file_size_bytes=${item.size_bytes} AND EXISTS (SELECT 1 FROM recording_reviews r WHERE r.video_id=videos.id AND r.analyzed_at=${r.analyzedAt.toISOString()}::timestamp AND r.updated_at=${r.updatedAt.toISOString()}::timestamp AND r.saved_at IS NOT DISTINCT FROM ${r.savedAt?.toISOString()??null}::timestamp AND r.clips=${JSON.stringify(r.clips)}::jsonb AND r.status=${r.status})`);
      if(rows.length!==1)throw new Error(`Generation guard did not match ${item.video_id}`);
    }
    console.log(JSON.stringify({status:'read_only_preflight_passed',eligible_handled_recordings:eligible.length,eligible_bytes:eligible.reduce((n:number,r:any)=>n+r.size_bytes,0),database_writes:0,originals_removed:0}));
    await closeDrizzleDatabase();process.exit(0);
  }
  await state('waiting_for_verified_copies');
  while(Date.now()-started<6*3600_000){
    const archive=JSON.parse(await readFile(resolve(root,'archive-state.json'),'utf8'));
    if(archive.status==='failed')throw new Error('Archive failed: cleanup stopped');
    if(archive.training_package_sha256){
      const training=JSON.parse(await readFile(resolve(nas,'training-package.receipt.json'),'utf8'));
      if(training.status!=='verified'||training.sha256!==archive.training_package_sha256||!training.nas_checksum_verified||!training.tar_entries_checked)throw new Error('Training package was not verified');
      for(const receipt of await receipts()){
        const id=Number(receipt.video_id);if(done.has(id)||retained.has(id)||forbidden.has(id))continue;
        const item=inventory.recordings.find((r:any)=>r.video_id===id);
        if(!item||!item.remove_after_verified_archive)continue;
        if(!item.handled||!receipt.nas_checksum_verified||receipt.destination!==resolve(nas,item.nas_relative_path))throw new Error('Unapproved archive receipt');
        for(const key of ['size_bytes','mtime_ns','ctime_ns','inode','device'])if(receipt.source_signature[key]!==item[key])throw new Error('Archive receipt differs from frozen inventory');
        if(receipt.bytes!==item.size_bytes||receipt.removal_eligible!==item.remove_after_verified_archive)throw new Error('Archive removal scope differs');
        if(!match(await stat(receipt.destination,{bigint:true}),receipt.destination_signature))throw new Error(`NAS copy changed ${id}`);
        const [video]=await db.select().from(videosTable).where(eq(videosTable.id,id));
        if(!video){retained.set(id,'Catalog changed; no automatic retry');continue;}
        if(video.directoryId!==inventory.recordings_directory_id||video.filePath!==item.source_path||video.fileSizeBytes!==item.size_bytes||await realpath(video.filePath)!==item.real_path||!match(await stat(video.filePath,{bigint:true}),receipt.source_signature)){retained.set(id,'Source generation changed');continue;}
        await videosBulkService.assertNoActiveEditJobs([id]);
        const [review]=await db.select().from(recordingReviewsTable).where(eq(recordingReviewsTable.videoId,id));
        const confirmed=!!review&&(review.savedAt!==null||review.status==='done'||review.status==='rendering'||review.clips.some(c=>!!c.output_video_id||!!c.job_id));
        let incomplete=false;
        if(confirmed)for(const clip of review.clips){if(!clip.keep)continue;const [output]=clip.output_video_id?await db.select().from(videosTable).where(eq(videosTable.id,clip.output_video_id)):[];if(!output||output.directoryId===inventory.recordings_directory_id||!await stat(output.filePath).then(s=>s.isFile()&&s.size===output.fileSizeBytes&&s.size>0).catch(()=>false))incomplete=true;}
        if(!confirmed||!review||!['done','dismissed'].includes(review.status)){retained.set(id,'Recording is not handled');continue;}
        if(incomplete){retained.set(id,'Saved keep has no usable rendered output');continue;}
        if(review?.status==='rendering'){retained.set(id,'Rendering started');continue;}
        await preserveRecordingReviewsBeforeDeletion([id]);
        const folder=resolve(nas,'latest-metadata',String(id));await mkdir(folder,{recursive:true,mode:0o700});
        const labels=await db.execute(sql`SELECT * FROM recording_label_tasks WHERE video_id=${id}`);
        const feedback=await db.execute(sql`SELECT * FROM recording_clip_feedback WHERE video_id=${id}`);
        await writeFile(resolve(folder,'catalog-before-removal.json'),JSON.stringify({video,review:review??null,labels,feedback},null,2)+'\n',{mode:0o600});
        if(confirmed)await cp(resolve('data/recording-training-snapshots',String(id)),resolve(folder,'training-snapshots'),{recursive:true,errorOnExist:true,force:false});
        await journal({stage:'prepared',video_id:id,nas_copy:receipt.destination,sha256:receipt.sha256,bytes:item.size_bytes,feedback_verdicts_unchanged:true,at:new Date().toISOString()});
        const catalogGuard=sql`file_path=${item.source_path} AND directory_id=${inventory.recordings_directory_id} AND file_size_bytes=${item.size_bytes} AND ${review?sql`EXISTS (SELECT 1 FROM recording_reviews r WHERE r.video_id=videos.id AND r.analyzed_at=${review.analyzedAt.toISOString()}::timestamp AND r.updated_at=${review.updatedAt.toISOString()}::timestamp AND r.saved_at IS NOT DISTINCT FROM ${review.savedAt?.toISOString()??null}::timestamp AND r.clips=${JSON.stringify(review.clips)}::jsonb AND r.status=${review.status})`:sql`NOT EXISTS (SELECT 1 FROM recording_reviews r WHERE r.video_id=videos.id)`}`;
        await videosBulkService.bulkDelete([id],{catalogGuard,removeSource:async v=>{
          if(v.id!==id||v.filePath!==item.source_path||!match(await stat(v.filePath,{bigint:true}),receipt.source_signature))throw new Error('Source changed after catalog guard; original retained');
          if(item.goondvr_id&&!await goondvr.deleteRecording(item.goondvr_id))throw new Error(`Recorder refused removal ${id}; source retained for reconciliation`);
        }});
        if(await stat(item.source_path).then(()=>true).catch((e:any)=>{if(e.code==='ENOENT')return false;throw e;}))throw new Error(`Original remains after cleanup ${id}`);
        done.add(id);removed++;removedBytes+=item.size_bytes;
        await journal({stage:'removed',video_id:id,bytes:item.size_bytes,at:new Date().toISOString()});await state('freeing_verified_originals');
        console.log(JSON.stringify({removed_recordings:removed,freed_bytes:removedBytes}));
      }
    }
    if(archive.status==='archive_verified'){
      await state('completed_with_protected_keeps');
      await cp(resolve(root,'cleanup-state.json'),resolve(nas,'cleanup-complete.json'),{errorOnExist:true,force:false});
      console.log(JSON.stringify({status:'completed_with_protected_keeps',removed_recordings:removed,freed_bytes:removedBytes,protected_recording_ids:[...forbidden],retained:[...retained]}));break;
    }
    await new Promise(done=>setTimeout(done,5000));
  }
  if(Date.now()-started>=6*3600_000)throw new Error('Six-hour cleanup bound expired');
}catch(error){await state('stopped');console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}finally{await closeDrizzleDatabase();}
