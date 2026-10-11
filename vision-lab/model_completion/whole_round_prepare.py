"""Bounded explicit whole-retention preparation; numeric-only, never queue/model writes."""
from __future__ import annotations
import argparse,copy,datetime,hashlib,json,math,os,signal,tempfile,time,zipfile
PROCESS_START=time.monotonic()
from pathlib import Path
import targeted_label_round as base
import creator_expansion_v2 as safe
import whole_verdict_labels as labels
import whole_review_inputs as recipe
import channel_partial_order as io
from channel_partial_order import immutable_write
BATCH='whole-verdict-20261010-1'
OUT=base.LAB/'data/model-completion-20261010/whole-verdict-round-v1'
HIST=Path(__file__).parent/'artifacts/whole-review-labels'
HISTORY_FILES=['eligibility.whole-recording-current-review-v1.json','private-identity.whole-recording-current-review-v1.json']
MAX_TASKS=16
MAX_SECONDS=180
MAX_BYTES=64*1024*1024
MAX_TOTAL=256*1024*1024
FIELDS=['kind','batch','position','video_id','start_seconds','end_seconds','channel','stratum','context']
POLICY={'version':1,'batch':BATCH,'target':labels.TARGET,'max_tasks':16,'max_recordings_per_creator':1,'selection':'Deterministic seeded hash among existing saved mixed reviews without an explicit whole decision. No fitted scores, duration/coverage ranking, fine/preference outcomes or expected class balance. Exclude exact known whole sources and all fourteen previously clarified near-full source IDs; those historical unknown receipts remain unchanged.','labels':'Only explicit four-choice current retention answers create new labels. No cut, clip acceptability, outside-quality, future replacement or permanent storage labels.','sampling':'Creator-balanced purposive unknown-source sample; not population prevalence or calibrated acceptance evidence. Class counts/folds must be checked after actual answers; positives are never manufactured.','budget':'180 seconds including numeric reads; <=16 sources, <=8000 frames/source, <=64MiB checkpoint and <=256MiB total numeric frame bytes. No source media contents, GPU, cloud, fits or new recordings.','evaluation':'Training only, all four reserved fine creators excluded before outcomes or numeric reads. Historical labels remain separate immutable artifacts.','automatic_action':False,'production_model_activation':False}
META=['video_id','file_path','duration','channel','analyzed_at','saved_at','model_revision','frame_count','interval_seconds','storyboard_generated_at','indexed_at','storyboard_at','vtt_path','actual_frame_count','frame_digest']
QUERY="""SELECT v.id,v.file_path,v.duration_seconds,(SELECT f.channel FROM recording_clip_feedback f WHERE f.video_id=v.id AND f.analyzed_at=r.analyzed_at ORDER BY f.id LIMIT 1),r.analyzed_at,r.saved_at,i.model_revision,i.frame_count,i.interval_seconds,i.storyboard_generated_at,i.indexed_at,s.generated_at,s.vtt_path,(SELECT count(*) FROM video_frame_embeddings e WHERE e.video_id=v.id),NULL FROM videos v JOIN recording_reviews r ON r.video_id=v.id JOIN video_visual_index i ON i.video_id=v.id JOIN storyboards s ON s.video_id=v.id WHERE v.is_available=true AND r.saved_at IS NOT NULL"""

def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def digest(value):return hashlib.sha256(canonical(value)).hexdigest()
def finite(x):return not isinstance(x,bool) and isinstance(x,(float,int)) and math.isfinite(x)
def task_key(task):return task['batch'],task['position']
def generation_key(value):
 try:at=datetime.datetime.fromisoformat(base.stamp(value).replace('Z','+00:00'))
 except (ValueError,AttributeError,TypeError) as e:raise ValueError('Exact whole generation timestamp required') from e
 if at.tzinfo is None:at=at.replace(tzinfo=datetime.timezone.utc)
 return at.astimezone(datetime.timezone.utc).isoformat(timespec='microseconds')
def source_key(source):return source['video_id'],generation_key(source['analyzed_at'])

def history_exclusions(eligibility,private):
 if eligibility.get('private_binding_sha256')!=digest(private) or eligibility.get('policy')!='whole-recording-current-review-v1' or private.get('policy')!=eligibility['policy']:raise ValueError('Historical whole source binding differs')
 rows=eligibility['rows'];mapping=private['recordings']
 if len({r['row'] for r in rows})!=len(rows) or set(mapping)!={r['row'] for r in rows}:raise ValueError('Historical exact source universe differs')
 known=set();clarified=set()
 for row in rows:
  p=mapping[row['row']]
  if row['y'] is not None:known.add(source_key(p))
  if row['near_full_edited_clips_still_unknown']:clarified.add(p['video_id'])
 return known,clarified

def task_exclusions(tasks):
 # Metadata only: pending and answered exact source versions both count as already asked.
 out=set()
 for task in tasks:
  if task.get('kind')!='whole-verdict':continue
  c=task.get('context') or {};s=c.get('candidate') or {}
  if isinstance(s.get('video_id'),int) and isinstance(s.get('analyzed_at'),str):out.add(source_key(s))
 return out

def choose(rows,reserved,known,clarified,already,count=16):
 if type(count) is not int or not 1<=count<=MAX_TASKS:raise ValueError('Bounded explicit task count required')
 by={};seen=set()
 for row in rows:
  vid=row['video_id'];group=base.canon(row['channel']);generation=generation_key(row['analyzed_at'])
  if vid in seen:raise ValueError('Duplicate current recording metadata')
  seen.add(vid)
  if not group or group in reserved or (vid,generation) in known|already or vid in clarified:continue
  clips=row.get('clips');proposals=row.get('proposals')
  if not isinstance(clips,list) or not clips or not isinstance(proposals,list):continue
  if any(not isinstance(c,dict) or type(c.get('keep')) is not bool for c in clips):raise ValueError('Unsupported saved review outcome')
  if not any(c['keep'] for c in clips) or any(c['keep'] and 'keep_whole' in c.get('reasons',[]) for c in clips):continue
  # Neither kept proportion nor duration/score determines selection or a target.
  key=hashlib.sha256(f'{BATCH}:{vid}'.encode()).hexdigest()
  if group not in by or key<by[group][0]:by[group]=(key,row)
 selected=[r for _,r in sorted(by.values(),key=lambda p:p[0])[:count]]
 if len(selected)!=count:raise ValueError('Insufficient distinct unasked unknown whole creators; no replacement/proxy labels')
 return selected

def load_metadata(pg,ids=None,lock=False):
 query=QUERY+(' AND v.id=ANY(%s)' if ids is not None else '')+' ORDER BY v.id LIMIT 1001'+(' FOR SHARE OF v,r,i,s' if lock else '')
 rows=[dict(zip(META,r)) for r in pg.execute(query,() if ids is None else (ids,)).fetchall()]
 if len(rows)>1000:raise ValueError('Metadata pool exceeds bounded1000 recordings')
 if ids is not None:
  for row in rows:row['frame_digest']=frame_digest(pg,row['video_id'])
 return rows

def frame_digest(pg,vid):
 return pg.execute("SELECT md5(string_agg(md5(e.frame_index::text||':'||e.timestamp_seconds::text||':'||e.embedding::text),'' ORDER BY e.frame_index)) FROM video_frame_embeddings e WHERE e.video_id=%s",(vid,)).fetchone()[0]

def recover_proposals(row,feedback):
 """Exact original bounds only: explicit immutable proposals, or generation-bound detector receipts."""
 raw=row['proposals'];generation=base.stamp(row['analyzed_at'])
 if raw is not None:
  if not isinstance(raw,list):raise ValueError('Unsupported immutable original proposal array')
  return copy.deepcopy(raw),{'kind':'recording_reviews.proposals','analyzed_at':generation,'sha256':digest(raw)}
 originals=[f for f in feedback if f['added'] is False]
 if len({f['clip_id'] for f in originals})!=len(originals) or any(f['video_id']!=row['video_id'] or generation_key(f['analyzed_at'])!=generation_key(generation) or base.canon(f['channel'])!=base.canon(row['channel']) for f in originals):raise ValueError('Ambiguous original feedback generation/creator')
 clips={c['id']:c for c in row['clips'] if isinstance(c,dict) and isinstance(c.get('id'),str) and not c['id'].startswith('added-')}
 if any(key not in {f['clip_id'] for f in originals} for key in clips):raise ValueError('Surviving original clip lacks generation-bound feedback')
 proposals=[];receipts=[]
 for f in sorted(originals,key=lambda r:r['id']):
  a,b=f['detected_start'],f['detected_end'];origin='feedback.detected_bounds'
  detected=clips.get(f['clip_id'],{}).get('detected')
  if a is None or b is None:
   if not isinstance(detected,dict) or set(detected)!={'start_seconds','end_seconds'}:raise ValueError('Original detector bounds unavailable; never use final trims')
   if (a is not None and a!=detected['start_seconds']) or (b is not None and b!=detected['end_seconds']):raise ValueError('Partial original feedback detector receipt disagrees')
   a,b=detected['start_seconds'],detected['end_seconds'];origin='saved_clip.detected_bounds'
  if detected is not None and (detected.get('start_seconds')!=a or detected.get('end_seconds')!=b):raise ValueError('Original detector receipts disagree')
  if not all(finite(z) for z in (a,b,f['score'])) or not 0<=a<b<=row['duration']:raise ValueError('Original detector bounds exceed exact source')
  proposals.append({'id':f['clip_id'],'start_seconds':a,'end_seconds':b,'score':f['score']})
  receipts.append({'feedback_id':f['id'],'clip_id':f['clip_id'],'analyzed_at':base.stamp(f['analyzed_at']),'bounds':[a,b],'score':f['score'],'origin':origin})
 return proposals,{'kind':'exact_generation_original_detector_receipts','analyzed_at':generation,'receipts':receipts,'sha256':digest(receipts)}

def attach_reviews(pg,rows,reserved):
 # Creator metadata is screened before the query reads any saved review choices.
 allowed=[r for r in rows if base.canon(r['channel']) and base.canon(r['channel']) not in reserved]
 ids=[r['video_id'] for r in allowed]
 saved={vid:{'analyzed_at':base.stamp(at),'clips':clips,'proposals':proposals} for vid,at,clips,proposals in pg.execute('SELECT video_id,analyzed_at,clips,proposals FROM recording_reviews WHERE video_id=ANY(%s)',(ids,)).fetchall()} if ids else {}
 if set(saved)!=set(ids):raise ValueError('Exact saved reviews absent')
 columns=['id','video_id','analyzed_at','clip_id','channel','added','detected_start','detected_end','score'];feedback={}
 if ids:
  for raw in pg.execute('SELECT f.id,f.video_id,f.analyzed_at,f.clip_id,f.channel,f.added,f.detected_start,f.detected_end,f.score FROM recording_clip_feedback f JOIN recording_reviews r ON r.video_id=f.video_id AND r.analyzed_at=f.analyzed_at WHERE f.video_id=ANY(%s) AND f.added=false ORDER BY f.video_id,f.id',(ids,)).fetchall():
   f=dict(zip(columns,raw));feedback.setdefault(f['video_id'],[]).append(f)
 for row in allowed:
  value=saved[row['video_id']]
  if value['analyzed_at']!=base.stamp(row['analyzed_at']):raise ValueError('Review generation drift')
  row.update(clips=value['clips'],proposals=value['proposals'],raw_proposals=copy.deepcopy(value['proposals']))
  try:row['proposals'],row['proposal_origin']=recover_proposals(row,feedback.get(row['video_id'],[]))
  except ValueError as error:row['proposals']=None;row['proposal_unsupported_reason']=str(error)
 return allowed

def source(row):
 duration=row['duration'];count=row['frame_count'];group=base.canon(row['channel'])
 if not group or not finite(duration) or duration<=0 or row['saved_at'] is None or row['model_revision']!=base.VISUAL_PIN or row['interval_seconds']!=5 or type(count) is not int or not 1<=count<=8000 or row['actual_frame_count']!=count or not isinstance(row['frame_digest'],str) or len(row['frame_digest'])!=32 or base.stamp(row['storyboard_at'])!=base.stamp(row['storyboard_generated_at']):raise ValueError('Full current recording/source/index required')
 for key in ('analyzed_at','indexed_at','storyboard_generated_at'):datetime.datetime.fromisoformat(base.stamp(row[key]).replace('Z','+00:00'))
 vtt=Path(row['vtt_path']);vtt=vtt if vtt.is_absolute() else base.BACKEND/vtt
 if not vtt.is_file() or vtt.stat().st_dev!=base.LAB.stat().st_dev or vtt.stat().st_size>1024*1024:raise ValueError('Bounded existing storyboard receipt required')
 candidate={'video_id':row['video_id'],'analyzed_at':base.stamp(row['analyzed_at']),'index':{'model_revision':row['model_revision'],'frame_count':count,'interval_seconds':5,'storyboard_generated_at':base.stamp(row['storyboard_generated_at']),'indexed_at':base.stamp(row['indexed_at'])},'source_fingerprint':base.source_fingerprint(row['file_path']),'duration_seconds':duration,'channel':row['channel'],'channel_key':group}
 proposals=[{'id':p['id'],'start':p['start_seconds'],'end':p['end_seconds'],'score':p['score']} for p in row['proposals'] if not p['id'].startswith('added-')]
 return {'candidate':candidate,'proposals':proposals,'saved_review_sha256':digest({'clips':row['clips'],'proposals':row.get('raw_proposals',row['proposals']),'saved_at':base.stamp(row['saved_at'])}),'proposal_origin':copy.deepcopy(row['proposal_origin']),'frame_digest':row['frame_digest'],'storyboard_receipt':{'path':str(vtt.resolve()),'sha256':base.digest(vtt)}}

def numeric(pg,row,private,out):
 import numpy as np
 raw=pg.execute('SELECT timestamp_seconds,embedding::text FROM video_frame_embeddings WHERE video_id=%s ORDER BY frame_index LIMIT 8001',(row['video_id'],)).fetchall()
 if len(raw)!=row['frame_count']:raise ValueError('Exact bounded frozen frame count changed')
 t=np.asarray([r[0] for r in raw],dtype=np.float64);v=np.asarray([json.loads(r[1]) for r in raw],dtype=np.float32)
 x,visual=recipe.features(private['proposals'],row['duration'],t,v)
 if visual is None:raise ValueError('Whole round requires existing full-source numeric coverage')
 identity=dict(private['candidate'],duration=row['duration'],proposals=private['proposals'],proposal_origin=private['proposal_origin'],frame_digest=private['frame_digest'])
 path,receipt=checkpoint(out,t,v,identity)
 return dict(private,numeric_identity=identity,frame_checkpoint=dict(receipt,path=path),features=x,visual_mean=visual,feature_recipe=recipe.RECIPE,visual_recipe=recipe.VISUAL_RECIPE)

def checkpoint(out,t,v,identity):
 import numpy as np
 sha=digest(identity);directory=Path(out)/'frames';directory.mkdir(parents=True,exist_ok=True,mode=0o700);directory.chmod(0o700);path=directory/f'{sha}.npz'
 if t.nbytes+v.nbytes>MAX_BYTES:raise ValueError('Whole numeric checkpoint exceeds bound')
 if not path.exists():
  fd,tmp=tempfile.mkstemp(prefix='.frames-',dir=directory)
  try:
   with os.fdopen(fd,'wb') as f:np.savez_compressed(f,t=t,v=v.astype(np.float32),identity_sha256=sha);f.flush();os.fsync(f.fileno())
   os.chmod(tmp,0o600)
   if Path(tmp).stat().st_size>MAX_BYTES:raise ValueError('Compressed checkpoint exceeds bound')
   try:os.link(tmp,path)
   except FileExistsError:pass
  finally:os.unlink(tmp)
 with np.load(path,allow_pickle=False) as z:
  if str(z['identity_sha256'])!=sha or not np.array_equal(z['t'],t) or not np.array_equal(z['v'],v.astype(np.float32)):raise ValueError('Existing immutable whole numeric checkpoint differs')
 return str(path.resolve()),{'sha256':base.digest(path),'identity_sha256':sha,'bytes':path.stat().st_size}


def validate_candidate(c):
 if not isinstance(c,dict) or set(c)!={'video_id','analyzed_at','index','source_fingerprint','duration_seconds','channel','channel_key'}:raise ValueError('Exact whole candidate fields required')
 index=c['index'];fp=c['source_fingerprint']
 if not isinstance(index,dict) or set(index)!={'model_revision','frame_count','interval_seconds','storyboard_generated_at','indexed_at'} or index['model_revision']!=base.VISUAL_PIN or type(index['frame_count']) is not int or not 1<=index['frame_count']<=8000 or index['interval_seconds']!=5:raise ValueError('Exact bounded whole index required')
 if not isinstance(fp,dict) or set(fp)!={'size_bytes','mtime_ns','path_identity_sha256'} or type(fp['size_bytes']) is not int or fp['size_bytes']<0 or not isinstance(fp['mtime_ns'],str) or not fp['mtime_ns'].isdigit() or not isinstance(fp['path_identity_sha256'],str) or len(fp['path_identity_sha256'])!=64 or any(x not in '0123456789abcdef' for x in fp['path_identity_sha256']):raise ValueError('Exact whole source fingerprint required')
 for stamp in (c['analyzed_at'],index['storyboard_generated_at'],index['indexed_at']):
  try:datetime.datetime.fromisoformat(stamp.replace('Z','+00:00'))
  except (ValueError,AttributeError,TypeError) as e:raise ValueError('Whole generation timestamp required') from e

def validate_manifest(value,reserved,holdout):
 if value.get('schema_version')!=1 or value.get('batch')!=BATCH or value.get('policy')!=POLICY or value.get('holdout_dependency')!=holdout or value.get('excluded_holdout_creators')!=sorted(reserved):raise ValueError('Frozen whole policy/holdout differs')
 rows=value.get('rows');private=value.get('private_sources')
 if not isinstance(rows,list) or not 1<=len(rows)<=16 or not isinstance(private,list) or len(private)!=len(rows) or [r['position'] for r in rows]!=list(range(len(rows))) or len({r['video_id'] for r in rows})!=len(rows):raise ValueError('Finite whole recording identities differ')
 groups=set()
 for row,p in zip(rows,private):
  if set(row)!=set(FIELDS) or row['batch']!=BATCH or row['stratum']!='explicit-whole-unknown' or p['position']!=row['position'] or row['context']!={'target':labels.TARGET,'reserved_fine_holdout':False,'fine_data_role':'training','candidate':p['candidate'],'original_range':[0,p['candidate']['duration_seconds']]}:raise ValueError('Exact whole context differs')
  validate_candidate(p['candidate']);labels.metadata(row,reserved)
  if row['channel']!=p['candidate']['channel'] or p['candidate']['channel_key']!=base.canon(row['channel']) or p['candidate']['channel_key'] in groups:raise ValueError('Distinct creator whole task required')
  groups.add(p['candidate']['channel_key'])
  identity=p['numeric_identity']
  if any(identity.get(k)!=v for k,v in p['candidate'].items()) or identity.get('proposals')!=p['proposals'] or identity.get('duration')!=p['candidate']['duration_seconds'] or identity.get('proposal_origin')!=p['proposal_origin'] or identity.get('frame_digest')!=p['frame_digest'] or p['frame_checkpoint']['identity_sha256']!=digest(identity) or p['feature_recipe']!=recipe.RECIPE or p['visual_recipe']!=recipe.VISUAL_RECIPE:raise ValueError('Entire-source numeric identity differs')
  if len(p['features'])!=8 or len(p['visual_mean'])!=1152 or not all(finite(v) for v in p['features']+p['visual_mean']) or abs(sum(v*v for v in p['visual_mean'])-1)>.04:raise ValueError('Finite whole features required')
 return value

def check_checkpoints(value,root):
 import numpy as np
 total=0
 for p in value['private_sources']:
  receipt=p['frame_checkpoint'];path=Path(receipt['path'])
  if not path.is_absolute() or path.resolve()!=path or not path.is_file() or path.stat().st_dev!=Path(root).stat().st_dev or path.stat().st_size>MAX_BYTES or base.digest(path)!=receipt['sha256']:raise ValueError('Pinned local SSD frame checkpoint changed')
  with zipfile.ZipFile(path) as z:
   if set(z.namelist())!={'t.npy','v.npy','identity_sha256.npy'} or len(z.infolist())!=3:raise ValueError('Exact numeric checkpoint members required')
   size=sum(i.file_size for i in z.infolist());total+=size
   if size>MAX_BYTES or total>MAX_TOTAL:raise ValueError('Numeric decompression/total bound')
  with np.load(path,allow_pickle=False) as z:
   if str(z['identity_sha256'])!=digest(p['numeric_identity']) or z['t'].shape!=(p['candidate']['index']['frame_count'],) or z['v'].shape!=(len(z['t']),1152):raise ValueError('Stored entire-source identity/shape differs')
   x,visual=recipe.features(p['proposals'],p['candidate']['duration_seconds'],z['t'],z['v'])
  if not np.allclose(x,p['features'],rtol=0,atol=1e-12) or not np.allclose(visual,p['visual_mean'],rtol=0,atol=1e-12):raise ValueError('Frozen full-recording features differ')

def consumer_pins():return {str(Path(__file__).with_name(n).resolve()):base.digest(Path(__file__).with_name(n)) for n in ('whole_round_prepare.py','whole_round_apply.py','whole_round_intake.py')}
def dependencies():return [Path(__file__),Path(labels.__file__),Path(recipe.__file__),Path(base.__file__),Path(safe.__file__),Path(safe.previous.__file__),Path(io.__file__),Path(io.fl.__file__)]+[HIST/n for n in HISTORY_FILES]

def load_contract(root,expected):
 root=Path(root);path=root/'private_manifest.json'
 if not isinstance(expected,str) or len(expected)!=64 or not path.is_file() or path.stat().st_size>8*1024*1024 or base.digest(path)!=expected:raise ValueError('Exact reviewed whole manifest SHA required')
 value=json.loads(path.read_text());reserved,receipt=safe.previous.holdout_contract();validate_manifest(value,reserved,receipt)
 if value.get('consumer_sources')!=consumer_pins() or value.get('source_sha256')!=base.digest(Path(__file__)):raise ValueError('Reviewed whole consumers changed')
 deps=value.get('dependencies')
 if not isinstance(deps,list) or len(deps)!=len(dependencies()) or {d['path'] for d in deps}!={str(p.resolve()) for p in dependencies()}:raise ValueError('Exact whole helper/history dependencies required')
 for d in deps:
  p=Path(d['path'])
  if p.stat().st_dev!=root.stat().st_dev or p.stat().st_size>8*1024*1024 or base.digest(p)!=d['sha256']:raise ValueError('Pinned whole dependency changed')
 known,clarified=historical_exclusions()
 if any(source_key(p['candidate']) in known or p['candidate']['video_id'] in clarified for p in value['private_sources']):raise ValueError('Known/previously clarified whole source cannot be repeated')
 check_checkpoints(value,root);return value,reserved,receipt

def historical_exclusions():
 return history_exclusions(*(json.loads((HIST/n).read_text()) for n in HISTORY_FILES))

def prepare(out,count=16):
 started=PROCESS_START;reserved,holdout=safe.previous.holdout_contract();paths=dependencies();pins={str(p.resolve()):base.digest(p) for p in paths};eligibility,private=(json.loads((HIST/n).read_text()) for n in HISTORY_FILES);known,clarified=history_exclusions(eligibility,private)
 import psycopg
 with psycopg.connect(base.pg_config()) as pg:
  pg.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');pg.execute("SET statement_timeout='20s'")
  history=[dict(zip(['kind','context'],r)) for r in pg.execute('SELECT kind,context FROM recording_label_tasks WHERE kind=%s',( 'whole-verdict',)).fetchall()]
  pool=attach_reviews(pg,load_metadata(pg),reserved);selected=choose(pool,reserved,known,clarified,task_exclusions(history),count);rows=[];privates=[];total=0
  for position,row in enumerate(selected):
   if time.monotonic()-started>=MAX_SECONDS:raise TimeoutError('Whole numeric prepare deadline')
   row['frame_digest']=frame_digest(pg,row['video_id']);p=numeric(pg,row,source(row),out);total+=Path(p['frame_checkpoint']['path']).stat().st_size
   if total>MAX_TOTAL:raise ValueError('Whole total numeric byte bound')
   p['position']=position;privates.append(p);c=p['candidate'];rows.append({'kind':'whole-verdict','batch':BATCH,'position':position,'video_id':c['video_id'],'start_seconds':0,'end_seconds':c['duration_seconds'],'channel':c['channel'],'stratum':'explicit-whole-unknown','context':{'target':labels.TARGET,'reserved_fine_holdout':False,'fine_data_role':'training','candidate':c,'original_range':[0,c['duration_seconds']]}})
 value={'schema_version':1,'batch':BATCH,'source_sha256':base.digest(Path(__file__)),'consumer_sources':consumer_pins(),'dependencies':[{'path':p,'sha256':s} for p,s in pins.items()],'policy':POLICY,'holdout_dependency':holdout,'excluded_holdout_creators':sorted(reserved),'rows':rows,'private_sources':privates,'selection_receipt':{'pool_recordings':len(pool),'known_sources_excluded':len(known),'previously_clarified_near_full_ids_excluded':len(clarified),'task_count':len(rows),'creator_count':len(rows),'unsupported_original_receipt_count':sum('proposal_unsupported_reason' in r for r in pool),'labels_preassigned':0,'population_prevalence_sample':False},'fits':0,'queue_writes':0,'media_reads':0,'GPU':False}
 validate_manifest(value,reserved,holdout)
 for p,s in pins.items():
  if base.digest(Path(p))!=s:raise ValueError('Whole dependencies changed during preparation')
 check_checkpoints(value,out);immutable_write(Path(out)/'private_manifest.json',value);print(json.dumps({'status':'prepared_for_review_only','count':len(rows),'manifest_sha256':base.digest(Path(out)/'private_manifest.json'),'queue_writes':0,'model_fits':0}));return value

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path,default=OUT);parser.add_argument('--count',type=int,default=16);args=parser.parse_args();signal.alarm(max(1,math.ceil(MAX_SECONDS-(time.monotonic()-PROCESS_START))));prepare(args.out,args.count)
