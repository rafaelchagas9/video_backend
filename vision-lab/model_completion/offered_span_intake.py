"""Frozen offered-span preference contract/intake; no acceptability, cuts or model fitting."""
from __future__ import annotations
import argparse,copy,datetime,hashlib,json,math,os,tempfile,zipfile
from pathlib import Path
import creator_expansion_v2 as safe
import blind_version_round as versions
from blind_version_counterbalanced_intake import viewing_context
base=safe.base
STEM='offered-span-20261010-1'
BATCHES=[STEM+'-candidate',STEM+'-control']
OUT=base.LAB/'data/model-completion-20261010/offered-span-prospective'
FIELDS=['kind','batch','position','video_id','start_seconds','end_seconds','channel','stratum','context']
ANSWER_FIELDS=FIELDS+['id','answer','reasons','detail','answered_at']
MAX_JSON=8*1024*1024

def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def digest(value):return hashlib.sha256(canonical(value)).hexdigest()
def key(row):return row['batch'],row['position']
def number(value):return not isinstance(value,bool) and isinstance(value,(float,int)) and math.isfinite(value)
def overlap_iou(a,b):
 intersection=max(0,min(a[1],b[1])-max(a[0],b[0]));return intersection/((a[1]-a[0])+(b[1]-b[0])-intersection)

def bounds(value):
 if not isinstance(value,list) or len(value)!=2 or not all(number(x) for x in value) or not 0<=value[0]<value[1]:raise ValueError('Invalid offered range')
 return value

def validate_manifest(value,reserved,receipt):
 if value.get('schema_version')!=1 or value.get('batch_stem')!=STEM or value.get('batches')!=BATCHES or value.get('holdout_dependency')!=receipt or value.get('excluded_holdout_creators')!=sorted(reserved):raise ValueError('Frozen batch/holdout dependency differs')
 rows=value.get('rows');assignments=value.get('private_assignments')
 if not isinstance(rows,list) or not 1<=len(rows)<=16 or not isinstance(assignments,list) or len(assignments)!=len(rows):raise ValueError('One to16 exact planned comparisons required')
 if len({key(r) for r in rows})!=len(rows) or len({key(r) for r in assignments})!=len(rows) or {key(r) for r in rows}!={key(r) for r in assignments}:raise ValueError('Private/public task identities differ')
 private={key(p):p for p in assignments};pairs=set();slots=set();creators=set();sources={}
 for batch in BATCHES:
  positions=sorted(r['position'] for r in rows if r['batch']==batch)
  if positions!=list(range(len(positions))) or any(isinstance(p,bool) for p in positions):raise ValueError('Batch positions must be contiguous exact integers')
 for row in rows:
  if row['kind']!='version-versus' or row['batch'] not in BATCHES:raise ValueError('Only frozen version preferences allowed')
  slot=(row['kind'],row['batch'],row['video_id'],row['start_seconds'])
  if slot in slots:raise ValueError('Existing DB item identity collision')
  slots.add(slot);p=private[key(row)];s=p['source'];c=row['context'];group=s['channel_key']
  if group in reserved or not group or base.canon(s['channel'])!=group or c.get('reserved_fine_holdout') is not False or c.get('fine_data_role')!='training':raise ValueError('Reserved or invalid creator')
  if c.get('blind_version_comparison') is not True or (c.get('target_semantics') or c.get('target'))!='preferred_version_if_keep_one' or c.get('acceptability_target') is not None or c.get('cut_target') is not None:raise ValueError('Pure preference target required')
  if p['pilot_role'] not in ('model_vs_human','same_duration_location') or (p['pilot_role']=='model_vs_human')!=(row['batch']==BATCHES[0]):raise ValueError('Role-specific batch differs')
  if set(p['assignments'])!={'a','b'} or any(not isinstance(v,str) or not v for v in p['assignments'].values()):raise ValueError('Exact private side roles required')
  original=bounds(s['clip']);duration=s['duration_seconds']
  if not number(duration) or original[1]>duration:raise ValueError('Original exceeds exact source duration')
  count=s['index'].get('frame_count')
  if isinstance(count,bool) or not isinstance(count,int) or not 1<=count<=8000:raise ValueError('Bounded frame inventory required')
  for side,label in (('a','Version A'),('b','Version B')):
   v=c[side]
   expected={k:s[k] for k in ('feedback_id','video_id','channel','channel_key','analyzed_at','source_fingerprint','index','detector','duration_seconds')}
   expected.update(original_range=original)
   if any(v.get(k)!=x for k,x in expected.items()) or v.get('version_label')!=label:raise ValueError('Offered source/generation/index identity differs')
   for hidden in ('score','file_name','pilot_role','assignments','initial_best_source','final_cut_receipt'):
    if hidden in v:raise ValueError('Private selection metadata exposed on version card')
   span=bounds(v['range'])
   if v.get('best')!=span or not original[0]<=span[0]<span[1]<=original[1] or span[1]-span[0]<15:raise ValueError('Exact playable offered bounds required')
   if v.get('preview_windows')!=versions.previews(span):raise ValueError('Three uniform frozen preview windows differ')
  a,b=c['a'],c['b']
  if p['pilot_role']=='same_duration_location' and (abs((a['range'][1]-a['range'][0])-(b['range'][1]-b['range'][0]))>1e-8 or not 180<=a['range'][1]-a['range'][0]<=900 or abs(a['range'][0]-b['range'][0])<30 or overlap_iou(a['range'],b['range'])>.8):raise ValueError('Matched-duration control geometry differs')
  if p['pilot_role']=='model_vs_human':
   if any(v['range'][1]-v['range'][0]<180 for v in (a,b)) or max(abs(a['range'][i]-b['range'][i]) for i in (0,1))<30 or overlap_iou(a['range'],b['range'])>.9:raise ValueError('Distinct candidate/reference geometry differs')
   if set(p['assignments'].values())!={'frozen_primary_best','current_human_approved'}:raise ValueError('Exact candidate/reference role mapping required')
   reference=next(k for k,role in p['assignments'].items() if role=='current_human_approved')
   if c[reference]['range']!=s['best']:raise ValueError('Human reference differs from confirmed saved cut')
  elif set(p['assignments'].values())!={'frozen_primary_location','fixed_endpoint_control'}:raise ValueError('Exact control role mapping required')
  if row['video_id']!=s['video_id'] or [row['start_seconds'],row['end_seconds']]!=a['range'] or row['channel']!=s['channel']:raise ValueError('Top-level playback differs from offered A')
  if versions.version_key(a)==versions.version_key(b):raise ValueError('Identical offered versions')
  pair=tuple(sorted(versions.version_key(c[k]) for k in ('a','b')))
  if pair in pairs:raise ValueError('Duplicate exact comparison')
  pairs.add(pair);creators.add(group)
  if s['feedback_id'] in sources and sources[s['feedback_id']]!=s:raise ValueError('Repeated source provenance differs')
  sources[s['feedback_id']]=s
  identity=p['numeric_identity'];frame=p['frame_checkpoint']
  if any(identity.get(k)!=s[k] for k in ('video_id','analyzed_at','index','source_fingerprint')) or identity.get('duration')!=duration or frame.get('identity_sha256')!=digest(identity):raise ValueError('Numeric checkpoint source binding differs')
  proposals=identity['proposals'];matches=[q for q in proposals if [q['start'],q['end']]==original and q['score']==s['score']]
  if len(matches)!=1 or not 1<=len(proposals)<=60 or len({q['id'] for q in proposals})!=len(proposals) or any(not q['id'] or q['id'].startswith('added-') or not all(number(q[k]) for k in ('start','end','score')) or not 0<=q['start']<q['end']<=duration for q in proposals):raise ValueError('Immutable original-proposal universe differs')
  predictions=p['predictions']
  if set(predictions)!={'numeric','predecessor','primary'} or any(not isinstance(scores,dict) or set(scores)!={'a','b'} or not all(number(x) for x in scores.values()) for scores in predictions.values()):raise ValueError('All three frozen head scores required')
 if len(creators)>8:raise ValueError('At most8 creators in finite batch')
 return value

def load_contract(root,expected):
 root=Path(root);path=root/'private_manifest.json'
 if not isinstance(expected,str) or len(expected)!=64 or any(x not in '0123456789abcdef' for x in expected) or not path.is_file() or path.stat().st_size>MAX_JSON or base.digest(path)!=expected:raise ValueError('Exact reviewed manifest SHA required')
 value=json.loads(path.read_text());reserved,receipt=safe.previous.holdout_contract();validate_manifest(value,reserved,receipt)
 deps=value.get('dependencies')
 if not isinstance(deps,list) or not deps or len(deps)>128:raise ValueError('Bounded pinned dependencies required')
 paths=set();roles=set();by={}
 for dependency in deps:
  path=Path(dependency['path']);role=dependency['role'];sha=dependency['sha256']
  if not path.is_absolute() or not path.is_file() or path.resolve()!=path or str(path) in paths or path.stat().st_size>64*1024*1024 or path.stat().st_dev!=root.stat().st_dev or base.digest(path)!=sha:raise ValueError('Pinned SSD dependency changed or unbounded')
  if role not in ('generator','head','feature_cohort','frame_checkpoint','source'):raise ValueError('Unknown dependency role')
  roles.add(role);paths.add(str(path));by[str(path)]=dependency
 if not {'generator','head','feature_cohort','frame_checkpoint','source'}<=roles:raise ValueError('Missing generator/head/cohort/checkpoint/source pins')
 generator=value.get('generator_source_path')
 if generator not in by or by[generator]['role']!='generator' or by[generator]['sha256']!=value.get('source_sha256'):raise ValueError('Exact generator source pin differs')
 consumers=value.get('consumer_sources');expected_consumers={str(Path(__file__).resolve()):base.digest(Path(__file__)),str(Path(__file__).with_name('offered_span_apply.py').resolve()):base.digest(Path(__file__).with_name('offered_span_apply.py'))}
 if consumers!=expected_consumers:raise ValueError('Reviewed apply/intake sources changed')
 import numpy as np
 seen=set()
 for p in value['private_assignments']:
  frame_receipt=p['frame_checkpoint'];path=Path(frame_receipt['path'])
  if str(path) not in by or by[str(path)]['role']!='frame_checkpoint' or by[str(path)]['sha256']!=frame_receipt['sha256']:raise ValueError('Private numeric checkpoint is not pinned')
  marker=(str(path),frame_receipt['identity_sha256'])
  if marker in seen:continue
  seen.add(marker)
  with zipfile.ZipFile(path) as archive:
   if sum(info.file_size for info in archive.infolist())>64*1024*1024:raise ValueError('Decompressed numeric checkpoint exceeds bound')
  with np.load(path,allow_pickle=False) as z:
   if str(z['identity_sha256'])!=frame_receipt['identity_sha256']:raise ValueError('Stored checkpoint generation differs')
   t=z['t'];v=z['v'];s=p['source'];duration=s['duration_seconds']
   if t.shape!=(len(v),) or v.shape!=(s['index']['frame_count'],1152) or not len(t) or not np.isfinite(t).all() or not np.isfinite(v).all() or np.any(np.diff(t)<=0) or t[0]<0 or t[-1]>duration or t[0]>5.001 or np.any(np.diff(t)>10.001) or t[-1]+10<duration or not np.all(np.abs(np.linalg.norm(v,axis=1)-1)<.02):raise ValueError('Bounded numeric checkpoint shape/coverage differs')
 return value,reserved,receipt

def checked_answers(tasks,manifest):
 rows=manifest['rows'];plans={key(r):r for r in rows}
 if len(tasks)!=len(rows) or len({t['id'] for t in tasks})!=len(rows) or {key(t) for t in tasks}!=set(plans):raise ValueError('Exact complete task identities required')
 output=[];pending=0
 for task in sorted(tasks,key=key):
  plan=plans[key(task)]
  if any(task[k]!=plan[k] for k in FIELDS):raise ValueError('Frozen task/source/range changed')
  answer=task.get('answer');at=task.get('answered_at');reasons=task.get('reasons');detail=task.get('detail')
  if not isinstance(reasons,list) or len(reasons)>32 or any(not isinstance(x,str) or len(x)>512 for x in reasons):raise ValueError('Invalid preference reasons')
  viewing=viewing_context(detail)
  if answer is None:
   if at is not None or reasons or detail is not None:raise ValueError('Pending task has stale outcome')
   pending+=1;continue
  if answer not in ('a','b','both','neither') or at is None:raise ValueError('Invalid preference answer provenance')
  stamp=base.stamp(at)
  try:datetime.datetime.fromisoformat(stamp.replace('Z','+00:00'))
  except (ValueError,AttributeError) as e:raise ValueError('Invalid answer timestamp') from e
  c=task['context'];a,b=c['a'],c['b']
  if c['reserved_fine_holdout'] is not False or c['fine_data_role']!='training' or a['channel_key'] in manifest['excluded_holdout_creators']:raise ValueError('Reserved preferences cannot be read')
  output.append({'task_id':task['id'],'batch':task['batch'],'position':task['position'],'kind':'version-versus','answer':answer,'answered_at':stamp,'reasons':copy.deepcopy(reasons),'a':copy.deepcopy(a),'b':copy.deepcopy(b),'a_version_identity':versions.version_key(a),'b_version_identity':versions.version_key(b),'preferred_side':answer if answer in ('a','b') else None,'preference_outcome':'strict' if answer in ('a','b') else 'no_strict_preference' if answer=='both' else 'abstained','current_acceptability':'unknown','absolute_y':None,'cut_gold':None,'outside_quality':'unknown','permanent_storage_worth':'unknown','future_replacement':'unknown','viewing':copy.deepcopy(viewing),'viewing_metadata_present':viewing is not None})
 if pending:return {'status':'waiting','batch_stem':STEM,'answered':len(rows)-pending,'pending':pending,'total':len(rows)}
 return {'status':'complete','batch_stem':STEM,'batches':BATCHES,'target':'preferred_version_if_keep_one','preference_rows':output,'strict_pairs':sum(r['preferred_side'] is not None for r in output),'no_strict_preference':sum(r['answer']=='both' for r in output),'abstained':sum(r['answer']=='neither' for r in output),'current_acceptability':'not_observed','cut_gold':'not_observed','permanent_storage_worth':'not_observed','fine_legacy_compatibility':False,'no_fitting_or_production_writes':True}

def write_snapshot(root,payload,manifest_sha):
 value={'schema_version':1,'manifest_sha256':manifest_sha,'intake_source_sha256':base.digest(Path(__file__)),'answers':payload};data=canonical(value)
 if len(data)>MAX_JSON:raise ValueError('Snapshot exceeds private bound')
 sha=hashlib.sha256(data).hexdigest();directory=Path(root)/'answer-snapshots';directory.mkdir(parents=True,exist_ok=True,mode=0o700);directory.chmod(0o700);path=directory/f'answers.{sha}.json'
 if path.exists():
  if path.read_bytes()!=data:raise ValueError('Immutable snapshot differs')
  return path,sha,False
 fd,tmp=tempfile.mkstemp(prefix='.answers-',dir=directory)
 try:
  with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
  os.chmod(tmp,0o600)
  try:os.link(tmp,path)
  except FileExistsError:
   if path.read_bytes()!=data:raise ValueError('Concurrent immutable snapshot differs')
   return path,sha,False
  fd=os.open(directory,os.O_RDONLY)
  try:os.fsync(fd)
  finally:os.close(fd)
 finally:os.unlink(tmp)
 return path,sha,True

def fetch_tasks(pg,manifest):
 # Metadata first; never fetch outcomes for an unplanned/reserved/drifted task.
 tasks=[dict(zip(FIELDS+['id'],r)) for r in pg.execute('SELECT '+','.join(FIELDS+['id'])+' FROM recording_label_tasks WHERE batch=ANY(%s) ORDER BY batch,position',(BATCHES,)).fetchall()]
 plans={key(r):r for r in manifest['rows']}
 if len(tasks)!=len(plans) or len({t['id'] for t in tasks})!=len(plans) or {key(t) for t in tasks}!=set(plans) or any(any(t[k]!=plans[key(t)][k] for k in FIELDS) for t in tasks):raise ValueError('Metadata-only frozen task check failed before outcomes')
 ids=[t['id'] for t in tasks];outcomes={r[0]:dict(zip(['answer','reasons','detail','answered_at'],r[1:])) for r in pg.execute('SELECT id,answer,reasons,detail,answered_at FROM recording_label_tasks WHERE id=ANY(%s)',(ids,)).fetchall()}
 if set(outcomes)!=set(ids):raise ValueError('Outcome query differs from allowed IDs')
 return [dict(t,**outcomes[t['id']]) for t in tasks]

def intake(root,expected,fetch):
 manifest,_,_=load_contract(root,expected);payload=checked_answers(fetch(manifest),manifest)
 if payload['status']=='waiting':return payload
 path,sha,created=write_snapshot(root,payload,expected)
 return {'status':'snapshot_ready','batch_stem':STEM,'answered':len(manifest['rows']),'pending':0,'strict_pairs':payload['strict_pairs'],'snapshot_path':str(path),'snapshot_sha256':sha,'created':created,'only_version_preference':True}

def run(root,expected):
 import psycopg
 with psycopg.connect(base.pg_config()) as pg:
  pg.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');pg.execute("SET statement_timeout='15s'")
  result=intake(root,expected,lambda manifest:fetch_tasks(pg,manifest))
 print(json.dumps(result));return result

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=OUT);p.add_argument('--manifest-sha256',required=True);args=p.parse_args();run(args.root,args.manifest_sha256)
