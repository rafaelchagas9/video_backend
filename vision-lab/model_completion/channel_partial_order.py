"""Verified observed same-channel preferences; no inference on unjudged clips."""
from __future__ import annotations
import argparse, hashlib, json, os, re
from datetime import datetime, timezone
from pathlib import Path
import fine_labels as fl

KIND = 'observed_channel_partial_order_v1'

def channel_key(name):
 # Exact deployed_data.channel_key recipe; leading@ only, then lowercase.
 if not isinstance(name,str) or not name:return ''
 return re.sub(r'^@','',name).lower()


def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def digest(value):return hashlib.sha256(canonical(value)).hexdigest()

def timestamp(value):
 if not isinstance(value,str):raise fl.FineLabelContractError('Missing saved generation or answer timestamp')
 try:dt=datetime.fromisoformat(value.replace('Z','+00:00'))
 except ValueError as error:raise fl.FineLabelContractError('Invalid saved timestamp') from error
 # Frozen PostgreSQL timestamp values are UTC even when serialized without an offset.
 return dt.replace(tzinfo=timezone.utc).timestamp() if dt.tzinfo is None else dt.timestamp()


def unique(items,key,kind):
 result={}
 for item in items:
  value=item[key]
  if value in result:raise fl.FineLabelContractError('Duplicate '+kind+' identity')
  result[value]=item
 return result


def validate_graph(nodes,edges):
 lookup=unique(nodes,'id','node');nexts={key:set() for key in lookup};seen=set()
 for edge in edges:
  winner,loser=edge['winner'],edge['loser']
  if winner not in lookup or loser not in lookup or winner==loser:raise fl.FineLabelContractError('Unknown/self preference edge')
  if lookup[winner]['group']!=lookup[loser]['group'] or lookup[winner]['group']!=edge['group']:raise fl.FineLabelContractError('Cross-channel preference edge')
  if lookup[winner]['current_acceptability_y']!=1 or lookup[loser]['current_acceptability_y']!=1:raise fl.FineLabelContractError('Current preference sides must both remain accepted')
  if (winner,loser) in seen:raise fl.FineLabelContractError('Duplicate explicit preference edge')
  seen.add((winner,loser));nexts[winner].add(loser)
 active=set();visited=set()
 def visit(node):
  if node in active:raise fl.FineLabelContractError('Preference cycle/conflict')
  if node in visited:return
  active.add(node)
  for other in nexts[node]:visit(other)
  active.remove(node);visited.add(node)
 for node in lookup:visit(node)
 return {'acyclic':True,'explicit_edges':len(edges),'total_order_inferred':False,'transitive_edges_exported':False}


def build(public,private,snapshot,cohort):
 rows=fl.annotate_rows(public,private,snapshot['tasks']);fl.require_fit_scope(rows,'partial-order export/promotion');labels=fl.summary(rows)
 tasks=unique(snapshot['tasks'],'id','task');meta=unique(private,'row','private side');records=unique(snapshot['records'],'id','feedback');recordings=unique(cohort['recordings'],'video_id','recording')
 coarse_rows=unique(cohort['rows'],'feedback_id','coarse feedback');by_task={};groups={};reverse_groups={};private_nodes={};node_alias={};video_alias={};exposures=[];nodes={}
 for row in rows:
  m=meta[row['row']]
  # Sparse public feature rows omit private identity/ranges. Shared annotation has
  # already checked every public field that is present; bind the authoritative
  # exact frozen metadata only after those checks, without exporting raw identities.
  row=dict(row,**{key:m[key] for key in ('video_id','start','end','group','recording')})
  task=tasks[row['task_id']];side=row['side'];source=task['context'][side];record=records.get(source.get('feedback_id'));rec=recordings.get(row['video_id'])
  if record is None or rec is None or record['video_id']!=row['video_id'] or source['video_id']!=row['video_id'] or record.get('added'):raise fl.FineLabelContractError('Exact original feedback/video identity required')
  if m.get('answered_at')!=task.get('answered_at'):raise fl.FineLabelContractError('Frozen answer generation mismatch')
  timestamp(record.get('analyzed_at'));answer_epoch=timestamp(task.get('answered_at'))
  if rec.get('analyzed_at')!=record['analyzed_at']:raise fl.FineLabelContractError('Recording analysis generation mismatch')
  task_channel=channel_key(task.get('channel'));record_channel=channel_key(record.get('channel'))
  if not task_channel or task_channel!=record_channel:raise fl.FineLabelContractError('Exact canonical private channel mismatch')
  group=row['group']
  if groups.get(group,task_channel)!=task_channel or reverse_groups.get(task_channel,group)!=group:raise fl.FineLabelContractError('Public channel namespace is not one-to-one')
  groups[group]=task_channel;reverse_groups[task_channel]=group
  original=[record.get('detected_start'),record.get('detected_end')]
  if (original[0] is None)!=(original[1] is None):raise fl.FineLabelContractError('Partially missing original bounds')
  match=[p for p in rec['original_proposals'] if p['id']==record['clip_id']]
  if len(match)!=1:raise fl.FineLabelContractError('Original proposal identity missing or duplicated')
  if original[0] is not None and (abs(match[0]['start']-original[0])>.001 or abs(match[0]['end']-original[1])>.001):raise fl.FineLabelContractError('Immutable detected-original proposal bounds mismatch')
  frozen=coarse_rows.get(record['id'])
  if frozen and (frozen['video_id']!=record['video_id'] or frozen['clip_id']!=record['clip_id'] or frozen['analyzed_at']!=record['analyzed_at']):raise fl.FineLabelContractError('Coarse feedback generation/clip mismatch')
  if frozen and frozen['group']!=rec['group']:raise fl.FineLabelContractError('Coarse recording channel namespace mismatch')
  if 'coarse_group' in row and row['coarse_group']!=rec['group']:raise fl.FineLabelContractError('Public coarse channel mapping mismatch')
  key=(record['video_id'],record['clip_id'],record['analyzed_at'],row['start'],row['end'])
  if key not in node_alias:node_alias[key]=f'n{len(node_alias):03d}'
  node=node_alias[key];vid=record['video_id']
  if vid not in video_alias:video_alias[vid]=f'v{len(video_alias):03d}'
  if node in nodes and nodes[node]['current_acceptability_y']!=row['current_acceptability_y']:raise fl.FineLabelContractError('Repeated exact offered clip has conflicting current answers')
  nodes[node]={'id':node,'group':group,'recording':video_alias[vid],'generation':hashlib.sha256(record['analyzed_at'].encode()).hexdigest()[:24],'offered':[row['start'],row['end']],'original':original,'current_acceptability_y':row['current_acceptability_y'],'future_replacement_y':None,'permanent_storage_y':None}
  identity={'video_id':vid,'clip_id':record['clip_id'],'feedback_id':record['id'],'analyzed_at':record['analyzed_at'],'channel':task_channel,'offered':[row['start'],row['end']],'context_clip':source['clip'],'original':original,'coarse_group':rec['group'],'visual_index_generation':snapshot.get('indices',{}).get(str(vid)), 'exposures':[]}
  if node in private_nodes:
   previous=dict(private_nodes[node]);previous.pop('exposures')
   if previous!={k:v for k,v in identity.items() if k!='exposures'}:raise fl.FineLabelContractError('Repeated offered identity provenance conflicts')
  else:private_nodes[node]=identity
  exposure={'side_id':row['row'],'task':row['row'][:-1],'side':side,'node':node,'group':group,'answered_epoch_seconds':answer_epoch,'current_acceptability_y':row['current_acceptability_y'],'ranking_y':row['ranking_y'],'cut_gold':row['cut_gold'],'future_replacement_y':None,'permanent_storage_y':None}
  exposures.append(exposure);private_nodes[node]['exposures'].append({'side_id':row['row'],'task_id':row['task_id'],'side':side,'answered_at':task['answered_at']})
  by_task.setdefault(row['task_id'],[]).append(exposure)
 edges=[]
 for tid,pair in by_task.items():
  if len(pair)!=2 or {x['side'] for x in pair}!={'a','b'} or len({x['group'] for x in pair})!=1:raise fl.FineLabelContractError('Exact complete same-channel task sides required')
  answer=tasks[tid]['answer']
  if answer in ('a','b'):
   winner=next(x for x in pair if x['side']==answer);loser=next(x for x in pair if x['side']!=answer)
   edges.append({'task':winner['task'],'group':winner['group'],'winner':winner['node'],'loser':loser['node'],'source':'explicit_same_channel_a_or_b','current_loser_accepted':True,'future_replacement_y':None})
 graph=validate_graph(list(nodes.values()),edges)
 mapping={'schema_version':1,'kind':KIND,'policy':fl.POLICY,'nodes':private_nodes,'channels':groups,'recordings':{alias:vid for vid,alias in video_alias.items()},'scope':'Private binding only; no source media paths, inferred deletion or new labels'}
 receipt={'schema_version':1,'kind':KIND,'policy':fl.POLICY,'label_target':fl.CURRENT_TARGET,'semantics_sha256':digest(fl.SEMANTICS),'private_binding_sha256':digest(mapping),'summary':labels,'nodes':list(nodes.values()),'observations':exposures,'strict_preferences':edges,'graph':graph,'model_trained':False,'automatic_action':False,'probabilities':None,'uncompared_clips':'Unknown relative quality; no inferred complete ordering, transitive edge, expiry or deletion','source_generation_scope':'Each task binds an immutable feedback id and frozen analysis generation; saved task has no independent visual-index-at-answer version, so current frozen index is recorded privately without claiming UI-generation proof','whole_recording_target':'Unknown from these clip observations'}
 return receipt,mapping


def immutable_write(path,value):
 path=Path(path);payload=canonical(value)+b'\n'
 if path.exists():
  if path.read_bytes()!=payload:raise fl.FineLabelContractError('Historical partial-order output would change')
  if path.stat().st_mode & 0o077:raise fl.FineLabelContractError('Private receipt permissions are too broad')
  return
 path.parent.mkdir(parents=True,exist_ok=True,mode=0o700);path.parent.chmod(0o700);temporary=path.with_suffix('.partial')
 with temporary.open('xb') as file:file.write(payload);file.flush();os.fsync(file.fileno())
 temporary.chmod(0o600)
 try:os.link(temporary,path)
 finally:temporary.unlink()


def export(root,private_path,public_path,out):
 paths=[root/'private_snapshot.json',root/'cohort.json',private_path,public_path];before={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
 snapshot=json.loads((root/'private_snapshot.json').read_text());cohort=json.loads((root/'cohort.json').read_text());private=json.loads(private_path.read_text())['rows'];public=json.loads(public_path.read_text())['rows']
 receipt,mapping=build(public,private,snapshot,cohort)
 summary=receipt['summary']
 if (summary['sides'],summary['current_acceptability_positive'],summary['current_acceptability_negative'],summary['ranking_pairs'],summary['valid_final_cuts'])!=(40,36,4,8,28):raise fl.FineLabelContractError('Frozen40/36/4/8/28 contract mismatch')
 if len(receipt['strict_preferences'])!=8 or len({e['group'] for e in receipt['strict_preferences']})!=7:raise fl.FineLabelContractError('Frozen eight preferences/seven channels mismatch')
 for p in paths:
  if hashlib.sha256(p.read_bytes()).hexdigest()!=before[str(p)]:raise fl.FineLabelContractError('Frozen source metadata changed during export')
 receipt['source_sha256']={str(p.name):before[str(p)] for p in paths}
 receipt['private_binding_sha256']=digest(mapping)
 immutable_write(out/f'private-identity.{fl.POLICY}.json',mapping);immutable_write(out/f'training-receipt.{fl.POLICY}.json',receipt)
 print(json.dumps({'policy':fl.POLICY,'counts':summary,'strict_edges':8,'graph':receipt['graph'],'model_trained':False,'private_identity_permissions':'0600','output':str(out)}))
 return receipt

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--private',type=Path,required=True);p.add_argument('--public',type=Path,required=True);p.add_argument('--output',type=Path,required=True);args=p.parse_args();export(args.root,args.private,args.public,args.output)
