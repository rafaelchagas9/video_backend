"""Complete-only isolated blind version preference intake; no acceptance/cut labels or fits."""
from __future__ import annotations
import argparse,datetime,hashlib,json,os,tempfile
from pathlib import Path
import blind_version_round as batch
FINAL_SHA='f12119225672bc4217a5e37d5185b55805dd64127c6309af37723c517ff22b56'
FIELDS=batch.FIELDS+['id','answer','reasons','detail','answered_at']


def load_contract(root,expected=FINAL_SHA):
 if expected!=FINAL_SHA or batch.base.digest(root/'private_manifest.json')!=expected:raise ValueError('Exact reviewed blind manifest checksum required')
 value=json.loads((root/'private_manifest.json').read_text());reserved,receipt=batch.safe.previous.holdout_contract()
 if value['policy']!=batch.POLICY or value['source_sha256']!=batch.base.digest(Path(batch.__file__)) or value['holdout_dependency']!=receipt or value['excluded_holdout_creators']!=sorted(reserved):raise ValueError('Blind source/holdout dependency changed')
 sources={r['feedback_id']:r['source'] for r in value['private_assignments']}
 if value!=batch.make_manifest(sources,reserved,receipt):raise ValueError('Frozen private assignment/public range consistency differs')
 return value,reserved,receipt



def viewing_context(detail):
 if detail is None:return None
 if not isinstance(detail,dict) or set(detail)-{'viewing'}:raise ValueError('Version preference must not contain cut/acceptance details')
 if 'viewing' not in detail:return None
 value=detail['viewing']
 if not isinstance(value,dict) or set(value)-{'a','b'}:raise ValueError('Invalid viewing side metadata')
 for side,seen in value.items():
  if not isinstance(seen,dict) or set(seen)!={'preview_started','preview_completed','full_opened','full_completed'}:raise ValueError('Exact viewing fields required')
  for key in ('preview_started','preview_completed'):
   indices=seen[key]
   if not isinstance(indices,list) or len(indices)>3 or any(isinstance(n,bool) or not isinstance(n,int) or not 0<=n<3 for n in indices) or len(set(indices))!=len(indices):raise ValueError('Invalid preview coverage')
  if not set(seen['preview_completed'])<=set(seen['preview_started']) or not isinstance(seen['full_opened'],bool) or not isinstance(seen['full_completed'],bool) or (seen['full_completed'] and not seen['full_opened']):raise ValueError('Inconsistent viewing metadata')
 return value


def checked_answers(tasks,manifest):
 if len(tasks)!=6 or len({r['id'] for r in tasks})!=6 or {r['position'] for r in tasks}!=set(range(6)):raise ValueError('Exactly six blind task identities required')
 result=[];pending=0
 for task,plan in zip(sorted(tasks,key=lambda r:r['position']),manifest['rows']):
  if any(task[k]!=plan[k] for k in batch.FIELDS):raise ValueError('Frozen blind task/source/range context differs')
  answer=task.get('answer');at=task.get('answered_at');reasons=task.get('reasons');detail=task.get('detail')
  if not isinstance(reasons,list) or any(not isinstance(x,str) or len(x)>512 for x in reasons):raise ValueError('Invalid blind reasons')
  viewing=viewing_context(detail)
  if answer is None:
   if at is not None or reasons or detail is not None:raise ValueError('Unanswered blind task has stale outcome')
   pending+=1;continue
  if answer not in ('a','b','both','neither') or at is None:raise ValueError('Invalid blind preference provenance')
  stamp=batch.base.stamp(at)
  try:datetime.datetime.fromisoformat(stamp.replace('Z','+00:00'))
  except (ValueError,AttributeError) as e:raise ValueError('Invalid blind timestamp') from e
  context=task['context'];a,b=(context[k] for k in ('a','b'));groups={a['channel_key'],b['channel_key']}
  if len(groups)!=1 or groups&set(manifest['excluded_holdout_creators']) or context['reserved_fine_holdout'] is not False or context['fine_data_role']!='training':raise ValueError('Blind creator/holdout contract differs')
  result.append({'task_id':task['id'],'position':task['position'],'kind':'version-versus','batch':batch.BATCH,'answer':answer,'answered_at':stamp,'reasons':reasons,'group':a['channel_key'],'a':a,'b':b,'a_version_identity':batch.version_key(a),'b_version_identity':batch.version_key(b),'preferred_side':answer if answer in ('a','b') else None,'preference_outcome':'strict' if answer in ('a','b') else 'no_strict_preference' if answer=='both' else 'abstained','current_acceptability':'unknown','absolute_y':None,'cut_gold':None,'outside_quality':'unknown','permanent_storage_worth':'unknown','future_replacement':'unknown','viewing':viewing,'viewing_metadata_present':viewing is not None})
 if pending:return {'status':'waiting','batch':batch.BATCH,'answered':6-pending,'pending':pending,'total':6}
 return {'status':'complete','batch':batch.BATCH,'kind':'version-versus','target':'preferred_version_if_keep_one','preference_rows':result,'strict_pairs':sum(r['preferred_side'] is not None for r in result),'no_strict_preference':sum(r['answer']=='both' for r in result),'abstained':sum(r['answer']=='neither' for r in result),'current_acceptability':'not_observed','cut_gold':'not_observed','permanent_storage_worth':'not_observed','fine_legacy_compatibility':False,'no_fitting_or_production_writes':True}


def write_snapshot(root,payload):
 value={'schema_version':1,'manifest_sha256':FINAL_SHA,'intake_source_sha256':batch.base.digest(Path(__file__)),'answers':payload};data=batch.canonical(value)
 if len(data)>1024*1024:raise ValueError('Bounded blind snapshot exceeds1MiB')
 sha=hashlib.sha256(data).hexdigest();directory=root/'answer-snapshots';directory.mkdir(parents=True,exist_ok=True,mode=0o700);directory.chmod(0o700);path=directory/f'answers.{sha}.json'
 if path.exists():
  if path.read_bytes()!=data:raise ValueError('Immutable blind snapshot differs')
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


def intake(root,fetch):
 manifest,_,_=load_contract(root);payload=checked_answers(fetch(),manifest)
 if payload['status']=='waiting':return payload
 path,sha,created=write_snapshot(root,payload)
 return {'status':'snapshot_ready','batch':batch.BATCH,'answered':6,'pending':0,'strict_pairs':payload['strict_pairs'],'snapshot_path':str(path),'snapshot_sha256':sha,'created':created,'only_version_preference':True}


def fetch_batch():
 import psycopg
 with psycopg.connect(batch.base.pg_config()) as pg:
  pg.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');pg.execute("SET statement_timeout='15s'")
  return [dict(zip(FIELDS,r)) for r in pg.execute('SELECT '+','.join(FIELDS)+' FROM recording_label_tasks WHERE kind=%s AND batch=%s ORDER BY position',('version-versus',batch.BATCH)).fetchall()]

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=batch.OUT);args=parser.parse_args();print(json.dumps(intake(args.root,fetch_batch)))
