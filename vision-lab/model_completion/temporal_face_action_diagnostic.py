"""Fixed temporal proposal diagnostic; existing numeric caches only, never a fitted head.

An observed face/action cluster is evidence for a challenger, not continuous face
truth or a user-imposed face constraint. Missing face points stay unknown. Source
selection and controls use pre-answer manifest metadata, not winners or scores.
"""
from __future__ import annotations
import argparse, hashlib, io, json, math, os, signal, time, zipfile
PROCESS_STARTED=time.monotonic()
from pathlib import Path
import numpy as np
import offered_face_action_features as aux

ROOT=aux.ROOT
OUT=ROOT/'temporal-face-action-diagnostic-v1'
MANIFEST=ROOT/'offered-span-prospective-v2/private_manifest.json'
MANIFEST_SHA='eec780157b221c592462e3224974c0e8b0e8f30a4f62311a16f81121c1f6be72'
AUX_SOURCE_SHA='8b37748ca10be15c084b619f7eb58ef32ccaca6652b6b4547b66d79a3c7c5a1a'
KNOWN_VIDEO=6209;KNOWN_FEEDBACK=350
POLICY={'schema_version':1,'recipe':'observed_temporal_face_action_same_length_challenger_v1',
 'selection':'Known reported source, then five smallest source hashes from pre-answer primary prospective sources, distinct nonreserved creators; no winner/score/coverage selection.',
 'control':'Exact frozen_primary_best range from authoritative prospective v2 manifest; same duration and immutable original proposal for challenger.',
 'joint_anchor':'Existing detected face AND full-context explicit probability >= .55 at same global index/timestamp. Require two observed anchors separated by <=90s; no face interpolation. Cluster is sampled evidence, not continuous episode truth.',
 'cluster':'Consecutive positive observed anchors joined only across gaps <=90s; require >=2 anchors excluded by control. Candidate centered on their first/last midpoint, rounded to5s relative original start and clipped to legal original bounds.',
 'choice':'Eligible cluster with largest SUM(max_face_confidence * same-point explicit_probability); more observed anchors then earliest cluster breaks ties. No labels or model prediction scores.',
 'distinct':'Start difference >=30s and IoU<=.8; candidate must include >=2 exact observed joint anchors excluded by control.',
 'duration':'Same as frozen control; 3–15 minutes is a SOFT preference, no hard15m cap or inferred expiry.',
 'coverage':'Report original/control/candidate observed-frame counts, full-frame counts, maximum observed gaps, detected joint timestamps and full-state point mass. Missing face is UNKNOWN, not zero; sparse clusters do not establish continuous coverage.',
 'known_source_role':'Posthoc debugging only; other sources are not an untouched preference validation cohort.',
 'global_auxiliary_overlap':'Fixed Stage1 personal coarse supervision was not retrained within creator folds. No all-pipeline unseen-creator claim.',
 'budget_seconds':90,'max_numeric_read_bytes':128*1024**2,'max_sources':6,'max_frame_file_bytes':64*1024**2,
 'fits':0,'GPU':False,'media_reads':False,'DB_queries':0,'queue_writes':0,'production_writes':0,
 'labels_created':False,'reserved_outcomes_opened':False,'automatic_face_constraint':False,
 'missed_action':'Unidentified minor round-level note only; no additional clarification or individual label inferred.'}

def sha(payload):return hashlib.sha256(payload).hexdigest()
def frozen(path,value):
 payload=(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False)+'\n').encode();path=Path(path)
 path.parent.mkdir(parents=True,exist_ok=True,mode=0o700);os.chmod(path.parent,0o700)
 if path.exists():
  if path.read_bytes()!=payload:raise ValueError('Immutable diagnostic output already differs')
  return sha(payload)
 temporary=path.parent/f'.{path.name}.{os.getpid()}.tmp'
 fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 try:
  with os.fdopen(fd,'wb') as f:f.write(payload);f.flush();os.fsync(f.fileno())
  try:os.link(temporary,path)
  except FileExistsError:
   if path.read_bytes()!=payload:raise ValueError('Immutable diagnostic output already differs')
 finally:temporary.unlink(missing_ok=True)
 return sha(payload)

class Reads(aux.NumericReads):
 def __init__(self):super().__init__(POLICY['max_numeric_read_bytes'])
 def read(self,path,limit,expected=None):
  if Path(path).stat().st_dev!=ROOT.stat().st_dev:raise ValueError('Only same-device SSD numeric inputs allowed')
  return super().read(path,limit,expected)

def check(deadline):
 if time.monotonic()>=deadline:raise TimeoutError('90-second numeric diagnostic deadline')

def select_sources(manifest,receipt):
 if manifest.get('excluded_holdout_creators')!=receipt.get('reserved_creators_excluded'):raise ValueError('Reserved creator contract differs')
 reserved=set(receipt['reserved_creators_excluded']);public={(r['batch'],r['position']):r for r in manifest['rows']};pool=[]
 for p in manifest['private_assignments']:
  if p['pilot_role']!='model_vs_human':continue
  identity=p['numeric_identity'];key=aux.state.identity_sha256(identity);source=receipt['sources'].get(key)
  if source is None or source['identity']!=identity or source['frame_checkpoint']!=p['frame_checkpoint']:raise ValueError('Exact prospective face/numeric source receipt differs')
  task=public[(p['batch'],p['position'])];context=task['context']
  if context.get('reserved_fine_holdout') is not False or context.get('fine_data_role')!='training' or source['group'] in reserved:raise ValueError('Reserved/nontraining source forbidden')
  sides=[s for s in ('a','b') if p['assignments'][s]=='frozen_primary_best']
  if len(sides)!=1:raise ValueError('Unique pre-answer primary control required')
  side=context[sides[0]];control=list(side['range']);original=list(side['original_range'])
  if any(side[k]!=identity[k] for k in ('video_id','analyzed_at','source_fingerprint','index')) or side['channel_key']!=source['group']:raise ValueError('Control generation/creator mismatch')
  matches=[x for x in identity['proposals'] if [x['start'],x['end']]==original]
  if len(matches)!=1 or not 0<=original[0]<=control[0]<control[1]<=original[1]<=identity['duration'] or control[1]-control[0]<180:raise ValueError('Immutable proposal and bounded same-length control required')
  pool.append({'source_key':key,'group':source['group'],'original_range':original,'control_range':control,'original_proposal_id':matches[0]['id'],'known_debug':side['video_id']==KNOWN_VIDEO and side['feedback_id']==KNOWN_FEEDBACK})
 if len(pool)!=8 or len({x['source_key'] for x in pool})!=8 or len({x['group'] for x in pool})!=8:raise ValueError('Eight distinct pre-answer source/creator controls required')
 known=[x for x in pool if x['known_debug']]
 if len(known)!=1:raise ValueError('Exact reported debugging source missing')
 return known+sorted([x for x in pool if not x['known_debug']],key=lambda x:x['source_key'])[:5]

def iou(a,b):
 intersection=max(0.,min(a[1],b[1])-max(a[0],b[0]));return intersection/(a[1]-a[0]+b[1]-b[0]-intersection)

def coverage(t,observed,bounds):
 full=t[(t>=bounds[0])&(t<=bounds[1])];seen=np.array(sorted(x for x in observed if bounds[0]<=x<=bounds[1]),float)
 gaps=np.diff(np.r_[bounds[0],seen,bounds[1]])
 return {'full_frame_points':len(full),'observed_face_points':len(seen),'face_unknown_frame_points':len(full)-len(seen),'max_observed_gap_seconds':float(gaps.max()),'continuous_face_coverage_known':False}

def propose(t,p,faces,original,control):
 t=np.asarray(t,float);p=np.asarray(p,float)
 if t.ndim!=1 or not len(t) or not np.isfinite(t).all() or np.any(np.diff(t)<=0) or p.shape!=(len(t),4) or not np.isfinite(p).all() or np.any(p<0) or np.any(p>1) or np.any(abs(p.sum(1)-1)>1e-6):raise ValueError('Finite full timeline/state simplex required')
 if not all(aux.state.finite_number(x) for x in (*original,*control)) or not 0<=original[0]<=control[0]<control[1]<=original[1] or control[1]-control[0]<180:raise ValueError('Legal original/control range required')
 seen={};anchors=[]
 for f in faces:
  i=f['index']
  if type(i) is not int or i in seen or not 0<=i<len(t) or f['timestamp']!=t[i] or type(f['detected']) is not bool or not aux.state.finite_number(f['max_confidence']) or not 0<=f['max_confidence']<=1:raise ValueError('Exact unique numeric face point required')
  seen[i]=f
  if original[0]<=t[i]<=original[1] and f['detected'] and p[i,3]>=.55:anchors.append({'index':i,'timestamp':float(t[i]),'joint_proxy':float(f['max_confidence']*p[i,3])})
 anchors.sort(key=lambda x:x['timestamp']);clusters=[]
 for a in anchors:
  if not clusters or a['timestamp']-clusters[-1][-1]['timestamp']>90:clusters.append([])
  clusters[-1].append(a)
 candidates=[];length=control[1]-control[0]
 for cluster in clusters:
  omitted=[a for a in cluster if not control[0]<=a['timestamp']<=control[1]]
  if len(omitted)<2:continue
  midpoint=(omitted[0]['timestamp']+omitted[-1]['timestamp'])/2
  start=original[0]+5*round((midpoint-length/2-original[0])/5);start=max(original[0],min(start,original[1]-length));bounds=[float(start),float(start+length)]
  retained=[a for a in omitted if bounds[0]<=a['timestamp']<=bounds[1]]
  if len(retained)<2 or abs(bounds[0]-control[0])<30 or iou(bounds,control)>.8:continue
  candidates.append((sum(a['joint_proxy'] for a in retained),len(retained),-retained[0]['timestamp'],bounds,retained))
 observed=[float(t[i]) for i in seen if original[0]<=t[i]<=original[1]]
 status='no_observed_joint_anchor' if not anchors else ('single_observed_joint_anchor_insufficient' if len(anchors)==1 else 'observed_joint_anchors_no_eligible_cluster')
 result={'status':status,'candidate_range':None,'control_range':list(control),'original_range':list(original),'joint_anchor_count':len(anchors),'observed_joint_anchors':anchors,'single_anchor_is_not_user_minimum':True,'sampled_clusters':clusters,'coverage_original':coverage(t,observed,original),'coverage_control':coverage(t,observed,control),'missing_face_is_unknown':True,'automatic_action':False}
 if candidates:
  _,_,_,bounds,retained=max(candidates,key=lambda x:x[:3]);result.update(status='distinct_sampled_episode_challenger',candidate_range=bounds,retained_omitted_joint_points=retained,coverage_candidate=coverage(t,observed,bounds),control_iou=iou(bounds,control))
  def mass(span):return float(p[(t>=span[0])&(t<=span[1]),3].sum())
  result['action_proxy_point_mass']={'control':mass(control),'candidate':mass(bounds),'original':mass(original),'elapsed_time_coverage':False,'human_action_truth':False}
 return result

def decode_numeric_checkpoint(payload,source):
 """Bound archive and exact array geometry BEFORE classifying; no object loads."""
 expected_count=source['identity']['index']['frame_count'];key=aux.state.identity_sha256(source['identity'])
 if type(expected_count) is not int or not 1<=expected_count<=aux.state.MAX_FRAMES:raise ValueError('Bounded frozen original frame count required')
 expected_members={'t.npy':expected_count*8+4096,'v.npy':expected_count*1152*4+4096,'identity_sha256.npy':4096}
 with zipfile.ZipFile(io.BytesIO(payload)) as archive:
  members=archive.infolist()
  if len(members)!=3 or {i.filename for i in members}!=set(expected_members) or any(i.flag_bits&1 or i.file_size<=0 or i.file_size>expected_members[i.filename] for i in members) or sum(i.file_size for i in members)>64*1024**2:raise ValueError('Exact bounded three-member numeric archive required')
 with np.load(io.BytesIO(payload),allow_pickle=False) as z:
  identity=z['identity_sha256'];t=z['t'];v=z['v']
  if identity.shape!=() or identity.dtype.kind!='U' or str(identity)!=key:raise ValueError('Exact scalar numeric generation required')
  if t.shape!=(expected_count,) or t.dtype.kind not in 'fiu' or v.shape!=(expected_count,1152) or v.dtype!=np.float32 or not np.isfinite(t).all() or not np.isfinite(v).all():raise ValueError('Exact full-source frame1152 shapes/types required')
  if not np.array_equal(t,np.asarray(source['full_timestamps'],float)) or np.any(np.diff(t)<=0) or t[0]<0 or t[-1]>source['identity']['duration']:raise ValueError('Exact frozen full original timestamp coverage required')
 return t,v

def inputs(reads,deadline):
 check(deadline);dependencies=[]
 for path,expected in [(Path(aux.__file__),AUX_SOURCE_SHA),(Path(aux.state.__file__),aux.STATE_SOURCE_SHA),(Path(aux.paired.face.__file__),aux.FACE_SOURCE_SHA),(Path(aux.paired.__file__),aux.PAIRED_SOURCE_SHA),(Path(aux.paired.face.face.__file__),None),(Path(__file__),None)]:
  dependencies.append({'path':str(path.resolve()),'sha256':sha(reads.read(path,256*1024,expected))})
 manifest=reads.json(MANIFEST,8*1024**2,MANIFEST_SHA);report=reads.json(aux.FACE_REPORT,8*1024**2,aux.FACE_REPORT_SHA);receipt=reads.json(aux.FACE_REPORT.parent/f'inputs.{aux.FACE_RECEIPT_SHA}.json',8*1024**2,aux.FACE_RECEIPT_SHA)
 if report.get('input_receipt_sha256')!=aux.FACE_RECEIPT_SHA:raise ValueError('Pinned complete face report binding differs')
 selected=select_sources(manifest,receipt);checkpoints={}
 for row in selected:
  check(deadline);key=row['source_key'];source=receipt['sources'][key];good=[]
  for path in sorted((aux.FACE_REPORT.parent/'sources'/key).glob('checkpoint.*.json')):
   payload=reads.read(path,4*1024**2);digest=sha(payload)
   if path.name!=f'checkpoint.{digest}.json':raise ValueError('Face checkpoint content-address differs')
   cp=json.loads(payload)
   if cp.get('input_receipt_sha256')!=aux.FACE_RECEIPT_SHA or cp.get('complete') is not True:continue
   points=aux.paired.face.validate_checkpoint(cp,key,source,aux.FACE_RECEIPT_SHA)
   if aux.paired.face.aggregate(source['rows'],points)!=report['sources'][key]['rows']:raise ValueError('Pinned complete face report differs from observed points')
   good.append({'path':str(path.resolve()),'sha256':digest,'frames':points})
  if not good:raise ValueError('Complete exact observed point checkpoint unavailable')
  if any(x['frames']!=good[0]['frames'] for x in good):raise ValueError('Conflicting complete face histories')
  checkpoints[key]=good[0]
 return selected,receipt,checkpoints,dependencies

def prepare(out=OUT):
 started=time.monotonic();reads=Reads();selected,receipt,cps,deps=inputs(reads,started+90)
 frames={r['source_key']:receipt['sources'][r['source_key']]['frame_checkpoint'] for r in selected}
 projected=reads.total+sum(Path(f['path']).stat().st_size for f in frames.values())+256*1024
 if projected>reads.limit:raise ValueError('Projected six-source numeric reads exceed budget')
 plan={'policy':POLICY,'manifest_sha256':MANIFEST_SHA,'face_receipt_sha256':aux.FACE_RECEIPT_SHA,'face_report_sha256':aux.FACE_REPORT_SHA,'probe_sha256':aux.state.PROBE_SHA256,'dependencies':deps,'selected':selected,'checkpoints':{k:{a:v[a] for a in ('path','sha256')} for k,v in cps.items()},'numeric_frames':frames,'projected_read_bytes':projected}
 frozen(Path(out)/'before-run.json',plan);return {'status':'prepared_numeric_only','sources':len(selected),'spec_sha256':sha((Path(out)/'before-run.json').read_bytes()),'fits':0}

def run(out=OUT):
 started=time.monotonic();deadline=started+90;reads=Reads();plan=reads.json(Path(out)/'before-run.json',4*1024**2);selected,receipt,cps,deps=inputs(reads,deadline)
 expected={'policy':POLICY,'manifest_sha256':MANIFEST_SHA,'face_receipt_sha256':aux.FACE_RECEIPT_SHA,'face_report_sha256':aux.FACE_REPORT_SHA,'probe_sha256':aux.state.PROBE_SHA256,'dependencies':deps,'selected':selected,'checkpoints':{k:{a:v[a] for a in ('path','sha256')} for k,v in cps.items()},'numeric_frames':{r['source_key']:receipt['sources'][r['source_key']]['frame_checkpoint'] for r in selected}}
 if {k:v for k,v in plan.items() if k!='projected_read_bytes'}!=expected:raise ValueError('Frozen diagnostic sources/selection/dependencies changed')
 probe_path=Path(aux.state.__file__).resolve().parents[2]/'data/models/recordings-highlight-probe.json';reads.charge(probe_path.stat().st_size);probe=aux.state.load_probe(probe_path);results=[]
 for row in selected:
  check(deadline);key=row['source_key'];source=receipt['sources'][key];frame=source['frame_checkpoint'];payload=reads.read(frame['path'],POLICY['max_frame_file_bytes'],frame['sha256'])
  t,v=decode_numeric_checkpoint(payload,source)
  context=aux.state.classify_original_context(probe,t,v,identity=source['identity'],expected_identity=source['identity']);del v,payload
  if not np.array_equal(t,np.asarray(source['full_timestamps'])):raise ValueError('Full face/state timestamp provenance differs')
  result=propose(t,context.probabilities,cps[key]['frames'],row['original_range'],row['control_range']);result.update(source_key=key,creator_key=sha(row['group'].encode()),known_debug=row['known_debug'],original_proposal_id=row['original_proposal_id'],numeric_identity_sha256=key,frame_sha256=frame['sha256'],face_checkpoint_sha256=cps[key]['sha256']);results.append(result)
 check(deadline);result={'known_source_if_no_challenger':'Report sparse/unknown coverage; any denser existing-storyboard CPU detector pass needs separate review, never tune these thresholds or infer no face.', 'schema_version':1,'policy':POLICY,'spec_sha256':sha((Path(out)/'before-run.json').read_bytes()),'results':results,'seconds':time.monotonic()-started,'numeric_read_bytes':reads.total,'fits':0,'queue_writes':0,'production_changed':False,'reserved_outcomes_opened':False}
 payload=(json.dumps(result,sort_keys=True,separators=(',',':'),allow_nan=False)+'\n').encode();digest=sha(payload);frozen(Path(out)/f'report.{digest}.json',result)
 return {'status':'diagnostic_only','sources':len(results),'distinct_challengers':sum(r['candidate_range'] is not None for r in results),'report_sha256':digest,'seconds':result['seconds'],'numeric_read_bytes':reads.total,'queue_writes':0}

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['prepare','run']);parser.add_argument('--out',type=Path,default=OUT);args=parser.parse_args();signal.signal(signal.SIGALRM,lambda *_: (_ for _ in ()).throw(TimeoutError('External numeric diagnostic budget')));signal.alarm(max(1,math.ceil(90-(time.monotonic()-PROCESS_STARTED))));print(json.dumps(prepare(args.out) if args.mode=='prepare' else run(args.out)))
