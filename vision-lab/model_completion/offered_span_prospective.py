"""Prospective frozen offered-span diagnostics, numeric-only and no model fitting."""
from __future__ import annotations
import argparse,copy,json,math,random,signal,time
from pathlib import Path
import numpy as np
import blind_version_round as view
import blind_preference_features as frames
import combined_blind_preference as rank
safe=view.safe
base=view.base
OUT=frames.ROOT/'offered-span-prospective'
STEM='offered-span-20261010-1'
IDS=[448,462,302,495,650,793,338,350]
HEAD=rank.OUT/'frozen_candidate.json'
HEAD_SHA='e681be589ec7778c7c09b0273a367012c8ba4278989edde41b576b7fe5495d43'
INVENTORY=frames.ROOT/'next-blind-eligibility/private_numeric_inventory.json'
INVENTORY_SHA='1a18e9f865cdee136a19b8ea6928d581e1582842d623b8495b72f879c25db2f4'
COHORT=frames.OUT/'feature_cohort.json'
COHORT_SHA='5a0b86cdb813702524ed22fe476908a7598d69289e005f0cbc7acec56861cbd3'
SPEC={'schema_version':1,'target':'preferred_version_if_keep_one','source_ids':IDS,'batch_stem':STEM,'source_selection':'Five existing changed3–15m human ranges and three longer sources fixed before optimizer scores. Eight creators absent from current22-pair fit; historically fine exposure is disclosed, not unseen holdout. No substitution after scoring.','optimizer':'Frozen primary head only; fixed durations180,300,600,900,original and reference length;17 uniformly spaced starts per length, rounded to5s relative original start except exact last endpoint. Original and approved reference always eligible. Max128 unique legal candidates, no15m cap. Highest score; shorter then earliest ties.','candidate_distinct':'Edge difference>=30s AND IoU<=.90, otherwise agreement/no distinct task. Never second-best forced challenger.','control':'L=min(reference seconds,900,original seconds−60)>=180. Frozen primary chooses among17 fixed legal locations. Compare to original endpoint of least overlap with selected location, earliest tie. Start difference>=30s AND IoU<=.80; otherwise report no distinct task. Not human cut gold.','side_balance':'Randomized exact half (difference<=1) primary-on-A perrole usingseed2026101016; randomized task ordering perrole.','previews':'Same three15s uniform10/50/90% windows perversion, optional exact full playback; methodblind, offered duration visible.','evaluation':'Freeze all three head scores BEFORE answers. Prospective model_vs_human and same_duration_location separately; creator blocks, ties/abstentions full denominator plus strict accuracy; paired head outcomes on identical offered spans. No pooled refit presented as prospective.','duplicate_policy':'Candidate-first exact-pair dedup; suppress duplicate control and record reason, never force alternate.','labels':'Pure preferences only; no new currentacceptability,cut,whole,permanentworth or outside-quality labels.','budget':'Numeric DB/checkpoints only,180s total,<=256MiB frame bytes,oneCPU process,no media/GPU/cloud/production writes.','production_model_activation':False}

def iou(a,b):
 intersection=max(0.,min(a[1],b[1])-max(a[0],b[0]));return intersection/((a[1]-a[0])+(b[1]-b[0])-intersection)

def locations(original,length):
 a,b=map(float,original)
 if not math.isfinite(a+b+length) or length<180 or length>b-a:raise ValueError('Invalid bounded length')
 starts=sorted({a+5*round(((b-a-length)*j/16)/5) for j in range(16)}|{b-length})
 return [[max(a,min(s,b-length)),max(a,min(s,b-length))+length] for s in starts]

def grid(original,reference):
 a,b=map(float,original);c,d=map(float,reference)
 if not 0<=a<=c<d<=b or b-a<180 or d-c<180:raise ValueError('Invalid original/reference')
 lengths=sorted({l for l in (180.,300.,600.,900.,b-a,d-c) if 180<=l<=b-a})
 result={tuple(r) for l in lengths for r in locations(original,l)}|{tuple(original),tuple(reference)}
 result=sorted(result)
 if len(result)>128:raise ValueError('Candidate grid bound')
 return [list(r) for r in result]

def same_pair(left,right):return {tuple(r) for r in left}=={tuple(r) for r in right}

def check_dependency(path,sha):
 if not Path(path).is_file() or base.digest(Path(path))!=sha:raise ValueError('Frozen dependency changed: '+str(path))

def prepare(out):
 reserved,receipt=safe.previous.holdout_contract()
 for path,sha in ((HEAD,HEAD_SHA),(INVENTORY,INVENTORY_SHA),(COHORT,COHORT_SHA)):check_dependency(path,sha)
 inventory=json.loads(INVENTORY.read_text());selected={r['feedback_id']:r for r in inventory['rows'] if r['feedback_id'] in IDS};head=json.loads(HEAD.read_text())
 if set(selected)!=set(IDS) or len({r['creator_identity_sha256'] for r in selected.values()})!=8 or not all(r['fresh_to_current_22_fit'] for r in selected.values()):raise ValueError('Fixed eight-source eligibility changed')
 if len(head['training_creators'])!=12 or head['training_gate_passed'] is not False or head['selected_head'] is not None or set(head['reserved_creators'])!=reserved:raise ValueError('Fixed exploratory head contract differs')
 helpers=[Path(frames.numeric.__file__),Path(frames.numeric.recipe.__file__),Path(frames.__file__),Path(view.__file__),Path(safe.previous.__file__),Path(safe.__file__),Path(rank.__file__),Path(rank.old.__file__),Path(__file__).with_name('offered_span_apply.py'),Path(__file__).with_name('offered_span_intake.py')]
 helper_pins={str(p.resolve()):base.digest(p) for p in helpers}
 spec=dict(SPEC,helper_sources=helper_pins,source_sha256=base.digest(Path(__file__)),head_sha256=HEAD_SHA,inventory_sha256=INVENTORY_SHA,cohort_sha256=COHORT_SHA,holdout_dependency=receipt,excluded_holdout_creators=sorted(reserved),fresh_all_fine_sources=sum(r['fresh_to_all_fine_metadata'] for r in selected.values()))
 base.save_frozen(out/'before-generation-v2.json',spec)
 print(json.dumps({'status':'prepared_before_optimizer','sources':8,'fresh_to_fit_creators':8,'historically_unseen_creators':spec['fresh_all_fine_sources'],'spec_sha256':base.digest(out/'before-generation-v2.json')}))
 return spec

def scores(heads,live,source,inputs,bounds):
 t,v,proposals,identity,path=inputs
 x,visual=frames.numeric.domain_features({'group':source['channel_key']},source,live,t,v,proposals,*bounds)
 if visual is None:raise ValueError('Offered range has no frames')
 x=np.asarray(x,dtype=float);visual=np.asarray(visual,dtype=float)
 if x.shape!=(13,) or visual.shape!=(1152,) or not np.isfinite(x).all() or not np.isfinite(visual).all() or abs(np.linalg.norm(visual)-1)>.02:raise ValueError('Offered numeric/visual features invalid or cancelling')
 result={kind:float(h['bias']+np.dot(h['numeric_weights'],x)+np.dot(h['visual_weights'],visual)+np.dot(h['duration_weights'],rank.hinges(bounds[1]-bounds[0]))) for kind,h in heads.items()}
 if set(result)!={'primary','predecessor','numeric'} or not all(math.isfinite(s) for s in result.values()):raise ValueError('Frozen head scores invalid')
 return result

def best(ranges,values):return min(range(len(ranges)),key=lambda i:(-values[i]['primary'],ranges[i][1]-ranges[i][0],ranges[i][0]))

def generate(out):
 import psycopg
 started=time.monotonic();spec=prepare(out);heads=json.loads(HEAD.read_text())['heads'];old=json.loads(COHORT.read_text());inventory=json.loads(INVENTORY.read_text());reserved,receipt=safe.previous.holdout_contract();records=[];drafts=[];frame_dependencies=[];frame_bytes=0
 def budget():
  if time.monotonic()-started>=180:raise TimeoutError('Numeric optimizer deadline')
 with psycopg.connect(base.pg_config()) as pg:
  pg.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');pg.execute("SET statement_timeout='20s'")
  history=safe.load_history(pg,reserved);live=safe.previous.load_rows(pg,IDS)
  if set(live)!=set(IDS):raise ValueError('Fixed source absent')
  for fid in IDS:
   budget();raw=live[fid];source=safe.previous.side(raw,history);planned=next(r for r in inventory['rows'] if r['feedback_id']==fid)
   if source['channel_key'] in reserved or source['channel_key'] in json.loads(HEAD.read_text())['training_creators']:raise ValueError('Creator entered current fit/reserved')
   if any(source[k]!=planned[k] for k in ('video_id','feedback_id','clip','best','analyzed_at','source_fingerprint','index','detector','duration_seconds')):raise ValueError('Preselected source changed')
   found=frames.cached_inputs({'rows':old['old_rows']+old['version_rows']},source,raw)
   if found is None:
    t,v,proposals,identity=frames.numeric.frame_inputs(raw,source,pg);path,frame_receipt=frames.checkpoint(out,t,v,identity);found=(t,v,proposals,identity,path)
   t,v,proposals,identity,path=found
   frames.check_vectors(t,v,source,raw['duration'])
   if np.any(t>raw['duration']) or any(not 0<=p['start']<p['end']<=raw['duration'] for p in proposals):raise ValueError('Runtime strict source duration bound')
   frame_bytes+=Path(path).stat().st_size
   if frame_bytes>256*1024*1024:raise ValueError('Numeric frame bytes bound')
   frame_receipt={'path':str(Path(path).resolve()),'sha256':base.digest(Path(path)),'identity_sha256':frames.numeric.digest(identity)};frame_dependencies.append(dict(path=frame_receipt['path'],sha256=frame_receipt['sha256'],role='frame_checkpoint'))
   ranges=grid(source['clip'],source['best']);values=[]
   for bounds in ranges:budget();values.append(scores(heads,raw,source,found,bounds))
   winner=ranges[best(ranges,values)];ref=source['best'];distinct=max(abs(winner[i]-ref[i]) for i in (0,1))>=30 and iou(winner,ref)<=.9
   record={'source':source,'numeric_identity':identity,'frame_checkpoint':frame_receipt,'candidate_ranges':ranges,'candidate_scores':values,'primary_best':winner,'reference':ref,'model_vs_human_emitted':distinct,'fresh_to_all_fine_metadata':planned['fresh_to_all_fine_metadata']}
   if distinct:drafts.append({'pilot_role':'model_vs_human','source':source,'ranges':[winner,ref],'roles':['frozen_primary_best','current_human_approved'],'numeric_identity':identity,'frame_checkpoint':frame_receipt,'predictions':{kind:[scores(heads,raw,source,found,winner)[kind],scores(heads,raw,source,found,ref)[kind]] for kind in heads}})
   length=min(ref[1]-ref[0],900.,source['clip'][1]-source['clip'][0]-60.)
   if length<180:record['control_status']='no_legal_length';records.append(record);continue
   cranges=locations(source['clip'],length);cvalues=[scores(heads,raw,source,found,r) for r in cranges];chosen=cranges[best(cranges,cvalues)]
   endpoints=[[source['clip'][0],source['clip'][0]+length],[source['clip'][1]-length,source['clip'][1]]]
   endpoint=min(endpoints,key=lambda r:(max(0,min(r[1],chosen[1])-max(r[0],chosen[0])),r[0]))
   cdistinct=abs(chosen[0]-endpoint[0])>=30 and iou(chosen,endpoint)<=.8
   if distinct and same_pair([winner,ref],[chosen,endpoint]):
    cdistinct=False;record['control_status']='duplicate_candidate_pair'
   record.update(control_length=length,control_ranges=cranges,control_scores=cvalues,control_primary_best=chosen,control_endpoint=endpoint,control_emitted=cdistinct)
   if cdistinct:drafts.append({'pilot_role':'same_duration_location','source':source,'ranges':[chosen,endpoint],'roles':['frozen_primary_location','fixed_endpoint_control'],'numeric_identity':identity,'frame_checkpoint':frame_receipt,'predictions':{kind:[scores(heads,raw,source,found,chosen)[kind],scores(heads,raw,source,found,endpoint)[kind]] for kind in heads}})
   records.append(record)
 dependency_paths=[(Path(__file__),'generator'),(HEAD,'head'),(COHORT,'feature_cohort'),(INVENTORY,'source'),(out/'before-generation-v2.json','source'),(Path(frames.numeric.__file__),'source'),(Path(frames.numeric.recipe.__file__),'source'),(Path(frames.__file__),'source'),(Path(view.__file__),'source'),(Path(safe.previous.__file__),'source'),(Path(safe.__file__),'source'),(Path(rank.__file__),'source'),(Path(rank.old.__file__),'source')]
 dependencies=[{'path':str(p.resolve()),'sha256':base.digest(p),'role':role} for p,role in dependency_paths]+frame_dependencies
 rng=random.Random(2026101016);rows=[];assignments=[];batches=[STEM+'-candidate',STEM+'-control']
 for role,batch in zip(('model_vs_human','same_duration_location'),batches):
  selected=[d for d in drafts if d['pilot_role']==role];rng.shuffle(selected);sides=[False]*(len(selected)//2)+[True]*(len(selected)-len(selected)//2);rng.shuffle(sides)
  for position,(d,flip) in enumerate(zip(selected,sides)):
   order=[1,0] if flip else [0,1];public={k:view.public_side(d['source'],d['ranges'][order[i]],'Version '+k.upper()) for i,k in enumerate(('a','b'))}
   context=dict(public,channel=d['source']['channel'],comparison_scope='same_channel',blind_version_comparison=True,target='preferred_version_if_keep_one',soft_preferred_minutes=[3,15],reserved_fine_holdout=False,fine_data_role='training',batch_policy=STEM,preview_recipe='uniform10_50_90_centres15s',acceptability_target=None,cut_target=None)
   rows.append({'kind':'version-versus','batch':batch,'position':position,'video_id':d['source']['video_id'],'start_seconds':public['a']['range'][0],'end_seconds':public['a']['range'][1],'channel':d['source']['channel'],'stratum':'blind-version','context':context})
   assignments.append({'batch':batch,'position':position,'pilot_role':role,'source':d['source'],'assignments':{k:d['roles'][order[i]] for i,k in enumerate(('a','b'))},'predictions':{kind:{k:value[order[i]] for i,k in enumerate(('a','b'))} for kind,value in d['predictions'].items()},'numeric_identity':d['numeric_identity'],'frame_checkpoint':d['frame_checkpoint']})
 for helper,sha in spec['helper_sources'].items():check_dependency(helper,sha)
 consumers={str((Path(__file__).parent/name).resolve()):base.digest(Path(__file__).parent/name) for name in ('offered_span_apply.py','offered_span_intake.py')}
 manifest={'schema_version':1,'batch_stem':STEM,'batches':batches,'generator_source_path':str(Path(__file__).resolve()),'source_sha256':base.digest(Path(__file__)),'policy':spec,'dependencies':dependencies,'consumer_sources':consumers,'holdout_dependency':receipt,'excluded_holdout_creators':sorted(reserved),'rows':rows,'private_assignments':assignments,'source_diagnostics':records,'queue_writes':0,'fits':0,'media_reads':0,'GPU':False}
 if not rows or len(rows)>16 or len({(r['batch'],r['video_id'],r['start_seconds']) for r in rows})!=len(rows):raise ValueError('Empty/oversize/collision batch')
 base.save_frozen(out/'private_manifest.json',manifest)
 summary={'status':'frozen_prospective_no_queue_writes','selected_creators':8,'historically_unseen_creators':sum(r['fresh_to_all_fine_metadata'] for r in records),'model_vs_human':sum(d['pilot_role']=='model_vs_human' for d in assignments),'same_duration_location':sum(d['pilot_role']=='same_duration_location' for d in assignments),'tasks':len(rows),'manifest_sha256':base.digest(out/'private_manifest.json'),'fits':0,'media_reads':0,'GPU':False,'production_model_activated':False}
 base.save_frozen(out/'summary.json',summary);print(json.dumps(dict(summary,seconds=round(time.monotonic()-started,2))))

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['prepare','generate']);parser.add_argument('--out',type=Path,default=OUT);args=parser.parse_args();signal.alarm(180);{'prepare':prepare,'generate':generate}[args.mode](args.out)
