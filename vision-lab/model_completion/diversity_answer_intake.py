"""Finite diversity-round intake; current judgments, audit recovery and cut edits stay distinct.

No partial label export, fitting, reserved outcomes, media access or queue writes.
"""
from __future__ import annotations
import argparse,collections,datetime,hashlib,json,os,tempfile
from pathlib import Path
import creator_expansion_round as batch
import connected_answer_intake as paired
import fine_labels as fl

FINAL_MANIFEST_SHA256='3daf13acd2aa14a32c7b042ae1f889fad5f73f0e5aa5c2e13e2e31e2d1a3669e'
FIELDS=['id','kind','batch','video_id','start_seconds','end_seconds','stratum','position','channel','context','answer','reasons','detail','answered_at']


def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def load_contract(root):
 path=root/'private_manifest.json'
 if batch.base.digest(path)!=FINAL_MANIFEST_SHA256:raise fl.FineLabelContractError('Exact reviewed connected manifest checksum differs')
 manifest=json.loads(path.read_text());reserved,receipt=batch.previous.holdout_contract()
 if manifest['source_sha256']!=batch.base.digest(Path(batch.__file__)) or manifest['policy']!=batch.POLICY or manifest['holdout_dependency']!=receipt or manifest['excluded_holdout_creators']!=sorted(reserved):raise fl.FineLabelContractError('Frozen connected source/holdout dependency changed')
 if len(manifest['rows'])!=24 or [r['position'] for r in manifest['rows']]!=list(range(24)):raise fl.FineLabelContractError('Fixed twenty-four-task positions changed')
 for row in manifest['rows']:
  context=row['context'];a,b=context['a'],context['b'];scope='same_channel' if a['channel_key']==b['channel_key'] else 'cross_channel'
  if {a['channel_key'],b['channel_key']}&reserved or context['reserved_fine_holdout'] is not False or context['fine_data_role']!='training':raise fl.FineLabelContractError('Reserved creator or nontraining role in connected round')
  if context['comparison_scope']!=scope or row['channel']!=(a['channel'] if scope=='same_channel' else None) or context['channel']!=row['channel']:raise fl.FineLabelContractError('Exact cross/same creator scope required')
 return manifest


# Reuse the audited scope-aware contract; both creators retain their exact identities.
pair_records=paired.pair_records
training_pairs_excluding_creators=paired.training_pairs_excluding_creators
strict_pair_metrics=paired.strict_pair_metrics


def checked_answers(tasks,manifest):
 if len(tasks)!=24 or len({t['id'] for t in tasks})!=24 or {t['position'] for t in tasks}!=set(range(24)):raise fl.FineLabelContractError('Exactly twenty-four unique stored task identities/positions required')
 expected={r['position']:r for r in manifest['rows']};reserved=set(manifest['excluded_holdout_creators']);pending=0;labels=[];confirmed=[]
 for task in sorted(tasks,key=lambda r:r['position']):
  plan=expected[task['position']]
  if any(task[k]!=plan[k] for k in ('kind','batch','video_id','start_seconds','end_seconds','stratum','channel','context')):raise fl.FineLabelContractError('Stored connected immutable context differs')
  context=task['context'];answer=task.get('answer');detail=task.get('detail');reasons=task.get('reasons')
  if context.get('reserved_fine_holdout') is not False or context.get('fine_data_role')!='training' or {context[k]['channel_key'] for k in ('a','b')}&reserved:raise fl.FineLabelContractError('Connected training/reserved creator contract changed')
  if not isinstance(reasons,list) or any(not isinstance(x,str) or len(x)>512 for x in reasons):raise fl.FineLabelContractError('Invalid answer reason metadata')
  if answer is None:
   if task.get('answered_at') is not None or detail is not None or reasons:raise fl.FineLabelContractError('Unanswered task contains stale answer details')
   pending+=1;continue
  if answer not in ('a','b','both','neither') or task.get('answered_at') is None:raise fl.FineLabelContractError('Answered versus provenance incomplete')
  at=batch.base.stamp(task['answered_at'])
  if not isinstance(at,str):raise fl.FineLabelContractError('Invalid answer timestamp')
  try:datetime.datetime.fromisoformat(at.replace('Z','+00:00'))
  except ValueError as error:raise fl.FineLabelContractError('Invalid answer timestamp') from error
  if detail is not None and (not isinstance(detail,dict) or set(detail)-{'best'}):raise fl.FineLabelContractError('Invalid saved cut metadata')
  cuts=(detail or {}).get('best',{});chosen={'a','b'} if answer=='both' else set() if answer=='neither' else {answer}
  if not isinstance(cuts,dict) or set(cuts)!=chosen:raise fl.FineLabelContractError('Every chosen side requires a confirmed cut; neither has none')
  creators=sorted({context[k]['channel_key'] for k in ('a','b')});scope='same_channel' if len(creators)==1 else 'cross_channel'
  if context.get('comparison_scope')!=scope or task['channel']!=(context['a']['channel'] if scope=='same_channel' else None):raise fl.FineLabelContractError('Cross comparison must retain per-side creator identities and NULL task channel')
  for key in ('a','b'):
   side=context[key];ca,cb=map(fl._number,side['clip']);a,b=map(fl._number,side['best']);a,b=max(ca,a),min(cb,b)
   if side['channel_key']!=batch.base.canon(side['channel']):raise fl.FineLabelContractError('Per-side creator identity changed')
   meta={'row':f"p{task['id']}{key}",'task_id':task['id'],'video_id':side['video_id'],'start':a,'end':b,'answer':answer,'y':int(answer in (key,'both'))};verified=fl.contract(meta,task)
   if key in chosen:
    cut=cuts[key]
    if not isinstance(cut,dict) or set(cut)!={'start_seconds','end_seconds','accepted'} or not isinstance(cut.get('accepted'),bool):raise fl.FineLabelContractError('Confirmed cut keys/accepted boolean invalid')
    lo,hi=fl._number(cut['start_seconds']),fl._number(cut['end_seconds']);duration=fl._number(side['duration_seconds'])
    if not 0<=ca<=lo<hi<=cb<=duration+.1:raise fl.FineLabelContractError('Confirmed cut outside immutable original/live bounds')
   labels.append(dict(meta,**verified,group=side['channel_key'],channel=side['channel'],recording=f"video{side['video_id']}",feedback_id=side['feedback_id'],analyzed_at=side['analyzed_at'],index=side['index'],source_fingerprint=side['source_fingerprint'],offered_range=[a,b],original_range=[ca,cb],answered_at=at,comparison_scope=scope,pair_creators=creators,selection_role=context['selection_role']))
  confirmed.append(dict(task,answered_at=at))
 if pending:return {'status':'waiting','batch':batch.BATCH,'answered':24-pending,'pending':pending,'total':24,'cross_creator_answered':sum(t['context']['comparison_scope']=='cross_channel' for t in confirmed),'same_creator_answered':sum(t['context']['comparison_scope']=='same_channel' for t in confirmed),'audit_answered':sum(t['context']['selection_role']=='two_skip_audit' for t in confirmed)}
 fl.require_fit_scope(labels);pairs=pair_records(labels)
 for row in labels:
  cut=row['cut_gold']
  row['boundary_changed_from_offered']=None if cut is None else abs(cut['start_seconds']-row['offered_range'][0])>.001 or abs(cut['end_seconds']-row['offered_range'][1])>.001
 counts={'confirmed_cuts':sum(r['cut_gold'] is not None for r in labels),'changed_boundaries':sum(r['boundary_changed_from_offered'] is True for r in labels),'confirmed_unchanged':sum(r['boundary_changed_from_offered'] is False for r in labels),'audit_sides':sum(r['selection_role']=='two_skip_audit' for r in labels),'audit_current_rejects':sum(r['selection_role']=='two_skip_audit' and r['y']==0 for r in labels),'audit_current_recoveries':sum(r['selection_role']=='two_skip_audit' and r['y']==1 for r in labels)}
 return {'status':'complete','batch':batch.BATCH,'tasks':confirmed,'current_candidate_rows':labels,'confirmed_cut_gold':[dict(r,selected_range=[r['cut_gold']['start_seconds'],r['cut_gold']['end_seconds']]) for r in labels if r['cut_gold'] is not None],'training_pairs':pairs,'label_summary':fl.summary(labels),'cut_and_audit_counts':counts,'unchanged_cut_limit':'Confirmation of unchanged offered edges is retained honestly but is not evidence of improved boundary precision.','excluded_holdout_channels':sorted(reserved),'fold_contract':'Exclude an entire pair from training whenever either side creator is held out, BEFORE any PCA/scaling/model fitting. Per-side creator groups remain exact. No model/family/threshold decisions on reserved holdout.','target':fl.CURRENT_TARGET,'permanent_storage_worth':'unknown','future_replacement':'unknown','no_fitting_or_production_writes':True}


def write_snapshot(root,payload):
 value={'schema_version':1,'manifest_sha256':FINAL_MANIFEST_SHA256,'intake_source_sha256':batch.base.digest(Path(__file__)),'fine_labels_source_sha256':batch.base.digest(Path(fl.__file__)),'paired_contract_sha256':batch.base.digest(Path(paired.__file__)),'answers':payload};data=canonical(value)
 if len(data)>4*1024*1024:raise fl.FineLabelContractError('Private answer snapshot exceeds bounded size')
 sha=hashlib.sha256(data).hexdigest();directory=root/'answer-snapshots';path=directory/f'answers.{sha}.json';directory.mkdir(parents=True,exist_ok=True,mode=0o700);directory.chmod(0o700)
 if path.exists():
  if path.read_bytes()!=data:raise fl.FineLabelContractError('Immutable answer snapshot content differs')
  return path,sha,False
 fd,tmp=tempfile.mkstemp(prefix='.answers-',dir=directory)
 try:
  with os.fdopen(fd,'wb') as output:output.write(data);output.flush();os.fsync(output.fileno())
  os.chmod(tmp,0o600)
  try:os.link(tmp,path)
  except FileExistsError:
   if path.read_bytes()!=data:raise fl.FineLabelContractError('Concurrent immutable snapshot differs')
   return path,sha,False
  descriptor=os.open(directory,os.O_RDONLY)
  try:os.fsync(descriptor)
  finally:os.close(descriptor)
 finally:os.unlink(tmp)
 return path,sha,True


def intake(root,fetch):
 manifest=load_contract(root);payload=checked_answers(fetch(),manifest)
 if payload['status']=='waiting':return payload
 path,sha,created=write_snapshot(root,payload)
 return {'status':'snapshot_ready','batch':batch.BATCH,'answered':24,'pending':0,'training_pairs':24,'snapshot_path':str(path),'snapshot_sha256':sha,'created':created,'no_fitting_or_production_writes':True}


def fetch_batch():
 import psycopg
 with psycopg.connect(batch.base.pg_config()) as connection:
  connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');connection.execute("SET statement_timeout='15s'")
  raw=connection.execute('SELECT '+','.join(FIELDS)+' FROM recording_label_tasks WHERE kind=%s AND batch=%s ORDER BY position',('versus',batch.BATCH)).fetchall()
 return [dict(zip(FIELDS,row)) for row in raw]

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=batch.OUT);args=parser.parse_args();print(json.dumps(intake(args.root,fetch_batch)))
