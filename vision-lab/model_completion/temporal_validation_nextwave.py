"""Fresh real-feedback originals: unchanged frozen selectors, finite preference wave.
Root alone executes preparation, numeric controls, detection, queue or intake.
"""
from __future__ import annotations
import argparse,copy,hashlib,json,math,random,time
from pathlib import Path
import numpy as np
import temporal_validation50_final as prior
import connected_label_round as connected
import whole_round_prepare as whole
import temporal_face_requests_v2 as face_api
base=prior.base;v1=prior.v1;temporal=prior.temporal;versions=prior.versions;safe=prior.safe
OUT=v1.ROOT/'temporal-validation-nextwave-v1';BATCH='temporal-model-validation-20261010-2';MAX_COUNT=30;FIELDS=prior.FIELDS
BASE_REQUEST=v1.OUT/'controls_and_face_request.json';BASE_REQUEST_SHA='621b2c622f0dd0fc4e7f47c3c460940afd4a032463d8e66ac80d596ed7df482f'
EXTRA_REQUEST=v1.ROOT/'temporal-validation50-expanded-v2/extra_controls_and_face_request.json';EXTRA_REQUEST_SHA='60dabd59ce4de960e19baec5ef6c03699fabf2012ab763f8eef7934d37f5d01a'
FIRST_SNAPSHOT=prior.OUT/'answer-snapshots/answers.5300979eb2f6160999e77e0756729ffcc9bb95ab04dc6f4acf84c8a781dd0eb8.json';FIRST_SHA='5300979eb2f6160999e77e0756729ffcc9bb95ab04dc6f4acf84c8a781dd0eb8'
POLICY={'schema_version':1,'batch':BATCH,'requested_max':30,'max_per_creator':3,'selection':'Metadata-only current original feedback >=240s, not previously scored first-wave originals, canonical reserved creators excluded first. Keep and skip are eligible; no acceptability targets inferred. Deterministic creator roundrobin, genuine distinct pairs only, no forced count. Known posthoc source excluded.','methods':'Frozen oldC weights/reference-free180/300/600/900/original+17starts; unchanged temporal observed-face/action omitted-cluster rule. No refit, duration change, threshold tuning or repaired algorithm.','sampling':'Unchanged72 uniform original plus24 uniform oldC existing5s points; no face-driven sampling.','safety':'Only real immutable feedback IDs. No pending fake IDs, media decode/cloud/new recordings. Exact full-generation numeric matrices and storyboard receipts required; unknown remains unavailable. Existing answers preserved.','budget_seconds':300,'max_numeric_read_bytes':1024**3,'target':'preferred_version_if_keep_one; both no strict direction, neither abstains; acceptance/cut/whole/permanent targets unknown','automatic_model_promotion':False,'assignment_seed':20261012,'assignment_seed_commit_sha256':hashlib.sha256(b'temporal-model-validation-20261010-2:20261012').hexdigest()}
METRIC_POLICY={'schema_version':1,'unit':'Whole creator, max3 new comparisons. New wave alone, not fifty independent samples.','confidence':.99,'bootstrap_samples':5000,'seed':20261011,'gates':{'minimum_nonabstaining_creators':20,'creator_macro_strict_newwin':.65,'creator_net_ci_lower':0},'timing':'Frozen after observed failed first-wave results but before any next-wave answers. Standalone stricter99% diagnostic; no recycled pooled release test or sequentially optimized thresholds.','pooled':'First+next totals are descriptive only, no pooled significance/promotion.','automatic_model_promotion':False}

def pins():
 names=[__file__,Path(__file__).with_name('temporal_validation_nextwave_apply.py'),Path(__file__).with_name('temporal_validation_nextwave_intake.py'),Path(__file__).with_name('temporal_validation_nextwave_test.py'),prior.__file__,v1.__file__,v1.old.__file__,v1.numeric.__file__,temporal.__file__,whole.__file__,connected.__file__,face_api.__file__,Path(face_api.__file__).with_name('temporal_face_requests_v2_test.py')]
 return {str(Path(p).resolve()):base.digest(Path(p)) for p in names}

def dependencies():
 for path,sha in ((BASE_REQUEST,BASE_REQUEST_SHA),(EXTRA_REQUEST,EXTRA_REQUEST_SHA),(FIRST_SNAPSHOT,FIRST_SHA)):
  if base.digest(path)!=sha:raise ValueError('Immutable first-wave dependency changed')
 used=set()
 for path in (BASE_REQUEST,EXTRA_REQUEST):
  for r in json.loads(path.read_text())['records']:
   if 'original_proposal_id'in r:used.add((r['source']['video_id'],r['source']['analyzed_at'],r['original_proposal_id']))
 return used,connected.holdout_contract()

def original_side(row):
 a,b=row['original_start'],row['original_end'];duration=row['duration'];group=base.canon(row['channel'])
 if row.get('is_available')is not True or type(row['feedback_id'])is not int or row['feedback_id']<=0 or not group or row['added']or row['merged_into']is not None or row['label_type']!='triage' or row['saved_at']is None or row['review_generation']!=row['analyzed_at']:raise ValueError('Exact current saved real-feedback original required; no verdict assumption')
 if any(x is None or isinstance(x,bool)or not math.isfinite(float(x))for x in(a,b,duration,row['score']))or not 0<=a<b<=duration or b-a<240:raise ValueError('Finite immutable original bounds required')
 if row['model_revision']!=base.VISUAL_PIN or row['interval_seconds']!=5 or not 1<=row['frame_count']<=8000 or row['frame_count']!=row['actual_frame_count']or base.stamp(row['storyboard_generated_at'])!=base.stamp(row['storyboard_at'])or row['last_frame_timestamp']is None or row['last_frame_timestamp']+10<duration:raise ValueError('Complete exact numeric index coverage required')
 vtt=Path(row['vtt_path']);vtt=vtt if vtt.is_absolute()else base.BACKEND/vtt
 if not vtt.is_file()or vtt.stat().st_dev!=v1.ROOT.stat().st_dev:raise ValueError('Existing SSD storyboard required')
 bounds=[float(a),float(b)];return {'feedback_id':row['feedback_id'],'video_id':row['video_id'],'file_name':row['file_name'],'clip':bounds,'best':bounds,'snippet':versions.previews(bounds)[0],'snippet_recipe':'uniform10_50_90_centres15s','score':row['score'],'duration_seconds':duration,'analyzed_at':base.stamp(row['analyzed_at']),'source_fingerprint':base.source_fingerprint(row['file_path']),'index':{'model_revision':row['model_revision'],'frame_count':row['frame_count'],'interval_seconds':5,'storyboard_generated_at':base.stamp(row['storyboard_generated_at']),'indexed_at':base.stamp(row['indexed_at'])},'detector':row['detector'],'channel':row['channel'],'channel_key':group,'initial_best_source':'GENERIC_ORIGINAL_NOT_HUMAN_GOLD'}

def canonical_originals(proposals):
 if not isinstance(proposals,list)or not proposals:raise ValueError('Complete original detector universe missing')
 result=[]
 for p in proposals:
  if not isinstance(p,dict)or not isinstance(p.get('id'),str)or p['id'].startswith('added-')or any(not temporal.aux.state.finite_number(p.get(k))for k in('start_seconds','end_seconds','score')):raise ValueError('Only complete original detector bounds supported')
  result.append({'id':p['id'],'start':p['start_seconds'],'end':p['end_seconds'],'score':p['score']})
 if len({p['id']for p in result})!=len(result):raise ValueError('Duplicate original detector IDs')
 return sorted(result,key=lambda p:p['id'])

def semantic_pair(row):
 sides=[]
 for side in('a','b'):
  s=row['context'][side];a,b=s['range']
  if not all(temporal.aux.state.finite_number(z)for z in(a,b))or not 0<=a<b:raise ValueError('Finite semantic version bounds required')
  sides.append(versions.canonical({'video_id':s['video_id'],'source_fingerprint':s['source_fingerprint'],'range_ms':[round(a*1000),round(b*1000)]}).decode())
 return tuple(sorted(sides))

def choose_sources(rows,used,reserved):
 valid=[];unavailable=[]
 for r in sorted(rows,key=lambda x:x['feedback_id']):
  group=base.canon(r['channel']);marker=(r['video_id'],base.stamp(r['analyzed_at']),r['clip_id'])
  if group in reserved or marker in used or r['video_id']==temporal.KNOWN_VIDEO:continue
  try:
   s=original_side(r);proposals=canonical_originals(r.get('proposals'));matching=[p for p in proposals if p['id']==r['clip_id']]
   if len(matching)!=1 or [matching[0]['start'],matching[0]['end']]!=s['clip']or matching[0]['score']!=s['score']:raise ValueError('Exact selected original detector universe mismatch')
  except(ValueError,OSError)as e:unavailable.append({'feedback_id':r['feedback_id'],'reason':str(e)});continue
  valid.append({'source':s,'original_proposal_id':r['clip_id'],'original_range':s['clip'],'review_verdict_metadata':r['verdict'],'current_acceptability':'unknown','proposals':proposals,'proposal_origin':r['proposal_origin']})
 ordered=v1.round_robin(valid);counts={};selected=[]
 for r in ordered:
  g=r['source']['channel_key']
  if counts.get(g,0)>=3 or len(selected)>=MAX_COUNT:continue
  selected.append(r);counts[g]=counts.get(g,0)+1
 return selected,unavailable

def history_metadata(pg):return prior.history_metadata(pg)
def load_live(pg,ids,lock=False):
 rows=safe.previous.load_rows(pg,ids,lock=lock);_,(reserved,_)=dependencies()
 loaded=whole.attach_reviews(pg,list(rows.values()),reserved)
 return {r['feedback_id']:r for r in loaded}
def validate_live(value,live,history,reserved,receipt):
 if value['excluded_holdout_creators']!=sorted(reserved)or value['holdout_dependency']!=receipt:raise ValueError('Reserved dependency differs')
 private=value.get('private_assignments',value.get('records',[]));expected={p['source']['feedback_id']:p for p in private}
 if set(live)!=set(expected):raise ValueError('Exact real source IDs required')
 for fid,p in expected.items():
  s=p['source']
  if s['channel_key']in reserved or original_side(live[fid])!=s:raise ValueError('Live source/generation/original/index drift')
  expected_proposals=p.get('proposals',(p.get('numeric_identity')or{}).get('proposals'))
  if canonical_originals(live[fid].get('proposals'))!=sorted(expected_proposals,key=lambda r:r['id']):raise ValueError('Complete live original detector universe drift')
 prior_rows=[t for t in history if t['batch']!=BATCH];pairs=versions.history_pairs(prior_rows);semantic={semantic_pair(t)for t in prior_rows if isinstance((t.get('context')or{}).get('a'),dict)and isinstance((t.get('context')or{}).get('b'),dict)};seen=set();seen_semantic=set()
 for row in value.get('rows',[]):
  pair=tuple(sorted(versions.version_key(row['context'][side])for side in('a','b')))
  sp=semantic_pair(row)
  if pair in pairs or pair in seen or sp in semantic or sp in seen_semantic:raise ValueError('Repeated exact or physical semantic version pair')
  seen.add(pair);seen_semantic.add(sp)

def inventory(out=OUT):
 import psycopg
 used,(reserved,receipt)=dependencies();query='WITH allowed AS MATERIALIZED (SELECT id FROM recording_clip_feedback WHERE lower(regexp_replace(coalesce(channel,\'\'),\'^@\',\'\'))<>ALL(%s)) '+connected.QUERY.rsplit(' WHERE ',1)[0]+' JOIN allowed af ON af.id=f.id WHERE r.analyzed_at=f.analyzed_at AND f.added=false AND f.detected_start IS NOT NULL AND f.detected_end-f.detected_start>=240 AND v.is_available=true ORDER BY f.id LIMIT 1201'
 with psycopg.connect(base.pg_config())as pg:
  pg.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');pg.execute("SET statement_timeout='20s'");raw=pg.execute(query,(sorted(reserved),)).fetchall()
  if len(raw)>1200:raise ValueError('Metadata bound exceeded')
  rows=[dict(zip(connected.COLS,r))for r in raw];rows=whole.attach_reviews(pg,rows,reserved);records,unavailable=choose_sources(rows,used,reserved);history=history_metadata(pg)
 if not records:raise ValueError('No new metadata-valid real originals')
 value={'schema_version':1,'policy':POLICY,'metric_policy':METRIC_POLICY,'source_pins':pins(),'head_sha256':v1.HEAD_SHA,'first_snapshot_sha256':FIRST_SHA,'excluded_holdout_creators':sorted(reserved),'holdout_dependency':receipt,'records':records,'unavailable':unavailable,'historical_version_pairs':sorted([list(x)for x in versions.history_pairs(history)]),'creator_count':len({r['source']['channel_key']for r in records}),'historical_semantic_pairs':sorted([list(semantic_pair(t))for t in history if isinstance((t.get('context')or{}).get('a'),dict)and isinstance((t.get('context')or{}).get('b'),dict)]),'coarse_metadata_only':True,'fine_preference_outcomes_read':False,'fits':0,'queue_writes':0}
 temporal.frozen(Path(out)/'frozen_pool.json',value);return {'status':'new_real_original_pool_frozen','proposals':len(records),'creators':value['creator_count'],'pool_sha256':base.digest(Path(out)/'frozen_pool.json'),'queue_writes':0}

def load_pool(out):
 p=json.loads((Path(out)/'frozen_pool.json').read_text());_,(reserved,receipt)=dependencies()
 if p['policy']!=POLICY or p['metric_policy']!=METRIC_POLICY or p['excluded_holdout_creators']!=sorted(reserved)or p['holdout_dependency']!=receipt or p['head_sha256']!=v1.HEAD_SHA or base.digest(v1.HEAD)!=v1.HEAD_SHA or p['source_pins']!=pins():raise ValueError('Exact frozen source/policy/head dependencies required')
 return p,reserved,receipt

def controls(out=OUT):
 import psycopg
 began=time.monotonic();deadline=began+300;pool,reserved,receipt=load_pool(out);head=json.loads(v1.HEAD.read_text())['heads'];records=[];sources={};usedbytes=0
 with psycopg.connect(base.pg_config())as pg:
  pg.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');pg.execute("SET statement_timeout='45s'");live=load_live(pg,[r['source']['feedback_id']for r in pool['records']]);validate_live(pool,live,[],reserved,receipt)
  for r in pool['records']:
   v1.check(deadline);s=r['source'];row=live[s['feedback_id']]
   usedbytes+=s['index']['frame_count']*(1152*4+8)
   if usedbytes>POLICY['max_numeric_read_bytes']:raise ValueError('Numeric preparation budget exceeded')
   try:t,v,proposals,identity=v1.numeric.frame_inputs(row,s,pg)
   except ValueError as error:records.append(dict(r,status='numeric_source_unavailable',reason=str(error)));continue
   if sorted(proposals,key=lambda p:p['id'])!=r['proposals']:records.append(dict(r,status='numeric_original_universe_unavailable',reason='complete original detector universe differs'));continue
   if t.nbytes+v.nbytes>s['index']['frame_count']*(1152*4+8):raise ValueError('Exact float32 numeric budget/geometry required')
   path,cp=v1.old.frames.checkpoint(Path(out),t,v,identity);cp=dict(cp,path=path);ranges=v1.generic_grid(s['clip']);scores=[]
   for bounds in ranges:
    v1.check(deadline);scores.append(v1.old.scores(head,row,s,(t,v,proposals,identity,path),bounds))
   control=ranges[v1.old.best(ranges,scores)];ii=sorted(set(v1.uniform_indices(t,s['clip'],72))|set(v1.uniform_indices(t,control,24)));key=temporal.aux.state.identity_sha256(identity)
   z=dict(r,numeric_identity=identity,frame_checkpoint=cp,source_key=key,control_range=control,old_candidate_grid=ranges,old_candidate_scores=scores,comparator_stratum='generic_oldC_without_human_reference',planned_face_indices=ii,planned_face_timestamps=t[ii].tolist(),known_debug=False);records.append(z)
   q=sources.setdefault(key,{'identity':identity,'group':s['channel_key'],'frame_checkpoint':cp,'feedback_ids':[],'rows':[],'planned_indices':[],'full_timestamps':t.tolist()})
   if q['identity']!=identity or q['frame_checkpoint']!=cp:raise ValueError('Same generation checkpoint conflict')
   q['feedback_ids'].append(s['feedback_id']);q['rows'].append({'feedback_id':s['feedback_id'],'original_range':s['clip'],'control_range':control,'point_indices':ii});q['planned_indices']=sorted(set(q['planned_indices'])|set(ii));del v
 v1.check(deadline);value={'schema_version':1,'policy':POLICY,'pool_sha256':base.digest(Path(out)/'frozen_pool.json'),'head_sha256':v1.HEAD_SHA,'records':records,'sources':sources,'seconds':time.monotonic()-began,'numeric_matrix_bytes':usedbytes,'requested_face_points':sum(len(s['planned_indices'])for s in sources.values()),'labels_used_for_scoring':False,'queue_writes':0,'fits':0}
 face_api.validate_request(value,reserved);temporal.frozen(Path(out)/'controls_and_face_request.json',value);return {'status':'controls_frozen_detection_required','numeric_generations':len(sources),'supported_records':sum('source_key'in r for r in records),'points':value['requested_face_points'],'request_sha256':base.digest(Path(out)/'controls_and_face_request.json')}


def load_request(out):
 pool,reserved,receipt=load_pool(out);path=Path(out)/'controls_and_face_request.json';q=json.loads(path.read_text())
 if q['policy']!=POLICY or q['pool_sha256']!=base.digest(Path(out)/'frozen_pool.json')or q['head_sha256']!=v1.HEAD_SHA:raise ValueError('Exact next-wave controls required')
 face_api.validate_request(q,reserved);return q,base.digest(path),reserved,receipt

def candidate_records(out,face_root):
 started=time.monotonic();request,sha,reserved,receipt=load_request(out);probe=temporal.aux.state.load_probe();records=[];unavailable=[{'proposal_identity':v1.source_key(r['source']),'reason':r.get('status','numeric_unavailable'),'detail':r.get('reason','unknown')}for r in request['records']if 'source_key'not in r];proofs={};bytes_used=0
 for key,s in sorted(request['sources'].items()):
  v1.check(started+300)
  try:points,proof=face_api.load_numeric_source(face_root,key,sha,s['identity'])
  except(ValueError,OSError)as e:unavailable.append({'source_key':key,'reason':'complete_face_receipt_unavailable','detail':str(e)});continue
  cp=s['frame_checkpoint'];p=Path(cp['path']);bytes_used+=p.stat().st_size
  if p.stat().st_dev!=v1.ROOT.stat().st_dev or p.stat().st_size>64*1024**2 or bytes_used>POLICY['max_numeric_read_bytes']:raise ValueError('Bounded exact SSD numeric request required')
  raw=p.read_bytes()
  if hashlib.sha256(raw).hexdigest()!=cp['sha256']:raise ValueError('Exact numeric checkpoint checksum required')
  t,v=temporal.decode_numeric_checkpoint(raw,s);context=temporal.aux.state.classify_original_context(probe,t,v,identity=s['identity'],expected_identity=s['identity']);del raw,v;proofs[key]=proof
  for r in request['records']:
   if r.get('source_key')!=key:continue
   d=temporal.propose(t,context.probabilities,points,r['original_range'],r['control_range'])
   if d['candidate_range']is None:unavailable.append({'proposal_identity':v1.source_key(r['source']),'reason':d['status']});continue
   records.append(dict(r,diagnostic=d,face_checkpoint_sha256=proof['checkpoint_sha256']))
 pool=json.loads((Path(out)/'frozen_pool.json').read_text());used={tuple(x)for x in pool['historical_version_pairs']};historical_semantic={tuple(x)for x in pool['historical_semantic_pairs']};seen=set();seen_semantic=set();selected=[];counts={}
 for r in v1.round_robin(records):
  pair=tuple(sorted(versions.version_key(versions.public_side(r['source'],bounds,'Version'))for bounds in(r['control_range'],r['diagnostic']['candidate_range'])))
  sp=semantic_pair({'context':{k:versions.public_side(r['source'],bounds,'Version')for k,bounds in zip(('a','b'),(r['control_range'],r['diagnostic']['candidate_range']))}})
  if pair in used or pair in seen or sp in historical_semantic or sp in seen_semantic:unavailable.append({'proposal_identity':v1.source_key(r['source']),'reason':'exact_historical_or_new_pair_duplicate'});continue
  seen.add(pair);seen_semantic.add(sp);g=r['source']['channel_key']
  if counts.get(g,0)>=3 or len(selected)>=MAX_COUNT:unavailable.append({'proposal_identity':v1.source_key(r['source']),'reason':'fixed_creator3_or_max30'});continue
  selected.append(r);counts[g]=counts.get(g,0)+1
 return {'selected':selected,'unavailable':unavailable,'face_provenance':proofs,'request_sha256':sha,'face_root':str(Path(face_root).resolve()),'actual_count':len(selected),'creators':len(counts)},reserved,receipt

def make_manifest(selection,reserved,receipt):
 selected=selection['selected'];n=len(selected);counts={}
 if not 1<=n<=MAX_COUNT:raise ValueError('Only actual distinct nonempty nextwave comparisons')
 for r in selected:
  g=r['source']['channel_key'];counts[g]=counts.get(g,0)+1
  if g in reserved or r['source']['video_id']==temporal.KNOWN_VIDEO or counts[g]>3:raise ValueError('Next-wave reserved/debug/creator cap')
 pairs_seen=set();semantic_seen=set()
 for r in selected:
  d=r['diagnostic'];pair=tuple(sorted(versions.version_key(versions.public_side(r['source'],bounds,'Version'))for bounds in(r['control_range'],d['candidate_range'])))
  sp=semantic_pair({'context':{k:versions.public_side(r['source'],bounds,'Version')for k,bounds in zip(('a','b'),(r['control_range'],d['candidate_range']))}})
  if pair in pairs_seen or sp in semantic_seen:raise ValueError('Distinct exact and physical semantic pairs required')
  pairs_seen.add(pair);semantic_seen.add(sp)
 rng=random.Random(POLICY['assignment_seed']);flags=[True]*(n//2)+[False]*(n-n//2);rng.shuffle(flags);pairs=[]
 for r,new_a in zip(sorted(selected,key=lambda x:v1.source_key(x['source'])),flags):
  s=r['source'];d=r['diagnostic'];ranges=[d['candidate_range'],r['control_range']]if new_a else[r['control_range'],d['candidate_range']];roles=['new_temporal','old_C']if new_a else['old_C','new_temporal'];sides={k:versions.public_side(s,ranges[i],f'Version {k.upper()}')for i,k in enumerate(('a','b'))};context=dict(sides,channel=s['channel'],comparison_scope='same_channel',blind_version_comparison=True,target='preferred_version_if_keep_one',soft_preferred_minutes=[3,15],reserved_fine_holdout=False,fine_data_role='training',batch_policy=BATCH,preview_recipe='uniform10_50_90_centres15s',acceptability_target=None,cut_target=None)
  row={'kind':'version-versus','batch':BATCH,'video_id':s['video_id'],'start_seconds':sides['a']['range'][0],'end_seconds':sides['a']['range'][1],'channel':s['channel'],'stratum':'blind-version','context':context};p={k:r[k]for k in('source','source_key','numeric_identity','frame_checkpoint','original_proposal_id','diagnostic','face_checkpoint_sha256','comparator_stratum')};p.update(assignments=dict(zip(('a','b'),roles)),known_debug=False);pairs.append((row,p))
 rng.shuffle(pairs);rows=[];private=[]
 for i,(r,p)in enumerate(pairs):r['position']=i;rows.append(r);private.append(dict(p,position=i))
 return {'schema_version':1,'policy':POLICY,'metric_policy':METRIC_POLICY,'source_pins':pins(),'excluded_holdout_creators':sorted(reserved),'holdout_dependency':receipt,'head_sha256':v1.HEAD_SHA,'first_snapshot_sha256':FIRST_SHA,'selection':dict(selection,selected=sorted(selection['selected'],key=lambda r:v1.source_key(r['source']))),'selection_summary':{'comparator_counts':{'generic_oldC_without_human_reference':n},'requested_max':MAX_COUNT,'actual_distinct':n,'unavailable':selection['unavailable']},'rows':rows,'private_assignments':private,'actual_count':n,'creators':len(counts),'queue_writes':0,'fits':0,'automatic_model_promotion':False}

def prepare(out=OUT,face_root=None):
 import psycopg
 selection,reserved,receipt=candidate_records(out,face_root);value=make_manifest(selection,reserved,receipt)
 with psycopg.connect(base.pg_config())as pg:
  pg.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');live=load_live(pg,[r['source']['feedback_id']for r in value['private_assignments']]);validate_live(value,live,history_metadata(pg),reserved,receipt)
 temporal.frozen(Path(out)/'private_manifest.json',value);return {'status':'prepared_actual_distinct_no_queue_writes','count':value['actual_count'],'creators':value['creators'],'manifest_sha256':base.digest(Path(out)/'private_manifest.json')}

def load_contract(out,expected):
 p=Path(out)/'private_manifest.json'
 if base.digest(p)!=expected:raise ValueError('Reviewed exact manifest SHA required')
 value=json.loads(p.read_text());selection,reserved,receipt=candidate_records(out,value['selection']['face_root'])
 if value!=make_manifest(selection,reserved,receipt):raise ValueError('Unchanged source/control/face/proposal/policy reconstruction required')
 return value,reserved,receipt

def metrics(rows):
 groups={}
 for r in rows:
  if r['known_debug']is not False or r['outcome']not in('new','old','both','neither'):raise ValueError('Fresh nondebug pure preference required')
  groups.setdefault(r['creator'],[]).append(r['outcome'])
 if any(len(v)>3 for v in groups.values()):raise ValueError('Creator cap3 required')
 net=[];strict=[]
 for _,values in sorted(groups.items()):
  a=values.count('new');b=values.count('old');t=values.count('both')
  if a+b+t:net.append((a-b)/(a+b+t))
  if a+b:strict.append(a/(a+b))
 net=np.array(net,float);ci=np.quantile(net[np.random.default_rng(20261011).integers(0,len(net),(5000,len(net)))].mean(1),[.005,.995]).tolist()if len(net)else None;win=float(np.mean(strict))if strict else None
 gates={'min20_primary_nonabstaining_creators':len(net)>=20,'creator_macro_strict_newwin_min065':win is not None and win>=.65,'creator_net_lower99_positive':ci is not None and ci[0]>0}
 return {'metric_policy':METRIC_POLICY,'counts':{k:sum(r['outcome']==k for r in rows)for k in('new','old','both','neither')},'creator_count':len(groups),'nonabstaining_creators':len(net),'creator_macro_net':float(net.mean())if len(net)else None,'creator_macro_strict_win':win,'creator_cluster_net_ci99':ci,'predeclared_gates':gates,'release_signal_passed':all(gates.values()),'pooled_with_firstwave':'DESCRIPTIVE_ONLY_NOT_RELEASE_TEST','automatic_model_promotion':False}

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['inventory','controls','prepare']);p.add_argument('--root',type=Path,default=OUT);p.add_argument('--face-root',type=Path);a=p.parse_args();print(json.dumps(inventory(a.root)if a.mode=='inventory'else controls(a.root)if a.mode=='controls'else prepare(a.root,a.face_root)))
