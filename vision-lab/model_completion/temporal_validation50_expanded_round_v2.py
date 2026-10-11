"""Isolated expanded 50-round consumers; no preparation/insert happens on import."""
from __future__ import annotations
import argparse,copy,hashlib,importlib,json,time
from pathlib import Path
import temporal_validation50_expanded_pipeline_v2 as pipeline
import temporal_validation50_round_v2 as base_round
import temporal_validation50_expansion_v2 as expansion
v1=pipeline.v1;base=pipeline.base;safe=pipeline.safe;temporal=pipeline.temporal;versions=pipeline.versions
OUT=pipeline.OUT;BATCH=pipeline.BATCH;COUNT=50;FIELDS=versions.FIELDS
BASE_FACE_SHA=base_round.FACE_EXTRACTOR_SHA
EXTENSION_FACE_MODULE='temporal_face_requests_extension'
EXTENSION_FACE_SHA='294906946dfe8dc0071e3abdb9f0508ef07bfd6ff71b92df17dacdcc8f86e6a6'


def extension_api(expected_sha):
 module=importlib.import_module(EXTENSION_FACE_MODULE)
 if expected_sha!=EXTENSION_FACE_SHA or base.digest(Path(module.__file__))!=expected_sha:raise ValueError('Explicit independently reviewed frozen local extension face API required')
 return module


def candidates(base_face_root,extra_face_root,extra_face_source_sha,out=OUT):
 started=time.monotonic();deadline=started+300;pool,reserved,receipt=pipeline.load_extra(out);root=Path(pool['base_root']);bp=json.loads((root/'controls_and_face_request.json').read_text());epath=Path(out)/'extra_controls_and_face_request.json';extra=json.loads(epath.read_text());extra_sha=base.digest(epath)
 if extra['policy']!=pipeline.POLICY or extra['extra_pool_sha256']!=base.digest(Path(out)/'extra_pool_before_scoring.json') or extra['base_request_sha256']!=pipeline.BASE_REQUEST_SHA:raise ValueError('Exact frozen extension/control request required')
 eapi=extension_api(extra_face_source_sha);probe=temporal.aux.state.load_probe();eligible=[];agreements=[];total=0;provenance={}
 if base.digest(Path(base_round.face_api.__file__))!=BASE_FACE_SHA:raise ValueError('Pinned base detector API changed')
 for kind,request,request_sha,face_root,api in [('base',bp,pipeline.BASE_REQUEST_SHA,Path(base_face_root),base_round.face_api),('extra',extra,extra_sha,Path(extra_face_root),eapi)]:
  agreements.extend({'source_identity':v1.source_key(r['source']),'reason':r['status'],'current_acceptability':'saved_keep_not_changed'} for r in request['records'] if 'source_key' not in r)
  for key,source in sorted(request['sources'].items()):
   v1.check(deadline);face_path=face_root/f'{key}.json'
   if not face_path.is_file():agreements.extend({'source_identity':v1.source_key(r['source']),'reason':'missing_face_checkpoint_UNKNOWN','stratum':kind} for r in request['records'] if r.get('source_key')==key);continue
   points,proof=api.load_numeric_source(face_root,key,request_sha,source['identity']);provenance[kind+':'+key]=proof
   if [f['index'] for f in points]!=source['planned_indices']:raise ValueError('Every exact planned point required')
   frame=source['frame_checkpoint'];path=Path(frame['path'])
   if path.stat().st_dev!=v1.ROOT.stat().st_dev or path.stat().st_size>64*1024**2:raise ValueError('Exact bounded SSD numeric generation required')
   total+=path.stat().st_size
   if total>pipeline.POLICY['max_numeric_read_bytes']:raise ValueError('Combined matched numeric read budget exceeded')
   raw=path.read_bytes()
   if hashlib.sha256(raw).hexdigest()!=frame['sha256']:raise ValueError('Exact generation checksum differs')
   t,v=temporal.decode_numeric_checkpoint(raw,source);context=temporal.aux.state.classify_original_context(probe,t,v,identity=source['identity'],expected_identity=source['identity']);del raw,v
   for row in request['records']:
    if row.get('source_key')!=key:continue
    diagnostic=temporal.propose(t,context.probabilities,points,row['original_range'],row['control_range'])
    if diagnostic['candidate_range'] is None:agreements.append({'source_identity':v1.source_key(row['source']),'reason':diagnostic['status'],'coverage':diagnostic['coverage_original'],'stratum':kind});continue
    record=dict(row,diagnostic=diagnostic,face_checkpoint_sha256=proof['checkpoint_sha256'],face_provenance_key=kind+':'+key)
    record['known_debug']=row['source']['video_id']==temporal.KNOWN_VIDEO
    record['comparator_stratum']=record.get('comparator_stratum','base_manual_reference_oldC');eligible.append(record)
 history=v1.load_pool(root)['historical_version_pairs'];result=pipeline.combine_candidates([r for r in eligible if r['comparator_stratum']=='base_manual_reference_oldC'],[r for r in eligible if r['comparator_stratum']!='base_manual_reference_oldC'],agreements,[],history)
 result.update(base_face_root=str(Path(base_face_root).resolve()),extra_face_root=str(Path(extra_face_root).resolve()),extra_face_source_sha256=extra_face_source_sha,base_face_source_sha256=BASE_FACE_SHA,base_root=str(root.resolve()),base_request_sha256=pipeline.BASE_REQUEST_SHA,extra_request_sha256=extra_sha,extra_pool_sha256=base.digest(Path(out)/'extra_pool_before_scoring.json'),face_provenance=provenance,total_original_proposals=67+len(pool['extensions']),numeric_read_bytes=total,seconds=time.monotonic()-started,source_sha256=base.digest(Path(__file__)),generator_source_sha256=base.digest(Path(pipeline.__file__)),excluded_holdout_creators=sorted(reserved),holdout_dependency=receipt,historical_version_pairs=history)
 v1.check(deadline);temporal.frozen(Path(out)/'expanded_candidate_selection.json',result)
 return {'status':result['status'],'selected':len(result['selected']),'creators':result['selected_creators'],'raw_distinct_eligible':result['raw_distinct_eligible'],'comparator_counts':result['comparator_counts'],'agreements':len(agreements),'selection_sha256':base.digest(Path(out)/'expanded_candidate_selection.json'),'queue_writes':0}


def consumer_pins():
 return {str(Path(__file__).with_name(p).resolve()):base.digest(Path(__file__).with_name(p)) for p in ('temporal_validation50_expanded_apply_v2.py','temporal_validation50_expanded_intake_v2.py')}


def make_manifest(selection,reserved,receipt):
 if selection['policy']!=pipeline.POLICY or selection['metric_policy']!=v1.METRIC_POLICY or selection['status']!='ready50_distinct_for_review' or len(selection['selected'])!=50 or selection['excluded_holdout_creators']!=sorted(reserved) or selection['holdout_dependency']!=receipt:raise ValueError('Exactly50 reviewed mixed-stratum candidates and creator guard required')
 adapt=copy.deepcopy(selection);adapt.update(policy=v1.POLICY,eligible_distinct=selection['raw_distinct_eligible'],all_inventory_sources=selection['total_original_proposals'])
 if sum(r['known_debug'] for r in selection['selected'])!=1:raise ValueError('Exactly one original known debugging comparison required')
 value=v1.make_manifest(adapt,reserved,receipt);value.update(policy=pipeline.POLICY,consumer_source_sha256=base.digest(Path(__file__)),consumer_sources=consumer_pins(),selection_summary={'selected_creators':selection['selected_creators'],'raw_distinct_eligible':selection['raw_distinct_eligible'],'comparator_counts':selection['comparator_counts'],'agreement_or_unavailable':selection['agreement_or_unavailable'],'suppressed':selection['suppressed']},base_root=selection['base_root'],base_request_sha256=selection['base_request_sha256'],extra_request_sha256=selection['extra_request_sha256'],extra_pool_sha256=selection['extra_pool_sha256'],base_face_root=selection['base_face_root'],extra_face_root=selection['extra_face_root'],base_face_source_sha256=selection['base_face_source_sha256'],extra_face_source_sha256=selection['extra_face_source_sha256'],face_provenance=selection['face_provenance'])
 selected={v1.source_key(r['source']):r for r in selection['selected']}
 for p in value['private_assignments']:
  r=selected[v1.source_key(p['source'])];p['original_proposal_id']=r['original_proposal_id'];p['comparator_stratum']=r['comparator_stratum'];p['face_provenance_key']=r['face_provenance_key']
  if 'parent_source' in r:p['parent_source']=r['parent_source'];p['original_proposal_id']=r['original_proposal_id'];p['original_detector_receipt']=r['original_detector_receipt']
 return value


def verify_selected(value,root):
 """Reconstruct exact controls, source identity and temporal proposal, no images."""
 base_request=json.loads((Path(value['base_root'])/'controls_and_face_request.json').read_text());extra_request=json.loads((Path(root)/'extra_controls_and_face_request.json').read_text());eapi=extension_api(value['extra_face_source_sha256']);probe=temporal.aux.state.load_probe();total=0;deadline=time.monotonic()+300
 for kind,request,api in [('base',base_request,base_round.face_api),('extra',extra_request,eapi)]:
  request_sha=value[kind+'_request_sha256'];face_root=value[kind+'_face_root'];records={v1.source_key(r['source']):r for r in request['records'] if 'source_key' in r};private=[p for p in value['private_assignments'] if p['face_provenance_key'].startswith(kind+':')]
  for key in sorted({p['source_key'] for p in private}):
   v1.check(deadline);source=request['sources'][key];proof=value['face_provenance'][kind+':'+key];points,actual=api.load_numeric_source(face_root,key,request_sha,source['identity'])
   if actual!=proof or [f['index'] for f in points]!=source['planned_indices']:raise ValueError('Exact extraction request/page/point/source proof differs')
   frame=source['frame_checkpoint'];path=Path(frame['path']);total+=path.stat().st_size
   if path.stat().st_dev!=v1.ROOT.stat().st_dev or path.stat().st_size>64*1024**2 or total>pipeline.POLICY['max_numeric_read_bytes']:raise ValueError('Bounded combined numeric verification required')
   payload=path.read_bytes()
   if hashlib.sha256(payload).hexdigest()!=frame['sha256']:raise ValueError('Exact reused matrix bytes differ')
   t,v=temporal.decode_numeric_checkpoint(payload,source);context=temporal.aux.state.classify_original_context(probe,t,v,identity=source['identity'],expected_identity=source['identity']);del v,payload
   for p in private:
    if p['source_key']!=key:continue
    r=records.get(v1.source_key(p['source']))
    if r is None or p['numeric_identity']!=r['numeric_identity'] or p['frame_checkpoint']!=r['frame_checkpoint'] or p['source']!=r['source'] or p['original_proposal_id']!=r['original_proposal_id'] or p['known_debug'] is not (p['source']['video_id']==temporal.KNOWN_VIDEO) or p['face_checkpoint_sha256']!=proof['checkpoint_sha256']:raise ValueError('Every selected proposal must bind immutable source/control identity')
    if 'parent_source' in r and (p.get('parent_source')!=r['parent_source'] or p.get('original_detector_receipt')!=r['original_detector_receipt']):raise ValueError('Derived proposal must preserve exact parent/detector receipt')
    computed=temporal.propose(t,context.probabilities,points,r['original_range'],r['control_range'])
    if computed['candidate_range'] is None or computed!=p['diagnostic']:raise ValueError('Exact unchanged temporal proposal reconstruction differs')
 v1.check(deadline)


def load_contract(root,expected):
 root=Path(root);path=root/'private_manifest.json'
 if path.stat().st_size>32*1024**2 or base.digest(path)!=expected:raise ValueError('Reviewed immutable expanded manifest SHA required')
 value=json.loads(path.read_text());selection_path=root/'expanded_candidate_selection.json'
 if selection_path.stat().st_size>32*1024**2 or base.digest(selection_path)!=value['selection_sha256']:raise ValueError('Exact pre-answer selected candidate receipt required')
 selection=json.loads(selection_path.read_text());pool,reserved,receipt=pipeline.load_extra(root)
 if selection['source_sha256']!=base.digest(Path(__file__)) or selection['generator_source_sha256']!=base.digest(Path(pipeline.__file__)) or selection['extra_pool_sha256']!=base.digest(root/'extra_pool_before_scoring.json') or selection['extra_request_sha256']!=base.digest(root/'extra_controls_and_face_request.json'):raise ValueError('Expanded source/control/selection drift')
 rebuilt=make_manifest(selection,reserved,receipt);rebuilt['selection_sha256']=value['selection_sha256']
 if value!=rebuilt:raise ValueError('Expanded manifest/source/consumer reconstruction differs')
 # Verify complete detection receipts again without touching images or raw media.
 eapi=extension_api(value['extra_face_source_sha256'])
 for kind in ('base','extra'):
  request_sha=value[kind+'_request_sha256'];face_root=value[kind+'_face_root'];api=base_round.face_api if kind=='base' else eapi
  for key in sorted({p['source_key'] for p in value['private_assignments'] if p['face_provenance_key'].startswith(kind+':')}):
   expected_proof=value['face_provenance'][kind+':'+key];_,proof=api.load_numeric_source(face_root,key,request_sha,expected_proof['source']['identity'])
   if proof!=expected_proof:raise ValueError('Exact completed face receipt/source/page/checkpoint drift')
 verify_selected(value,root)
 return value,reserved,receipt


def validate_live(value,live,history,reserved,receipt):
 if value['excluded_holdout_creators']!=sorted(reserved) or value['holdout_dependency']!=receipt:raise ValueError('Reserved/source creator contract drift')
 parent_ids=set()
 for p in value['private_assignments']:
  parent=p.get('parent_source',p['source']);parent_ids.add(parent['feedback_id'])
  if parent['feedback_id'] not in live or safe.previous.side(live[parent['feedback_id']],[])!=parent:raise ValueError('Exact live parent source/generation/index drift')
  if 'parent_source' in p:
   identity=p['numeric_identity'];proposal=[z for z in identity['proposals'] if z['id']==p['original_proposal_id']];s=p['source'];r=p['original_detector_receipt']
   if len(proposal)!=1 or s['clip']!=[proposal[0]['start'],proposal[0]['end']] or r['bounds']!=s['clip'] or r['clip_id']!=p['original_proposal_id'] or r['feedback_id']!=s['feedback_id'] or r['analyzed_at']!=s['analyzed_at'] or s['score']!=proposal[0]['score']:raise ValueError('Exact additional original detector receipt differs')
   if any(s[k]!=parent[k] for k in ('video_id','analyzed_at','source_fingerprint','index','duration_seconds','channel_key')):raise ValueError('Derived side must preserve complete parent generation')
 if set(live)!=parent_ids:raise ValueError('Exactly reviewed parent metadata set required')
 used=versions.history_pairs([t for t in history if t['batch']!=BATCH]);seen=set()
 for row in value['rows']:
  pair=tuple(sorted(versions.version_key(row['context'][side]) for side in ('a','b')))
  if pair in used or pair in seen:raise ValueError('Historical or combined exact pair duplicate')
  seen.add(pair)


def history_metadata(pg):return base_round.history_metadata(pg)

def prepare(root,selection_sha):
 root=Path(root);path=root/'expanded_candidate_selection.json'
 if path.stat().st_size>32*1024**2 or base.digest(path)!=selection_sha:raise ValueError('Exact reviewed50 combined candidate selection required')
 selection=json.loads(path.read_text());_,reserved,receipt=pipeline.load_extra(root);value=make_manifest(selection,reserved,receipt);value['selection_sha256']=selection_sha
 import psycopg
 with psycopg.connect(base.pg_config()) as pg:
  pg.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');pg.execute("SET statement_timeout='20s'");ids=sorted({p.get('parent_source',p['source'])['feedback_id'] for p in value['private_assignments']});live=safe.previous.load_rows(pg,ids);validate_live(value,live,history_metadata(pg),reserved,receipt)
 verify_selected(value,root);temporal.frozen(root/'private_manifest.json',value);load_contract(root,base.digest(root/'private_manifest.json'))
 return {'status':'prepared_no_queue_writes','count':50,'creators':selection['selected_creators'],'comparator_counts':selection['comparator_counts'],'manifest_sha256':base.digest(root/'private_manifest.json'),'known_debug':sum(p['known_debug'] for p in value['private_assignments']),'fits':0,'media_reads':0}

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['candidates','prepare']);p.add_argument('--root',type=Path,default=OUT);p.add_argument('--base-face-root',type=Path);p.add_argument('--extra-face-root',type=Path);p.add_argument('--extra-face-source-sha256');p.add_argument('--selection-sha256');a=p.parse_args();print(json.dumps(candidates(a.base_face_root,a.extra_face_root,a.extra_face_source_sha256,a.root) if a.mode=='candidates' else prepare(a.root,a.selection_sha256)))
