"""Explicit whole outcomes only; no clip/cut targets, fitting or production writes."""
from __future__ import annotations
import argparse,copy,hashlib,json,math,signal,time
from pathlib import Path
import whole_round_prepare as contract
from channel_partial_order import immutable_write
base=contract.base

def fetch_tasks(pg,manifest):
 fields=contract.FIELDS+['id'];plans={contract.task_key(r):r for r in manifest['rows']}
 tasks=[dict(zip(fields,r)) for r in pg.execute('SELECT '+','.join(fields)+' FROM recording_label_tasks WHERE batch=%s ORDER BY position',(contract.BATCH,)).fetchall()]
 if len(tasks)!=len(plans) or len({t['id'] for t in tasks})!=len(plans) or {contract.task_key(t) for t in tasks}!=set(plans) or any(any(t[k]!=plans[contract.task_key(t)][k] for k in contract.FIELDS) for t in tasks):raise ValueError('Metadata-only exact whole task validation must pass before outcomes')
 ids=[t['id'] for t in tasks];outcomes={r[0]:dict(zip(['answer','reasons','detail','answered_at'],r[1:])) for r in pg.execute('SELECT id,answer,reasons,detail,answered_at FROM recording_label_tasks WHERE id=ANY(%s)',(ids,)).fetchall()}
 if set(outcomes)!=set(ids):raise ValueError('Whole outcomes outside exact allowed IDs')
 return [dict(t,**outcomes[t['id']]) for t in tasks]

def checked_answers(tasks,manifest,reserved):
 plans={contract.task_key(r):r for r in manifest['rows']}
 if len(tasks)!=len(plans) or len({t['id'] for t in tasks})!=len(plans) or {contract.task_key(t) for t in tasks}!=set(plans):raise ValueError('Exact whole task identities required')
 output=[];pending=0
 for task in sorted(tasks,key=contract.task_key):
  if any(task[k]!=plans[contract.task_key(task)][k] for k in contract.FIELDS):raise ValueError('Frozen whole source/context drift')
  task=copy.deepcopy(task);task['answered_at']=base.stamp(task.get('answered_at'));row=contract.labels.contract(task,reserved)
  if row is None:pending+=1
  else:output.append(row)
 if pending:return {'status':'waiting','batch':contract.BATCH,'answered':len(output),'pending':pending,'total':len(plans)}
 return {'status':'complete','batch':contract.BATCH,'label_policy':contract.labels.POLICY,'label_target':contract.labels.TARGET,'whole_rows':output,'positive':sum(r['y']==1 for r in output),'negative':sum(r['y']==0 for r in output),'unknown':sum(r['y'] is None for r in output),'whole_positive_creators':len({r['group'] for r in output if r['y']==1}),'positive_class_manufactured':False,'population_prevalence_sample':False,'probability_calibrated':False,'clip_targets_observed':False,'cut_targets_observed':False,'permanent_storage_targets_observed':False,'model_fits':0,'enabled':False}

def intake(root,expected,fetch):
 manifest,reserved,_=contract.load_contract(root,expected);payload=checked_answers(fetch(manifest),manifest,reserved)
 if payload['status']=='waiting':return payload
 value={'schema_version':1,'manifest_sha256':expected,'intake_source_sha256':base.digest(Path(__file__)),'labels_source_sha256':base.digest(Path(contract.labels.__file__)),'answers':payload};sha=hashlib.sha256(contract.canonical(value)+b'\n').hexdigest();path=Path(root)/'answer-snapshots'/f'answers.{sha}.json';immutable_write(path,value)
 return {'status':'snapshot_ready','batch':contract.BATCH,'snapshot_path':str(path),'snapshot_sha256':sha,'answered':len(manifest['rows']),'pending':0,'positive':payload['positive'],'negative':payload['negative'],'unknown':payload['unknown'],'model_fits':0}

def run(root,expected):
 import psycopg
 with psycopg.connect(base.pg_config()) as pg:
  pg.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');pg.execute("SET statement_timeout='15s'");result=intake(root,expected,lambda manifest:fetch_tasks(pg,manifest))
 print(json.dumps(result));return result

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=contract.OUT);p.add_argument('--manifest-sha256',required=True);a=p.parse_args();signal.alarm(max(1,math.ceil(contract.MAX_SECONDS-(time.monotonic()-contract.PROCESS_START))));run(a.root,a.manifest_sha256)
