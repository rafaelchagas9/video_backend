"""Join the frozen prospective round only AFTER its immutable evaluation.

Reuses old60 rows unchanged. New32 sides are exact offered-version preferences;
no media, face detection, fitting, DB access, cut gold or acceptance assignments.
"""
from __future__ import annotations
import argparse,collections,copy,hashlib,json,signal,time,zipfile
from pathlib import Path
import numpy as np
import blind_preference_features as prior
import combined_blind_preference as combined
import offered_span_evaluate as evaluation
import offered_span_intake as intake
BASE=prior.OUT/'feature_cohort.json'
BASE_SHA='5a0b86cdb813702524ed22fe476908a7598d69289e005f0cbc7acec56861cbd3'
ROOT=evaluation.ROOT
SNAPSHOT_SHA='cfd780602d294faf634a9caca59a96d50ca24dbd2f4dc5666fa14e4860d8b60f'
REPORT_SHA='65a01c39975840c3add8813fec2fb8670a6870fd7f50b08ca238564829321f28'
OUT=ROOT.parent/'prospective-preference-features-v1'

def read_checked(path,sha,limit=16*1024**2):
 path=Path(path)
 if not path.is_file() or path.stat().st_size>limit or prior.numeric.base.digest(path)!=sha:raise ValueError('Exact bounded source checksum required')
 return json.loads(path.read_text())

def check_evaluation(root):
 report_path=Path(root)/'evaluation-reports'/f'report.{SNAPSHOT_SHA}.{REPORT_SHA}.json'
 report=read_checked(report_path,REPORT_SHA)
 if report.get('snapshot_sha256')!=SNAPSHOT_SHA or report.get('prospective_before_append_or_refit') is not True or report.get('fits')!=0 or report.get('production_changed') is not False or report.get('reserved_opened') is not False:raise ValueError('Completed frozen prospective evaluation must precede export')
 return report_path

def row_features(preference,side,assignment,t,v):
 source=assignment['source'];identity=assignment['numeric_identity'];public=preference[side]
 original=[p for p in identity['proposals'] if [p['start'],p['end']]==source['clip'] and p['score']==source['score']]
 if len(original)!=1:raise ValueError('Exact original proposal required')
 fx,visual=prior.numeric.domain_features({'group':source['channel_key']},source,{'clip_id':original[0]['id'],'duration':source['duration_seconds']},t,v,identity['proposals'],*public['range'])
 if visual is None or len(fx)!=13 or len(visual)!=1152 or not np.isfinite(fx).all() or not np.isfinite(visual).all() or abs(np.linalg.norm(visual)-1)>.02:raise ValueError('Exact offered numeric/visual coverage required')
 a,b=public['range'];receipt=assignment['frame_checkpoint']
 return {'row':f"prospective{preference['task_id']}{side}",'task_id':preference['task_id'],'position':preference['position'],'side':side,'kind':'version-versus','cohort_kind':'prospective_offered_v1','batch':preference['batch'],'answer':preference['answer'],'answered_at':preference['answered_at'],'target':'preferred_version_if_keep_one','ranking_y':int(preference['answer']==side) if preference['answer'] in ('a','b') else None,'current_acceptability_y':None,'absolute_y':None,'cut_gold':None,'future_replacement':'unknown','permanent_storage_worth':'unknown','group':source['channel_key'],'channel':source['channel'],'video_id':source['video_id'],'feedback_id':source['feedback_id'],'analyzed_at':source['analyzed_at'],'source_fingerprint':copy.deepcopy(source['source_fingerprint']),'index':copy.deepcopy(source['index']),'original_range':source['clip'].copy(),'offered_range':[a,b],'start':a,'end':b,'features':fx,'visual_mean':visual,'numeric_identity':copy.deepcopy(identity),'original_proposal_id':original[0]['id'],'frame_cache':receipt['path'],'frame_checkpoint':copy.deepcopy(receipt),'duration_seconds':source['duration_seconds'],'score':source['score'],'reserved_fine_holdout':False,'fine_data_role':'training','comparison_scope':'same_channel','pair_creators':[source['channel_key']],'pilot_role_private':assignment['pilot_role']}

def strict_pairs(rows,reserved):
 groups=collections.defaultdict(list);seen=set();nodes={}
 for r in rows:
  if r['group'] in reserved or r['reserved_fine_holdout'] is not False or r['fine_data_role']!='training' or r['current_acceptability_y'] is not None or r['absolute_y'] is not None or r['cut_gold'] is not None or r['target']!='preferred_version_if_keep_one':raise ValueError('Pure nonreserved preference required')
  if r['side'] not in ('a','b') or r['kind']!='version-versus' or r['comparison_scope']!='same_channel' or r['pair_creators']!=[r['group']]:raise ValueError('Exact per-side preference scope required')
  X=np.asarray(r['features'],dtype=float);V=np.asarray(r['visual_mean'],dtype=float)
  if X.shape!=(13,) or V.shape!=(1152,) or not np.isfinite(X).all() or not np.isfinite(V).all() or abs(np.linalg.norm(V)-1)>.02:raise ValueError('Exact offered finite numeric/unit visual features required')
  a,b=r['offered_range'];lo,hi=r['original_range'];identity=r['numeric_identity']
  if any(isinstance(z,bool) or not isinstance(z,(int,float)) or not np.isfinite(z) for z in (a,b,lo,hi,r['duration_seconds'])) or not 0<=lo<=a<b<=hi<=r['duration_seconds'] or r['start']!=a or r['end']!=b:raise ValueError('Exact offered actual-duration bounds required')
  if any(identity.get(k)!=r[k] for k in ('video_id','analyzed_at','index','source_fingerprint')) or identity.get('duration')!=r['duration_seconds']:raise ValueError('Exact row/source generation identity required')
  if identity['index'].get('model_revision')!=prior.numeric.historical.VISUAL_PIN or type(identity['index'].get('frame_count')) is not int or identity['index']['frame_count']<=0:raise ValueError('Exact indexed visual generation required')
  originals=[p for p in identity['proposals'] if p['id']==r['original_proposal_id']]
  if len(originals)!=1 or [originals[0]['start'],originals[0]['end']]!=r['original_range'] or originals[0]['score']!=r['score']:raise ValueError('Exact original proposal identity required')
  key=combined.old.node_key(r);value=(r['group'],X,V)
  if key in nodes and (nodes[key][0]!=value[0] or not np.array_equal(nodes[key][1],X) or not np.array_equal(nodes[key][2],V)):raise ValueError('Same offered node input conflict')
  nodes[key]=value
  k=(r['task_id'],r['side'])
  if k in seen:raise ValueError('Duplicate task side')
  seen.add(k);groups[r['task_id']].append(r)
 pairs=[]
 for tid,rs in sorted(groups.items()):
  if len(rs)!=2 or {r['side'] for r in rs}!={'a','b'} or any(rs[0][k]!=rs[1][k] for k in ('answer','group','feedback_id','video_id','analyzed_at','source_fingerprint','index','numeric_identity','original_range','original_proposal_id','duration_seconds','pilot_role_private','batch')):raise ValueError('Complete same-source comparison required')
  answer=rs[0]['answer']
  if answer in ('both','neither'):
   if any(r['ranking_y'] is not None for r in rs):raise ValueError('Tie/abstention cannot define an order')
   continue
  if answer not in ('a','b') or any(type(r['ranking_y']) is not int or r['ranking_y']!=int(r['side']==answer) for r in rs):raise ValueError('Exact saved winner required')
  winner=next(r for r in rs if r['side']==answer);loser=next(r for r in rs if r['side']!=answer)
  if combined.old.node_key(winner)==combined.old.node_key(loser):raise ValueError('Exact duplicate versions cannot define a preference loss')
  pairs.append({'task_id':tid,'winner':combined.old.node_key(winner),'loser':combined.old.node_key(loser),'creators':(winner['group'],),'cohort_kind':'prospective','subkind':winner['pilot_role_private']})
 return pairs

def export(root=ROOT,out=OUT):
 started=time.monotonic();report_path=check_evaluation(root)
 old=read_checked(BASE,BASE_SHA);nodes,old_pairs,lengths,reserved=combined.validated(old)
 manifest,_=evaluation.contract(root)
 snapshot=read_checked(Path(root)/'answer-snapshots'/f'answers.{SNAPSHOT_SHA}.json',SNAPSHOT_SHA)
 payload=evaluation.checked_snapshot(snapshot,manifest)
 assignments={intake.key(r):r for r in manifest['private_assignments']};frame_cache={};total=0;rows=[]
 for pref in payload['preference_rows']:
  if time.monotonic()-started>180:raise TimeoutError('Bounded numeric export expired')
  p=assignments[(pref['batch'],pref['position'])];receipt=p['frame_checkpoint'];path=Path(receipt['path']);cache_key=(str(path),receipt['sha256'])
  if cache_key not in frame_cache:
   total+=path.stat().st_size
   if total>256*1024**2 or prior.numeric.base.digest(path)!=receipt['sha256']:raise ValueError('Bounded pinned numeric inputs required')
   with zipfile.ZipFile(path) as z:
    if sum(i.file_size for i in z.infolist())>64*1024**2:raise ValueError('Bounded decompressed frames required')
   with np.load(path,allow_pickle=False) as z:
    if str(z['identity_sha256'])!=receipt['identity_sha256'] or receipt['identity_sha256']!=intake.digest(p['numeric_identity']):raise ValueError('Stored source generation differs')
    t=z['t'].copy();v=z['v'].copy()
   prior.check_vectors(t,v,p['source'],p['source']['duration_seconds'])
   if np.any(t<0) or np.any(t>p['source']['duration_seconds']):raise ValueError('Numeric frame points outside actual source duration')
   frame_cache[cache_key]=(t,v)
  t,v=frame_cache[cache_key]
  for side in ('a','b'):
   row=row_features(pref,side,p,t,v);key=combined.old.node_key(row)
   if key in nodes:
    existing=nodes[key]
    if existing[0]!=row['group'] or not np.allclose(existing[1],row['features'],rtol=0,atol=1e-9) or not np.allclose(existing[2],row['visual_mean'],rtol=0,atol=1e-7):raise ValueError('Old/new same-node feature conflict')
    row['features']=existing[1].tolist();row['visual_mean']=existing[2].tolist()
   nodes[key]=(row['group'],np.asarray(row['features'],dtype=float),np.asarray(row['visual_mean'],dtype=float))
   rows.append(row)
 pairs=strict_pairs(rows,reserved)
 if len(rows)!=32 or len(pairs)!=10 or len(old_pairs)!=22 or len(old['old_rows'])!=48 or len(old['version_rows'])!=12:raise ValueError('Exact92 sides/32 strict comparisons required')
 data={'schema_version':1,'format':'combined_prospective_offered_preference_v1','old_cohort_sha256':BASE_SHA,'prospective_manifest_sha256':evaluation.MANIFEST_SHA,'prospective_snapshot_sha256':SNAPSHOT_SHA,'prospective_report_sha256':REPORT_SHA,'export_source_sha256':prior.numeric.base.digest(Path(__file__)),'old_rows':copy.deepcopy(old['old_rows']),'version_rows':copy.deepcopy(old['version_rows']),'prospective_rows':rows,'reserved_creators_excluded':sorted(reserved),'target':'preferred_version_if_keep_one','visual_recipe':'unit_mean_unit_frames_inside_exact_offered_range','feature_names':old['feature_names'],'feature_recipe':old['feature_recipe'],'coarse_reserved_groups_excluded':old['coarse_reserved_groups_excluded'],'old_rows_unchanged':True,'ties_create_no_order':True,'new_acceptability':'unknown','new_cut_gold':'unknown','media_reads':0,'DB_queries':0,'fits':0,'production_writes':0,'evaluation_frozen_before_export':True,'dependencies':[{'path':str(p.resolve()),'sha256':prior.numeric.base.digest(p)} for p in (BASE,report_path,Path(__file__),Path(prior.numeric.__file__),Path(prior.numeric.recipe.__file__))]}
 evaluation.immutable(Path(out)/'feature_cohort.json',data)
 result={'status':'numeric_feature_join_ready','sides':92,'strict_pairs':32,'new_ties':6,'creators':len({g for pair in [*old_pairs,*pairs] for g in pair['creators']}),'cohort_sha256':prior.numeric.base.digest(Path(out)/'feature_cohort.json'),'seconds':time.monotonic()-started,'fits':0,'production_writes':0};evaluation.immutable(Path(out)/'export-receipt.json',result);print(json.dumps(result));return data

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=ROOT);parser.add_argument('--out',type=Path,default=OUT);a=parser.parse_args();signal.alarm(180);export(a.root,a.out)
