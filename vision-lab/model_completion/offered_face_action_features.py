"""Exploratory fixed face x state/action-proxy features, numeric caches only.

The globally fixed Stage1 probe includes personalized historical state and coarse
wrong-negative supervision. Older fine creator/source overlap is known: this is
NOT an all-pipeline unseen-creator representation. No exact action, absence,
acceptability, cut-gold or storage-worth labels are created.
"""
from __future__ import annotations
import argparse,io,json,math,signal,time,zipfile
from pathlib import Path
import numpy as np
import offered_state_features as state
import paired_face_preference as paired

COHORT_SHA='6a5aa01427e6832ac25243ec2ee4c0c9111d18a9c1bf15fcdd0a23bf5cdaade3'
FACE_REPORT_SHA='c4d9e659fdc0448f1c6ae42677b70019ee7a3680211881a3e756207776446093'
FACE_RECEIPT_SHA='0ab64171fc29d41d5b89c0e1bb1c354961a1574675be2cae0feff1b37b4d92d4'
STATE_SOURCE_SHA='6149a335f769e5baab0ef5c358f36b0596f34769c1cda2a6ca792bdff71b7475'
FACE_SOURCE_SHA='fb45e727fec4b11bfab08f7800f885a2a3cb64c0adb03835799eeb637cf80ef1'
PAIRED_SOURCE_SHA='bcc892793cbe3e7c4c1b03ea4829f71431a91b4199951c9bfc12d134707e95ab'
ROOT=paired.inputs.ROOT.parent
COHORT=ROOT/'prospective-preference-features-v1/feature_cohort.json'
FACE_REPORT=ROOT/'offered-face-features-v3'/f'features.{FACE_REPORT_SHA}.json'
OUT=ROOT/'offered-face-action-features-v1'
FEATURE_NAMES=state.FEATURE_NAMES+['sampled_face_detected_x_action_proxy_mean','sampled_face_confidence_x_action_proxy_max']
POLICY={'schema_version':1,'recipe':'offered_state8_uniform24_face_action_cooccur2_v1','feature_names':FEATURE_NAMES,'cohort_sha256':COHORT_SHA,'face_report_sha256':FACE_REPORT_SHA,'face_input_receipt_sha256':FACE_RECEIPT_SHA,'stage1_probe_sha256':state.PROBE_SHA256,'state_recipe':state.RECIPE,'face_recipe':paired.face.POLICY['recipe'],'state_context':'Full exact generation rawstoredfloat32 frames; same fixed radius2/Bun classifier BEFORE offered inclusive point pooling.','cooccurrence':'Over exact v3 uniform24 offered point indices: MEAN(detected_boolean * same-timestamp explicit_state_probability), MAX(max_confidence * same-timestamp explicit_state_probability). Sparse proxies, not continuous action or face truth.','missing':'Unavailable fails whole export, never zero imputed.','exploratory':True,'supervised_overlap':'Global Stage1 uses historical hand state labels+coarse wrong-negative mining. Inold22 strict cohort2hand-recording/4creator and3potentialnegativepool-recording/3creator overlaps; new8 prospective sources0hand-recording and1potentialnegativepool-recording overlap. Not all-pipeline unseen-creator evaluation.','action_proxy_is_human_action_truth':False,'face_absence_is_truth':False,'hard_constraints':False,'labels_created':False,'fits':0,'DB_queries':0,'images_or_media_read':False,'GPU':False,'model_download':False,'production_writes':0,'budget_seconds':180,'numeric_read_budget_bytes':256*1024**2,'max_frame_file_bytes':64*1024**2,'max_decompressed_frame_bytes':64*1024**2,'one_fullsource_matrix_at_a_time':True,'timing':'Source/policy frozen before export, after prior preference outcomes and unsuccessful face-only fit were observed; no outcome-blind claim.'}


class NumericReads:
 def __init__(self,limit=POLICY['numeric_read_budget_bytes']):self.total=0;self.limit=limit
 def charge(self,size):
  if not isinstance(size,int) or size<0 or self.total+size>self.limit:raise ValueError('Bounded total numeric reads exceeded')
  self.total+=size
 def read(self,path,limit,sha=None):
  path=Path(path);size=path.stat().st_size
  if not path.is_file() or size>limit:raise ValueError('Bounded numeric input required')
  self.charge(size);payload=path.read_bytes()
  if len(payload)!=size or (sha is not None and paired.face.face.digest(payload)!=sha):raise ValueError('Frozen numeric checksum/size differs')
  return payload
 def json(self,path,limit,sha=None):return json.loads(self.read(path,limit,sha))


def check(deadline):
 if time.monotonic()>=deadline:raise TimeoutError('Bounded numeric face-action export expired')


def checked_dependencies(reads):
 paths=[(Path(state.__file__),STATE_SOURCE_SHA),(Path(paired.face.__file__),FACE_SOURCE_SHA),(Path(paired.__file__),PAIRED_SOURCE_SHA),(Path(paired.face.face.__file__),None),(Path(__file__),None)]
 return [{'path':str(p.resolve()),'sha256':paired.face.face.digest(reads.read(p,256*1024,sha))} for p,sha in paths]


def select_checkpoints(report,receipt,reads,deadline):
 result={}
 for key,source in receipt['sources'].items():
  check(deadline);chosen=None
  for path in sorted((FACE_REPORT.parent/'sources'/key).glob('checkpoint.*.json')):
   check(deadline);raw=reads.read(path,4*1024**2);sha=paired.face.face.digest(raw)
   if path.name!=f'checkpoint.{sha}.json':raise ValueError('Numeric face checkpoint filename differs')
   cp=json.loads(raw)
   if cp.get('input_receipt_sha256')!=FACE_RECEIPT_SHA:continue
   frames=paired.face.validate_checkpoint(cp,key,source,FACE_RECEIPT_SHA)
   if cp.get('complete') is not True:continue
   if paired.face.aggregate(source['rows'],frames)!=report['sources'][key]['rows']:raise ValueError('Exact face summary/detection checkpoint differs')
   chosen={'path':str(path.resolve()),'sha256':sha,'frames':frames};break
  if chosen is None:raise ValueError('Complete exact perpoint face checkpoint unavailable')
  result[key]=chosen
 return result


def load_metadata(reads,deadline):
 dependencies=checked_dependencies(reads);data=reads.json(COHORT,16*1024**2,COHORT_SHA);report=reads.json(FACE_REPORT,16*1024**2,FACE_REPORT_SHA);receipt_path=FACE_REPORT.parent/f'inputs.{FACE_RECEIPT_SHA}.json';receipt=reads.json(receipt_path,16*1024**2,FACE_RECEIPT_SHA)
 if report.get('input_receipt_sha256')!=FACE_RECEIPT_SHA or data.get('reserved_creators_excluded')!=receipt.get('reserved_creators_excluded'):raise ValueError('Exact parent/face reserved-generation contract differs')
 rows=paired.rows_of(data)
 if len(rows)!=92 or len({(r['task_id'],r['side']) for r in rows})!=92 or any(r['reserved_fine_holdout'] is not False or r['fine_data_role']!='training' or r['group'] in data['reserved_creators_excluded'] for r in rows):raise ValueError('Exact92 nonreserved offered sides required')
 # Reuse pure strict face joining, accounting for its two small source checksum reads.
 reads.charge(sum(Path(p).stat().st_size for p in (paired.face.__file__,paired.face.face.__file__)))
 paired.join_face(rows,report,receipt);check(deadline);checkpoints=select_checkpoints(report,receipt,reads,deadline)
 if len(receipt['sources'])!=33:raise ValueError('Exact33 fullgeneration sources required')
 for key,source in receipt['sources'].items():
  frame=source['frame_checkpoint'];path=Path(frame['path'])
  if path.stat().st_dev!=ROOT.stat().st_dev or not path.is_file() or path.stat().st_size>POLICY['max_frame_file_bytes'] or frame['identity_sha256']!=key or state.identity_sha256(source['identity'])!=key:raise ValueError('Exact bounded SSD numeric generation required')
 return data,receipt,checkpoints,dependencies


def cooccurrence(context,source,face_frames,offered_range):
 if not isinstance(context,state.OriginalStateContext) or not isinstance(context.probabilities,np.ndarray) or context.probabilities.dtype.kind not in 'fiu':raise ValueError('Numeric exact state context required')
 if context.identity_sha256!=paired.face.source_key(source['identity']) or context.probe_sha256!=state.PROBE_SHA256 or json.loads(context.identity_json)!=source['identity']:raise ValueError('Face/state source generation mismatch')
 if not np.array_equal(context.timestamps,np.asarray(source['full_timestamps'],float)):raise ValueError('Face/state full point timeline mismatch')
 if context.probabilities.shape!=(len(context.timestamps),4) or not np.isfinite(context.probabilities).all() or np.any(context.probabilities<0) or np.any(context.probabilities>1) or np.any(np.abs(context.probabilities.astype(float).sum(1)-1)>1e-6):raise ValueError('Complete finite state probability simplex required')
 if not isinstance(offered_range,(list,tuple)) or len(offered_range)!=2 or any(not state.finite_number(x) for x in offered_range) or not 0<=offered_range[0]<offered_range[1]<=source['identity']['duration']:raise ValueError('Finite legal offered range required')
 indices=paired.face.sample_indices(context.timestamps,list(offered_range));by={f['index']:f for f in face_frames}
 if len(by)!=len(face_frames) or any(i not in by for i in indices):raise ValueError('Missing exact observed face/action points; not zero')
 expected={f['index']:f for f in source['frames']};values=[]
 for i in indices:
  frame=by[i]
  if i not in expected or frame['timestamp']!=float(context.timestamps[i]):raise ValueError('Face/state global point index/timestamp mismatch')
  paired.face.checked_result(frame,expected[i])
  if not state.finite_number(frame['max_confidence']) or any(not state.finite_number(box['confidence']) for box in frame['boxes']):raise ValueError('Finite numeric face confidence required')
  prob=float(context.probabilities[i,3])
  if not math.isfinite(prob) or not 0<=prob<=1:raise ValueError('Invalid action-proxy probability')
  values.append((int(frame['detected'])*prob,frame['max_confidence']*prob))
 values=np.asarray(values,float)
 return [float(values[:,0].mean()),float(values[:,1].max())],indices


def original_proposal_id(row):
 """Legacy old48 rows omit IDs; recover only one exact immutable detected range/score."""
 identity=row['numeric_identity'];bounds=row.get('original_range');score=row.get('score')
 if not isinstance(bounds,(list,tuple)) or len(bounds)!=2 or not all(state.finite_number(x) for x in (*bounds,score)):raise ValueError('Finite original range/score receipt required')
 matches=[p for p in identity['proposals'] if [p['start'],p['end']]==list(bounds) and p['score']==score and p.get('added',False) is False]
 if len(matches)!=1 or (row.get('original_proposal_id') is not None and row['original_proposal_id']!=matches[0]['id']):raise ValueError('Unique exact original detected proposal required')
 return matches[0]['id']


def row_features(row,context,source,face_frames):
 identity=row['numeric_identity']
 if state.identity_sha256(identity)!=context.identity_sha256 or row['frame_checkpoint']['identity_sha256']!=context.identity_sha256 or row['frame_checkpoint']['sha256']!=source['frame_checkpoint']['sha256'] or any(row[k]!=identity[k] for k in ('video_id','analyzed_at','source_fingerprint','index')):raise ValueError('Exact row/face/state generation differs')
 clip_id=original_proposal_id(row)
 base=state.pool_state_features(context,original_proposal_id=clip_id,original_range=row['original_range'],offered_range=row['offered_range']);extra,indices=cooccurrence(context,source,face_frames,row['offered_range']);features=base+extra
 if len(features)!=10 or not np.isfinite(features).all():raise ValueError('Finite exact10 state/face-action features required')
 return {'row':row['row'],'task_id':row['task_id'],'side':row['side'],'node_key':paired.prior.old.node_key(row),'source_key':context.identity_sha256,'original_proposal_id':clip_id,'original_range':row['original_range'],'offered_range':row['offered_range'],'features':features,'sampled_point_indices':indices,'sampled_timestamps':context.timestamps[indices].tolist(),'availability':True,'action_proxy_is_truth':False,'labels_created':False}



def join_features(value,rows,receipt,*,spec_sha256,export_source_sha256):
 """Pure downstream join: exact generation/proposal/offered/task side; no label target.

 Caller pins immutable feature-file SHA and before-export spec; no matrices or media
 are reread here. Validated complete perpoint input/report receipts were frozen by
 this exporter. This helper never trains or claims auxiliary validation is unbiased.
 """
 if value.get('schema_version')!=1 or value.get('policy')!=POLICY or any(value.get(k)!=v for k,v in {'parent_cohort_sha256':COHORT_SHA,'face_report_sha256':FACE_REPORT_SHA,'probe_sha256':state.PROBE_SHA256,'spec_sha256':spec_sha256,'export_source_sha256':export_source_sha256,'fits':0,'production_changed':False,'reserved_outcomes_opened':False}.items()):raise ValueError('Exact exploratory feature/spec/source pins required')
 if len(rows)!=92 or len(value.get('rows',[]))!=92 or set(value.get('sources',{}))!=set(receipt['sources']) or type(value.get('numeric_read_bytes')) is not int or not 0<=value['numeric_read_bytes']<=POLICY['numeric_read_budget_bytes'] or not state.finite_number(value.get('seconds')) or not 0<=value['seconds']<POLICY['budget_seconds']:raise ValueError('Complete bounded92-side auxiliary artifact required')
 by={}
 for observed in value['rows']:
  key=(observed['task_id'],observed['side'])
  if key in by:raise ValueError('Duplicate auxiliary task side')
  by[key]=observed
 result={};seen=set()
 for row in rows:
  key=(row['task_id'],row['side'])
  if key in seen or key not in by or row.get('reserved_fine_holdout') is not False or row.get('fine_data_role')!='training' or row['group'] in receipt['reserved_creators_excluded']:raise ValueError('Exact nonreserved training-side metadata required')
  seen.add(key);source_key=state.identity_sha256(row['numeric_identity']);source=receipt['sources'].get(source_key)
  if source is None or source['identity']!=row['numeric_identity'] or any(row[k]!=row['numeric_identity'][k] for k in ('video_id','analyzed_at','source_fingerprint','index')) or row['frame_checkpoint']['sha256']!=source['frame_checkpoint']['sha256'] or row['frame_checkpoint']['identity_sha256']!=source_key:raise ValueError('Exact auxiliary source generation required')
  clip_id=original_proposal_id(row);a,b=row['offered_range'];lo,hi=row['original_range']
  if not all(state.finite_number(x) for x in (a,b,lo,hi)) or not 0<=lo<=a<b<=hi<=source['identity']['duration']:raise ValueError('Exact bounded offered interval required')
  indices=paired.face.sample_indices(np.asarray(source['full_timestamps']),row['offered_range']);node=paired.prior.old.node_key(row);observed=by[key]
  expected={'row':row['row'],'node_key':node,'source_key':source_key,'original_proposal_id':clip_id,'original_range':row['original_range'],'offered_range':row['offered_range'],'sampled_point_indices':indices,'sampled_timestamps':[source['full_timestamps'][i] for i in indices],'availability':True,'action_proxy_is_truth':False,'labels_created':False}
  if any(observed.get(k)!=v for k,v in expected.items()) or set(observed)!=set(expected)|{'task_id','side','features'}:raise ValueError('Exact auxiliary offered/point provenance required')
  features=observed['features']
  if not isinstance(features,list) or len(features)!=10 or not all(state.finite_number(x) and 0<=x<=1+1e-7 for x in features) or abs(sum(features[:4])-1)>1e-6 or features[4]+1e-7<max(features[3],features[5],features[9]):raise ValueError('Finite state/simplex/cooccurrence feature contract required')
  if node in result and not np.array_equal(result[node],features):raise ValueError('Same offered-node auxiliary features conflict')
  result[node]=np.asarray(features,float)
 for key,source in receipt['sources'].items():
  if value['sources'][key]!={'probe_sha256':state.PROBE_SHA256,'frame_count':len(source['full_timestamps'])}:raise ValueError('Exact auxiliary fullsource context metadata required')
 return result


def prepare(out=OUT):
 start=time.monotonic();reads=NumericReads();data,receipt,cps,deps=load_metadata(reads,start+180);plan=dict(POLICY,dependencies=deps,source_count=len(receipt['sources']),version_count=len(paired.rows_of(data)),checkpoints={k:{'path':v['path'],'sha256':v['sha256']} for k,v in cps.items()},numeric_frames={k:source['frame_checkpoint'] for k,source in receipt['sources'].items()})
 # Preflight projected bytes includes all selected raw matrices + fixed probe and a fresh
 # metadata/checkpoint validation run at observed actual cost; no source media is involved.
 projected=reads.total+sum(Path(s['frame_checkpoint']['path']).stat().st_size for s in receipt['sources'].values())+256*1024
 if projected>reads.limit:raise ValueError('Projected numeric export exceeds256MiB')
 plan['projected_numeric_read_bytes']=projected;paired.prior.old.frozen(Path(out)/'before-export.json',plan);print(json.dumps({'status':'prepared_no_export','versions':92,'sources':33,'spec_sha256':paired.prior.old.sha(Path(out)/'before-export.json'),'numeric_preflight_read_bytes':reads.total,'projected_numeric_read_bytes':projected,'fits':0}));return plan


def export(out=OUT):
 started=time.monotonic();deadline=started+180;reads=NumericReads();plan=reads.json(Path(out)/'before-export.json',16*1024**2);data,receipt,cps,deps=load_metadata(reads,deadline)
 expected=dict(POLICY,dependencies=deps,source_count=len(receipt['sources']),version_count=len(paired.rows_of(data)),checkpoints={k:{'path':v['path'],'sha256':v['sha256']} for k,v in cps.items()},numeric_frames={k:source['frame_checkpoint'] for k,source in receipt['sources'].items()})
 if {k:v for k,v in plan.items() if k!='projected_numeric_read_bytes'}!=expected:raise ValueError('Reviewed before-export source/policy/input pins changed')
 probe_path=Path(state.__file__).resolve().parents[2]/'data/models/recordings-highlight-probe.json';reads.charge(probe_path.stat().st_size);probe=state.load_probe(probe_path);rows=paired.rows_of(data);contexts={};output=[];seen={}
 for key,source in sorted(receipt['sources'].items()):
  check(deadline);frame=source['frame_checkpoint'];raw=reads.read(frame['path'],POLICY['max_frame_file_bytes'],frame['sha256'])
  with zipfile.ZipFile(io.BytesIO(raw)) as archive:
   if sum(i.file_size for i in archive.infolist())>POLICY['max_decompressed_frame_bytes']:raise ValueError('Numeric frame decompression exceeds bound')
  with np.load(io.BytesIO(raw),allow_pickle=False) as z:
   if str(z['identity_sha256'])!=key:raise ValueError('Stored numeric matrix generation differs')
   t=z['t'].copy();v=z['v'].copy()
  context=state.classify_original_context(probe,t,v,identity=source['identity'],expected_identity=source['identity']);del t,v,raw
  if not np.array_equal(context.timestamps,np.asarray(source['full_timestamps'],float)):raise ValueError('Exact face/numeric timeline differs')
  for row in rows:
   if state.identity_sha256(row['numeric_identity'])!=key:continue
   value=row_features(row,context,source,cps[key]['frames']);node=value['node_key']
   if node in seen and not np.array_equal(seen[node],value['features']):raise ValueError('Same offered node state/action input conflict')
   seen[node]=value['features'];output.append(value)
  contexts[key]={'probe_sha256':context.probe_sha256,'frame_count':len(context.timestamps)}
 if len(output)!=92 or len({(r['task_id'],r['side']) for r in output})!=92:raise ValueError('Exact92 complete offered feature rows required')
 check(deadline);artifact={'schema_version':1,'policy':POLICY,'export_source_sha256':deps[-1]['sha256'],'spec_sha256':paired.prior.old.sha(Path(out)/'before-export.json'),'parent_cohort_sha256':COHORT_SHA,'face_report_sha256':FACE_REPORT_SHA,'probe_sha256':state.PROBE_SHA256,'rows':output,'sources':contexts,'numeric_read_bytes':reads.total,'seconds':time.monotonic()-started,'fits':0,'production_changed':False,'reserved_outcomes_opened':False};paired.prior.old.frozen(Path(out)/'features.json',artifact);print(json.dumps({'status':'complete_exploratory_numeric_features','versions':len(output),'sources':len(contexts),'features_per_version':10,'numeric_read_bytes':reads.total,'seconds':artifact['seconds'],'output_sha256':paired.prior.old.sha(Path(out)/'features.json'),'fits':0}));return artifact

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['prepare','export']);p.add_argument('--out',type=Path,default=OUT);a=p.parse_args();signal.alarm(180);{'prepare':prepare,'export':export}[a.mode](a.out)
