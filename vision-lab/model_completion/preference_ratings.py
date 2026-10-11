"""Provisional batch Bradley–Terry ratings; static offered clips, no content-model training.

Only explicit A/B edges enter each disconnected component's lambda=1 fit.
Acceptance observations and saved cuts are independent. Reserved creators are excluded
before answers are accessed. No score predicts permanent worth, deletion or unseen clips.
"""
from __future__ import annotations
import argparse,hashlib,json,math
from pathlib import Path
LAMBDA=1.0
POLICY='offered-clip-component-bradley-terry-lambda1-v1'
class RatingContractError(ValueError):pass

def canon(value):
 if not isinstance(value,str) or not value.strip():raise RatingContractError('Creator identity missing')
 return value.strip().lstrip('@').lower()
def number(value):
 if isinstance(value,bool):raise RatingContractError('Boolean range value')
 try:value=float(value)
 except (TypeError,ValueError) as error:raise RatingContractError('Invalid range value') from error
 if not math.isfinite(value):raise RatingContractError('Nonfinite range value')
 return 0.0 if value==0 else value
def sha(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
def creator(task,side):
 context=task['context'];meta=context.get(side)
 if not isinstance(meta,dict):raise RatingContractError('Two explicit side contexts required')
 raw=meta.get('channel') or task.get('channel') or context.get('channel')
 key=meta.get('channel_key')
 value=canon(raw) if raw else canon(key)
 if key is not None and canon(key)!=value:raise RatingContractError('Side creator key mismatch')
 if context.get('comparison_scope')=='cross_channel':
  if not (meta.get('channel') or key) or task.get('channel') is not None:raise RatingContractError('Cross-creator sides require explicit identities and no shared creator')
 elif task.get('channel') and canon(task['channel'])!=value:raise RatingContractError('Shared creator disagrees with side creator')
 return value

def supported_version(task):
 return all(isinstance(task['context'][side].get('analyzed_at'),str) and bool(task['context'][side]['analyzed_at']) and isinstance(task['context'][side].get('source_fingerprint'),dict) and bool(task['context'][side]['source_fingerprint']) and isinstance(task['context'][side].get('index'),dict) and bool(task['context'][side]['index']) for side in ('a','b'))

def node(task,side):
 meta=task['context'][side]
 for key in ('feedback_id','video_id'):
  if not isinstance(meta.get(key),int) or isinstance(meta[key],bool) or meta[key]<=0:raise RatingContractError('Exact feedback/video identity required')
 generation=meta.get('analyzed_at')
 if not isinstance(generation,str) or not generation:raise RatingContractError('Exact analysis generation required')
 try:a,b=map(number,meta['best']);lo,hi=map(number,meta['clip'])
 except (KeyError,TypeError,ValueError) as error:raise RatingContractError('Exact offered/original ranges required') from error
 if not 0<=lo<=a<b<=hi:raise RatingContractError('Offered range outside original')
 if not isinstance(meta.get('source_fingerprint'),dict) or not meta['source_fingerprint'] or not isinstance(meta.get('index'),dict) or not meta['index']:raise RatingContractError('Offered-time source/index receipts required')
 identity={'feedback_id':meta['feedback_id'],'video_id':meta['video_id'],'analyzed_at':generation,'offered_best':[a,b],'source_fingerprint':meta['source_fingerprint'],'index':meta['index']}
 key=sha(identity);channel=creator(task,side)
 return key,{'node':key,'creator':sha(['creator',channel]),'offered_range':[a,b],'provisional':True,'accepted_observations':0,'rejected_observations':0,'strict_wins':0,'strict_losses':0,'strict_comparisons':0,'component':None,'theta':None,'elo_display':None}

def sigmoid(x):return 1/(1+math.exp(-x)) if x>=0 else math.exp(x)/(1+math.exp(x))
def softplus(x):return max(x,0)+math.log1p(math.exp(-abs(x)))
def solve(matrix,vector):
 a=[list(row)+[value] for row,value in zip(matrix,vector)];n=len(a)
 for j in range(n):
  pivot=max(range(j,n),key=lambda i:abs(a[i][j]));a[j],a[pivot]=a[pivot],a[j]
  if abs(a[j][j])<1e-14:raise RatingContractError('Singular regularized Hessian')
  for i in range(j+1,n):
   factor=a[i][j]/a[j][j]
   for k in range(j,n+1):a[i][k]-=factor*a[j][k]
 result=[0.0]*n
 for i in range(n-1,-1,-1):result[i]=(a[i][n]-sum(a[i][j]*result[j] for j in range(i+1,n)))/a[i][i]
 return result

def fit_component(keys,edges):
 if len(keys)>128:raise RatingContractError('Component exceeds bounded advisory fit size')
 index={key:i for i,key in enumerate(keys)};pairs=[(index[w],index[l]) for w,l in edges];theta=[0.0]*len(keys)
 def objective(values):return .5*LAMBDA*sum(x*x for x in values)+sum(softplus(values[l]-values[w]) for w,l in pairs)
 converged=False
 for iteration in range(80):
  n=len(theta);g=[LAMBDA*x for x in theta];h=[[LAMBDA if i==j else 0.0 for j in range(n)] for i in range(n)]
  for w,l in pairs:
   p=sigmoid(theta[w]-theta[l]);delta=p-1;curvature=p*(1-p)
   g[w]+=delta;g[l]-=delta;h[w][w]+=curvature;h[l][l]+=curvature;h[w][l]-=curvature;h[l][w]-=curvature
  if max(abs(x) for x in g)<1e-9:converged=True;break
  step=solve(h,g);old=objective(theta);factor=1.0
  for _ in range(30):
   candidate=[x-factor*d for x,d in zip(theta,step)]
   if objective(candidate)<=old-1e-4*factor*sum(x*y for x,y in zip(g,step)):
    theta=candidate;break
   factor*=.5
  else:raise RatingContractError('Bounded optimizer failed to descend')
 if not converged:raise RatingContractError('Bounded optimizer did not converge')
 return {k:(0.0 if abs(v)<1e-12 else v) for k,v in zip(keys,theta)},iteration+1

def ratings(tasks,reserved_channels):
 tasks=list(tasks)
 if len(tasks)>10000:raise RatingContractError('Too many advisory observations')
 relevant=[t for t in tasks if t.get('kind')=='versus'];ids=[t.get('id') for t in relevant]
 if any(not isinstance(x,int) or isinstance(x,bool) for x in ids) or len(set(ids))!=len(ids):raise RatingContractError('Unique versus task identities required')
 reserved={canon(x) for x in reserved_channels}
 # Read metadata only here: an excluded task's answer is never consulted.
 for task in relevant:
  context=task.get('context')
  if not isinstance(context,dict):raise RatingContractError('Task context missing')
  marker=context.get('reserved_fine_holdout',False)
  if not isinstance(marker,bool):raise RatingContractError('Reserved marker must be boolean')
  if marker or context.get('fine_data_role')=='holdout':reserved.update(creator(task,side) for side in ('a','b'))
 nodes={};edges=[];excluded=unsupported=pending=answered=neutral=0
 for task in sorted(relevant,key=lambda x:x['id']):
  context=task['context'];channels=[creator(task,s) for s in ('a','b')]
  if context.get('reserved_fine_holdout',False) or context.get('fine_data_role')=='holdout' or any(c in reserved for c in channels):excluded+=1;continue
  if not supported_version(task):unsupported+=1;continue
  answer=task.get('answer')
  if answer not in (None,'a','b','both','neither'):raise RatingContractError('Unsupported versus answer')
  pair=[]
  for side in ('a','b'):
   key,value=node(task,side)
   if key in nodes and any(nodes[key][k]!=value[k] for k in ('creator','offered_range')):raise RatingContractError('Offered-node provenance conflict')
   nodes.setdefault(key,value);pair.append(key)
  if pair[0]==pair[1]:raise RatingContractError('A clip cannot compete against itself')
  if answer is None:pending+=1;continue
  answered+=1
  for key in pair:nodes[key]['rejected_observations' if answer=='neither' else 'accepted_observations']+=1
  if answer in ('both','neither'):neutral+=1;continue
  winner,loser=pair if answer=='a' else pair[::-1];edges.append((winner,loser))
  nodes[winner]['strict_wins']+=1;nodes[loser]['strict_losses']+=1
  for key in pair:nodes[key]['strict_comparisons']+=1
 if len(nodes)>512:raise RatingContractError('Too many advisory nodes')
 graph={key:set() for edge in edges for key in edge}
 for w,l in edges:graph[w].add(l);graph[l].add(w)
 components=[];seen=set()
 for first in sorted(graph):
  if first in seen:continue
  stack=[first];members=set()
  while stack:
   key=stack.pop()
   if key in members:continue
   members.add(key);stack.extend(graph[key]-members)
  seen.update(members);keys=sorted(members);component_edges=[e for e in edges if e[0] in members];values,iterations=fit_component(keys,component_edges);cid=f'component_{len(components):03d}'
  for key in keys:nodes[key].update(component=cid,theta=values[key],elo_display=1500+400/math.log(10)*values[key])
  components.append({'component':cid,'nodes':len(keys),'strict_edges':len(component_edges),'fit_iterations':iterations,'provisional':True,'ordering':sorted(keys,key=lambda k:(-values[k],k))})
 return {'policy':POLICY,'regularization_lambda':LAMBDA,'target':'Contextual offered-clip preference only','answered_tasks':answered,'pending_tasks':pending,'excluded_reserved_creator_tasks':excluded,'unsupported_version_tasks':unsupported,'strict_edges':len(edges),'no_order_tasks':neutral,'nodes':[nodes[k] for k in sorted(nodes)],'components':components,'unplayed_nodes':sum(n['theta'] is None for n in nodes.values()),'global_ranking':None,'permanent_worth':None,'expiry':None,'deletion':None,'unsupported_version_reason':'Legacy missing offered-time analysis generation/source/index receipts; no current-by-video substitution','limitations':'Separate component scales are incomparable. No predictions for unseen clips; saved edited cuts never alter the offered item. Acceptance observations are not rating losses. Scores are provisional regularized estimates, not calibrated keep probabilities.'}

def live_report():
 import targeted_label_round as b
 import psycopg
 receipt=json.loads((b.OUT/'fine_holdout.json').read_text());manifest=json.loads((b.OUT/'private_manifest.json').read_text())
 expected='97138b934ec6c586a711c7c99d213c1707e2a36179e1fa1f3c8786be64e79fd3'
 if b.digest(b.OUT/'private_manifest.json')!=expected or receipt['source_manifest_sha256']!=expected or receipt['channels']!=manifest['holdout_channels'] or receipt['positions']!=[4,5,6,7]:raise RatingContractError('Reserved creator receipt differs')
 with psycopg.connect(b.pg_config(),connect_timeout=3) as c:
  c.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');c.execute("SET statement_timeout='15s'")
  cols=['id','kind','channel','context'];tasks=[dict(zip(cols,row)) for row in c.execute('SELECT '+','.join(cols)+" FROM recording_label_tasks WHERE kind='versus' ORDER BY id").fetchall()]
  reserved={canon(x) for x in receipt['channels']}
  for task in tasks:
   context=task.get('context') or {}
   if context.get('reserved_fine_holdout',False) or context.get('fine_data_role')=='holdout':reserved.update(creator(task,s) for s in ('a','b'))
  eligible=[t['id'] for t in tasks if not t['context'].get('reserved_fine_holdout',False) and t['context'].get('fine_data_role')!='holdout' and not any(creator(t,s) in reserved for s in ('a','b')) and supported_version(t)]
  answers=dict(c.execute('SELECT id,answer FROM recording_label_tasks WHERE id=ANY(%s)',(eligible,)).fetchall())
  for task in tasks:
   if task['id'] in answers:task['answer']=answers[task['id']]
 report=ratings(tasks,reserved)
 report['provenance']={'utility_source_sha256':b.digest(Path(__file__)),'reserved_manifest_sha256':expected,'reserved_receipt_sha256':b.digest(b.OUT/'fine_holdout.json'),'screened_input_sha256':sha(tasks),'input_scope':'Metadata for all versus tasks; answers only for nonreserved complete offered-version identities','database_writes':0}
 return report

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path);args=parser.parse_args();report=live_report()
 if args.output:
  data=json.dumps(report,sort_keys=True,allow_nan=False,indent=2).encode()
  args.output.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
  import os
  fd=os.open(args.output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  with os.fdopen(fd,'wb') as file:file.write(data);file.flush();os.fsync(file.fileno())
 print(json.dumps(dict({k:report[k] for k in ('policy','answered_tasks','pending_tasks','excluded_reserved_creator_tasks','unsupported_version_tasks','strict_edges','no_order_tasks','unplayed_nodes')},components=len(report['components']),nodes=len(report['nodes']),no_production_writes=True),sort_keys=True))
