"""Final pre-answer cap5 bridge over frozen controls/detections; no new models/media."""
from __future__ import annotations
import argparse,copy,hashlib,json,random,time
from pathlib import Path
import numpy as np
import temporal_validation50_expanded_round_v2 as previous
v1=previous.v1;base=previous.base;safe=previous.safe;temporal=previous.temporal;versions=previous.versions
OUT=v1.ROOT/'temporal-validation50-final-v1';BATCH=previous.BATCH;COUNT=50;FIELDS=previous.FIELDS
PARENT_SELECTION=previous.OUT/'expanded_candidate_selection.json'
PARENT_SELECTION_SHA='00458cdf3e16921aa5c3561f0a62b55c1adfba9b1d5c713e48bc680116bc323c'
POLICY=dict(previous.pipeline.POLICY,schema_version=4,max_comparisons_per_creator=5,selection='Final pre-answer bridge: reconstruct the same51 exact distinct candidates; deterministic creator roundrobin max5 reaches50 while retaining28creators. Exactlyone knownsource debug excludedprimary. No newmodel/scoring/face sampling; priorcap3/4 capacities46/48 insufficient. Equalcreator metric/bootstrap prevents repeatedcreators being treatedasindependent.',budget_seconds=300,parent_selection_sha256=PARENT_SELECTION_SHA)
METRIC_POLICY=dict(v1.METRIC_POLICY,unit='Whole creator, max5 displayed comparisons each (two creators have5). Fifty comparisons are not50 independent samples. Primary excludes one known debugging source.',timing='Frozen AFTER label-independent51candidate count but BEFORE any new50round answers; only creator exposurecap changed. All improvement gates/creatorweights unchanged.')


def parent_inputs():
 if PARENT_SELECTION.stat().st_size>32*1024**2 or base.digest(PARENT_SELECTION)!=PARENT_SELECTION_SHA:raise ValueError('Exact immutable51candidate parent receipt required')
 value=json.loads(PARENT_SELECTION.read_text());pool,reserved,receipt=previous.pipeline.load_extra(previous.OUT)
 if value['raw_distinct_eligible']!=51 or value['source_sha256']!=base.digest(Path(previous.__file__)) or value['generator_source_sha256']!=base.digest(Path(previous.pipeline.__file__)) or value['extra_pool_sha256']!=base.digest(previous.OUT/'extra_pool_before_scoring.json') or value['extra_request_sha256']!=base.digest(previous.OUT/'extra_controls_and_face_request.json'):raise ValueError('Parent proposal/control/source receipt drift')
 if value['excluded_holdout_creators']!=sorted(reserved) or value['holdout_dependency']!=receipt or value['policy']!=previous.pipeline.POLICY or value['metric_policy']!=v1.METRIC_POLICY:raise ValueError('Reserved/protocol parent differs')
 return value,reserved,receipt


def reconstruct_all(parent):
 """Read numeric receipts and existing fixed-probe predictions; never C rescoring."""
 started=time.monotonic();deadline=started+300;probe=temporal.aux.state.load_probe();total=0;records=[]
 requests={'base':json.loads((Path(parent['base_root'])/'controls_and_face_request.json').read_text()),'extra':json.loads((previous.OUT/'extra_controls_and_face_request.json').read_text())}
 if base.digest(Path(parent['base_root'])/'controls_and_face_request.json')!=parent['base_request_sha256'] or base.digest(previous.OUT/'extra_controls_and_face_request.json')!=parent['extra_request_sha256']:raise ValueError('Exact previously scored control requests required')
 eapi=previous.extension_api(parent['extra_face_source_sha256']);history={tuple(p) for p in parent['historical_version_pairs']};seen=set()
 for kind,api in [('base',previous.base_round.face_api),('extra',eapi)]:
  request=requests[kind]
  for key,source in sorted(request['sources'].items()):
   v1.check(deadline)
   if kind+':'+key not in parent['face_provenance']:continue
   points,proof=api.load_numeric_source(parent[kind+'_face_root'],key,parent[kind+'_request_sha256'],source['identity'])
   if proof!=parent['face_provenance'][kind+':'+key] or [f['index'] for f in points]!=source['planned_indices']:raise ValueError('Unchanged complete model/page/source/point receipts required')
   frame=source['frame_checkpoint'];path=Path(frame['path']);total+=path.stat().st_size
   if path.stat().st_dev!=v1.ROOT.stat().st_dev or path.stat().st_size>64*1024**2 or total>POLICY['max_numeric_read_bytes']:raise ValueError('Bounded numeric SSD reconstruction required')
   raw=path.read_bytes()
   if hashlib.sha256(raw).hexdigest()!=frame['sha256']:raise ValueError('Exact previous source matrix required')
   t,v=temporal.decode_numeric_checkpoint(raw,source);context=temporal.aux.state.classify_original_context(probe,t,v,identity=source['identity'],expected_identity=source['identity']);del v,raw
   for row in request['records']:
    if row.get('source_key')!=key:continue
    if kind=='extra' and row['source']['video_id']==temporal.KNOWN_VIDEO:continue
    diagnostic=temporal.propose(t,context.probabilities,points,row['original_range'],row['control_range'])
    if diagnostic['candidate_range'] is None:continue
    pair=tuple(sorted(versions.version_key(versions.public_side(row['source'],r,'Version')) for r in (row['control_range'],diagnostic['candidate_range'])))
    if pair in history or pair in seen:continue
    seen.add(pair);r=dict(row,diagnostic=diagnostic,face_checkpoint_sha256=proof['checkpoint_sha256'],face_provenance_key=kind+':'+key,comparator_stratum=row.get('comparator_stratum','base_manual_reference_oldC'),known_debug=row['source']['video_id']==temporal.KNOWN_VIDEO);records.append(r)
 if len(records)!=51:raise ValueError('The SAME51 distinct candidates must reconstruct; no expansions/substitutions')
 by_key={v1.source_key(r['source']):r for r in records}
 for prior in parent['selected']:
  if by_key.get(v1.source_key(prior['source']))!=prior:raise ValueError('Every previous46selected candidate must be unchanged')
 v1.check(deadline);return records,{'seconds':time.monotonic()-started,'numeric_read_bytes':total,'rescored_controls':0,'new_media_reads':0,'detector_calls':0,'fits':0}


def select_final(records):
 if len(records)!=51 or len({v1.source_key(r['source']) for r in records})!=51 or sum(r['known_debug'] for r in records)!=1:raise ValueError('Same51 unique originals and exactone debug required')
 selected=[];counts={};suppressed=[];ordered=sorted([r for r in records if r['known_debug']],key=lambda r:v1.source_key(r['source']))+v1.round_robin([r for r in records if not r['known_debug']])
 for r in ordered:
  group=r['source']['channel_key']
  if counts.get(group,0)>=5 or len(selected)>=50:suppressed.append({'source_identity':v1.source_key(r['source']),'reason':'pre_answer_creator_cap5_or_requested50'});continue
  selected.append(r);counts[group]=counts.get(group,0)+1
 if len(selected)!=50 or len(counts)!=28 or sorted(counts.values()).count(5)!=2:raise ValueError('Actualcap5 mustyield exactly50/28creators/two5exposures, otherwise stop')
 return selected,suppressed,counts


def consumers():
 return {str(Path(__file__).with_name(p).resolve()):base.digest(Path(__file__).with_name(p)) for p in ('temporal_validation50_final_apply.py','temporal_validation50_final_intake.py')}


def make_manifest(records,parent,reserved,receipt):
 selected,suppressed,counts=select_final(records);rng=random.Random(20261010);a_flags=[True]*25+[False]*25;rng.shuffle(a_flags);pairs=[]
 if any(r['source']['channel_key'] in reserved for r in selected):raise ValueError('Reserved creators cannot be compared')
 for r,challenger_a in zip(sorted(selected,key=lambda r:v1.source_key(r['source'])),a_flags):
  source=r['source'];candidate=r['diagnostic']['candidate_range'];control=r['control_range'];bounds=[candidate,control] if challenger_a else [control,candidate];roles=['new_temporal','old_C'] if challenger_a else ['old_C','new_temporal'];sides={k:versions.public_side(source,bounds[i],f'Version {k.upper()}') for i,k in enumerate(('a','b'))}
  context=dict(sides,channel=source['channel'],comparison_scope='same_channel',blind_version_comparison=True,target='preferred_version_if_keep_one',soft_preferred_minutes=[3,15],reserved_fine_holdout=False,fine_data_role='training',batch_policy=BATCH,preview_recipe='uniform10_50_90_centres15s',acceptability_target=None,cut_target=None)
  row={'kind':'version-versus','batch':BATCH,'video_id':source['video_id'],'start_seconds':sides['a']['range'][0],'end_seconds':sides['a']['range'][1],'channel':source['channel'],'stratum':'blind-version','context':context}
  p={k:r[k] for k in ('source','numeric_identity','frame_checkpoint','source_key','original_proposal_id','known_debug','face_checkpoint_sha256','face_provenance_key','diagnostic','comparator_stratum')};p['assignments']=dict(zip(('a','b'),roles))
  if 'parent_source' in r:p.update(parent_source=r['parent_source'],original_detector_receipt=r['original_detector_receipt'])
  pairs.append((row,p))
 rng.shuffle(pairs);rows=[];private=[]
 for position,(row,p) in enumerate(pairs):row['position']=position;rows.append(row);private.append(dict(p,position=position))
 value={k:parent[k] for k in ('base_root','base_request_sha256','extra_request_sha256','extra_pool_sha256','base_face_root','extra_face_root','base_face_source_sha256','extra_face_source_sha256','face_provenance')}
 value.update(schema_version=1,policy=POLICY,metric_policy=METRIC_POLICY,parent_selection_sha256=PARENT_SELECTION_SHA,selection_sha256=PARENT_SELECTION_SHA,source_sha256=base.digest(Path(__file__)),consumer_sources=consumers(),excluded_holdout_creators=sorted(reserved),holdout_dependency=receipt,rows=rows,private_assignments=private,head_sha256=v1.HEAD_SHA,selection_summary={'raw_distinct_eligible':51,'selected':50,'selected_creators':28,'primary_creators':27,'creator_exposure_histogram':{str(n):list(counts.values()).count(n) for n in sorted(set(counts.values()))},'comparator_counts':{s:sum(r['comparator_stratum']==s for r in selected) for s in ('base_manual_reference_oldC','generic_oldC_without_human_reference')},'agreement_or_unavailable':parent['agreement_or_unavailable'],'suppressed':suppressed},queue_writes=0,model_fits=0,media_reads=0,GPU=False,automatic_model_promotion=False)
 return value


def metrics(rows):
 groups={};debug=[]
 for r in rows:
  if r['outcome'] not in ('new','old','both','neither') or type(r['known_debug']) is not bool:raise ValueError('Pure paired preference required')
  if r['known_debug']:debug.append(r);continue
  groups.setdefault(r['creator'],[]).append(r['outcome'])
 if any(len(v)>5 for v in groups.values()) or len(debug)!=1:raise ValueError('Final creatorcap5/exactone debug required')
 per={};strict=[]
 for g,outcomes in sorted(groups.items()):
  n=outcomes.count('new');o=outcomes.count('old');tie=outcomes.count('both');abstain=outcomes.count('neither');per[g]={'new':n,'old':o,'tie':tie,'abstain':abstain,'net':(n-o)/(n+o+tie) if n+o+tie else None,'strict_win':n/(n+o) if n+o else None}
  if n+o:strict.append(n/(n+o))
 net=np.array([p['net'] for p in per.values() if p['net'] is not None],float);ci=np.quantile(net[np.random.default_rng(42).integers(0,len(net),size=(5000,len(net)))].mean(1),[.025,.975]).tolist() if len(net) else None;macro_strict=float(np.mean(strict)) if strict else None
 gates={'primary_nonabstaining_creators_min20':len(net)>=20,'creator_macro_strict_newwin_min065':macro_strict is not None and macro_strict>=.65,'creator_net_lower95_positive':ci is not None and ci[0]>0,'known_debug_not_lost':all(r['outcome'] in ('new','both') for r in debug)}
 return {'metric_policy':METRIC_POLICY,'all_comparison_counts':{k:sum(r['outcome']==k for r in rows) for k in ('new','old','both','neither')},'primary_comparison_counts':{k:sum(o==k for values in groups.values() for o in values) for k in ('new','old','both','neither')},'primary_creator_count':len(groups),'primary_nonabstaining_creator_count':len(net),'primary_strict_creator_count':len(strict),'primary_creator_macro_net':float(net.mean()) if len(net) else None,'primary_creator_macro_strict_win':macro_strict,'creator_cluster_net_ci95':ci,'known_debug_outcomes':[r['outcome'] for r in debug],'predeclared_evidence_gates':gates,'release_signal_passed':all(gates.values()),'automatic_model_promotion':False,'50_independent_sample_claim':False}


def load_contract(root,expected):
 path=Path(root)/'private_manifest.json'
 if path.stat().st_size>32*1024**2 or base.digest(path)!=expected:raise ValueError('Exact reviewedfinal50 manifest required')
 value=json.loads(path.read_text());parent,reserved,receipt=parent_inputs();records,_=reconstruct_all(parent)
 if value!=make_manifest(records,parent,reserved,receipt):raise ValueError('Final source/consumer/policy/input reconstruction differs')
 previous.verify_selected(value,previous.OUT)
 return value,reserved,receipt


def validate_live(value,live,history,reserved,receipt):return previous.validate_live(value,live,history,reserved,receipt)
def history_metadata(pg):return previous.history_metadata(pg)

def prepare(root=OUT):
 parent,reserved,receipt=parent_inputs();records,proof=reconstruct_all(parent);value=make_manifest(records,parent,reserved,receipt)
 import psycopg
 with psycopg.connect(base.pg_config()) as pg:
  pg.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');pg.execute("SET statement_timeout='20s'");ids=sorted({p.get('parent_source',p['source'])['feedback_id'] for p in value['private_assignments']});live=safe.previous.load_rows(pg,ids);validate_live(value,live,history_metadata(pg),reserved,receipt)
 previous.verify_selected(value,previous.OUT);temporal.frozen(Path(root)/'private_manifest.json',value);temporal.frozen(Path(root)/'numeric_reconstruction_receipt.json',proof)
 return {'status':'prepared_final50_no_queue_writes','count':50,'creators':28,'primary_creators':27,'max_per_creator':5,'creator_exposure_histogram':value['selection_summary']['creator_exposure_histogram'],'comparator_counts':value['selection_summary']['comparator_counts'],'manifest_sha256':base.digest(Path(root)/'private_manifest.json'),'numeric_reconstruction':proof}

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=OUT);a=p.parse_args();print(json.dumps(prepare(a.root)))
