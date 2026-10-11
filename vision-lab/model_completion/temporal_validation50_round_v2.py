"""Consumer-only reviewed 50-task manifest; frozen pool/control source stays untouched."""
from __future__ import annotations
import argparse,copy,hashlib,json,math,time
from pathlib import Path
import temporal_validation50 as generator
import temporal_face_requests_v2 as face_api
base=generator.base;safe=generator.safe;versions=generator.versions;temporal=generator.temporal
BATCH=generator.BATCH;COUNT=generator.COUNT;FIELDS=versions.FIELDS;OUT=generator.OUT
FACE_EXTRACTOR_SHA='a6bb48c35b208c6d6247f91a971356d424ba9f81d426ffb12b6fc41dbd4d297f'
GENERATOR_SHA='57f2472b03b1813114fcec921f0f2ec90b91b336156279b34518b6f7f38dab21'


def load_selection(root,selection_sha,face_root):
 root=Path(root);path=root/'candidate_selection.json'
 if base.digest(Path(face_api.__file__))!=FACE_EXTRACTOR_SHA or base.digest(Path(generator.__file__))!=GENERATOR_SHA or path.stat().st_size>16*1024**2 or base.digest(path)!=selection_sha:raise ValueError('Frozen reviewed generator/selection required')
 pool=generator.load_pool(root);value=json.loads(path.read_text());request_path=root/'controls_and_face_request.json'
 if request_path.stat().st_size>32*1024**2:raise ValueError('Bounded frozen request required')
 request=json.loads(request_path.read_text())
 if value['policy']!=generator.POLICY or value['metric_policy']!=generator.METRIC_POLICY or value['pool_sha256']!=base.digest(root/'frozen_pool.json') or value['request_sha256']!=base.digest(request_path) or request['pool_sha256']!=value['pool_sha256'] or request['policy']!=generator.POLICY or request['head_sha256']!=generator.HEAD_SHA:raise ValueError('Exact pool/control/request/selection provenance required')
 if value['status']!='ready50_distinct_for_review' or len(value['selected'])!=50:raise ValueError('Only exactly50 distinct meaningful candidates may be prepared')
 started=time.monotonic();deadline=started+300;numeric_bytes=0
 expected={generator.source_key(r['source']):r for r in request['records'] if 'source_key' in r};seen=set();numeric_receipts={};face_cache={};face_provenance={}
 for row in value['selected']:
  source=row['source'];key=generator.source_key(source);control=expected.get(key)
  if key in seen or control is None or any(row[k]!=control[k] for k in control):raise ValueError('Selected proposal must match immutable control completely')
  seen.add(key);identity=row['numeric_identity'];frame=row['frame_checkpoint'];source_key=temporal.aux.state.identity_sha256(identity)
  if source_key!=row['source_key'] or frame['identity_sha256']!=source_key or any(identity[k]!=source[k] for k in ('video_id','analyzed_at','index','source_fingerprint')) or identity['duration']!=source['duration_seconds']:raise ValueError('Exact source/generation/index numeric identity required')
  face_path=Path(face_root)/f'{source_key}.json'
  if face_path.stat().st_size>4*1024**2 or base.digest(face_path)!=row['face_checkpoint_sha256']:raise ValueError('Exact completed face checkpoint required')
  if source_key not in face_cache:
   face_cache[source_key],face_provenance[source_key]=face_api.load_numeric_source(face_root,source_key,value['request_sha256'],identity)
  points=face_cache[source_key]
  if face_provenance[source_key]['checkpoint_sha256']!=row['face_checkpoint_sha256'] or [f['index'] for f in points]!=request['sources'][source_key]['planned_indices']:raise ValueError('Exact extractor/page/point/checkpoint receipt differs')
  point_map={p['index']:p for p in points}
  diagnostic=row['diagnostic'];candidate=diagnostic['candidate_range'];old=row['control_range'];a,b=source['clip']
  if diagnostic['status']!='distinct_sampled_episode_challenger' or not a<=candidate[0]<candidate[1]<=b or abs((candidate[1]-candidate[0])-(old[1]-old[0]))>1e-7 or abs(candidate[0]-old[0])<30 or temporal.iou(candidate,old)>.8 or diagnostic['automatic_action'] is not False:raise ValueError('Exact same-duration genuinely distinct temporal preference required')
  anchors=diagnostic['retained_omitted_joint_points']
  if len(anchors)<2 or len({p['index'] for p in anchors})!=len(anchors):raise ValueError('Distinct observed anchors required')
  for p in anchors:
   face=point_map.get(p['index'])
   if face is None or face['max_confidence']<.5 or face['timestamp']!=p['timestamp'] or face['detected'] is not True or not temporal.aux.state.finite_number(p['joint_proxy']) or not .55*face['max_confidence']<=p['joint_proxy']<=face['max_confidence'] or not candidate[0]<=p['timestamp']<=candidate[1] or old[0]<=p['timestamp']<=old[1]:raise ValueError('Observed retained/omitted face-action anchor differs')
  fp=Path(frame['path'])
  if not fp.is_absolute() or fp.stat().st_dev!=generator.ROOT.stat().st_dev or fp.stat().st_size>64*1024**2:raise ValueError('Exact bounded SSD numeric source required')
  if source_key in numeric_receipts and numeric_receipts[source_key]!=frame:raise ValueError('Generation checkpoint conflict')
  numeric_receipts[source_key]=frame
 # Reconstruct every selection from immutable numeric frame/probe/face receipts, one generation at a time.
 probe=temporal.aux.state.load_probe()
 for source_key,frame in sorted(numeric_receipts.items()):
  generator.check(deadline);path=Path(frame['path']);numeric_bytes+=path.stat().st_size
  if numeric_bytes>generator.POLICY['max_numeric_read_bytes']:raise ValueError('Bounded manifest numeric validation exceeded')
  payload=path.read_bytes()
  if hashlib.sha256(payload).hexdigest()!=frame['sha256']:raise ValueError('Exact frame generation bytes differ')
  source=request['sources'][source_key];t,v=temporal.decode_numeric_checkpoint(payload,source);context=temporal.aux.state.classify_original_context(probe,t,v,identity=source['identity'],expected_identity=source['identity']);del v,payload
  points=face_cache[source_key]
  for row in value['selected']:
   if row['source_key']==source_key and temporal.propose(t,context.probabilities,points,row['original_range'],row['control_range'])!=row['diagnostic']:raise ValueError('Temporal challenger/anchor policy reconstruction differs')
 generator.check(deadline)
 reserved,receipt=safe.previous.holdout_contract()
 generator.validate_sources([r['source'] for r in value['selected']],reserved)
 return value,reserved,receipt,dict(request,face_provenance=face_provenance)


def consumers():
 return {str(Path(__file__).with_name(p).resolve()):base.digest(Path(__file__).with_name(p)) for p in ('temporal_validation50_apply_v2.py','temporal_validation50_intake_v2.py')}


def make_manifest(selection,reserved,receipt,request,selection_sha,face_root):
 value=generator.make_manifest(selection,reserved,receipt)
 value.update(face_extractor_source_sha256=FACE_EXTRACTOR_SHA,face_provenance=request.get('face_provenance',{}),consumer_sources=consumers(),consumer_generator_sha256=base.digest(Path(__file__)),selection_sha256=selection_sha,face_root=str(Path(face_root).resolve()),generic_control_counts=request['generic_control_counts'],generic_control_proof=[{'feedback_id':r['source']['feedback_id'],'identical':r['generic_control_matches']} for r in request['records'] if 'generic_control_matches' in r])
 return value


def load_contract(root,expected):
 root=Path(root);path=root/'private_manifest.json'
 if not isinstance(expected,str) or len(expected)!=64 or any(c not in '0123456789abcdef' for c in expected) or path.stat().st_size>16*1024**2 or base.digest(path)!=expected:raise ValueError('Exact reviewed50 manifest checksum required')
 value=json.loads(path.read_text());selection,reserved,receipt,request=load_selection(root,value['selection_sha256'],value['face_root'])
 if value!=make_manifest(selection,reserved,receipt,request,value['selection_sha256'],value['face_root']):raise ValueError('Manifest/source/consumer/checkpoint contract drift')
 return value,reserved,receipt


def validate_live(value,live,history,reserved,receipt):
 if value['holdout_dependency']!=receipt or value['excluded_holdout_creators']!=sorted(reserved):raise ValueError('Reserved creator contract differs')
 sources={p['source']['feedback_id']:p['source'] for p in value['private_assignments']}
 if set(live)!=set(sources):raise ValueError('Every exact eligible live proposal required')
 for fid,source in sources.items():
  if safe.previous.side(live[fid],[])!=source:raise ValueError('Source/fingerprint/generation/index/proposal/review drift')
 prior=[t for t in history if t['batch']!=BATCH];used=versions.history_pairs(prior);seen=set()
 for row in value['rows']:
  pair=tuple(sorted(versions.version_key(row['context'][side]) for side in ('a','b')))
  if pair in used or pair in seen:raise ValueError('Historical/new exact version pair duplicate')
  seen.add(pair)


def history_metadata(pg):
 return [{'kind':k,'batch':b,'context':c} for k,b,c in pg.execute("SELECT kind,batch,context FROM recording_label_tasks WHERE kind='version-versus' ORDER BY id").fetchall()]


def prepare(root,selection_sha,face_root):
 selection,reserved,receipt,request=load_selection(root,selection_sha,face_root);value=make_manifest(selection,reserved,receipt,request,selection_sha,face_root)
 import psycopg
 with psycopg.connect(base.pg_config()) as pg:
  pg.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');pg.execute("SET statement_timeout='20s'");ids=sorted({p['source']['feedback_id'] for p in value['private_assignments']});live=safe.previous.load_rows(pg,ids);validate_live(value,live,history_metadata(pg),reserved,receipt)
 temporal.frozen(Path(root)/'private_manifest.json',value)
 return {'status':'prepared_no_queue_writes','count':50,'creators':len({r['context']['a']['channel_key'] for r in value['rows']}),'known_debug':sum(p['known_debug'] for p in value['private_assignments']),'new_on_A':25,'new_on_B':25,'manifest_sha256':base.digest(Path(root)/'private_manifest.json'),'generic_control_counts':value['generic_control_counts'],'fits':0}

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=OUT);p.add_argument('--selection-sha256',required=True);p.add_argument('--face-root',type=Path,required=True);a=p.parse_args();print(json.dumps(prepare(a.root,a.selection_sha256,a.face_root)))
