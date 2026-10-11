"""Fixed face-feature preference extension; preparation/fitting require reviewed pins.

Design follows observed22 training and16 prospective outcomes. It is NOT an
outcome-blind preregistration. Fine outcomes stay pure offered-version order;
no acceptance, cut gold, whole-worth, or automatic action is inferred. The
face detector's sparse observations are not continuous visibility/absence truth.
"""
from __future__ import annotations
import argparse,collections,copy,json,math,signal,time
from pathlib import Path
import numpy as np
import prospective_preference_features as inputs
import combined_blind_preference as prior
import face_offered_features_v3 as face

OUT=inputs.ROOT.parent/'paired-face-preference-v1'
COHORT=inputs.OUT/'feature_cohort.json'
COHORT_SHA='6a5aa01427e6832ac25243ec2ee4c0c9111d18a9c1bf15fcdd0a23bf5cdaade3'
KINDS=('face','duration','numeric','visual')
GATE={'minimum_strict_pairs':12,'minimum_creator_folds':6,'minimum_macro_accuracy':.75,'minimum_macro_gain':.05,'creator_macro_bootstrap_lower':0.0}
SPEC={'schema_version':1,'parent_cohort_sha256':COHORT_SHA,'timing':'Frozen before first face-extension fit AFTER22 training and16 prospective outcomes and face rationales were observed; NOT outcome-blind preregistration.',
      'target':'preferred_version_if_keep_one','primary':'D numeric13+trainingPCA8+softduration2+face4','matched_control':'C identical numeric13+trainingPCA8+softduration2+zero4',
      'numeric_control':'A numeric13+zero8+zero2+zero4','visual_diagnostic':'B numeric13+trainingPCA8+zero2+zero4; not a selection candidate',
      'C':1.0,'fit_intercept':False,'PCA_components':8,'seed':42,'training':prior.old.SPEC['training'],'visual_sampling':prior.old.SPEC['visual_sampling'],'folds':prior.old.SPEC['folds'],
      'duration_recipe':'log_hinges_180_900_v1','face_recipe':face.POLICY['recipe'],'face_features':face.FEATURES,'face_model_sha256':face.face.MODEL_SHA,
      'face_missing':'All92 exact offered versions must be available; never impute missing aszero. Sparse detection absence is not groundtruth.',
      'counts':{'old_sides':60,'prospective_sides':32,'ordinary_strict':17,'prior_blind_strict':5,'prospective_candidate_strict':5,'prospective_control_strict':5,'strict_total':32},
      'gate':GATE,'selection_policy':'D eligible only if BOTH D-vs-C andD-vs-A pass fixed gates. No positivity constraint, modelfamily grid, threshold tuning or diagnostic-head fallback.',
      'reserved':'Four reserved creator outcomes unopened and excluded globally before all PCA/scaler/head fitting.',
      'interpretation':'Learn face association with preference; two explicit face rationales belong toone creator. Do not claim a universal face requirement, exact action meaning or storage-worth.',
      'state_auxiliary':'No Stage1 state features in this primary comparison; globally personalized coarse-supervision overlap would require separate exploratory disclosure.',
      'budget_seconds':180,'automatic_action':False,'production_promotion':False}


def bounded_json(path,limit=16*1024**2):
 path=Path(path)
 if not path.is_file() or path.stat().st_size>limit:raise ValueError('Bounded numeric artifact required')
 return json.loads(path.read_text())


def rows_of(data):return data['old_rows']+data['version_rows']+data['prospective_rows']


def validated(data):
 base=inputs.read_checked(inputs.BASE,inputs.BASE_SHA);nodes,pairs,lengths,reserved=prior.validated(base)
 if data.get('format')!='combined_prospective_offered_preference_v1' or data.get('schema_version')!=1 or data.get('old_rows')!=base['old_rows'] or data.get('version_rows')!=base['version_rows'] or data.get('old_cohort_sha256')!=inputs.BASE_SHA or data.get('prospective_manifest_sha256')!=inputs.evaluation.MANIFEST_SHA or data.get('prospective_snapshot_sha256')!=inputs.SNAPSHOT_SHA or data.get('prospective_report_sha256')!=inputs.REPORT_SHA or data.get('export_source_sha256')!=prior.old.sha(inputs.__file__) or data.get('reserved_creators_excluded')!=sorted(reserved):raise ValueError('Authoritative immutable old60/new32 cohort differs')
 inputs.check_evaluation(inputs.ROOT);manifest,_=inputs.evaluation.contract(inputs.ROOT);snapshot=inputs.read_checked(inputs.ROOT/'answer-snapshots'/f'answers.{inputs.SNAPSHOT_SHA}.json',inputs.SNAPSHOT_SHA);payload=inputs.evaluation.checked_snapshot(snapshot,manifest)
 assignment={inputs.intake.key(p):p for p in manifest['private_assignments']};pref={p['task_id']:p for p in payload['preference_rows']};seen=set()
 for row in data['prospective_rows']:
  p=pref.get(row['task_id']);side=row['side']
  if p is None or side not in ('a','b') or (row['task_id'],side) in seen:raise ValueError('Exact prospective side required')
  seen.add((row['task_id'],side));a=assignment[(p['batch'],p['position'])];s=a['source'];identity=a['numeric_identity'];span=p[side]['range'];original=[q for q in identity['proposals'] if [q['start'],q['end']]==s['clip'] and q['score']==s['score']]
  if len(original)!=1:raise ValueError('Original source context ambiguous')
  expected={'position':p['position'],'batch':p['batch'],'answer':p['answer'],'answered_at':p['answered_at'],'ranking_y':int(p['answer']==side) if p['answer'] in ('a','b') else None,'numeric_identity':identity,'frame_cache':a['frame_checkpoint']['path'],'frame_checkpoint':a['frame_checkpoint'],'original_proposal_id':original[0]['id'],'original_range':s['clip'],'offered_range':span,'start':span[0],'end':span[1],'group':s['channel_key'],'channel':s['channel'],'duration_seconds':s['duration_seconds'],'score':s['score'],'pilot_role_private':a['pilot_role'],'future_replacement':'unknown','permanent_storage_worth':'unknown'}
  expected.update({k:s[k] for k in ('feedback_id','video_id','analyzed_at','source_fingerprint','index')})
  if any(row.get(k)!=v for k,v in expected.items()):raise ValueError('New exact preference/source provenance differs')
 newpairs=inputs.strict_pairs(data['prospective_rows'],reserved)
 if len(seen)!=32 or len(newpairs)!=10 or len(pairs)!=22 or len(rows_of(data))!=92 or {p['task_id'] for p in pairs}&{p['task_id'] for p in newpairs}:raise ValueError('Exact92 sides/32 independent task edges required')
 nodes=dict(nodes);lengths=dict(lengths)
 for row in data['prospective_rows']:
  key=prior.old.node_key(row);value=(row['group'],np.asarray(row['features'],float),np.asarray(row['visual_mean'],float));length=row['end']-row['start']
  if key in nodes and (nodes[key][0]!=value[0] or not np.array_equal(nodes[key][1],value[1]) or not np.array_equal(nodes[key][2],value[2]) or lengths[key]!=length):raise ValueError('Old/new exact offered node conflict')
  nodes[key]=value;lengths[key]=length
 return nodes,[*pairs,*newpairs],lengths,reserved


def face_key(identity,original,offered):return (face.source_key(identity),tuple(original),tuple(offered))


def join_face(rows,report,receipt):
 """No row-label join: exact generation/original/offered range and sampledpoints."""
 if report.get('status')!='complete' or report.get('available_version_count')!=92 or report.get('planned_version_count')!=92 or report.get('policy')!=face.POLICY or receipt.get('policy')!=face.POLICY or any(report.get(k)!=v for k,v in {'answers_used':False,'predictions_used':False,'fits':0,'raw_media_reads':0,'GPU':False,'DB_writes':0,'automatic_action':False}.items()):raise ValueError('All92 complete fixed face features required')
 if receipt.get('source_sha256')!=prior.old.sha(face.__file__) or receipt.get('pilot_helper_sha256')!=prior.old.sha(face.face.__file__) or receipt.get('model',{}).get('sha256')!=face.face.MODEL_SHA:raise ValueError('Fixed extractor/model source receipt differs')
 available={};count=0
 if set(report['sources'])!=set(receipt['sources']):raise ValueError('Exact completed face source inventory differs')
 for key,source in receipt['sources'].items():
  if key!=face.source_key(source['identity']):raise ValueError('Face source identity checksum differs')
  got=report['sources'][key]
  if got.get('source_key')!=key or got.get('identity_sha256')!=key:raise ValueError('Completed face generation identity differs')
  planned={r['row']:r for r in source['rows']};observed={r['row']:r for r in got['rows']}
  if len(planned)!=len(source['rows']) or len(observed)!=len(got['rows']) or set(planned)!=set(observed):raise ValueError('Complete exact face offered rows required')
  timeline=source['full_timestamps'];times=np.asarray(timeline,float)
  if times.ndim!=1 or not 1<=len(times)<=8000 or times.shape!=(source['identity']['index']['frame_count'],) or not np.isfinite(times).all() or np.any(np.diff(times)<=0) or not np.allclose(np.diff(times),5,atol=.001) or times[0]<0 or times[0]>5.001 or times[-1]>source['identity']['duration'] or times[-1]+10<source['identity']['duration']:raise ValueError('Frozen full face point timeline invalid')
  for label,p in planned.items():
   r=observed[label];count+=1;ids=p['point_indices'];values=r['features']
   if ids!=face.sample_indices(times,p['offered_range']):raise ValueError('Fixed uniform offered-point sampling differs')
   if r.get('availability') is not True or r.get('offered_range')!=p['offered_range'] or r.get('point_indices')!=ids or r.get('sample_count')!=len(ids) or r.get('sampled_timestamps')!=[timeline[i] for i in ids] or r.get('absence_is_ground_truth') is not False or r.get('continuous_coverage_estimated') is not False:raise ValueError('Exact offered face points unavailable/mismatched')
   if len(values)!=4 or any(isinstance(x,bool) or not isinstance(x,(int,float)) or not math.isfinite(x) or not 0<=x<=1 for x in values):raise ValueError('Finite4 sampled face geometry values required')
   k=face_key(source['identity'],p['original_range'],p['offered_range']);v=np.asarray(values,float)
   if k in available and not np.array_equal(available[k],v):raise ValueError('Same offered version face conflict')
   available[k]=v
 if count!=92 or len(rows)!=92:raise ValueError('All92 version availability required')
 result={}
 for row in rows:
  identity=row['numeric_identity'];key=face_key(identity,row['original_range'],row['offered_range']);source=receipt['sources'].get(key[0]);frame=row['frame_checkpoint']
  if source is None or identity!=source['identity'] or row['group']!=source['group'] or frame['sha256']!=source['frame_checkpoint']['sha256'] or frame['identity_sha256']!=key[0] or key not in available:raise ValueError('Exact feature source/range/checkpoint join unavailable')
  if not any(p['feedback_id']==row['feedback_id'] and p['original_range']==row['original_range'] and p['offered_range']==row['offered_range'] for p in source['rows']):raise ValueError('Exact offered feedback receipt missing')
  node=prior.old.node_key(row);value=available[key]
  if node in result and not np.array_equal(result[node],value):raise ValueError('Exact offered node face conflict')
  result[node]=value
 return result


def validate_completed_checkpoints(report,receipt,receipt_sha,root):
 """Regenerate the summary from bounded numeric checkpoints, never sprite images."""
 total=0
 if set(report['sources'])!=set(receipt['sources']):raise ValueError('Exact completed checkpoint inventory differs')
 for key,source in receipt['sources'].items():
  candidates=[];directory=Path(root)/'sources'/key
  for path in sorted(directory.glob('checkpoint.*.json')):
   if path.stat().st_size>4*1024**2:raise ValueError('Numeric detection checkpoint exceeds bound')
   total+=path.stat().st_size
   if total>16*1024**2:raise ValueError('Bounded total numeric checkpoint reads exceeded')
   sha=prior.old.sha(path)
   if path.name!=f'checkpoint.{sha}.json':raise ValueError('Numeric detection checkpoint filename/checksum differs')
   value=bounded_json(path,4*1024**2)
   if value.get('input_receipt_sha256')!=receipt_sha:continue
   frames=face.validate_checkpoint(value,key,source,receipt_sha)
   if value.get('complete') is not True:continue
   regenerated=face.aggregate(source['rows'],frames)
   if regenerated!=report['sources'][key]['rows']:raise ValueError('Face summary differs from exact validated numeric detections')
   candidates.append(path)
  if not candidates:raise ValueError('Exact complete per-source numeric checkpoint missing; no imputation')
 return True


def load(cohort,face_report):
 if prior.old.sha(cohort)!=COHORT_SHA:raise ValueError('Exact92-side parent cohort checksum differs')
 data=bounded_json(cohort);nodes,pairs,lengths,reserved=validated(data);face_report=Path(face_report);report=bounded_json(face_report);report_sha=prior.old.sha(face_report)
 if face_report.name!=f'features.{report_sha}.json':raise ValueError('Immutable face report filename/checksum differs')
 receipt_sha=report['input_receipt_sha256'];receipt_path=face_report.parent/f'inputs.{receipt_sha}.json';receipt=bounded_json(receipt_path)
 if prior.old.sha(receipt_path)!=receipt_sha or receipt.get('reserved_creators_excluded')!=sorted(reserved):raise ValueError('Exact face input/reserved receipt differs')
 validate_completed_checkpoints(report,receipt,receipt_sha,face_report.parent)
 faces=join_face(rows_of(data),report,receipt)
 return nodes,pairs,lengths,reserved,faces,receipt_path


def training_pairs(pairs,held):return [p for p in pairs if not set(p['creators'])&set(held)]


def preflight(nodes,pairs,lengths,faces):
 groups=sorted({g for p in pairs for g in p['creators']})
 if set(nodes)!=set(lengths) or set(nodes)!=set(faces):raise ValueError('All nodes must have identical numeric/duration/face coverage')
 for key,(group,x,v) in nodes.items():
  if np.asarray(x).shape!=(13,) or np.asarray(v).shape!=(1152,) or np.asarray(faces[key]).shape!=(4,) or not all(np.isfinite(a).all() for a in (x,v,faces[key])) or abs(np.linalg.norm(v)-1)>.02 or not math.isfinite(lengths[key]) or lengths[key]<=0:raise ValueError('Finite matched model inputs required')
 for group in groups:
  train=training_pairs(pairs,{group});keys={p[k] for p in train for k in ('winner','loser')}
  if len(keys)<9 or any(nodes[k][0]==group for k in keys):raise ValueError('All trainfold coverage/exclusions must pass BEFORE any fit')
 return groups


class Fit:
 def fit(self,nodes,pairs,lengths,faces):
  self.keys=sorted({p[k] for p in pairs for k in ('winner','loser')});self.groups=sorted({nodes[k][0] for k in self.keys})
  if len(self.keys)<9 or not pairs:raise ValueError('Training-only PCA8 coverage required')
  X=np.asarray([nodes[k][1] for k in self.keys]);V=np.asarray([nodes[k][2] for k in self.keys]);H=np.asarray([prior.hinges(lengths[k]) for k in self.keys]);F=np.asarray([faces[k] for k in self.keys]);self.pca=prior.old.PCA(n_components=8,svd_solver='full').fit(V);z=np.c_[X,self.pca.transform(V),H,F];index={k:i for i,k in enumerate(self.keys)};diff=np.asarray([z[index[p['winner']]]-z[index[p['loser']]] for p in pairs]);self.scale=prior.old.StandardScaler().fit(np.r_[diff,-diff]);self.models={}
  for kind in KINDS:
   design=self.scale.transform(self.design(X,V,H,F,kind));d=np.asarray([design[index[p['winner']]]-design[index[p['loser']]] for p in pairs]);self.models[kind]=prior.old.LogisticRegression(C=1.,fit_intercept=False,solver='liblinear',max_iter=5000,tol=1e-9,random_state=42).fit(np.r_[d,-d],np.r_[np.ones(len(d)),np.zeros(len(d))],sample_weight=np.full(2*len(d),.5))
  return self
 def design(self,X,V,H,F,kind):
  z=np.c_[X,self.pca.transform(V),H,F]
  if kind=='numeric':z[:,13:]=0
  elif kind=='visual':z[:,21:]=0
  elif kind=='duration':z[:,23:]=0
  elif kind!='face':raise ValueError('Unknown fixed comparison head')
  return z
 def score(self,nodes,lengths,faces,kind):
  keys=sorted(nodes);X=np.asarray([nodes[k][1] for k in keys]);V=np.asarray([nodes[k][2] for k in keys]);H=np.asarray([prior.hinges(lengths[k]) for k in keys]);F=np.asarray([faces[k] for k in keys]);scores=self.models[kind].decision_function(self.scale.transform(self.design(X,V,H,F,kind)))
  if not np.isfinite(scores).all():raise ValueError('Nonfinite preference scores')
  return dict(zip(keys,map(float,scores)))
 def export(self,kind):
  raw=self.models[kind].coef_[0]/self.scale.scale_;vw=raw[13:21]@self.pca.components_ if kind!='numeric' else np.zeros(1152);hw=raw[21:23] if kind in ('face','duration') else np.zeros(2);fw=raw[23:27] if kind=='face' else np.zeros(4);bias=-float(raw@self.scale.mean_+vw@self.pca.mean_)
  head={'schema_version':1,'kind':'offered_version_face_preference_linear','numeric_weights':raw[:13].tolist(),'visual_weights':vw.tolist(),'duration_weights':hw.tolist(),'face_weights':fw.tolist(),'soft_preferred_seconds':[180,900],'visual_recipe':'unit_mean_unit_frames_inside_exact_offered_range','feature_recipe':'recording-v1-replace_exact_offered_proposal','duration_recipe':'log_hinges_180_900_v1','face_recipe':face.POLICY['recipe'],'face_feature_names':face.FEATURES,'face_model_sha256':face.face.MODEL_SHA,'bias':bias,'target':SPEC['target'],'probability_calibrated':False,'automatic_action':False}
  if not all(np.isfinite(head[k]).all() for k in ('numeric_weights','visual_weights','duration_weights','face_weights')) or not math.isfinite(bias):raise ValueError('Nonfinite portable coefficients')
  return head


def validate_head(head):
 required={'schema_version','kind','numeric_weights','visual_weights','duration_weights','face_weights','soft_preferred_seconds','visual_recipe','feature_recipe','duration_recipe','face_recipe','face_feature_names','face_model_sha256','bias','target','probability_calibrated','automatic_action'}
 if not isinstance(head,dict) or set(head)!=required or type(head['schema_version']) is not int or head['schema_version']!=1 or head['kind']!='offered_version_face_preference_linear' or head['target']!=SPEC['target'] or head['soft_preferred_seconds']!=[180,900] or head['visual_recipe']!='unit_mean_unit_frames_inside_exact_offered_range' or head['feature_recipe']!='recording-v1-replace_exact_offered_proposal' or head['duration_recipe']!='log_hinges_180_900_v1' or head['face_recipe']!=face.POLICY['recipe'] or head['face_feature_names']!=face.FEATURES or head['face_model_sha256']!=face.face.MODEL_SHA or head['automatic_action'] is not False or head['probability_calibrated'] is not False:raise ValueError('Unsupported isolated face preference head')
 for key,width in [('numeric_weights',13),('visual_weights',1152),('duration_weights',2),('face_weights',4)]:
  a=head[key]
  if not isinstance(a,list) or len(a)!=width or any(isinstance(z,bool) or not isinstance(z,(int,float)) or not math.isfinite(z) for z in a):raise ValueError('Finite portable coefficient widths required')
 if isinstance(head['bias'],bool) or not isinstance(head['bias'],(int,float)) or not math.isfinite(head['bias']):raise ValueError('Finite portable bias required')
 return head


def portable(head,nodes,lengths,faces):
 validate_head(head)
 values={k:float(head['bias']+np.dot(head['numeric_weights'],n[1])+np.dot(head['visual_weights'],n[2])+np.dot(head['duration_weights'],prior.hinges(lengths[k]))+np.dot(head['face_weights'],faces[k])) for k,n in nodes.items()}
 if not all(math.isfinite(v) for v in values.values()):raise ValueError('Nonfinite portable score')
 return values


def dependencies(cohort,face_report,receipt):
 return [{'path':str(Path(p).resolve()),'sha256':prior.old.sha(p)} for p in (cohort,face_report,receipt,__file__,inputs.__file__,prior.__file__,prior.old.__file__,face.__file__,face.face.__file__,prior.features.__file__,prior.features.numeric.__file__,prior.features.numeric.recipe.__file__)]


def prepared_spec(cohort,face_report,receipt,groups,reserved):
 return dict(SPEC,dependencies=dependencies(cohort,face_report,receipt),cohort_sha256=prior.old.sha(cohort),face_report_sha256=prior.old.sha(face_report),face_input_receipt_sha256=prior.old.sha(receipt),creator_folds=len(groups),reserved_creators=sorted(reserved))


def prepare(cohort,face_report,out):
 nodes,pairs,lengths,reserved,faces,receipt=load(cohort,face_report);groups=preflight(nodes,pairs,lengths,faces);spec=prepared_spec(cohort,face_report,receipt,groups,reserved);prior.old.frozen(Path(out)/'before-first-fit.json',spec);print(json.dumps({'status':'prepared_no_fit','strict_pairs':len(pairs),'creator_folds':len(groups),'spec_sha256':prior.old.sha(Path(out)/'before-first-fit.json')}));return spec


def gate(macro,delta,interval,pairs,groups):
 return bool(len(pairs)>=12 and len(groups)>=6 and macro>=.75 and float(np.mean(delta))>=.05 and interval[0]>0)


def fit_round(cohort,face_report,out):
 started=time.monotonic();deadline=started+180;out=Path(out);nodes,pairs,lengths,reserved,faces,receipt=load(cohort,face_report);groups=preflight(nodes,pairs,lengths,faces);spec=bounded_json(out/'before-first-fit.json')
 if spec!=prepared_spec(cohort,face_report,receipt,groups,reserved):raise ValueError('Reviewed before-first-fit source/input pins changed')
 if (out/'attempt.json').exists():raise ValueError('Single fixed attempt already recorded; no automatic retry')
 prior.old.frozen(out/'attempt.json',{'spec_sha256':prior.old.sha(out/'before-first-fit.json'),'status':'started_single_attempt'});folds=[];unique=collections.defaultdict(lambda:collections.defaultdict(list))
 for group in groups:
  prior.old.check(deadline);train=training_pairs(pairs,{group});test=[p for p in pairs if group in p['creators']];model=Fit().fit(nodes,train,lengths,faces)
  if group in model.groups:raise ValueError('Held creator entered PCA/scaler/head')
  results={}
  for kind in KINDS:
   margins=prior.old.margins(test,model.score(nodes,lengths,faces,kind));results[kind]={'accuracy':prior.old.accuracy(list(margins.values())),'margins':margins}
   for tid,value in margins.items():unique[tid][kind].append(value)
  folds.append({'held_creator':group,'train_nodes':model.keys,'train_creators':model.groups,'training_pairs':len(train),'testing_pairs':len(test),'results':results})
 macro={k:float(np.mean([f['results'][k]['accuracy'] for f in folds])) for k in KINDS};delta={name:np.asarray([f['results']['face']['accuracy']-f['results'][control]['accuracy'] for f in folds]) for name,control in [('face_vs_duration','duration'),('face_vs_numeric','numeric')]};rng=np.random.default_rng(42);indices=rng.integers(0,len(folds),size=(2000,len(folds)));ci={k:np.quantile(np.mean(v[indices],axis=1),[.025,.975]).tolist() for k,v in delta.items()};gates={k:gate(macro['face'],v,ci[k],pairs,groups) for k,v in delta.items()};passed=all(gates.values());subsets={}
 for scope,test in [('ordinary17',[p for p in pairs if p['cohort_kind']=='ordinary']),('prior_blind5',[p for p in pairs if p['cohort_kind']=='blind']),('prospective_candidate5',[p for p in pairs if p['cohort_kind']=='prospective' and p['subkind']=='model_vs_human']),('prospective_control5',[p for p in pairs if p['cohort_kind']=='prospective' and p['subkind']=='same_duration_location'])]:
  subsets[scope]={'strict_pairs':len(test),'unique_accuracy':{k:prior.old.accuracy([float(np.mean(unique[p['task_id']][k])) for p in test]) for k in KINDS}}
 prior.old.check(deadline);final=Fit().fit(nodes,pairs,lengths,faces);heads={k:final.export(k) for k in KINDS};parity={}
 for k,head in heads.items():
  direct=final.score(nodes,lengths,faces,k);got=portable(head,nodes,lengths,faces);parity[k]=max(abs(direct[n]-got[n]) for n in nodes)
  if not math.isfinite(parity[k]) or parity[k]>1e-7:raise ValueError('Portable exact offered face-head parity failed')
 effects={k:{'face_weights':h['face_weights'],'face_names':face.FEATURES,'duration_weights':h['duration_weights'],'log_seconds_weight':h['numeric_weights'][0],'effective_log_seconds_slopes':{'below180':h['numeric_weights'][0]-h['duration_weights'][0],'180to900':h['numeric_weights'][0],'above900':h['numeric_weights'][0]+h['duration_weights'][1]},'limit':'Partial holding other correlated numeric/visual inputs fixed; no guaranteed positive face effect or3–15minute utility.'} for k,h in heads.items()}
 report={'strict_unique_pairs':len(pairs),'creator_folds':len(groups),'macro_accuracy':macro,'paired_macro_gains':{k:float(v.mean()) for k,v in delta.items()},'paired_creator_bootstrap_95':ci,'paired_gates':gates,'gate_passed':passed,'selected_head':'face' if passed else None,'subsets':subsets,'folds':folds,'feature_effects':effects,'portable_parity_max_error':parity,'seconds':time.monotonic()-started,'labels_seen_before_design':True,'heldout_opened':False,'production_changed':False,'limitations':['Sparse face detections are not continuous visibility or absence groundtruth.','Two explicit face rationales are one source/creator; inference is learned across preference edges, not a universal face constraint.','Ties supply no order, acceptance, exactcut or recording-worth gold.','State/action-proxy features are absent from this primary comparison.']}
 prior.old.frozen(out/'training_report.json',report);prior.old.frozen(out/'frozen_candidate.json',{'schema_version':1,'heads':heads,'training_gate_passed':passed,'selected_head':report['selected_head'],'training_creators':groups,'reserved_creators':sorted(reserved),'cohort_sha256':prior.old.sha(cohort),'spec_sha256':prior.old.sha(out/'before-first-fit.json'),'report_sha256':prior.old.sha(out/'training_report.json'),'automatic_action':False,'production_promotion':False});print(json.dumps({k:report[k] for k in ('strict_unique_pairs','creator_folds','macro_accuracy','paired_macro_gains','paired_creator_bootstrap_95','paired_gates','gate_passed','subsets','seconds')}));return report

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['prepare','fit']);p.add_argument('--cohort',type=Path,default=COHORT);p.add_argument('--face-report',type=Path,required=True);p.add_argument('--out',type=Path,default=OUT);a=p.parse_args();signal.alarm(180);{'prepare':prepare,'fit':fit_round}[a.mode](a.cohort,a.face_report,a.out)
