"""Complete-only immutable temporal preferences, isolated from acceptance/cut/whole labels."""
from __future__ import annotations
import argparse,datetime,json
from pathlib import Path
import temporal_version_round as batch
from blind_version_counterbalanced_intake import viewing_context
FIELDS=batch.FIELDS+['id','answer','reasons','detail','answered_at']


def checked_answers(tasks,manifest):
 if len(tasks)!=5 or len({r['id'] for r in tasks})!=5 or {r['position'] for r in tasks}!=set(range(5)):raise ValueError('Exactly five frozen temporal task identities required')
 rows=[];pending=0;private={p['position']:p for p in manifest['private_assignments']}
 for task,plan in zip(sorted(tasks,key=lambda t:t['position']),manifest['rows']):
  if any(task[k]!=plan[k] for k in batch.FIELDS):raise ValueError('Frozen temporal task context/source/range differs')
  answer=task.get('answer');at=task.get('answered_at');reasons=task.get('reasons');detail=task.get('detail')
  if not isinstance(reasons,list) or any(not isinstance(r,str) or len(r)>512 for r in reasons):raise ValueError('Valid preference reasons required')
  viewing=viewing_context(detail)
  if answer is None:
   if at is not None or reasons or detail is not None:raise ValueError('Unanswered temporal task has stale outcome')
   pending+=1;continue
  if answer not in ('a','b','both','neither') or at is None:raise ValueError('Explicit temporal preference answer provenance required')
  stamp=batch.base.stamp(at)
  try:datetime.datetime.fromisoformat(stamp.replace('Z','+00:00'))
  except (ValueError,AttributeError) as e:raise ValueError('Valid answer timestamp required') from e
  context=task['context'];a,b=context['a'],context['b'];groups={a['channel_key'],b['channel_key']}
  if len(groups)!=1 or groups&set(manifest['excluded_holdout_creators']) or context['reserved_fine_holdout'] is not False or context['fine_data_role']!='training':raise ValueError('Same-source creator and reserved guard differs')
  rows.append({'task_id':task['id'],'position':task['position'],'batch':batch.BATCH,'kind':'version-versus','target':'preferred_version_if_keep_one','answer':answer,'answered_at':stamp,'reasons':reasons,'group':a['channel_key'],'a':a,'b':b,'a_version_identity':batch.version_key(a),'b_version_identity':batch.version_key(b),'preferred_side':answer if answer in ('a','b') else None,'preference_outcome':'strict' if answer in ('a','b') else 'no_strict_preference' if answer=='both' else 'abstained','current_acceptability':'unknown','absolute_y':None,'cut_gold':None,'outside_quality':'unknown','whole_verdict':None,'permanent_storage_worth':'unknown','future_replacement':'unknown','viewing':viewing,'pilot_role':private[task['position']]['pilot_role']})
 if pending:return {'status':'waiting','batch':batch.BATCH,'answered':5-pending,'pending':pending,'total':5}
 return {'status':'complete','batch':batch.BATCH,'target':'preferred_version_if_keep_one','preference_rows':rows,'strict_pairs':sum(r['preferred_side'] is not None for r in rows),'no_strict_preference':sum(r['answer']=='both' for r in rows),'abstained':sum(r['answer']=='neither' for r in rows),'known_debug_pairs':1,'other_diagnostic_pairs':4,'labels_created_except_preferences':False,'automatic_model_promotion':False,'fits':0}


def intake(root,expected,fetch):
 value,_,_=batch.load_contract(root,expected);answers=checked_answers(fetch(),value)
 if answers['status']=='waiting':return answers
 result={'schema_version':1,'manifest_sha256':expected,'intake_source_sha256':batch.base.digest(Path(__file__)),'diagnostic_report_sha256':batch.REPORT_SHA,'answers':answers};digest=batch.diagnostic.sha(batch.canonical(result)+b'\n');path=Path(root)/'answer-snapshots'/f'answers.{digest}.json';existed=path.exists();batch.diagnostic.frozen(path,result)
 return {'status':'snapshot_ready','batch':batch.BATCH,'answered':5,'pending':0,'strict_pairs':answers['strict_pairs'],'snapshot_sha256':batch.base.digest(path),'snapshot_path':str(path),'created':not existed,'only_version_preference':True,'automatic_model_promotion':False}


def fetch_batch():
 import psycopg
 with psycopg.connect(batch.base.pg_config()) as pg:
  pg.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');pg.execute("SET statement_timeout='15s'")
  return [dict(zip(FIELDS,r)) for r in pg.execute('SELECT '+','.join(FIELDS)+' FROM recording_label_tasks WHERE kind=%s AND batch=%s ORDER BY position',('version-versus',batch.BATCH)).fetchall()]

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=batch.OUT);p.add_argument('--manifest-sha256',required=True);a=p.parse_args();print(json.dumps(intake(a.root,a.manifest_sha256,fetch_batch)))
