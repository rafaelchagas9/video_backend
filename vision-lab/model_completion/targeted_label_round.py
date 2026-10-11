"""Eight fixed existing-recording comparisons; prepare first, audited insert explicitly.

No source media/frame decode, new recordings, model inference, automatic redraw or cache writes.
"""
from __future__ import annotations
import argparse,ast,datetime,hashlib,json,math,os,random,re
from pathlib import Path
LAB=Path(__file__).resolve().parents[1]
BACKEND=LAB.parent
BATCH='versus-targeted-20261010-1'
SEED=20261010
PAIRS=[(284,286),(696,697),(485,592),(575,632),(186,189),(432,435),(266,268),(712,713)]
VISUAL_PIN='siglip2/so400m-patch16-256'
OUT=LAB/'data/model-completion-20261010/targeted-label-round'
POLICY={'batch':BATCH,'pairs':PAIRS,'seed':SEED,'count':8,'target':'Current keep candidates: A/B orders two accepted candidates; both no strict preference; neither rejects both currently. Only selected sides have explicit final-cut targets. Replacement/permanent worth unknown.', 'cuts':'Full immutable original detected clip bounds; initial best is saved coarse range, no four-minute cap or learned cut. Winner cut confirms final selected interval.', 'snippets':'Existing numeric cheap activity only with exact feedback/generation/source/index receipt; otherwise bounded midpoint15s. No cache/media/frame reads to generate missing features.', 'selection':'Eight fixed new fine channels; first two short pairs; no redraw/repeated sides/pairs.', 'holdout':'Predeclared before any answers: positions0..3 training4newchannels/8sides,positions4..7 untouched future fine holdout4newchannels/8sides. Never change roles after answers; held-out channels cannot fit or select models/thresholds.', 'safety':'Prepare immutable private manifest, root audit, then explicit finite transactional insertion; revalidate live feedback/source/index/storyboard/duration and metadata hashes immediately before insert. Preserve all existing tasks/answers. No new recordings/GPU/decode/cloud.'}


def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def canon(value):return re.sub(r'^@','',value or '').lower()
def stamp(value):
 if value is None:return None
 if isinstance(value,str):return value
 if value.tzinfo is None:value=value.replace(tzinfo=datetime.timezone.utc)
 return value.astimezone(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
def source_fingerprint(path):
 path=Path(path)
 if not path.is_file():raise ValueError('Target recording source is not playable')
 stat=path.stat()
 return {'size_bytes':stat.st_size,'mtime_ns':str(stat.st_mtime_ns),'path_identity_sha256':hashlib.sha256(str(path.resolve()).encode()).hexdigest()}
def save_frozen(path,value):
 path=Path(path)
 if path.exists():
  if json.loads(path.read_text())!=value:raise ValueError('Frozen targeted batch differs; no overwrite')
  return
 path.parent.mkdir(parents=True,exist_ok=True,mode=0o700);path.parent.chmod(0o700);tmp=path.with_suffix('.partial')
 with tmp.open('w') as f:json.dump(value,f,allow_nan=False,indent=2);f.flush();os.fsync(f.fileno())
 tmp.chmod(0o600);tmp.replace(path)
def pg_config():
 # Read existing configuration without importing a module with filesystem side effects.
 return next(ast.literal_eval(n.value) for n in ast.parse((LAB/'label_server.py').read_text()).body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='PG' for t in n.targets))

COLS=['feedback_id','video_id','clip_id','channel','analyzed_at','start','end','original_start','original_end','score','file_path','file_name','duration','saved_at','review_generation','model_revision','frame_count','interval_seconds','storyboard_generated_at','indexed_at','storyboard_at','vtt_path','actual_frame_count','last_frame_timestamp','detector','verdict','added','merged_into','label_type']
QUERY="""SELECT f.id,f.video_id,f.clip_id,f.channel,f.analyzed_at,f.start_seconds,f.end_seconds,f.detected_start,f.detected_end,f.score,v.file_path,v.file_name,v.duration_seconds,r.saved_at,r.analyzed_at,i.model_revision,i.frame_count,i.interval_seconds,i.storyboard_generated_at,i.indexed_at,s.generated_at,s.vtt_path,(SELECT count(*) FROM video_frame_embeddings e WHERE e.video_id=v.id),(SELECT max(timestamp_seconds) FROM video_frame_embeddings e WHERE e.video_id=v.id),f.detector,f.verdict,f.added,f.merged_into,f.label_type FROM recording_clip_feedback f JOIN videos v ON v.id=f.video_id JOIN recording_reviews r ON r.video_id=v.id JOIN video_visual_index i ON i.video_id=v.id JOIN storyboards s ON s.video_id=v.id WHERE f.id=ANY(%s)"""


def load_rows(connection,lock=False):
 ids=[x for pair in PAIRS for x in pair]
 sql=QUERY+(' FOR SHARE OF f,v,r,i,s' if lock else '')
 rows={r['feedback_id']:r for r in (dict(zip(COLS,raw)) for raw in connection.execute(sql,(ids,)).fetchall())}
 if set(rows)!=set(ids):raise ValueError('All16 fixed feedback/source/index/storyboard rows required')
 return rows


def side(row):
 fid=row['feedback_id'];vid=row['video_id'];a,b=row['original_start'],row['original_end'];start,end=row['start'],row['end'];duration=row['duration']
 if row['verdict']!='keep' or row['added'] or row['merged_into'] is not None or row['label_type']!='triage':raise ValueError('Target is not an original saved keep')
 if row['saved_at'] is None or row['review_generation']!=row['analyzed_at']:raise ValueError('Target analysis is not current confirmed generation')
 if any(x is None or not math.isfinite(float(x)) for x in (a,b,start,end,duration,row['score'])) or not 0<=a<=start<end<=b<=duration+.1 or end-start<15:raise ValueError('Target original/saved/live duration bounds invalid')
 if row['model_revision']!=VISUAL_PIN or row['interval_seconds']!=5 or row['frame_count']<=0 or row['actual_frame_count']!=row['frame_count'] or stamp(row['storyboard_generated_at'])!=stamp(row['storyboard_at']) or row['last_frame_timestamp'] is None or row['last_frame_timestamp']+5<b-.1:raise ValueError('Target indexed storyboard coverage/generation invalid')
 vtt=Path(row['vtt_path']);vtt=vtt if vtt.is_absolute() else BACKEND/vtt
 if not vtt.is_file():raise ValueError('Target storyboard VTT is absent')
 fingerprint=source_fingerprint(row['file_path']);generation=stamp(row['analyzed_at']);index={'model_revision':row['model_revision'],'frame_count':row['frame_count'],'interval_seconds':row['interval_seconds'],'storyboard_generated_at':stamp(row['storyboard_generated_at']),'indexed_at':stamp(row['indexed_at'])}
 # ID-only legacy audio arrays lack exact provenance; midpoint is deliberate, not a peak claim.
 midpoint=(start+end)/2;span=min(15.,end-start);snippet=[midpoint-span/2,midpoint+span/2]
 return {'feedback_id':fid,'video_id':vid,'file_name':row['file_name'],'clip':[a,b],'best':[start,end],'snippet':snippet,'snippet_recipe':'midpoint15s_no_validated_activity_receipt','score':row['score'],'duration_seconds':duration,'analyzed_at':generation,'source_fingerprint':fingerprint,'index':index,'detector':row['detector'],'initial_best_source':'existing_saved_coarse_range'}


def make_manifest(rows,tasks):
 answered_channels={canon(t['channel']) for t in tasks if t['answer'] is not None};used_pairs=set();used_sides=set()
 for task in tasks:
  context=task['context'] or {}
  if 'a' in context and 'b' in context:used_pairs.add(frozenset((context['a']['feedback_id'],context['b']['feedback_id'])));used_sides.update((context['a']['feedback_id'],context['b']['feedback_id']))
 rng=random.Random(SEED);pairs=[];channels=[]
 for position,(fa,fb) in enumerate(PAIRS):
  channel=canon(rows[fa]['channel'])
  if not channel or canon(rows[fb]['channel'])!=channel or channel in channels or channel in answered_channels:raise ValueError('Fixed batch requires8 distinct new fine channels')
  if frozenset((fa,fb)) in used_pairs or fa in used_sides or fb in used_sides:raise ValueError('Fixed pair/side already asked; no duplication')
  a,b=side(rows[fa]),side(rows[fb])
  if rng.random()<.5:a,b=b,a
  channels.append(channel);context={'a':a,'b':b,'channel':rows[fa]['channel'],'selection':'targeted_new_fine_channel','batch_policy':BATCH,'target_semantics':'current_acceptability_and_strict_preference','cut_target':'final_saved_interval_within_original','reserved_fine_holdout':position>=4,'fine_data_role':'holdout' if position>=4 else 'training','randomization_seed':SEED}
  pairs.append({'kind':'versus','batch':BATCH,'position':position,'video_id':a['video_id'],'start_seconds':a['best'][0],'end_seconds':a['best'][1],'channel':rows[fa]['channel'],'stratum':'targeted-new-channel','context':context})
 return {'schema_version':1,'policy':json.loads(json.dumps(POLICY)),'source_sha256':digest(Path(__file__)),'rows':pairs,'holdout_channels':channels[4:],'training_channels':channels[:4],'source_reads':'metadata stat only; no media/frame content','no_fits_or_new_features':True}


def tasks(connection):return [dict(zip(['id','batch','answer','channel','context'],r)) for r in connection.execute("SELECT id,batch,answer,channel,context FROM recording_label_tasks WHERE kind='versus'").fetchall()]


def prepare(out):
 import psycopg
 with psycopg.connect(pg_config()) as connection:
  connection.execute('SET TRANSACTION READ ONLY');connection.execute("SET statement_timeout='15s'");manifest=make_manifest(load_rows(connection),tasks(connection))
 save_frozen(out/'private_manifest.json',manifest);save_frozen(out/'fine_holdout.json',{'batch':BATCH,'channels':manifest['holdout_channels'],'positions':[4,5,6,7],'target':'Future untouched fine evaluation only; no fitting, model/family/threshold selection on these channel answers','channel_count':4,'side_count':8,'source_manifest_sha256':digest(out/'private_manifest.json')})
 save_frozen(out/'fine_training.json',{'batch':BATCH,'channels':manifest['training_channels'],'positions':[0,1,2,3],'channel_count':4,'side_count':8,'role':'Training only; holdout positions4..7 remain unavailable for fitting/selection','source_manifest_sha256':digest(out/'private_manifest.json')})
 print(json.dumps({'status':'prepared_for_review','batch':BATCH,'pairs':8,'channels':8,'manifest_sha256':digest(out/'private_manifest.json'),'snippets':'bounded15s midpoint; no generation-verified cheap audio','queue_writes':0}))


def existing_match(existing,planned):
 if len(existing)!=8:raise ValueError('Existing targeted batch is incomplete; preserve it and inspect')
 expected={r['position']:r for r in planned}
 for row in existing:
  value=expected.get(row['position'])
  if value is None or any(row[k]!=value[k] for k in ('video_id','start_seconds','end_seconds','channel','context')):raise ValueError('Existing targeted batch differs; no answer/task overwrite')
 return True


def validate_replay(live_rows,planned):
 for row in planned:
  for key in ('a','b'):
   expected=row['context'][key];live=live_rows.get(expected['feedback_id'])
   if live is None or side(live)!=expected:raise ValueError('Existing targeted batch live source/generation/index differs; preserve answers')


def insert(out,expected_hash):
 # Explicit CLI hash is the reviewed concrete artifact authorization boundary.
 import psycopg
 path=out/'private_manifest.json'
 if digest(path)!=expected_hash:raise ValueError('Reviewed targeted manifest hash differs')
 manifest=json.loads(path.read_text())
 if manifest['source_sha256']!=digest(Path(__file__)) or manifest['policy']!=json.loads(json.dumps(POLICY)):raise ValueError('Reviewed source/policy changed')
 with psycopg.connect(pg_config()) as connection:
  connection.execute("SET statement_timeout='15s'");connection.execute("SET lock_timeout='5s'")
  connection.execute('LOCK TABLE recording_label_tasks IN SHARE ROW EXCLUSIVE MODE')
  columns=['id','position','video_id','start_seconds','end_seconds','channel','context','answer']
  existing=[dict(zip(columns,r)) for r in connection.execute("SELECT id,position,video_id,start_seconds,end_seconds,channel,context,answer FROM recording_label_tasks WHERE kind='versus' AND batch=%s ORDER BY position",(BATCH,)).fetchall()]
  if existing:
   # Idempotent replay never changes answers, but still proves all sources currently playable.
   validate_replay(load_rows(connection,lock=True),manifest['rows'])
   existing_match(existing,manifest['rows']);written=0
  else:
   fresh=make_manifest(load_rows(connection,lock=True),tasks(connection))
   if fresh!=manifest:raise ValueError('Target metadata/source/generation changed since review')
   written=0
   for row in manifest['rows']:
    written+=connection.execute("INSERT INTO recording_label_tasks(kind,batch,video_id,start_seconds,end_seconds,stratum,position,channel,context) VALUES('versus',%s,%s,%s,%s,%s,%s,%s,%s::jsonb)",(BATCH,row['video_id'],row['start_seconds'],row['end_seconds'],row['stratum'],row['position'],row['channel'],json.dumps(row['context'],allow_nan=False))).rowcount
   if written!=8:raise ValueError('Finite batch did not insert exactly8; rollback')
  actual=connection.execute("SELECT count(*),count(*) FILTER(WHERE answer IS NULL) FROM recording_label_tasks WHERE kind='versus' AND batch=%s",(BATCH,)).fetchone()
  if actual[0]!=8:raise ValueError('Finite targeted batch count differs; rollback')
 print(json.dumps({'status':'inserted' if written else 'already_present_preserved','batch':BATCH,'inserted':written,'total':actual[0],'pending':actual[1],'manifest_sha256':expected_hash,'no_new_recordings':True}))

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['prepare','insert']);p.add_argument('--output',type=Path,default=OUT);p.add_argument('--manifest-sha256');a=p.parse_args()
 if a.mode=='prepare':prepare(a.output)
 else:
  if not a.manifest_sha256:p.error('insert requires exact reviewed --manifest-sha256')
  insert(a.output,a.manifest_sha256)
