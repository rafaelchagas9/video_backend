"""Unexecuted V2 expansion adapter: original detector proposals, no quality labels.

The v1 accepted/manual-reference comparator stays immutable. Extra proposals use
an explicitly separate reference-free old-C grid; missing features remain unknown.
No database, media, detector, fit or queue operation is performed by this module.
"""
from __future__ import annotations
import copy,math
import numpy as np
import temporal_validation50 as v1
base=v1.base
DRAFT_POLICY={'schema_version':2,'status':'DRAFT_NOT_AUTHORIZED_FOR_REAL_PREPARATION','selection':'All additional non-debug >=240s immutable original detector proposals within the existing reserved-screened inventory, ordered by exact source-generation/proposal identity. No fine outcome/face/action selection.','old_comparator':'Separate explicit generic-old-C stratum: fixed180/300/600/900/original lengths and same17starts; no approved-reference candidate, no silent v1 protocol substitution. Frozen old-C weights unchanged.','target':'preferred_version_if_keep_one only; no acceptance/quality/whole/permanent labels inferred','numeric':'Reuse full-generation frozen v1 numeric checkpoints and exact full-original proposal universe; no fresh media/indexing. Missing exact checkpoints reported unavailable, not zero.','sampling':'Same fixed72 uniform original plus24 uniform old control points; explicit merged request extension before new answers, no interpolated or face-driven points.','runtime':'Separate exact provenance for parent generation and derived original proposal; live parent context/source must match.','creator_balance':'Inherited max3 displayed comparisons percreator; known debug source excluded primary.','automatic_model_promotion':False,'fits':0,'DB_writes':0,'media_reads':0}


def proposal_key(parent,proposal):
 return v1.numeric.digest({'video_id':parent['video_id'],'analyzed_at':parent['analyzed_at'],'source_fingerprint':parent['source_fingerprint'],'index':parent['index'],'original_proposal':proposal})


def build_extensions(inventory,controls,reserved):
 """Pure draft. All parent rows are metadata-only; no saved fine outcomes read."""
 if controls.get('policy')!=v1.POLICY:raise ValueError('Exact frozen v1 control policy required')
 v1.validate_sources(inventory['sources'],reserved)
 if inventory['excluded_holdout_creators']!=sorted(reserved):raise ValueError('Reserved-screened pool required')
 if len(inventory['rows'])!=len(inventory['sources']):raise ValueError('Exact per-proposal inventory rows required')
 source_lookup={v1.source_key(s):s for s in inventory['sources']}
 consumed={(r['source']['video_id'],r['source']['analyzed_at'],r['original_proposal_id']) for r in inventory['rows']}
 cache={}
 for r in controls['records']:
  if 'source_key' not in r:continue
  source=r['source'];identity=r['numeric_identity'];key=(source['video_id'],source['analyzed_at'])
  if v1.source_key(source) not in source_lookup or source_lookup[v1.source_key(source)]!=source or r['source_key']!=v1.temporal.aux.state.identity_sha256(identity) or r['frame_checkpoint']['identity_sha256']!=r['source_key']:raise ValueError('Exact complete parent numeric source required')
  if any(identity[k]!=source[k] for k in ('video_id','analyzed_at','source_fingerprint','index')) or identity['duration']!=source['duration_seconds']:raise ValueError('Parent generation/source drift')
  if key in cache and (cache[key]['numeric_identity']!=identity or cache[key]['frame_checkpoint']!=r['frame_checkpoint']):raise ValueError('Same-generation checkpoint conflict')
  cache[key]=r
 extensions={};unavailable=[];seen_proposals=set()
 for row in sorted(inventory['rows'],key=lambda r:v1.source_key(r['source'])):
  parent=row['source'];marker=(parent['video_id'],parent['analyzed_at']);cp=cache.get(marker);proposals=row['proposals'];origin=row['proposal_origin']
  if source_lookup.get(v1.source_key(parent))!=parent or origin['analyzed_at']!=parent['analyzed_at'] or origin['kind']!='exact_generation_original_detector_receipts':raise ValueError('Exact detector metadata provenance required')
  if len({p['id'] for p in proposals})!=len(proposals):raise ValueError('Original detector universe has duplicate IDs')
  if cp is not None and cp['numeric_identity']['proposals']!=proposals:raise ValueError('Frozen full numeric proposal universe differs')
  for p in proposals:
   if not isinstance(p['id'],str) or p['id'].startswith('added-') or not all(v1.temporal.aux.state.finite_number(p[k]) for k in ('start','end','score')) or not 0<=p['start']<p['end']<=parent['duration_seconds']:raise ValueError('Only immutable finite original proposals supported')
   key=proposal_key(parent,p)
   if (parent['video_id'],parent['analyzed_at'],p['id']) in consumed or p['end']-p['start']<240 or key in seen_proposals:continue
   seen_proposals.add(key)
   if parent['video_id']==v1.temporal.KNOWN_VIDEO:
    unavailable.append({'proposal_identity':key,'reason':'known_posthoc_source_extra_excluded_keep_one_debug'});continue
   receipt=[r for r in origin['receipts'] if r['clip_id']==p['id'] and r['analyzed_at']==parent['analyzed_at'] and r['bounds']==[p['start'],p['end']] and r['score']==p['score']]
   if not receipt or len({r['feedback_id'] for r in receipt})!=1:raise ValueError('Each derived original must have exact unique detector feedback receipt')
   if cp is None:
    unavailable.append({'proposal_identity':key,'reason':'missing_existing_complete_generation_checkpoint_unknown'});continue
   source=copy.deepcopy(parent);source.update(clip=[p['start'],p['end']],best=[p['start'],p['end']],score=p['score'],feedback_id=receipt[0]['feedback_id'],initial_best_source='generic_original_reference_NO_HUMAN_GOLD',snippet=v1.versions.previews([p['start'],p['end']])[0])
   extensions[key]={'proposal_identity':key,'parent_source':cp['source'],'derived_source':source,'numeric_identity':cp['numeric_identity'],'frame_checkpoint':cp['frame_checkpoint'],'source_key':cp['source_key'],'original_proposal_id':p['id'],'original_detector_receipt':copy.deepcopy(receipt[0]),'original_range':[p['start'],p['end']],'comparator_stratum':'generic_oldC_without_human_reference','current_acceptability':'UNKNOWN_NOT_INFERRED','quality_y':None,'whole_y':None,'cut_gold':None,'known_debug':parent['video_id']==v1.temporal.KNOWN_VIDEO}
 return {'policy':DRAFT_POLICY,'extensions':[extensions[k] for k in sorted(extensions)],'unavailable':unavailable,'reserved_creators_excluded':sorted(reserved),'creators':len({r['derived_source']['channel_key'] for r in extensions.values()}),'actual_preparation':False,'new_labels_created':False}


def validate_live_parent(extension,live,public_parent):
 """Live wrapper must call connected.side(live,[]) for the frozen PARENT only."""
 parent=extension['parent_source'];identity=extension['numeric_identity'];proposal_id=extension['original_proposal_id'];source=extension['derived_source']
 if any(source[k]!=parent[k] for k in ('video_id','analyzed_at','source_fingerprint','index','duration_seconds','detector')):raise ValueError('Derived source must preserve complete parent generation/source identity')
 if public_parent!=parent or live['video_id']!=parent['video_id'] or source['channel_key']!=parent['channel_key'] or source['channel_key']!=base.canon(source['channel']):raise ValueError('Exact live parent/source creator required')
 proposals=[p for p in identity['proposals'] if p['id']==proposal_id]
 if len(proposals)!=1 or source['clip']!=[proposals[0]['start'],proposals[0]['end']] or source['score']!=proposals[0]['score'] or extension['original_range']!=source['clip'] or source['best']!=source['clip']:raise ValueError('Derived immutable original-proposal context differs')
 # Only model input metadata changes clip_id; no actual feedback row is rewritten.
 scoring_live=copy.deepcopy(live);scoring_live['clip_id']=proposal_id
 return scoring_live


def generic_control(heads,scoring_live,source,t,v,identity,path):
 """Root-authorized later only; pure numeric scorer, no I/O, fit or media."""
 ranges=v1.generic_grid(source['clip']);scores=[v1.old.scores(heads,scoring_live,source,(t,v,identity['proposals'],identity,path),r) for r in ranges];control=ranges[v1.old.best(ranges,scores)]
 points=sorted(set(v1.uniform_indices(t,source['clip'],72))|set(v1.uniform_indices(t,control,24)))
 return {'generic_control_range':control,'generic_candidate_grid':ranges,'generic_candidate_scores':scores,'planned_face_indices':points,'planned_face_timestamps':t[points].tolist(),'comparator_stratum':'generic_oldC_without_human_reference','reference_free':True}
