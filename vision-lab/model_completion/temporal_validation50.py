"""Frozen old-C vs temporal-policy validation preparation; no fitting or media decode.

Phases: freeze metadata inventory; generate exact numeric controls and label-free
face-point requests; join separately reviewed face detections; build a blind round.
No source is selected using new answers, and agreements are never forced into pairs.
"""
from __future__ import annotations
import argparse,copy,hashlib,io,json,math,random,time,zipfile
from pathlib import Path
import numpy as np
import offered_span_prospective as old
import temporal_face_action_diagnostic as temporal
import blind_version_round as versions
import new_round_features as numeric
base=versions.base;safe=versions.safe
ROOT=temporal.ROOT;OUT=ROOT/'temporal-validation50-v1';BATCH='temporal-model-validation-20261010-1';COUNT=50
HEAD=old.HEAD;HEAD_SHA=old.HEAD_SHA
POLICY={'schema_version':1,'batch':BATCH,'target':'preferred_version_if_keep_one','requested_comparisons':50,'max_comparisons_per_creator':3,'creator_target':25,'selection':'Freeze ALL eligible reviewed original proposals in supplied metadata inventory BEFORE scoring. Deterministic creator-round-robin by canonical source hash, max3 displayed comparisons/creator; known source debug retained first and evaluated separately. Never force agreement into comparison.','old_selector':'Pinned oldC e681be58 primary, exact existing128-max grid180/300/600/900/original/reference with17 fixed starts; same inherited score/tie rule; no refit.','new_selector':'EXACT pinned observed temporal same-duration challenger policy; no new threshold, duration or parameter search.','face_request':'72 uniformly spaced existing5-second frame indices over each original, union24 uniform old-control points; union by exact full-source generation. Already validated observed v3 points may be reused. No label/face/action-driven new sampling.','unknown':'Missing face never zero; source not eligible until every planned numeric detection is identity/point validated. Unavailable exact cached storyboard cannot fall back to raw video.','blind':'Private challengerA25/B25 seed20261010 and seeded order; neutral Version A/B and uniform3x15s previews. Methods/debug/episodes/oldscore private.','semantics':'Pure version preference only. Both=no strict preference/tie; neither=abstention. No acceptance, cut gold, whole, expiry or permanent-storage labels.','primary':'Exclude known posthoc debugging source from main release evaluation, retain its result separately. Fixed global Stage1 supervision overlap disclosed.','numeric_budget_seconds':300,'short_reference':'Approved references shorter180 remain accepted inventory; exact prior old-grid unsupported status recorded, never unworthy. This validation uses only original>=240 and prior supported reference>=180; no silent grid extension.', 'generic_grid_diagnostic':'Also score reference-free fixed180/300/600/900/original grid with same17starts and oldC weights; record identical-selection proof only, never replace the benchmark comparator after answers.','max_sources':256,'max_numeric_read_bytes':1024*1024**2,'face_extract_not_in_this_script':True,'fits':0,'GPU':False,'media_decode':False,'DB_writes':0,'production_changes':0}
METRIC_POLICY={'schema_version':1,'timing':'Frozen before any new50-round answers','unit':'Whole creator, max3 displayed comparisons each. 50comparisons are not50 independent creator samples.','outcomes':'New win +1, old win -1, human tie0; abstention excluded from net denominator but always counted. Both never absolute acceptability or equality training labels.','creator_macro_net':'Mean per-creator (newwins-oldwins)/(newwins+oldwins+ties), excluding only all-abstaining creators.','strict_win':'Mean per-creator newwins/(newwins+oldwins), among creators with strict preference.','bootstrap':{'unit':'whole creator','samples':5000,'seed':42,'confidence':.95},'release_signal':'At least20 primary nonabstaining creators, macrostrictnewwin>=.65, creator-bootstrap net lower95endpoint>0, known debugging source not lost. These are evidence gates only; root parity/product review still required.','significant_improvement_claim':'Only when predeclared creator-cluster lowerCI>0; no independent-comparison binomial CI.','known_debug':'Report separately; cannot establish generalization.','ties':'Insufficient directional evidence may mean equivalence or uncertainty; no forced binary conversion.','automatic_model_promotion':False}


def source_key(source):return numeric.digest({k:source[k] for k in ('feedback_id','video_id','analyzed_at','source_fingerprint','index','clip')})
def check(deadline):
 if time.monotonic()>=deadline:raise TimeoutError('Bounded numeric control preparation expired')

def round_robin(records):
 groups={}
 for r in records:groups.setdefault(r['source']['channel_key'],[]).append(r)
 for g in groups:groups[g].sort(key=lambda r:source_key(r['source']))
 result=[]
 while any(groups.values()):
  for g in sorted(groups):
   if groups[g]:result.append(groups[g].pop(0))
 return result

def validate_sources(sources,reserved):
 if not isinstance(sources,list) or not 1<=len(sources)<=POLICY['max_sources']:raise ValueError('Bounded supplied existing-source inventory required')
 seen=set()
 for s in sources:
  if not isinstance(s,dict) or s['channel_key'] in reserved or base.canon(s['channel'])!=s['channel_key'] or source_key(s) in seen:raise ValueError('Distinct canonical nonreserved source required')
  seen.add(source_key(s));a,b=s['clip'];c,d=s['best'];index=s['index']
  if not all(temporal.aux.state.finite_number(x) for x in (a,b,c,d,s['duration_seconds'],s['score'])) or not 0<=a<=c<d<=b<=s['duration_seconds'] or b-a<240 or d-c<15:raise ValueError('Existing original/manual range and duration invalid')
  if type(index['frame_count']) is not int or not 1<=index['frame_count']<=8000 or index['model_revision']!=base.VISUAL_PIN or index['interval_seconds']!=5:raise ValueError('Exact bounded indexed source required')
 return sources

def freeze_inventory(inventory_path,inventory_sha,out=OUT):
 path=Path(inventory_path)
 if path.stat().st_size>8*1024**2 or base.digest(path)!=inventory_sha:raise ValueError('Exact bounded supplied inventory SHA required')
 inventory=json.loads(path.read_text());reserved,receipt=safe.previous.holdout_contract()
 if inventory['excluded_holdout_creators']!=sorted(reserved) or inventory['holdout_dependency']!=receipt:raise ValueError('Authoritative reserved contract differs')
 sources=validate_sources(inventory['sources'],reserved)
 if base.digest(HEAD)!=HEAD_SHA:raise ValueError('Exact oldC head pin differs')
 value={'schema_version':1,'policy':POLICY,'metric_policy':METRIC_POLICY,'source_sha256':base.digest(Path(__file__)),'inventory_path':str(path.resolve()),'inventory_sha256':inventory_sha,'head_path':str(HEAD.resolve()),'head_sha256':HEAD_SHA,'holdout_dependency':receipt,'excluded_holdout_creators':sorted(reserved),'sources':sorted(copy.deepcopy(sources),key=source_key),'helper_sources':{str(Path(p).resolve()):base.digest(Path(p)) for p in (old.__file__,temporal.__file__,numeric.__file__,versions.__file__,old.frames.__file__)},'creator_count':len({s['channel_key'] for s in sources}),'source_count':len(sources),'outcomes_read':False}
 import psycopg
 with psycopg.connect(base.pg_config()) as pg:
  pg.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');pg.execute("SET statement_timeout='15s'");history=[{'kind':k,'batch':b,'context':c} for k,b,c in pg.execute("SELECT kind,batch,context FROM recording_label_tasks WHERE kind='version-versus' ORDER BY id").fetchall()]
 value['historical_version_pairs']=sorted([list(pair) for pair in versions.history_pairs(history)])
 temporal.frozen(Path(out)/'frozen_pool.json',value);return {'status':'pool_frozen_before_control_scoring','sources':len(sources),'creators':value['creator_count'],'pool_sha256':base.digest(Path(out)/'frozen_pool.json'),'queue_writes':0}

def load_pool(out):
 pool=json.loads((Path(out)/'frozen_pool.json').read_text());reserved,receipt=safe.previous.holdout_contract()
 if pool['policy']!=POLICY or pool['metric_policy']!=METRIC_POLICY or pool['source_sha256']!=base.digest(Path(__file__)) or pool['head_sha256']!=HEAD_SHA or base.digest(HEAD)!=HEAD_SHA or pool['holdout_dependency']!=receipt or pool['excluded_holdout_creators']!=sorted(reserved) or base.digest(Path(pool['inventory_path']))!=pool['inventory_sha256']:raise ValueError('Frozen pool/head/evaluation contract changed')
 for p,sha in pool['helper_sources'].items():
  if base.digest(Path(p))!=sha:raise ValueError('Frozen numerical helper differs')
 validate_sources(pool['sources'],reserved);return pool

def generic_grid(original):
 a,b=map(float,original)
 if not 0<=a<b or b-a<180:raise ValueError('Generic original range invalid')
 result={tuple(r) for length in (180.,300.,600.,900.,b-a) if length<=b-a for r in old.locations(original,length)}|{tuple(original)}
 return [list(r) for r in sorted(result)]

def generic_selection(ranges,scores,original):
 generic=generic_grid(original);lookup={tuple(r):s for r,s in zip(ranges,scores)}
 if any(tuple(r) not in lookup for r in generic):raise ValueError('Generic grid must be exact subset of benchmark grid')
 values=[lookup[tuple(r)] for r in generic]
 return generic[old.best(generic,values)]

def uniform_indices(t,bounds,number):
 ii=np.flatnonzero((t>=bounds[0])&(t<=bounds[1]))
 if not len(ii):raise ValueError('Range has no observed indexed points')
 return ii[np.unique(np.linspace(0,len(ii)-1,min(number,len(ii))).astype(int))].tolist()

def controls(out=OUT):
 import psycopg
 started=time.monotonic();deadline=started+POLICY['numeric_budget_seconds'];pool=load_pool(out);head=json.loads(HEAD.read_text());sources=pool['sources'];records=[];requests={};bytes_used=0;matrices={}
 ids=sorted(s['feedback_id'] for s in sources)
 with psycopg.connect(base.pg_config()) as pg:
  pg.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');pg.execute("SET statement_timeout='45s'");live=safe.previous.load_rows(pg,ids)
  if set(live)!=set(ids):raise ValueError('Exact frozen eligible live source inventory unavailable')
  for source in sorted(sources,key=lambda s:(s['video_id'],s['analyzed_at'],s['feedback_id'])):
   check(deadline)
   if source['best'][1]-source['best'][0]<180:
    records.append({'source':source,'status':'old_reference_protocol_unsupported','current_acceptability':'saved_keep_not_changed'});continue
   raw=live[source['feedback_id']]
   if safe.previous.side(raw,[])!=source:raise ValueError('Frozen source/index/proposal/review drift')
   marker=(source['video_id'],source['analyzed_at'])
   if marker not in matrices:
    matrices.clear()
    t,v,proposals,identity=numeric.frame_inputs(raw,source,pg);bytes_used+=t.nbytes+v.nbytes
    if bytes_used>POLICY['max_numeric_read_bytes']:raise ValueError('Bounded numeric frame preparation exceeded')
    path,frame=old.frames.checkpoint(Path(out),t,v,identity);frame=dict(frame,path=path);matrices[marker]=(t,v,proposals,identity,path,frame)
   t,v,proposals,identity,path,frame=matrices[marker];key=temporal.aux.state.identity_sha256(identity);ranges=old.grid(source['clip'],source['best']);scores=[]
   for bounds in ranges:
    check(deadline);scores.append(old.scores(head['heads'],raw,source,(t,v,proposals,identity,path),bounds))
   control=ranges[old.best(ranges,scores)];generic_control=generic_selection(ranges,scores,source['clip']);planned=sorted(set(uniform_indices(t,source['clip'],72))|set(uniform_indices(t,control,24)))
   record={'source':source,'source_key':key,'numeric_identity':identity,'frame_checkpoint':frame,'original_proposal_id':raw['clip_id'],'original_range':source['clip'],'control_range':control,'generic_control_range':generic_control,'generic_control_matches':generic_control==control,'old_candidate_grid':ranges,'old_candidate_scores':scores,'known_debug':source['video_id']==temporal.KNOWN_VIDEO and source['feedback_id']==temporal.KNOWN_FEEDBACK,'planned_face_indices':planned,'planned_face_timestamps':t[planned].tolist()}
   temporal.frozen(Path(out)/'controls'/f'{source_key(source)}.json',record);records.append(record)
   req=requests.setdefault(key,{'identity':identity,'group':source['channel_key'],'frame_checkpoint':frame,'feedback_ids':[],'rows':[],'planned_indices':[],'full_timestamps':t.tolist()})
   if req['identity']!=identity or req['frame_checkpoint']!=frame:raise ValueError('Same-source numeric generation conflict')
   req['feedback_ids'].append(source['feedback_id']);req['rows'].append({'feedback_id':source['feedback_id'],'original_range':source['clip'],'control_range':control,'point_indices':planned});req['planned_indices']=sorted(set(req['planned_indices'])|set(planned))
  # Exactly one full generation matrix retained; proposals in that recording reuse it.
 check(deadline);value={'schema_version':1,'policy':POLICY,'pool_sha256':base.digest(Path(out)/'frozen_pool.json'),'head_sha256':HEAD_SHA,'records':records,'sources':requests,'seconds':time.monotonic()-started,'numeric_matrix_bytes':bytes_used,'generic_control_counts':{'supported':sum('generic_control_matches' in r for r in records),'identical':sum(r.get('generic_control_matches',False) for r in records),'different':sum(r.get('generic_control_matches') is False for r in records)},'requested_face_points':sum(len(r['planned_indices']) for r in requests.values()),'labels_used_for_scoring':False,'queue_writes':0,'fits':0}
 temporal.frozen(Path(out)/'controls_and_face_request.json',value)
 return {'status':'old_controls_frozen_face_checkpoint_required','records':len(records),'sources':len(requests),'points':value['requested_face_points'],'generic_control_counts':value['generic_control_counts'],'seconds':value['seconds'],'request_sha256':base.digest(Path(out)/'controls_and_face_request.json'),'queue_writes':0}

def validate_face_points(checkpoint,request,request_sha):
 """Extraction adapter contract: frozen generation/model/point list; no images here."""
 identity=request['identity'];key=temporal.aux.state.identity_sha256(identity)
 if checkpoint.get('request_sha256')!=request_sha or checkpoint.get('source_key')!=key or checkpoint.get('identity')!=identity or checkpoint.get('model_sha256')!=temporal.aux.paired.face.face.MODEL_SHA or checkpoint.get('provider')!='CPUExecutionProvider' or checkpoint.get('identity_embeddings') is not False or checkpoint.get('complete') is not True:raise ValueError('Complete pinned detection-only face request binding required')
 points=checkpoint.get('frames');planned=request['planned_indices']
 if not isinstance(points,list) or len(points)!=len(planned) or [f['index'] for f in points]!=planned:raise ValueError('Every planned exact observed face point required; no zero filling')
 for f in points:
  i=f['index']
  if f['timestamp']!=request['full_timestamps'][i] or type(f['detected']) is not bool or not temporal.aux.state.finite_number(f['max_confidence']) or not 0<=f['max_confidence']<=1:raise ValueError('Exact face timestamp/index/numeric confidence required')
 return points

def select_pairs(records,limit=50):
 chosen=[];counts={};suppressed=[]
 debug=sorted([r for r in records if r.get('known_debug')],key=lambda r:source_key(r['source']))
 for r in debug+round_robin([r for r in records if not r.get('known_debug')]):
  group=r['source']['channel_key']
  if counts.get(group,0)>=3:suppressed.append({'source_identity':source_key(r['source']),'reason':'creator_limit3'});continue
  if len(chosen)>=limit:suppressed.append({'source_identity':source_key(r['source']),'reason':'requested_limit50'});continue
  chosen.append(r);counts[group]=counts.get(group,0)+1
 return chosen,suppressed

def candidates(face_root,face_request_sha,out=OUT):
 started=time.monotonic();deadline=started+POLICY['numeric_budget_seconds'];pool=load_pool(out);request_path=Path(out)/'controls_and_face_request.json'
 if base.digest(request_path)!=face_request_sha:raise ValueError('Exact face/control request SHA required')
 value=json.loads(request_path.read_text());request_sha=base.digest(request_path)
 if value['policy']!=POLICY or value['pool_sha256']!=base.digest(Path(out)/'frozen_pool.json') or value['head_sha256']!=HEAD_SHA:raise ValueError('Exact frozen control/pool binding required')
 probe=temporal.aux.state.load_probe();bytes_used=0;eligible=[];agreements=[{'feedback_id':r['source']['feedback_id'],'reason':r['status'],'current_acceptability':'saved_keep_not_changed'} for r in value['records'] if r.get('status')=='old_reference_protocol_unsupported']
 for key,source in sorted(value['sources'].items()):
  check(deadline);path=Path(face_root)/f'{key}.json'
  if not path.is_file():agreements.extend({'feedback_id':r['feedback_id'],'reason':'missing_face_checkpoint_unknown'} for r in source['rows']);continue
  if path.stat().st_size>4*1024**2:raise ValueError('Bounded detection-only numeric checkpoint required')
  cp=json.loads(path.read_text());points=validate_face_points(cp,source,request_sha);frame=source['frame_checkpoint'];p=Path(frame['path'])
  if p.stat().st_dev!=ROOT.stat().st_dev or p.stat().st_size>64*1024**2:raise ValueError('Bounded SSD numeric generation required')
  bytes_used+=p.stat().st_size
  if bytes_used>POLICY['max_numeric_read_bytes']:raise ValueError('Numeric read budget exceeded before matrix read')
  payload=p.read_bytes()
  if hashlib.sha256(payload).hexdigest()!=frame['sha256']:raise ValueError('Exact generation frame checkpoint changed')
  t,v=temporal.decode_numeric_checkpoint(payload,source);context=temporal.aux.state.classify_original_context(probe,t,v,identity=source['identity'],expected_identity=source['identity']);del v,payload
  for r in value['records']:
   if r.get('source_key')!=key:continue
   diagnostic=temporal.propose(t,context.probabilities,points,r['original_range'],r['control_range'])
   if diagnostic['candidate_range'] is None:agreements.append({'feedback_id':r['source']['feedback_id'],'reason':diagnostic['status'],'coverage':diagnostic['coverage_original']});continue
   eligible.append(dict(r,diagnostic=diagnostic,face_checkpoint_sha256=base.digest(path)))
 history={tuple(p) for p in pool['historical_version_pairs']};deduplicated=[];duplicate_records=[];seen=set()
 for r in eligible:
  source=r['source'];pair=tuple(sorted(versions.version_key(versions.public_side(source,bounds,'Version')) for bounds in (r['control_range'],r['diagnostic']['candidate_range'])))
  if pair in history or pair in seen:duplicate_records.append({'source_identity':source_key(source),'reason':'historical_or_same_round_exact_pair_duplicate'});continue
  seen.add(pair);deduplicated.append(r)
 selected,suppressed=select_pairs(deduplicated,50);suppressed=duplicate_records+suppressed;result={'schema_version':1,'policy':POLICY,'metric_policy':METRIC_POLICY,'historical_version_pairs':pool['historical_version_pairs'],'pool_sha256':value['pool_sha256'],'request_sha256':request_sha,'eligible_distinct':len(deduplicated),'raw_eligible_before_duplicate_filter':len(eligible),'selected':selected,'agreement_or_unavailable':agreements,'suppressed':suppressed,'selected_creators':len({r['source']['channel_key'] for r in selected}),'all_inventory_sources':len(pool['sources']),'seconds':time.monotonic()-started,'numeric_read_bytes':bytes_used,'queue_writes':0,'fits':0,'status':'ready50_distinct_for_review' if len(selected)==50 else 'insufficient_distinct_pairs_no_forcing'}
 check(deadline);temporal.frozen(Path(out)/'candidate_selection.json',result);return {'status':result['status'],'selected':len(selected),'creators':result['selected_creators'],'eligible':len(eligible),'agreement_or_unavailable':len(agreements),'suppressed':len(suppressed),'queue_writes':0}

def make_manifest(selection,reserved,holdout):
 if selection['policy']!=POLICY or selection['metric_policy']!=METRIC_POLICY or selection['status']!='ready50_distinct_for_review' or len(selection['selected'])!=50:raise ValueError('Exactly50 real distinct comparisons required; no forced fill')
 chosen=selection['selected']
 if max(sum(r['source']['channel_key']==g for r in chosen) for g in {r['source']['channel_key'] for r in chosen})>3 or any(r['source']['channel_key'] in reserved for r in chosen):raise ValueError('Creator cap/reserved exclusion violated')
 rng=random.Random(20261010);a_flags=[True]*25+[False]*25;rng.shuffle(a_flags);pairs=[]
 for r,challenger_a in zip(sorted(chosen,key=lambda r:source_key(r['source'])),a_flags):
  source=r['source'];candidate=r['diagnostic']['candidate_range'];control=r['control_range'];bounds=[candidate,control] if challenger_a else [control,candidate];roles=['new_temporal','old_C'] if challenger_a else ['old_C','new_temporal']
  sides={k:versions.public_side(source,bounds[i],f'Version {k.upper()}') for i,k in enumerate(('a','b'))};context=dict(sides,channel=source['channel'],comparison_scope='same_channel',blind_version_comparison=True,target='preferred_version_if_keep_one',soft_preferred_minutes=[3,15],reserved_fine_holdout=False,fine_data_role='training',batch_policy=BATCH,preview_recipe='uniform10_50_90_centres15s',acceptability_target=None,cut_target=None)
  row={'kind':'version-versus','batch':BATCH,'video_id':source['video_id'],'start_seconds':sides['a']['range'][0],'end_seconds':sides['a']['range'][1],'channel':source['channel'],'stratum':'blind-version','context':context};private={'source':source,'numeric_identity':r['numeric_identity'],'frame_checkpoint':r['frame_checkpoint'],'source_key':r['source_key'],'assignments':dict(zip(('a','b'),roles)),'known_debug':r['known_debug'],'face_checkpoint_sha256':r['face_checkpoint_sha256'],'diagnostic':r['diagnostic']};pairs.append((row,private))
 rng.shuffle(pairs);rows=[];private=[]
 for position,(r,p) in enumerate(pairs):r['position']=position;rows.append(r);private.append(dict(p,position=position))
 return {'schema_version':1,'policy':POLICY,'metric_policy':METRIC_POLICY,'source_sha256':base.digest(Path(__file__)),'head_sha256':HEAD_SHA,'excluded_holdout_creators':sorted(reserved),'holdout_dependency':holdout,'rows':rows,'private_assignments':private,'selection_summary':{k:selection[k] for k in ('eligible_distinct','selected_creators','all_inventory_sources','agreement_or_unavailable','suppressed')},'queue_writes':0,'model_fits':0,'media_reads':0,'GPU':False}

def metrics(rows):
 groups={};debug=[]
 for r in rows:
  if r['outcome'] not in ('new','old','both','neither') or type(r['known_debug']) is not bool:raise ValueError('Pure paired preference outcome required')
  if r['known_debug']:debug.append(r);continue
  groups.setdefault(r['creator'],[]).append(r['outcome'])
 if any(len(v)>3 for v in groups.values()):raise ValueError('At most3 paired comparisons per creator')
 counts={k:sum(r['outcome']==k for r in rows) for k in ('new','old','both','neither')};per={};strict=[]
 for g,outcomes in sorted(groups.items()):
  n=outcomes.count('new');o=outcomes.count('old');tie=outcomes.count('both');abstain=outcomes.count('neither')
  per[g]={'new':n,'old':o,'tie':tie,'abstain':abstain,'net':(n-o)/(n+o+tie) if n+o+tie else None,'strict_win':n/(n+o) if n+o else None}
  if n+o:strict.append(n/(n+o))
 net=np.array([p['net'] for p in per.values() if p['net'] is not None],float);ci=np.quantile(net[np.random.default_rng(42).integers(0,len(net),size=(5000,len(net)))].mean(1),[.025,.975]).tolist() if len(net) else None
 macro_strict=float(np.mean(strict)) if strict else None;debug_not_lost=bool(debug) and all(r['outcome'] in ('new','both') for r in debug)
 gates={'primary_nonabstaining_creators_min20':len(net)>=20,'creator_macro_strict_newwin_min065':macro_strict is not None and macro_strict>=.65,'creator_net_lower95_positive':ci is not None and ci[0]>0,'known_debug_not_lost':debug_not_lost}
 return {'metric_policy':METRIC_POLICY,'all_comparison_counts':counts,'primary_comparison_counts':{k:sum(o==k for values in groups.values() for o in values) for k in ('new','old','both','neither')},'primary_creator_count':len(groups),'primary_nonabstaining_creator_count':len(net),'primary_strict_creator_count':len(strict),'primary_creator_macro_net':float(net.mean()) if len(net) else None,'primary_creator_macro_strict_win':macro_strict,'creator_cluster_net_ci95':ci,'known_debug_outcomes':[r['outcome'] for r in debug],'predeclared_evidence_gates':gates,'release_signal_passed':all(gates.values()),'automatic_model_promotion':False,'50_independent_sample_claim':False}

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['freeze-pool','controls','candidates']);p.add_argument('--out',type=Path,default=OUT);p.add_argument('--inventory',type=Path);p.add_argument('--inventory-sha256');p.add_argument('--face-root',type=Path);p.add_argument('--face-request-sha256');a=p.parse_args()
 result=freeze_inventory(a.inventory,a.inventory_sha256,a.out) if a.mode=='freeze-pool' else controls(a.out) if a.mode=='controls' else candidates(a.face_root,a.face_request_sha256,a.out);print(json.dumps(result))
