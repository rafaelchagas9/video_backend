"""Read-only finite creator-expansion-v2 answer intake; no fitting, media, optional audit export or queue writes."""
from __future__ import annotations
import argparse,collections,datetime,hashlib,json,os,tempfile
from pathlib import Path
import creator_expansion_v2 as batch
import fine_labels as fl

FINAL_MANIFEST_SHA256='b7edc7bb32797a342f5a9a9523c70cdba99db743814fac5dfb2c55c9bbe682f1'
FIELDS=['id','kind','batch','video_id','start_seconds','end_seconds','stratum','position','channel','context','answer','reasons','detail','answered_at']


def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def load_contract(root):
 path=root/'private_manifest.json'
 if batch.base.digest(path)!=FINAL_MANIFEST_SHA256:raise fl.FineLabelContractError('Exact reviewed connected manifest checksum differs')
 manifest=json.loads(path.read_text());reserved,receipt=batch.previous.holdout_contract()
 if manifest['source_sha256']!=batch.base.digest(Path(batch.__file__)) or manifest['policy']!=batch.POLICY or manifest['holdout_dependency']!=receipt or manifest['excluded_holdout_creators']!=sorted(reserved):raise fl.FineLabelContractError('Frozen connected source/holdout dependency changed')
 if len(manifest['rows'])!=18 or [r['position'] for r in manifest['rows']]!=list(range(18)):raise fl.FineLabelContractError('Fixed eighteen-task positions changed')
 for row in manifest['rows']:
  context=row['context'];a,b=context['a'],context['b'];scope='same_channel' if a['channel_key']==b['channel_key'] else 'cross_channel'
  if {a['channel_key'],b['channel_key']}&reserved or context['reserved_fine_holdout'] is not False or context['fine_data_role']!='training':raise fl.FineLabelContractError('Reserved creator or nontraining role in connected round')
  if context['comparison_scope']!=scope or row['channel']!=(a['channel'] if scope=='same_channel' else None) or context['channel']!=row['channel']:raise fl.FineLabelContractError('Exact cross/same creator scope required')
 if any(r['kind']!='versus' or r['context'].get('selection_role')!='keep_preference' for r in manifest['rows']):raise fl.FineLabelContractError('Only eighteen reviewed keep-preference comparisons may be consumed')
 return manifest


def pair_records(rows):
 """Verified pair identities retain both creators; cross pairs are never assigned a fake group."""
 grouped=collections.defaultdict(list)
 for row in rows:
  fl._checked(row)
  if row.get('group')!=batch.base.canon(row.get('channel')):raise fl.FineLabelContractError('Exact per-side creator group required')
  grouped[row['task_id']].append(row)
 result=[]
 for task_id,pair in sorted(grouped.items()):
  if len(pair)!=2 or {r['side'] for r in pair}!={'a','b'}:raise fl.FineLabelContractError('Complete two-sided pair required')
  a,b=sorted(pair,key=lambda r:r['side']);creators=tuple(sorted({a['group'],b['group']}));scope='same_channel' if len(creators)==1 else 'cross_channel'
  if any(r.get('comparison_scope')!=scope or tuple(r.get('pair_creators',()))!=creators for r in pair):raise fl.FineLabelContractError('Both exact creator identities/scope required')
  result.append({'task_id':task_id,'comparison_scope':scope,'creators':list(creators),'rows':[a,b]})
 return result


def training_pairs_excluding_creators(rows,held_creators):
 """Only a pair whose NEITHER creator is held out can train PCA/scalers/heads.

This helper does not fit anything; downstream folds must call it before any transformation.
"""
 fl.require_fit_scope(rows);held=set(held_creators)
 return [pair for pair in pair_records(rows) if not set(pair['creators'])&held]



def strict_pair_metrics(rows,scores):
 """Scope-aware paired evaluation only, retaining actual creators and both sides."""
 if len(rows)!=len(scores):raise fl.FineLabelContractError('Ranking score/row alignment mismatch')
 values={}
 for row,score in zip(rows,scores):
  identity=(row['task_id'],row['side'])
  if identity in values:raise fl.FineLabelContractError('Duplicate evaluated side identity')
  values[identity]=fl._number(score)
 total=correct=ties=cross=same=0
 for pair in pair_records(rows):
  sides=pair['rows'];labels=[r['ranking_y'] for r in sides]
  if labels==[None,None]:continue
  if set(labels)!={0,1}:raise fl.FineLabelContractError('Both verified strict preference sides required')
  winner=next(r for r in sides if r['ranking_y']==1);loser=next(r for r in sides if r['ranking_y']==0)
  win=values[(winner['task_id'],winner['side'])];loss=values[(loser['task_id'],loser['side'])]
  total+=1;correct+=int(win>loss);ties+=int(win==loss)
  cross+=int(pair['comparison_scope']=='cross_channel');same+=int(pair['comparison_scope']=='same_channel')
 return {'strict_pairs':total,'correct_pairs':correct,'tied_pairs':ties,'cross_creator_strict_pairs':cross,'same_creator_strict_pairs':same}


def checked_answers(tasks,manifest):
 if len(tasks)!=18 or len({t['id'] for t in tasks})!=18 or {t['position'] for t in tasks}!=set(range(18)):raise fl.FineLabelContractError('Exactly eighteen unique stored task identities/positions required')
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
   labels.append(dict(meta,**verified,group=side['channel_key'],channel=side['channel'],recording=f"video{side['video_id']}",feedback_id=side['feedback_id'],analyzed_at=side['analyzed_at'],index=side['index'],source_fingerprint=side['source_fingerprint'],offered_range=[a,b],original_range=[ca,cb],answered_at=at,comparison_scope=scope,pair_creators=creators))
  confirmed.append(dict(task,answered_at=at))
 if pending:return {'status':'waiting','batch':batch.BATCH,'answered':18-pending,'pending':pending,'total':18,'cross_creator_answered':sum(t['context']['comparison_scope']=='cross_channel' for t in confirmed),'same_creator_answered':sum(t['context']['comparison_scope']=='same_channel' for t in confirmed)}
 fl.require_fit_scope(labels);pairs=pair_records(labels)
 for row in labels:
  cut=row['cut_gold'];row['boundary_changed_from_offered']=None if cut is None else abs(cut['start_seconds']-row['offered_range'][0])>.001 or abs(cut['end_seconds']-row['offered_range'][1])>.001
 cut_counts={'confirmed_cuts':sum(r['cut_gold'] is not None for r in labels),'changed_boundaries':sum(r['boundary_changed_from_offered'] is True for r in labels),'confirmed_unchanged':sum(r['boundary_changed_from_offered'] is False for r in labels)}
 return {'status':'complete','batch':batch.BATCH,'tasks':confirmed,'current_candidate_rows':labels,'confirmed_cut_gold':[dict(r,selected_range=[r['cut_gold']['start_seconds'],r['cut_gold']['end_seconds']]) for r in labels if r['cut_gold'] is not None],'training_pairs':pairs,'cut_counts':cut_counts,'unchanged_edges_limit':'Unchanged offered edge confirmations are not evidence of improved boundary precision.','label_summary':fl.summary(labels),'excluded_holdout_channels':sorted(reserved),'fold_contract':'Exclude an entire pair from training whenever either side creator is held out, BEFORE any PCA/scaling/model fitting. Per-side creator groups remain exact. No model/family/threshold decisions on reserved holdout.','target':fl.CURRENT_TARGET,'permanent_storage_worth':'unknown','future_replacement':'unknown','no_fitting_or_production_writes':True}


def write_snapshot(root,payload):
 value={'schema_version':1,'manifest_sha256':FINAL_MANIFEST_SHA256,'intake_source_sha256':batch.base.digest(Path(__file__)),'fine_labels_source_sha256':batch.base.digest(Path(fl.__file__)),'answers':payload};data=canonical(value)
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
 return {'status':'snapshot_ready','batch':batch.BATCH,'answered':18,'pending':0,'training_pairs':18,'snapshot_path':str(path),'snapshot_sha256':sha,'created':created,'no_fitting_or_production_writes':True}


def fetch_batch():
 import psycopg
 with psycopg.connect(batch.base.pg_config()) as connection:
  connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');connection.execute("SET statement_timeout='15s'")
  raw=connection.execute('SELECT '+','.join(FIELDS)+' FROM recording_label_tasks WHERE kind=%s AND batch=%s ORDER BY position',('versus',batch.BATCH)).fetchall()
 return [dict(zip(FIELDS,row)) for row in raw]

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=batch.OUT);args=parser.parse_args();print(json.dumps(intake(args.root,fetch_batch)))
