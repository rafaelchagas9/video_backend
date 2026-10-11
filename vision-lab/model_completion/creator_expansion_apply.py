"""Explicit finite apply/preflight for the reviewed18 comparisons; no auto invocation.

Metadata-first historical outcome filtering, live source/index/triage/final-cut guards,
serializable batch-scoped transaction, exact idempotency and offered-version graph receipt.
No answer updates, optional recall tasks, media decode, new recordings, model fits or GPU.
"""
from __future__ import annotations
import argparse,collections,hashlib,json,math
from pathlib import Path
import creator_expansion_v2 as batch
import creator_expansion_intake as intake
FIELDS=['kind','batch','position','video_id','start_seconds','end_seconds','channel','stratum','context']
FINAL_SHA=intake.FINAL_MANIFEST_SHA256


def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def load_contract(root,expected):
 if expected!=FINAL_SHA or batch.base.digest(root/'private_manifest.json')!=expected:raise ValueError('Exact reviewed v2 manifest checksum required before DB access')
 value=intake.load_contract(root);old,reserved,receipt=batch.load_legacy()
 if value!=batch.manifest(old,reserved,receipt):raise ValueError('New manifest does not match immutable eighteen copied contexts')
 return value,reserved,receipt


def node(side,task):
 # Never collapse clips by creator/video/feedback alone, or use saved cuts in place of offered best.
 required=('feedback_id','video_id','analyzed_at','source_fingerprint','index','clip','best','detector')
 if any(k not in side for k in required):raise ValueError('Historical side lacks complete offered-version provenance')
 context=task.get('context') or {};creator=side.get('channel_key') or batch.base.canon(side.get('channel') or task.get('channel') or context.get('channel'))
 if not creator or side.get('channel_key',creator)!=batch.base.canon(side.get('channel',creator)):raise ValueError('Historical creator identity differs')
 if any(isinstance(side[k],bool) or not isinstance(side[k],int) for k in ('feedback_id','video_id')):raise ValueError('Historical side identities malformed')
 bounds=[]
 for key in ('clip','best'):
  raw=side[key]
  if not isinstance(raw,list) or len(raw)!=2 or any(isinstance(x,bool) or not isinstance(x,(int,float)) or not math.isfinite(x) for x in raw) or not 0<=raw[0]<raw[1]:raise ValueError('Historical offered bounds invalid')
  bounds.append([float(x) for x in raw])
 if not bounds[0][0]<=bounds[1][0]<bounds[1][1]<=bounds[0][1]:raise ValueError('Historical offered outside original')
 fp=side['source_fingerprint'];idx=side['index']
 if not isinstance(side['analyzed_at'],str) or not isinstance(fp,dict) or not {'size_bytes','mtime_ns','path_identity_sha256'}<=set(fp) or not isinstance(idx,dict) or not {'model_revision','frame_count','interval_seconds','storyboard_generated_at','indexed_at'}<=set(idx):raise ValueError('Historical source/index identity incomplete')
 identity={'feedback_id':side['feedback_id'],'video_id':side['video_id'],'creator':creator,'analyzed_at':side['analyzed_at'],'source_fingerprint':fp,'index':idx,'original_range':bounds[0],'offered_range':bounds[1],'detector':side['detector']}
 return hashlib.sha256(canonical(identity)).hexdigest(),identity


def components(nodes,edges):
 adjacent={key:set() for key in nodes}
 for a,b in edges:adjacent[a].add(b);adjacent[b].add(a)
 todo=set(nodes);parts=[]
 while todo:
  pending=[todo.pop()];found=set(pending)
  while pending:
   for key in adjacent[pending.pop()]&todo:todo.remove(key);found.add(key);pending.append(key)
  parts.append(sorted(found))
 return sorted(parts,key=lambda p:(-len(p),p))


def graph_receipt(history,planned,reserved):
 nodes={};observed=set();hypothetical=set();missing=excluded=no_order=0;changed_bridges=[];old_ranges=collections.defaultdict(set);strict_ids=[]
 for task in history:
  if task.get('kind')!='versus' or task['batch']==batch.BATCH:continue
  if not batch.outcome_eligible(task,reserved):excluded+=1;continue
  ctx=task.get('context') or {}
  try:a,ia=node(ctx.get('a',{}),task);b,ib=node(ctx.get('b',{}),task)
  except ValueError:missing+=1;continue
  nodes.update({a:ia,b:ib})
  for key,identity in ((a,ia),(b,ib)):old_ranges[identity['feedback_id']].add(key)
  if task.get('answer') in ('a','b'):observed.add(tuple(sorted((a,b))));strict_ids.append(task['id'])
  else:no_order+=1
 for task in planned:
  ctx=task['context'];a,ia=node(ctx['a'],task);b,ib=node(ctx['b'],task);nodes.update({a:ia,b:ib});hypothetical.add(tuple(sorted((a,b))))
  for key,identity in ((a,ia),(b,ib)):
   prior=old_ranges.get(identity['feedback_id'],set())
   if prior and key not in prior:changed_bridges.append({'feedback_id':identity['feedback_id'],'new_node':key,'prior_nodes':sorted(prior),'reason':'Exact offered range/generation/source/index version differs; creator identity is not an order edge'})
 historical_nodes=set().union(*(set(edge) for edge in observed)) if observed else set()
 # All full-provenance historical/no-order and prospective versions remain visible as isolated nodes.
 pre=components(nodes,observed);prospective=components(nodes,observed|hypothetical)
 return {'kind':'exact_offered_version_graph','node_identity':'feedback/video/generation/source/index/detector/original/offered bounds plus per-side creator','nodes':nodes,'observed_strict_edges':[list(x) for x in sorted(observed)],'observed_strict_task_ids':sorted(strict_ids),'prospective_comparison_edges':[list(x) for x in sorted(hypothetical)],'observed_components_including_prospective_isolates':pre,'observed_strict_only_components':components(historical_nodes,observed),'prospective_if_every_new_comparison_is_strict_components':prospective,'no_order_historical_pairs':no_order,'excluded_reserved_tasks':excluded,'missing_full_provenance_historical_pairs':missing,'changed_bridge_versions':sorted({r['new_node']:r for r in changed_bridges}.values(),key=lambda r:r['feedback_id']),'global_order_claim':False,'limitation':'Creator connectivity does not establish exact-version order. Both/neither add no strict edge; prospective comparisons do not yet establish preference or a global ranking.'}


def existing_match(existing,planned):
 if len(existing)!=18 or [r['position'] for r in existing]!=list(range(18)):raise ValueError('Existing batch incomplete; preserve answers')
 if any(any(actual[k]!=wanted[k] for k in FIELDS) for actual,wanted in zip(existing,planned)):raise ValueError('Existing exact batch differs; preserve answers')


def execute_batch(connection,value,reserved,receipt,insert):
 # Scoped lock avoids concurrent reapplication of this batch; SERIALIZABLE detects history phantoms.
 connection.execute('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'+('' if insert else ' READ ONLY'))
 connection.execute("SET statement_timeout='20s'");connection.execute("SET lock_timeout='5s'")
 lock=int.from_bytes(hashlib.sha256(batch.BATCH.encode()).digest()[:8],'big',signed=True)
 connection.execute('SELECT pg_advisory_xact_lock(%s)',(lock,))
 history=batch.load_history(connection,reserved)
 ids=sorted({r['context'][key]['feedback_id'] for r in value['rows'] for key in ('a','b')})
 live=batch.previous.load_rows(connection,ids,lock=insert)
 batch.validate_live(value,live,history,reserved,receipt)
 raw=connection.execute('SELECT '+','.join(FIELDS)+' FROM recording_label_tasks WHERE batch=%s ORDER BY position',(batch.BATCH,)).fetchall()
 existing=[dict(zip(FIELDS,row)) for row in raw]
 if existing:existing_match(existing,value['rows'])
 written=0
 if insert and not existing:
  for row in value['rows']:
   written+=connection.execute('INSERT INTO recording_label_tasks(kind,batch,video_id,start_seconds,end_seconds,stratum,position,channel,context) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)',(row['kind'],batch.BATCH,row['video_id'],row['start_seconds'],row['end_seconds'],row['stratum'],row['position'],row['channel'],json.dumps(row['context'],allow_nan=False))).rowcount
  if written!=18:raise ValueError('Exactly18 comparisons required or rollback')
 graph=graph_receipt(history,value['rows'],reserved)
 return {'status':'inserted' if written else 'already_present_preserved' if existing else 'preflight_ready_no_queue_writes','batch':batch.BATCH,'inserted':written,'total':18,'manifest_sha256':FINAL_SHA,'apply_source_sha256':batch.base.digest(Path(__file__)),'intake_source_sha256':batch.base.digest(Path(intake.__file__)),'graph':graph,'optional_interval_audits_inserted':0,'media_reads':0,'GPU':False}


def run(root,expected,insert=False):
 value,reserved,receipt=load_contract(root,expected)
 import psycopg
 with psycopg.connect(batch.base.pg_config()) as connection:result=execute_batch(connection,value,reserved,receipt,insert)
 # Receipt only after transaction successfully commits; never rewrite frozen draft/manifest.
 data=canonical(result);sha=hashlib.sha256(data).hexdigest();batch.base.save_frozen(root/'apply-receipts'/f'receipt.{sha}.json',result)
 summary={k:result[k] for k in ('status','batch','inserted','total','manifest_sha256','optional_interval_audits_inserted','media_reads','GPU')};g=result['graph']
 summary.update(receipt_sha256=sha,full_provenance_nodes=len(g['nodes']),observed_strict_edges=len(g['observed_strict_edges']),observed_components=len(g['observed_components_including_prospective_isolates']),prospective_components=len(g['prospective_if_every_new_comparison_is_strict_components']),changed_bridge_versions=len(g['changed_bridge_versions']),global_order_claim=False)
 print(json.dumps(summary))
 return result

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['preflight','insert']);parser.add_argument('--root',type=Path,default=batch.OUT);parser.add_argument('--manifest-sha256',required=True);args=parser.parse_args();run(args.root,args.manifest_sha256,args.mode=='insert')
