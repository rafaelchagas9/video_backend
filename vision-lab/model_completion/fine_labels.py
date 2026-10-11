"""Pure frozen-versus contract: current acceptability, ranking and saved cuts are distinct."""
from __future__ import annotations
import json,math,os,re
from pathlib import Path
from collections import Counter
POLICY='current-acceptability-versus-v2'
CURRENT_TARGET='current_keep_acceptability'
SEMANTICS={
 'policy':POLICY,'authority':'Direct user clarification on2026-10-10',
 'current_acceptability':{'a':[1,1],'b':[1,1],'both':[1,1],'neither':[0,0]},
 'relative_preference':'A/B identifies the substantially better winner; both/neither identify no winner.',
 'future_replacement':'Unknown. A current loser may later be replaced by stronger same-channel material; this is not a current reject or an expiry/deletion label.',
 'permanent_storage_worth':'Unknown; current acceptability must not be presented as final/permanent storage worth.',
 'compatibility_absolute_y':'Compatibility name for current acceptability only.',
 'saved_cuts':'Existing selected winner/both cuts remain valid, including accepted=false manual adjustments; no cut is invented for an unrefined loser.'}

def current_acceptability(answer):
 if answer not in ('a','b','both','neither'):raise FineLabelContractError('Unsupported versus answer')
 return 0 if answer=='neither' else 1

def freeze_semantics(path):
 path=Path(path)
 if path.exists():
  if json.loads(path.read_text())!=SEMANTICS:raise FineLabelContractError('Immutable semantic clarification changed')
  return
 path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 temp=path.with_suffix('.partial')
 with temp.open('w') as file:json.dump(SEMANTICS,file,allow_nan=False,indent=2);file.flush();os.fsync(file.fileno())
 temp.chmod(0o600);temp.replace(path)
class FineLabelContractError(ValueError):pass
class InsufficientAbsoluteLabels(ValueError):pass
class ReservedFineHoldoutError(FineLabelContractError):pass

def require_binary(labels,scope='absolute training'):
 values=list(labels)
 if any(v not in (0,1) for v in values) or set(values)!={0,1}:
  raise InsufficientAbsoluteLabels(f'{scope}: requires explicit positive and negative labels; unknowns cannot be negatives')

def _number(value):
 if isinstance(value,bool):raise FineLabelContractError('Boolean is not a range value')
 try:value=float(value)
 except (ValueError,TypeError) as e:raise FineLabelContractError('Invalid numeric range') from e
 if not math.isfinite(value):raise FineLabelContractError('Non-finite range')
 return value

def contract(meta,task):
 if task.get('kind')!='versus' or task.get('id')!=meta.get('task_id'):raise FineLabelContractError('Exact versus task identity required')
 row=meta.get('row','');match=re.fullmatch(r'p[0-9]+([ab])',row)
 if not match:raise FineLabelContractError('Neutral side identity required')
 side=match.group(1)
 if meta.get('side',side)!=side:raise FineLabelContractError('Side identity mismatch')
 answer=task.get('answer')
 if answer not in ('a','b','both','neither') or ('answer' in meta and meta['answer']!=answer):raise FineLabelContractError('Answered task provenance mismatch')
 reserved=task.get('context',{}).get('reserved_fine_holdout',False)
 if not isinstance(reserved,bool):raise FineLabelContractError('Reserved fine holdout marker must be boolean')
 context=task.get('context',{}).get(side)
 if not isinstance(context,dict) or context.get('video_id')!=meta.get('video_id'):raise FineLabelContractError('Side video identity mismatch')
 try:
  ca,cb=map(_number,context['clip']);a=max(ca,_number(context['best'][0]));b=min(cb,_number(context['best'][1]));a,b=(a,b) if b>a else (ca,cb)
  start,end=_number(meta['start']),_number(meta['end'])
 except (KeyError,TypeError,ValueError) as e:raise FineLabelContractError('Offered range provenance missing or invalid') from e
 if not ca<cb or abs(start-a)>.001 or abs(end-b)>.001:raise FineLabelContractError('Exact pre-answer offered range required')
 legacy=int(answer in (side,'both'))
 if 'y' in meta and meta['y']!=legacy:raise FineLabelContractError('Historical side label provenance mismatch')
 absolute=current_acceptability(answer)
 relative=int(answer==side) if answer in ('a','b') else None
 cut=None;selected=(task.get('detail') or {}).get('best',{}).get(side)
 if selected is not None:
  if answer not in (side,'both'):raise FineLabelContractError('Final cut belongs to an unchosen side')
  try:lo,hi=_number(selected['start_seconds']),_number(selected['end_seconds'])
  except (KeyError,TypeError,ValueError) as e:raise FineLabelContractError('Invalid saved final cut') from e
  if not ca-.01<=lo<hi<=cb+.01:raise FineLabelContractError('Saved final cut outside kept context')
  cut={'start_seconds':lo,'end_seconds':hi,'accepted_offered_edges':selected.get('accepted')}
 return {'fine_label_policy':POLICY,'label_target':CURRENT_TARGET,'task_id':task['id'],'side':side,'legacy_y':legacy,'y':absolute,'absolute_y':absolute,'current_acceptability_y':absolute,'ranking_y':relative,'future_replacement_y':None,'permanent_storage_y':None,'cut_gold':cut,'reserved_fine_holdout':reserved,'fine_data_role':'holdout' if reserved else 'training'}

def annotate_rows(rows,private_rows,tasks):
 private={};bytask={}
 for meta in private_rows:
  if meta['row'] in private:raise FineLabelContractError('Duplicate private side identity')
  private[meta['row']]=meta
 for task in tasks:
  if task['id'] in bytask:raise FineLabelContractError('Duplicate task identity')
  bytask[task['id']]=task
 seen=set();result=[]
 for row in rows:
  key=row.get('row')
  if key in seen or key not in private:raise FineLabelContractError('Missing or duplicate public side identity')
  seen.add(key);meta=private[key]
  if meta['task_id'] not in bytask:raise FineLabelContractError('Private task absent from frozen answers')
  if any(k in row and k in meta and row[k]!=meta[k] for k in ('task_id','video_id','start','end','group','recording')):raise FineLabelContractError('Public/private side provenance mismatch')
  verified=contract(meta,bytask[meta['task_id']])
  if 'legacy_y' in row and row['legacy_y']!=verified['legacy_y']:raise FineLabelContractError('Public/private historical side provenance mismatch')
  if 'y' in row:
   expected=verified['current_acceptability_y'] if row.get('fine_label_policy')==POLICY and row.get('label_target')==CURRENT_TARGET else verified['legacy_y']
   if row['y']!=expected:raise FineLabelContractError('Public/private side target provenance mismatch')
  result.append(dict(row,**verified))
 return result

def _checked(row):
 if row.get('fine_label_policy')!=POLICY:raise FineLabelContractError('Absolute/relative labels require the shared verified contract')
 if row.get('absolute_y') not in (0,1):raise FineLabelContractError('V2 current acceptability cannot be unknown after verification')
 if row.get('label_target',CURRENT_TARGET)!=CURRENT_TARGET or row.get('current_acceptability_y',row.get('absolute_y'))!=row.get('absolute_y'):raise FineLabelContractError('Compatibility absolute target must be current acceptability')
 if row.get('future_replacement_y') is not None or row.get('permanent_storage_y') is not None:raise FineLabelContractError('No permanent storage/replacement label is available')
 return row

def require_fit_scope(rows,scope='fine model fitting'):
 for row in rows:
  reserved=row.get('reserved_fine_holdout',False)
  if not isinstance(reserved,bool):raise FineLabelContractError('Reserved fine holdout marker must be boolean')
  if reserved or row.get('fine_data_role')=='holdout':raise ReservedFineHoldoutError(f'{scope}: reserved future fine holdout cannot fit PCA/scaling/models or select a family/threshold')


def require_task_fit_scope(tasks,scope='fine cut fitting'):
 for task in tasks:
  reserved=(task.get('context') or {}).get('reserved_fine_holdout',False)
  if not isinstance(reserved,bool):raise FineLabelContractError('Reserved fine holdout marker must be boolean')
  if task.get('kind')=='versus' and reserved:raise ReservedFineHoldoutError(f'{scope}: reserved future fine holdout tasks require explicit evaluation-only access')


def absolute_rows(rows,*,for_fit=True):
 rows=list(rows)
 if for_fit:require_fit_scope(rows)
 return [dict(_checked(r),y=r['absolute_y']) for r in rows if _checked(r)['absolute_y'] is not None]


def ranking_rows(rows,*,for_fit=True):
 rows=list(rows)
 if for_fit:require_fit_scope(rows)
 return [dict(_checked(r),y=r['ranking_y']) for r in rows if _checked(r)['ranking_y'] is not None]

def strict_pair_metrics(rows,scores):
 if len(rows)!=len(scores):raise FineLabelContractError('Ranking score/row alignment mismatch')
 groups={}
 for row,score in zip(rows,scores):
  _checked(row);value=_number(score)
  if row.get('ranking_y') is None:continue
  if row['ranking_y'] not in (0,1) or 'task_id' not in row:raise FineLabelContractError('Verified ranking task identity required')
  groups.setdefault(row['task_id'],[]).append((row,value))
 correct=ties=total=0
 for pair in groups.values():
  if len(pair)==1:continue
  if len(pair)!=2 or {row['ranking_y'] for row,value in pair}!={0,1} or len({row['group'] for row,value in pair})!=1:raise FineLabelContractError('Strict ranking pair provenance mismatch')
  winner=next(value for row,value in pair if row['ranking_y']==1);loser=next(value for row,value in pair if row['ranking_y']==0)
  total+=1;correct+=int(winner>loser);ties+=int(winner==loser)
 return {'strict_pairs':total,'correct_pairs':correct,'tied_pairs':ties}

def summary(rows):
 for r in rows:_checked(r)
 absolute=absolute_rows(rows,for_fit=False);ranking=ranking_rows(rows,for_fit=False)
 return {'policy':POLICY,'reserved_holdout_sides':sum(r.get('reserved_fine_holdout',False) for r in rows),'fit_eligible_sides':sum(not r.get('reserved_fine_holdout',False) for r in rows),'sides':len(rows),'absolute_sides':len(absolute),'absolute_positive':sum(r['y'] for r in absolute),'absolute_negative':sum(1-r['y'] for r in absolute),'absolute_unknown':len(rows)-len(absolute),'ranking_sides':len(ranking),'ranking_pairs':len({r['task_id'] for r in ranking}),'valid_final_cuts':sum(r['cut_gold'] is not None for r in rows),'current_acceptability_sides':len(absolute),'current_acceptability_positive':sum(r['y'] for r in absolute),'current_acceptability_negative':sum(1-r['y'] for r in absolute),'future_replacement_unknown':len(rows),'permanent_storage_unknown':len(rows),'absolute_y_target':CURRENT_TARGET,'semantics':'A/B and both make both sides current keep candidates; neither rejects both currently. Ranking and selected saved cuts remain independent. Future replacement and permanent storage worth remain unknown.'}
