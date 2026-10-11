"""Source-only expanded validation adapter; root alone runs each reviewed phase.

Current v1 manual-reference controls are preserved. Additional original proposals
form a separately declared generic old-C stratum. No acceptance labels are inferred.
"""
from __future__ import annotations
import argparse,copy,hashlib,json,time
from pathlib import Path
import temporal_validation50 as v1
import temporal_validation50_expansion_v2 as expansion
base=v1.base;safe=v1.safe;temporal=v1.temporal;versions=v1.versions
OUT=v1.ROOT/'temporal-validation50-expanded-v2';BATCH=v1.BATCH;COUNT=50;FIELDS=versions.FIELDS
INVENTORY_SHA='8fc5004056772ae4ece889b8a0bc8b2bf66101af177a94741730a1151e58bb92'
BASE_REQUEST_SHA='621b2c622f0dd0fc4e7f47c3c460940afd4a032463d8e66ac80d596ed7df482f'
BASE_POOL_SHA='147c7b917721ba93e10a6da82fcbbf78479fb566fe61e59241bc6803b730e1fe'
POLICY={'schema_version':3,'batch':BATCH,'count':50,'selection':'Freeze ALL eligible extra original proposals within the same exact generation source pool before generic old-C scoring; base manual-reference64 controls stay untouched. Combined exact distinct candidates round-robin acrosscreators max3, knownsource metadata-first; agreements neverforced.','extra_comparator':'GENERIC old-C fixed180/300/600/900/original, same17starts and frozenC weights. Explicit separate stratum from base approved-reference grid. No human-approved range or label for extras.','extra_sampling':'Unchanged72uniform original +24uniform generic-old control indices; explicit extra-only face extension request, exact priorpoint reuse independentlyvalidated bymodel/source/page/timestamp.','primary':'Knownvideo6209 ALL proposals debug only; no all-pipeline unseencreator claim because frozenStage1 coarseaux was global.','target':'preferred_version_if_keep_one','semantics':'No quality/currentacceptability/cut/whole/expiry labels inferred; neither abstention; both no strict preference.','metric_policy':'EXACT inherited pre-answer creator-cluster net/strictwin/CI gates; no50independentclaim.','numeric_seconds':300,'max_extra_proposals':32,'max_extra_sources':32,'max_numeric_read_bytes':1024*1024**2,'fits':0,'media_reads':0,'GPU':False,'queue_writes':0,'automatic_model_promotion':False}


def pins():
 return [{'path':str(Path(p).resolve()),'sha256':base.digest(Path(p))} for p in (v1.__file__,expansion.__file__,temporal.__file__,versions.__file__,v1.old.__file__,Path(__file__),Path(__file__).with_name('temporal_validation50_expanded_round_v2.py'),Path(__file__).with_name('temporal_validation50_expanded_apply_v2.py'),Path(__file__).with_name('temporal_validation50_expanded_intake_v2.py'),Path(__file__).with_name('temporal_validation50_expanded_v2_test.py'),Path(__file__).with_name('temporal_validation50_expansion_v2_test.py'),Path(__file__).with_name('temporal_face_requests_extension.py'),Path(__file__).with_name('temporal_face_requests_extension_test.py'))]


def freeze_extra(inventory_path,base_root=v1.OUT,out=OUT):
 inventory_path=Path(inventory_path);base_root=Path(base_root)
 if inventory_path.stat().st_size>8*1024**2 or base.digest(inventory_path)!=INVENTORY_SHA or base.digest(base_root/'frozen_pool.json')!=BASE_POOL_SHA or base.digest(base_root/'controls_and_face_request.json')!=BASE_REQUEST_SHA:raise ValueError('Exact pre-answer base pool/control/inventory required')
 pool=v1.load_pool(base_root);controls=json.loads((base_root/'controls_and_face_request.json').read_text());inventory=json.loads(inventory_path.read_text());reserved,receipt=safe.previous.holdout_contract()
 result=expansion.build_extensions(inventory,controls,reserved)
 if not 1<=len(result['extensions'])<=32:raise ValueError('Bounded genuinely additional immutable originals required')
 value={'schema_version':1,'policy':POLICY,'metric_policy':v1.METRIC_POLICY,'source_pins':pins(),'base_root':str(base_root.resolve()),'inventory_path':str(inventory_path.resolve()),'inventory_sha256':INVENTORY_SHA,'base_pool_sha256':BASE_POOL_SHA,'base_request_sha256':BASE_REQUEST_SHA,'head_sha256':v1.HEAD_SHA,'excluded_holdout_creators':sorted(reserved),'holdout_dependency':receipt,'extensions':result['extensions'],'unavailable':result['unavailable'],'new_labels_created':False,'actual_control_scoring':False}
 temporal.frozen(Path(out)/'extra_pool_before_scoring.json',value)
 return {'status':'extra_original_pool_frozen_before_scoring','extra_proposals':len(result['extensions']),'creators':result['creators'],'unavailable':len(result['unavailable']),'pool_sha256':base.digest(Path(out)/'extra_pool_before_scoring.json'),'queue_writes':0}


def load_extra(out):
 value=json.loads((Path(out)/'extra_pool_before_scoring.json').read_text());reserved,receipt=safe.previous.holdout_contract()
 if value['policy']!=POLICY or value['metric_policy']!=v1.METRIC_POLICY or value['head_sha256']!=v1.HEAD_SHA or base.digest(v1.HEAD)!=v1.HEAD_SHA or value['excluded_holdout_creators']!=sorted(reserved) or value['holdout_dependency']!=receipt:raise ValueError('Frozen expansion/head/creator policy drift')
 for p in value['source_pins']:
  if base.digest(Path(p['path']))!=p['sha256']:raise ValueError('Frozen expansion helper changed')
 root=Path(value['base_root']);inventory_path=Path(value['inventory_path'])
 if base.digest(root/'frozen_pool.json')!=BASE_POOL_SHA or base.digest(root/'controls_and_face_request.json')!=BASE_REQUEST_SHA or base.digest(inventory_path)!=INVENTORY_SHA:raise ValueError('Exact preserved base inputs changed')
 rebuilt=expansion.build_extensions(json.loads(inventory_path.read_text()),json.loads((root/'controls_and_face_request.json').read_text()),reserved)
 if rebuilt['extensions']!=value['extensions'] or rebuilt['unavailable']!=value['unavailable']:raise ValueError('Exact derived proposal inventory reconstruction differs')
 return value,reserved,receipt


def extra_controls(out=OUT):
 started=time.monotonic();deadline=started+300;pool,reserved,receipt=load_extra(out);heads=json.loads(v1.HEAD.read_text())['heads'];groups={};records=[];requests={};total=0;base_request=json.loads((Path(pool['base_root'])/'controls_and_face_request.json').read_text())
 for row in pool['extensions']:groups.setdefault(row['source_key'],[]).append(row)
 import psycopg
 with psycopg.connect(base.pg_config()) as pg:
  pg.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');pg.execute("SET statement_timeout='20s'");ids=sorted({r['parent_source']['feedback_id'] for r in pool['extensions']});live=safe.previous.load_rows(pg,ids)
  if set(live)!=set(ids):raise ValueError('Every exact parent source required')
  for key,rows in sorted(groups.items()):
   v1.check(deadline);frame=rows[0]['frame_checkpoint'];path=Path(frame['path'])
   if path.stat().st_dev!=v1.ROOT.stat().st_dev or path.stat().st_size>64*1024**2:raise ValueError('Exact bounded SSD generation required')
   total+=path.stat().st_size
   if total>1024*1024**2:raise ValueError('Extra numeric read budget exceeded')
   payload=path.read_bytes()
   if hashlib.sha256(payload).hexdigest()!=frame['sha256']:raise ValueError('Exact reused generation bytes differ')
   parent_request=base_request['sources'][key];t,v=temporal.decode_numeric_checkpoint(payload,parent_request);del payload
   request={'identity':rows[0]['numeric_identity'],'group':rows[0]['derived_source']['channel_key'],'frame_checkpoint':frame,'feedback_ids':[],'rows':[],'planned_indices':[],'full_timestamps':t.tolist()}
   for extra in sorted(rows,key=lambda r:r['proposal_identity']):
    v1.check(deadline);parent=extra['parent_source'];raw=live[parent['feedback_id']];scoring=expansion.validate_live_parent(extra,raw,safe.previous.side(raw,[]));result=expansion.generic_control(heads,scoring,extra['derived_source'],t,v,extra['numeric_identity'],str(path))
    record=dict(extra,source=extra['derived_source'],control_range=result['generic_control_range'],generic_control_matches=True,old_candidate_grid=result['generic_candidate_grid'],old_candidate_scores=result['generic_candidate_scores'],planned_face_indices=result['planned_face_indices'],planned_face_timestamps=result['planned_face_timestamps']);records.append(record)
    request['feedback_ids'].append(extra['derived_source']['feedback_id']);request['rows'].append({'feedback_id':extra['derived_source']['feedback_id'],'original_range':extra['original_range'],'control_range':record['control_range'],'point_indices':result['planned_face_indices']});request['planned_indices']=sorted(set(request['planned_indices'])|set(result['planned_face_indices']))
    temporal.frozen(Path(out)/'extra_controls'/f"{extra['proposal_identity']}.json",record)
   requests[key]=request;del v
 value={'schema_version':1,'policy':POLICY,'metric_policy':v1.METRIC_POLICY,'extra_pool_sha256':base.digest(Path(out)/'extra_pool_before_scoring.json'),'base_request_sha256':BASE_REQUEST_SHA,'head_sha256':v1.HEAD_SHA,'records':records,'sources':requests,'requested_face_points':sum(len(r['planned_indices']) for r in requests.values()),'numeric_read_bytes':total,'seconds':time.monotonic()-started,'labels_used_for_scoring':False,'fits':0,'queue_writes':0}
 v1.check(deadline);temporal.frozen(Path(out)/'extra_controls_and_face_request.json',value)
 return {'status':'extra_generic_controls_frozen','proposals':len(records),'sources':len(requests),'points':value['requested_face_points'],'request_sha256':base.digest(Path(out)/'extra_controls_and_face_request.json'),'queue_writes':0}


def combine_candidates(base_selected,extra_selected,base_agreements,extra_agreements,base_history):
 """Pure creator-balanced selection; agreements/unavailable always disclosed."""
 eligible=[];duplicates=[];seen=set();history={tuple(p) for p in base_history}
 for row in base_selected+extra_selected:
  if row in extra_selected and row['source']['video_id']==temporal.KNOWN_VIDEO:
   duplicates.append({'source_identity':v1.source_key(row['source']),'reason':'extra_posthoc_known_source_excluded_keep_one_debug'});continue
  source=row['source'];pair=tuple(sorted(versions.version_key(versions.public_side(source,r,'Version')) for r in (row['control_range'],row['diagnostic']['candidate_range'])))
  if pair in history or pair in seen:duplicates.append({'source_identity':v1.source_key(source),'reason':'historical_or_expansion_exact_pair_duplicate'});continue
  seen.add(pair);record=copy.deepcopy(row);record['comparator_stratum']=row.get('comparator_stratum','base_manual_reference_oldC');eligible.append(record)
 selected,suppressed=v1.select_pairs(eligible,50)
 return {'schema_version':1,'policy':POLICY,'metric_policy':v1.METRIC_POLICY,'selected':selected,'raw_distinct_eligible':len(eligible),'selected_creators':len({r['source']['channel_key'] for r in selected}),'agreement_or_unavailable':base_agreements+extra_agreements,'suppressed':duplicates+suppressed,'status':'ready50_distinct_for_review' if len(selected)==50 else 'insufficient_distinct_pairs_no_forcing','comparator_counts':{s:sum(r['comparator_stratum']==s for r in selected) for s in ('base_manual_reference_oldC','generic_oldC_without_human_reference')},'queue_writes':0,'fits':0}

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['freeze-extra','controls']);p.add_argument('--out',type=Path,default=OUT);p.add_argument('--base-root',type=Path,default=v1.OUT);p.add_argument('--inventory',type=Path);a=p.parse_args();print(json.dumps(freeze_extra(a.inventory,a.base_root,a.out) if a.mode=='freeze-extra' else extra_controls(a.out)))
