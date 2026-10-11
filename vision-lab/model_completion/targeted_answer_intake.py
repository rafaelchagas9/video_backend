"""Finite read-only intake of the reviewed eight-task batch; no fitting or media access."""
from __future__ import annotations
import argparse,datetime,hashlib,json,os
from pathlib import Path
import fine_labels as fl
import targeted_label_round as batch
FINAL_MANIFEST_SHA256='97138b934ec6c586a711c7c99d213c1707e2a36179e1fa1f3c8786be64e79fd3'
FIELDS=['id','kind','batch','video_id','start_seconds','end_seconds','stratum','position','channel','context','answer','reasons','detail','answered_at']


def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def digest(value):return hashlib.sha256(canonical(value)).hexdigest()
def load_contract(root):
 path=root/'private_manifest.json'
 if batch.digest(path)!=FINAL_MANIFEST_SHA256:raise fl.FineLabelContractError('Final reviewed manifest checksum differs')
 manifest=json.loads(path.read_text())
 if manifest['source_sha256']!=batch.digest(Path(batch.__file__)):raise fl.FineLabelContractError('Frozen generator source checksum differs')
 if len(manifest['rows'])!=8 or [r['position'] for r in manifest['rows']]!=list(range(8)):raise fl.FineLabelContractError('Fixed eight-task positions changed')
 for role,positions in [('training',[0,1,2,3]),('holdout',[4,5,6,7])]:
  receipt=json.loads((root/f'fine_{role}.json').read_text());channels=manifest[f'{role}_channels']
  if receipt['source_manifest_sha256']!=FINAL_MANIFEST_SHA256 or receipt['batch']!=batch.BATCH or receipt['positions']!=positions or receipt['channel_count']!=4 or receipt['side_count']!=8 or receipt['channels']!=channels:raise fl.FineLabelContractError('Pre-answer role receipt differs')
 if set(manifest['training_channels'])&set(manifest['holdout_channels']):raise fl.FineLabelContractError('Training/holdout channels overlap')
 return manifest


def checked_answers(tasks,manifest):
 if len(tasks)!=8 or len({t['id'] for t in tasks})!=8 or {t['position'] for t in tasks}!=set(range(8)):raise fl.FineLabelContractError('Exactly eight unique stored task identities/positions required')
 expected={r['position']:r for r in manifest['rows']};pending=0;confirmed=[];labels=[]
 for task in sorted(tasks,key=lambda r:r['position']):
  plan=expected[task['position']]
  if any(task[k]!=plan[k] for k in ('kind','batch','video_id','start_seconds','end_seconds','stratum','channel','context')):raise fl.FineLabelContractError('Stored task immutable context differs from reviewed manifest')
  reserved=task['position']>=4;role='holdout' if reserved else 'training'
  if task['context'].get('reserved_fine_holdout') is not reserved or task['context'].get('fine_data_role')!=role:raise fl.FineLabelContractError('Pre-answer training/holdout role changed')
  answer=task['answer'];detail=task.get('detail');reasons=task.get('reasons')
  if not isinstance(reasons,list) or any(not isinstance(x,str) or len(x)>512 for x in reasons):raise fl.FineLabelContractError('Invalid answer reason metadata')
  if answer is None:
   if task.get('answered_at') is not None or detail is not None or reasons:raise fl.FineLabelContractError('Unanswered task contains stale answer details')
   pending+=1;continue
  if answer not in ('a','b','both','neither') or task.get('answered_at') is None:raise fl.FineLabelContractError('Answered versus provenance incomplete')
  at=task['answered_at']
  if isinstance(at,datetime.datetime):at=batch.stamp(at)
  if not isinstance(at,str):raise fl.FineLabelContractError('Invalid answer timestamp')
  try:datetime.datetime.fromisoformat(at.replace('Z','+00:00'))
  except ValueError as error:raise fl.FineLabelContractError('Invalid answer timestamp') from error
  if detail is not None and (not isinstance(detail,dict) or set(detail)-{'best'}):raise fl.FineLabelContractError('Invalid saved cut metadata')
  cuts=(detail or {}).get('best',{})
  if not isinstance(cuts,dict):raise fl.FineLabelContractError('Invalid saved cut map')
  chosen={'a','b'} if answer=='both' else set() if answer=='neither' else {answer}
  if set(cuts)!=chosen:raise fl.FineLabelContractError('Every chosen side requires a confirmed cut; neither has none')
  current=[]
  for side in ('a','b'):
   context=task['context'][side];a,b=context['best'];ca,cb=context['clip'];a,b=max(ca,a),min(cb,b)
   meta={'row':f"p{task['id']}{side}",'task_id':task['id'],'video_id':context['video_id'],'start':a,'end':b,'answer':answer,'y':int(answer in (side,'both'))}
   verified=fl.contract(meta,task)
   if side in chosen:
    cut=cuts[side]
    if not isinstance(cut,dict) or set(cut)!={'start_seconds','end_seconds','accepted'} or not isinstance(cut.get('accepted'),bool):raise fl.FineLabelContractError('Confirmed cut accepted marker must be boolean')
    lo,hi=fl._number(cut.get('start_seconds')),fl._number(cut.get('end_seconds'))
    duration=fl._number(context['duration_seconds'])
    if not 0<=ca<=lo<hi<=cb<=duration+.1:raise fl.FineLabelContractError('Confirmed cut lies outside immutable original/live duration')
   current.append(dict(meta,**verified,group=batch.canon(task['channel']),recording=f"video{context['video_id']}",feedback_id=context['feedback_id'],analyzed_at=context['analyzed_at'],index=context['index'],source_fingerprint=context['source_fingerprint'],offered_range=[a,b],original_range=[ca,cb],answered_at=at))
  labels.extend(current);confirmed.append(dict(task,answered_at=at))
 if pending:return {'status':'waiting','batch':batch.BATCH,'answered':8-pending,'pending':pending,'total':8,'training_answered':sum(t['position']<4 for t in confirmed),'holdout_answered':sum(t['position']>=4 for t in confirmed)}
 # Default fit guards remain active. Only training rows may be given to fitting helpers.
 training=[r for r in labels if not r['reserved_fine_holdout']];holdout=[r for r in labels if r['reserved_fine_holdout']]
 if len(training)!=8 or len(holdout)!=8 or {r['group'] for r in training}!={*manifest['training_channels']} or {r['group'] for r in holdout}!={*manifest['holdout_channels']}:raise fl.FineLabelContractError('Fixed four-channel split changed')
 fl.require_fit_scope(training)
 return {'status':'complete','batch':batch.BATCH,'tasks':confirmed,'current_candidate_rows':labels,'confirmed_cut_gold':[dict(row,selected_range=[row['cut_gold']['start_seconds'],row['cut_gold']['end_seconds']]) for row in labels if row['cut_gold'] is not None],'training_rows':training,'holdout_rows':holdout,'label_summary':fl.summary(labels),'roles':'Pre-answer positions0..3 training;4..7 untouched future fine holdout. No role changes or model selection from holdout.', 'target':fl.CURRENT_TARGET,'permanent_storage_worth':'unknown','future_replacement':'unknown','no_fitting_or_production_writes':True}


def write_snapshot(root,payload):
 value={'schema_version':1,'manifest_sha256':FINAL_MANIFEST_SHA256,'intake_source_sha256':batch.digest(Path(__file__)),'fine_labels_source_sha256':batch.digest(Path(fl.__file__)),'answers':payload}
 data=canonical(value)
 if len(data)>2*1024*1024:raise fl.FineLabelContractError('Private answer snapshot exceeds bounded size')
 sha=hashlib.sha256(data).hexdigest();directory=root/'answer-snapshots';path=directory/f'answers.{sha}.json'
 directory.mkdir(parents=True,exist_ok=True,mode=0o700);directory.chmod(0o700)
 if path.exists():
  if path.read_bytes()!=data:raise fl.FineLabelContractError('Immutable answer snapshot content differs')
  return path,sha,False
 # Unique temporary file + exclusive link prevents overwriting another immutable revision.
 import tempfile
 fd,tmp=tempfile.mkstemp(prefix='.answers-',dir=directory)
 try:
  with os.fdopen(fd,'wb') as output:output.write(data);output.flush();os.fsync(output.fileno())
  os.chmod(tmp,0o600)
  try:os.link(tmp,path)
  except FileExistsError:
   if path.read_bytes()!=data:raise fl.FineLabelContractError('Concurrent immutable snapshot content differs')
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
 return {'status':'snapshot_ready','batch':batch.BATCH,'answered':8,'pending':0,'training_answered':4,'holdout_answered':4,'training_channels':4,'holdout_channels':4,'snapshot_path':str(path),'snapshot_sha256':sha,'created':created,'no_fitting_or_production_writes':True}


def fetch_batch():
 import psycopg
 with psycopg.connect(batch.pg_config()) as connection:
  connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');connection.execute("SET statement_timeout='15s'")
  rows=connection.execute('SELECT '+','.join(FIELDS)+' FROM recording_label_tasks WHERE kind=%s AND batch=%s ORDER BY position',('versus',batch.BATCH)).fetchall()
 return [dict(zip(FIELDS,row)) for row in rows]

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=batch.OUT);args=parser.parse_args();print(json.dumps(intake(args.root,fetch_batch)))
