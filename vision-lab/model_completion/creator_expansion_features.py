"""Append one complete reviewed18-versus snapshot to immutable48 numeric training sides.

No fits, optional audits, held-out outcomes, audio/cache access, media decode or DB writes.
Old rows retain their exact values and old frame root; new rows bind exact live numeric generations.
"""
from __future__ import annotations
import time
PROCESS_STARTED=time.monotonic()
import argparse,copy,hashlib,json,os,signal,tempfile
from pathlib import Path
os.environ.setdefault('OMP_NUM_THREADS','2');os.environ.setdefault('OPENBLAS_NUM_THREADS','2');os.environ.setdefault('MKL_NUM_THREADS','2')
import numpy as np
import new_round_features as numeric
import creator_expansion_intake as intake
import fine_labels as labels

ROOT=numeric.ROOT
OLD_SHA='014b9a6c69e1d55eeff0f9af0daf2e3f3f7c33437255ee88d04cbf9c00099a98'
MANIFEST_SHA='b7edc7bb32797a342f5a9a9523c70cdba99db743814fac5dfb2c55c9bbe682f1'
PREREG_SHA='12556dba4fd030e644b3d4a016027a7aec7f55cbfa335e4f991923f50a3ee2ae'
FIT_SOURCE_SHA='c7d5dedfe3c3a2b7ebc454b6fd3935a72b0517f29e15f3713b98d086593ebdf9'
MAX_SECONDS=180

def check(deadline):
 if time.monotonic()>=deadline:raise TimeoutError('Numeric-only180s exporter deadline expired; no fitting or media fallback')
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def read_json(path,max_bytes=16*1024*1024):
 path=Path(path)
 if path.stat().st_size>max_bytes:raise labels.FineLabelContractError('Bounded numeric JSON size exceeded')
 return json.loads(path.read_text())
def node_identity(row):
 return numeric.digest({k:row[k] for k in ('feedback_id','video_id','analyzed_at','offered_range','source_fingerprint','index')})

def load_contract(root,answer_sha):
 if not isinstance(answer_sha,str) or len(answer_sha)!=64 or any(c not in '0123456789abcdef' for c in answer_sha):raise labels.FineLabelContractError('An explicit immutable completed answer SHA is required')
 batch=root/'creator-expansion-v2';spec_path=batch/'preregistered_training.json'
 if sha(spec_path)!=PREREG_SHA:raise labels.FineLabelContractError('Frozen ranking preregistration changed')
 spec=read_json(spec_path)
 if spec['fit_source_sha256']!=FIT_SOURCE_SHA or sha(Path(__file__).with_name('learned_preference_round.py'))!=FIT_SOURCE_SHA or spec['old_training_feature_cohort_sha256']!=OLD_SHA or spec['new_training_manifest_sha256']!=MANIFEST_SHA:raise labels.FineLabelContractError('Fixed ranking recipe/source or input pins changed')
 manifest=intake.load_contract(batch)
 if sha(batch/'private_manifest.json')!=MANIFEST_SHA:raise labels.FineLabelContractError('Reviewed18-versus manifest differs')
 path=batch/'answer-snapshots'/f'answers.{answer_sha}.json'
 if sha(path)!=answer_sha:raise labels.FineLabelContractError('Explicit answer snapshot content checksum differs')
 payload=read_json(path,4*1024*1024)
 expected={'schema_version':1,'manifest_sha256':MANIFEST_SHA,'intake_source_sha256':sha(Path(intake.__file__)),'fine_labels_source_sha256':sha(Path(labels.__file__))}
 if any(payload.get(k)!=v for k,v in expected.items()):raise labels.FineLabelContractError('Answer snapshot policy/source/manifest provenance differs')
 answers=payload.get('answers',{})
 if answers.get('status')!='complete' or len(answers.get('tasks',[]))!=18 or len(answers.get('current_candidate_rows',[]))!=36:raise labels.FineLabelContractError('Incomplete18-versus answers cannot produce training features')
 # Reconstruct every target from the exact task context, not the supplied binary y.
 reconstructed=intake.checked_answers(answers['tasks'],manifest)
 if answers!=reconstructed:raise labels.FineLabelContractError('Frozen answer rows/details differ from verified exact tasks')
 rows=copy.deepcopy(answers['current_candidate_rows']);reserved=set(manifest['excluded_holdout_creators']);labels.require_fit_scope(rows)
 if len({r['row'] for r in rows})!=36 or any(r['group'] in reserved for r in rows):raise labels.FineLabelContractError('Duplicate or reserved new side')
 tasks={t['id']:t for t in answers['tasks']};plans={}
 for row in rows:
  task=tasks[row['task_id']];ctx=task['context'][row['side']]
  if task['kind']!='versus' or task['context']['selection_role']!='keep_preference':raise labels.FineLabelContractError('Optional recall audits cannot enter preference training')
  if any(row[k]!=ctx[k] for k in ('feedback_id','video_id','analyzed_at','source_fingerprint','index')) or row['group']!=ctx['channel_key'] or row['original_range']!=ctx['clip']:raise labels.FineLabelContractError('Exact new side identity/generation/source/creator differs')
  row['batch']=task['batch'];plans[row['row']]=ctx
 old_base=root/'new-round-training';old_path=old_base/'feature_cohort.json'
 if sha(old_path)!=OLD_SHA:raise labels.FineLabelContractError('Original48 training snapshot changed')
 old=read_json(old_path)
 if old['format']!='kura-new-round-training-features' or old['policy']!=labels.POLICY or len(old['rows'])!=48 or set(old['reserved_creators_excluded'])!=reserved:raise labels.FineLabelContractError('Old training-only cohort or reserved creator contract differs')
 labels.require_fit_scope(old['rows'])
 if any(r['group'] in reserved for r in old['rows']) or len({r['row'] for r in old['rows']})!=48 or {r['row'] for r in rows}&{r['row'] for r in old['rows']}:raise labels.FineLabelContractError('Old/new duplicate or reserved side')
 return old,rows,plans,reserved,{'answer_sha256':answer_sha,'manifest_sha256':MANIFEST_SHA,'preregistered_training_sha256':PREREG_SHA,'fit_source_sha256':FIT_SOURCE_SHA,'intake_source_sha256':expected['intake_source_sha256'],'fine_labels_source_sha256':expected['fine_labels_source_sha256'],'old_feature_cohort_sha256':OLD_SHA,'selected_field':'answers.current_candidate_rows','selected_tasks':18,'selected_sides':36,'optional_audit_sides':0}

def numeric_new_rows(rows,plans,connection,out,deadline):
 check(deadline);fids=sorted({r['feedback_id'] for r in rows})
 live={r['feedback_id']:r for r in (dict(zip(numeric.connected.COLS,raw)) for raw in connection.execute(numeric.connected.QUERY,(fids,)).fetchall())}
 if set(live)!=set(fids) or any(r['is_available'] is not True for r in live.values()):raise labels.FineLabelContractError('Every exact new feedback/source identity must be available')
 values=[];inputs={}
 for row in rows:
  check(deadline);ctx=plans[row['row']];source=live[row['feedback_id']];numeric.validate_live(row,ctx,source);key=(row['video_id'],ctx['analyzed_at'])
  if key not in inputs:inputs[key]=numeric.frame_inputs(source,ctx,connection)
  t,v,proposals,identity=inputs[key];a,b=row['offered_range'];fx,visual=numeric.domain_features(row,ctx,source,t,v,proposals,a,b)
  if visual is None:raise labels.FineLabelContractError('Exact offered range has no cached point-frame visual support')
  value=copy.deepcopy(row);value.update(numeric_identity=identity,features=fx,visual_mean=visual,duration_seconds=source['duration'],score=ctx['score'])
  value['domains']={'offered':{'range':[a,b],'features':fx,'visual_mean':visual,'audio':None,'audio_status':'not_requested_numeric_only'}}
  values.append(value)
 for (vid,generation),(t,v,proposals,identity) in inputs.items():
  check(deadline);digest=numeric.digest(identity);directory=out/'frames';directory.mkdir(exist_ok=True,mode=0o700);path=directory/f'{digest}.npz'
  # Output belongs to a unique answer-version staging directory; no historical cache overwrite.
  with path.open('xb') as output:np.savez_compressed(output,t=t,v=v.astype(np.float32),identity_sha256=digest)
  path.chmod(0o600)
  with np.load(path,allow_pickle=False) as stored:
   if str(stored['identity_sha256'])!=digest or not np.array_equal(stored['t'],t) or not np.array_equal(stored['v'],v.astype(np.float32)):raise labels.FineLabelContractError('New numeric frame checkpoint failed byte-value verification')
  for value in values:
   if value['video_id']==vid and value['analyzed_at']==generation:value['frame_checkpoint']={'file':str(path.relative_to(out)),'sha256':sha(path),'identity_sha256':digest}
 return values

def combine(old,new_rows,receipt,reserved,old_base,out):
 if len(old['rows'])!=48 or len(new_rows)!=36:raise labels.FineLabelContractError('Exactly48 immutable plus36 new sides required')
 all_rows=copy.deepcopy(old['rows'])+copy.deepcopy(new_rows);labels.require_fit_scope(all_rows)
 if len({r['row'] for r in all_rows})!=84 or any(r['group'] in reserved for r in all_rows):raise labels.FineLabelContractError('Combined side identities or reserved scope invalid')
 result=copy.deepcopy(old);result.update(rows=all_rows,source_sha256=sha(Path(__file__)),answers=copy.deepcopy(old['answers'])+[dict(batch='creator-expansion-v2',**receipt)],preregistered_training_sha256=PREREG_SHA,fit_source_sha256=FIT_SOURCE_SHA)
 result['frame_checkpoint_origins']={r['row']:str(old_base.resolve()) for r in old['rows']}
 result['frame_checkpoint_origins'].update({r['row']:str(out.resolve()) for r in new_rows})
 result['frame_checkpoint_resolution']='Resolve relative frame_checkpoint.file against this per-row origin. Old48 rows retain their original frame_cache/provenance exactly; this exporter supplies ranking offered means and does not train cuts.'
 result['offered_version_sha256']={r['row']:node_identity(r) for r in all_rows}
 result['old_rows_value_sha256']=numeric.digest(old['rows']);result['new_answer_sha256']=receipt['answer_sha256'];result['optional_audit_sides']=0;result['numeric_only_append']=True
 if result['rows'][:48]!=old['rows']:raise labels.FineLabelContractError('Historical48 rows changed')
 return result

def prepare(root,answer_sha):
 deadline=PROCESS_STARTED+MAX_SECONDS
 def expired(*args):raise TimeoutError('Single180s total numeric exporter deadline expired')
 signal.signal(signal.SIGALRM,expired);signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
 stage=None
 try:
  check(deadline);old,rows,plans,reserved,receipt=load_contract(root,answer_sha)
  parent=root/'creator-expansion-v2/training-features';out=parent/f'answers.{answer_sha}'
  if out.exists():raise labels.FineLabelContractError('This answer-version feature export already exists; no overwrite')
  parent.mkdir(parents=True,exist_ok=True,mode=0o700);parent.chmod(0o700);stage=Path(tempfile.mkdtemp(prefix='.numeric-',dir=parent));stage.chmod(0o700)
  import psycopg
  with psycopg.connect(numeric.base.pg_config()) as connection:
   connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');connection.execute("SET statement_timeout='45s'")
   new=numeric_new_rows(rows,plans,connection,stage,deadline)
  for r in new:r['frame_cache']=str((out/r['frame_checkpoint']['file']).resolve())
  payload=combine(old,new,receipt,reserved,root/'new-round-training',out);check(deadline)
  if sha(root/'new-round-training/feature_cohort.json')!=OLD_SHA:raise labels.FineLabelContractError('Old training bytes changed during append')
  summary={'status':'complete','training_sides':84,'old_sides_preserved':48,'new_sides':36,'new_tasks':18,'strict_pairs':len({r['task_id'] for r in payload['rows'] if r['ranking_y'] is not None}),'creators':len({r['group'] for r in payload['rows']}),'positive':sum(r['y'] for r in payload['rows']),'negative':sum(not r['y'] for r in payload['rows']),'old_feature_cohort_sha256':OLD_SHA,'new_answer_sha256':answer_sha,'preregistered_training_sha256':PREREG_SHA,'reserved_creators_excluded':len(reserved),'optional_audit_sides':0,'fits':0,'GPU':False,'audio_reads':0,'media_reads':0,'database_writes':0,'holdout_outcomes_accessed':False}
  numeric.base.save_frozen(stage/'feature_cohort.json',payload);summary['feature_cohort_sha256']=sha(stage/'feature_cohort.json');summary['elapsed_seconds']=time.monotonic()-PROCESS_STARTED;numeric.base.save_frozen(stage/'summary.json',summary);check(deadline)
  # Single local publish of a complete version; answers and earlier outputs remain untouched.
  os.rename(stage,out);stage=None;return summary
 finally:
  signal.setitimer(signal.ITIMER_REAL,0)
  if stage is not None:numeric.base.save_frozen(stage/'failure.json',{'status':'incomplete_not_published','answer_sha256':answer_sha,'holdout_outcomes_accessed':False,'fits':0,'media_reads':0,'GPU':False})

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=ROOT);parser.add_argument('--answer-sha',required=True);a=parser.parse_args()
 try:print(json.dumps(prepare(a.root,a.answer_sha)))
 except Exception as error:print(json.dumps({'status':'failed_closed','error_type':type(error).__name__,'message':'No complete numeric training version published; verify immutable contract or source availability.','fits':0,'media_reads':0,'database_writes':0}));raise SystemExit(1)
