"""One fixed exploratory face-with-action comparison, numeric caches only.

No head can be selected or promoted: fixed global Stage1 coarse/state supervision
is not excluded inside the fine creator folds. No new labels or cut constraints.
"""
from __future__ import annotations
import argparse,collections,json,math,signal,time
from pathlib import Path
import numpy as np
import paired_face_preference as base
import offered_face_action_features as auxiliary
OUT=base.OUT.parent/'paired-face-action-preference-v1'
AUX=auxiliary.OUT/'features.json'
AUX_SHA='d8b22ceca110387e82ba90df68bd475a2b3534acd7c4ecb2f3f3f833a9b8845d'
EXPORT_SPEC_SHA='024e4383835234b5638efd36577d04d4318d4ebcbb618469699df5e7980d821b'
KINDS=('joint','face','duration')
JOINT_NAMES=['sampled_face_detected_x_action_proxy_mean','sampled_face_confidence_x_action_proxy_max']
SPEC={'schema_version':1,'target':'preferred_version_if_keep_one','timing':'Frozen before first joint-action fit AFTER prior preference outcomes across92 offered sides and unsuccessful face-only fit observed; NOT outcome-blind preregistration.','primary_diagnostic':'E numeric13+trainingPCA8+softduration2+face4+state8+joint2','matched_face_control':'D identical37columns withaux10 zero','matched_duration_control':'C identical37columns withface4+aux10 zero','C':1.,'fit_intercept':False,'seed':42,'PCA_components':8,'scaling':'Training-only StandardScaler fit on pair differences and negations,37columns; PCA on unique participating training nodes only.','pair_weights':'Exactly.5 per signed winner-minus-loser and loser-minus-winner, total1 per answered strict comparison.','folds':'Leave one whole creator out; drop entirecrosscreatorpair if EITHER creator held; four reserved creators excluded globally.','counts':{'offered_versions':92,'strict_pairs':32,'creator_folds':19,'subsets':[17,5,5,5]},'state_features':auxiliary.state.FEATURE_NAMES,'joint_features':JOINT_NAMES,'face_features':base.face.FEATURES,'state_probe_sha256':auxiliary.state.PROBE_SHA256,'face_model_sha256':base.face.face.MODEL_SHA,'parent_cohort_sha256':base.COHORT_SHA,'duration_recipe':'log_hinges_180_900_v1','budget_seconds':180,'exploratory':True,'selected_head':None,'selection_allowed':False,'production_promotion':False,'automatic_action':False,'supervised_overlap':'Fixedglobal Stage1 includes personal historicalstate labels pluscoarse wrong-negative mining. Auxiliarysupervision was NOT excluded inside finecreatorfolds; this cannot establish all-pipeline unseencreator generalization.','labels':'StrictansweredA/B offered-version order only. Ties addnoequality/order/acceptability/cut/whole/storage labels.','model_grid':False,'hard_face_or_action_requirement':False}

def unique_proposal(row):
 matching=[p for p in row['numeric_identity']['proposals'] if [p['start'],p['end']]==row['original_range']]
 if len(matching)!=1 or ('original_proposal_id' in row and row['original_proposal_id']!=matching[0]['id']):raise ValueError('Exact immutable original proposal ambiguous')
 return matching[0]['id']

def join_aux(rows,artifact,face_receipt):
 if artifact.get('schema_version')!=1 or artifact.get('policy')!=auxiliary.POLICY or artifact.get('parent_cohort_sha256')!=base.COHORT_SHA or artifact.get('face_report_sha256')!=auxiliary.FACE_REPORT_SHA or artifact.get('probe_sha256')!=auxiliary.state.PROBE_SHA256 or artifact.get('fits')!=0 or artifact.get('production_changed') is not False or artifact.get('reserved_outcomes_opened') is not False:raise ValueError('Exact exploratory auxiliary artifact required')
 if auxiliary.FEATURE_NAMES!=auxiliary.state.FEATURE_NAMES+JOINT_NAMES:raise ValueError('Fixed state8/mean-detected/max-confidence cooccurrence recipe differs')
 got=artifact.get('rows')
 if not isinstance(got,list) or len(got)!=92 or len(rows)!=92:raise ValueError('All92 matched offered sides required')
 by={}
 for r in got:
  key=(r['task_id'],r['side'])
  if key in by:raise ValueError('Duplicate auxiliary task side')
  by[key]=r
 required={'row','task_id','side','node_key','source_key','original_proposal_id','original_range','offered_range','features','sampled_point_indices','sampled_timestamps','availability','action_proxy_is_truth','labels_created'};out={}
 if set(by)!={(r['task_id'],r['side']) for r in rows}:raise ValueError('Auxiliary task-side inventory differs')
 for row in rows:
  r=by[(row['task_id'],row['side'])];sourcekey=base.face.source_key(row['numeric_identity']);source=face_receipt['sources'].get(sourcekey)
  if source is None or source['identity']!=row['numeric_identity'] or source['group']!=row['group'] or row['frame_checkpoint']['identity_sha256']!=sourcekey or row['frame_checkpoint']['sha256']!=source['frame_checkpoint']['sha256']:raise ValueError('Auxiliary exactsource/frame binding missing')
  span=row['offered_range'];times=np.asarray(source['full_timestamps'],float);indices=base.face.sample_indices(times,span);node=base.prior.old.node_key(row)
  expected={'row':row['row'],'task_id':row['task_id'],'side':row['side'],'node_key':node,'source_key':sourcekey,'original_proposal_id':unique_proposal(row),'original_range':row['original_range'],'offered_range':span,'sampled_point_indices':indices,'sampled_timestamps':times[indices].tolist(),'availability':True,'action_proxy_is_truth':False,'labels_created':False}
  if set(r)!=required or any(r.get(k)!=v for k,v in expected.items()):raise ValueError('Auxiliary exact offered source/proposal/timeline differs')
  values=r['features']
  if not isinstance(values,list) or len(values)!=10 or any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or not 0<=v<=1+1e-7 for v in values):raise ValueError('Finite complete state8/joint2 required')
  if node in out and not np.array_equal(out[node],values):raise ValueError('Duplicate exactnode auxiliary values differ')
  out[node]=np.asarray(values,float)
 return out

def load(cohort,face_report,aux_path):
 if base.prior.old.sha(aux_path)!=AUX_SHA or base.prior.old.sha(Path(aux_path).parent/'before-export.json')!=EXPORT_SPEC_SHA:raise ValueError('Exact root-reviewed complete auxiliary artifact/spec changed')
 nodes,pairs,lengths,reserved,faces,receipt_path=base.load(cohort,face_report);data=base.bounded_json(cohort);artifact=base.bounded_json(aux_path);planpath=Path(aux_path).parent/'before-export.json';plan=base.bounded_json(planpath)
 if artifact.get('spec_sha256')!=base.prior.old.sha(planpath) or {k:v for k,v in plan.items() if k not in ('dependencies','source_count','version_count','checkpoints','numeric_frames','projected_numeric_read_bytes')}!=auxiliary.POLICY:raise ValueError('Immutable auxiliary source/export policy differs')
 if plan.get('source_count')!=33 or plan.get('version_count')!=92:raise ValueError('Fixed complete auxiliary coverage required')
 for dependency in plan['dependencies']:
  if base.prior.old.sha(dependency['path'])!=dependency['sha256']:raise ValueError('Auxiliary exporter/helper dependency changed')
 if str(Path(auxiliary.__file__).resolve()) not in {d['path'] for d in plan['dependencies']}:raise ValueError('Actual auxiliary exporter source pin missing')
 receipt=base.bounded_json(receipt_path);values=join_aux(base.rows_of(data),artifact,receipt)
 checked=auxiliary.join_features(artifact,base.rows_of(data),receipt,spec_sha256=base.prior.old.sha(planpath),export_source_sha256=base.prior.old.sha(auxiliary.__file__))
 if set(checked)!=set(values) or any(not np.array_equal(checked[k],values[k]) for k in values):raise ValueError('Shared exporter/join validation differs')
 return nodes,pairs,lengths,reserved,faces,values,receipt_path,planpath

def preflight(nodes,pairs,lengths,faces,aux):
 groups=base.preflight(nodes,pairs,lengths,faces)
 if set(aux)!=set(nodes):raise ValueError('Matched auxiliary node coverage differs')
 if any(np.asarray(x).shape!=(10,) or not np.isfinite(x).all() for x in aux.values()):raise ValueError('Finite fixed10 auxiliary columns required')
 if len(pairs)!=32 or len(groups)!=19:raise ValueError('Fixed32strict/19creator cohort required')
 return groups

class Fit:
 def fit(self,nodes,pairs,lengths,faces,aux):
  self.keys=sorted({p[k] for p in pairs for k in ('winner','loser')});self.groups=sorted({nodes[k][0] for k in self.keys})
  if len(self.keys)<9 or not pairs:raise ValueError('Training-only PCA8 coverage required')
  X=np.asarray([nodes[k][1] for k in self.keys]);V=np.asarray([nodes[k][2] for k in self.keys]);H=np.asarray([base.prior.hinges(lengths[k]) for k in self.keys]);F=np.asarray([faces[k] for k in self.keys]);A=np.asarray([aux[k] for k in self.keys]);self.pca=base.prior.old.PCA(n_components=8,svd_solver='full').fit(V);z=np.c_[X,self.pca.transform(V),H,F,A];index={k:i for i,k in enumerate(self.keys)};diff=np.asarray([z[index[p['winner']]]-z[index[p['loser']]] for p in pairs]);self.scale=base.prior.old.StandardScaler().fit(np.r_[diff,-diff]);self.models={}
  for kind in KINDS:
   design=self.scale.transform(self.design(X,V,H,F,A,kind));d=np.asarray([design[index[p['winner']]]-design[index[p['loser']]] for p in pairs]);self.models[kind]=base.prior.old.LogisticRegression(C=1.,fit_intercept=False,solver='liblinear',max_iter=5000,tol=1e-9,random_state=42).fit(np.r_[d,-d],np.r_[np.ones(len(d)),np.zeros(len(d))],sample_weight=np.full(2*len(d),.5))
  return self
 def design(self,X,V,H,F,A,kind):
  z=np.c_[X,self.pca.transform(V),H,F,A]
  if kind=='duration':z[:,23:]=0
  elif kind=='face':z[:,27:]=0
  elif kind!='joint':raise ValueError('Unknown fixed exploratory head')
  return z
 def score(self,nodes,lengths,faces,aux,kind):
  keys=sorted(nodes);X=np.asarray([nodes[k][1] for k in keys]);V=np.asarray([nodes[k][2] for k in keys]);H=np.asarray([base.prior.hinges(lengths[k]) for k in keys]);F=np.asarray([faces[k] for k in keys]);A=np.asarray([aux[k] for k in keys]);scores=self.models[kind].decision_function(self.scale.transform(self.design(X,V,H,F,A,kind)))
  if not np.isfinite(scores).all():raise ValueError('Nonfinite exploratory scores')
  return dict(zip(keys,map(float,scores)))
 def export(self,kind):
  raw=self.models[kind].coef_[0]/self.scale.scale_;vw=raw[13:21]@self.pca.components_;fw=raw[23:27] if kind in ('joint','face') else np.zeros(4);aw=raw[27:37] if kind=='joint' else np.zeros(10);bias=-float(raw@self.scale.mean_+vw@self.pca.mean_)
  return {'schema_version':1,'kind':'exploratory_only_offered_face_action_linear','numeric_weights':raw[:13].tolist(),'visual_weights':vw.tolist(),'duration_weights':raw[21:23].tolist(),'face_weights':fw.tolist(),'auxiliary_weights':aw.tolist(),'bias':bias,'auxiliary_feature_names':auxiliary.state.FEATURE_NAMES+JOINT_NAMES,'face_feature_names':base.face.FEATURES,'probe_sha256':auxiliary.state.PROBE_SHA256,'face_model_sha256':base.face.face.MODEL_SHA,'target':SPEC['target'],'exploratory':True,'probability_calibrated':False,'automatic_action':False,'production_usable':False,'promotion_allowed':False}

def portable(head,nodes,lengths,faces,aux):
 if head.get('kind')!='exploratory_only_offered_face_action_linear' or head.get('exploratory') is not True or head.get('production_usable') is not False or head.get('promotion_allowed') is not False:raise ValueError('Exploratory-only diagnostic weights required')
 for k,n in [('numeric_weights',13),('visual_weights',1152),('duration_weights',2),('face_weights',4),('auxiliary_weights',10)]:
  if not isinstance(head.get(k),list) or len(head[k])!=n or any(isinstance(x,bool) or not isinstance(x,(int,float)) or not math.isfinite(x) for x in head[k]):raise ValueError('Finite exact diagnostic coefficient widths required')
 if isinstance(head.get('bias'),bool) or not isinstance(head['bias'],(int,float)) or not math.isfinite(head['bias']):raise ValueError('Finite diagnostic bias required')
 return {k:float(head['bias']+np.dot(head['numeric_weights'],v[1])+np.dot(head['visual_weights'],v[2])+np.dot(head['duration_weights'],base.prior.hinges(lengths[k]))+np.dot(head['face_weights'],faces[k])+np.dot(head['auxiliary_weights'],aux[k])) for k,v in nodes.items()}

def dependencies(cohort,face_report,aux_path,receipt,plan):
 return [{'path':str(Path(p).resolve()),'sha256':base.prior.old.sha(p)} for p in (cohort,face_report,aux_path,receipt,plan,__file__,base.__file__,auxiliary.__file__,auxiliary.state.__file__,base.face.__file__,base.prior.__file__,base.prior.old.__file__)]
def frozen_spec(cohort,face_report,aux_path,receipt,plan,groups,reserved):return dict(SPEC,dependencies=dependencies(cohort,face_report,aux_path,receipt,plan),creator_folds=len(groups),reserved_creators=sorted(reserved),aux_feature_names=auxiliary.FEATURE_NAMES)

def prepare(cohort,face_report,aux_path,out):
 nodes,pairs,lengths,reserved,faces,aux,receipt,plan=load(cohort,face_report,aux_path);groups=preflight(nodes,pairs,lengths,faces,aux);spec=frozen_spec(cohort,face_report,aux_path,receipt,plan,groups,reserved);base.prior.old.frozen(Path(out)/'before-first-fit.json',spec);return {'status':'prepared_no_fit','strict_pairs':32,'creator_folds':19,'spec_sha256':base.prior.old.sha(Path(out)/'before-first-fit.json'),'promotion_allowed':False}

def fit_round(cohort,face_report,aux_path,out):
 start=time.monotonic();deadline=start+180;out=Path(out);nodes,pairs,lengths,reserved,faces,aux,receipt,plan=load(cohort,face_report,aux_path);groups=preflight(nodes,pairs,lengths,faces,aux)
 if base.bounded_json(out/'before-first-fit.json')!=frozen_spec(cohort,face_report,aux_path,receipt,plan,groups,reserved):raise ValueError('Frozen before-first-fit bindings changed')
 if (out/'attempt.json').exists():raise ValueError('Single exploratory attempt already recorded')
 base.prior.old.frozen(out/'attempt.json',{'status':'started_single_fixed_diagnostic','spec_sha256':base.prior.old.sha(out/'before-first-fit.json')});folds=[];unique=collections.defaultdict(lambda:collections.defaultdict(list))
 for group in groups:
  base.prior.old.check(deadline);train=base.training_pairs(pairs,{group});test=[p for p in pairs if group in p['creators']];model=Fit().fit(nodes,train,lengths,faces,aux)
  if group in model.groups:raise ValueError('Held creator entered fine PCA/scaler/head')
  results={}
  for kind in KINDS:
   margins=base.prior.old.margins(test,model.score(nodes,lengths,faces,aux,kind));results[kind]={'accuracy':base.prior.old.accuracy(list(margins.values())),'margins':margins}
   for task,value in margins.items():unique[task][kind].append(value)
  folds.append({'held_creator':group,'training_nodes':model.keys,'training_creators':model.groups,'training_pairs':len(train),'testing_pairs':len(test),'results':results})
 macro={k:float(np.mean([f['results'][k]['accuracy'] for f in folds])) for k in KINDS};deltas={name:np.asarray([f['results']['joint']['accuracy']-f['results'][control]['accuracy'] for f in folds]) for name,control in [('joint_vs_face','face'),('joint_vs_duration','duration')]};rng=np.random.default_rng(42);indices=rng.integers(0,len(folds),size=(2000,len(folds)));cis={k:np.quantile(np.mean(v[indices],axis=1),[.025,.975]).tolist() for k,v in deltas.items()};subsets={}
 for name,test in [('ordinary17',[p for p in pairs if p['cohort_kind']=='ordinary']),('prior_blind5',[p for p in pairs if p['cohort_kind']=='blind']),('prospective_candidate5',[p for p in pairs if p['cohort_kind']=='prospective' and p['subkind']=='model_vs_human']),('prospective_control5',[p for p in pairs if p['cohort_kind']=='prospective' and p['subkind']=='same_duration_location'])]:
  subsets[name]={'strict_pairs':len(test),'unique_accuracy':{k:base.prior.old.accuracy([float(np.mean(unique[p['task_id']][k])) for p in test]) for k in KINDS}}
 base.prior.old.check(deadline);final=Fit().fit(nodes,pairs,lengths,faces,aux);heads={k:final.export(k) for k in KINDS};parity={}
 for kind,head in heads.items():
  direct=final.score(nodes,lengths,faces,aux,kind);got=portable(head,nodes,lengths,faces,aux);parity[kind]=max(abs(direct[k]-got[k]) for k in nodes)
  if not math.isfinite(parity[kind]) or parity[kind]>1e-7:raise ValueError('Exploratory portable score parity failed')
 report={'strict_unique_pairs':32,'creator_folds':19,'macro_accuracy':macro,'paired_macro_gains':{k:float(v.mean()) for k,v in deltas.items()},'paired_creator_bootstrap_95':cis,'creator_delta_counts':{k:{'positive':int(np.sum(v>0)),'zero':int(np.sum(v==0)),'negative':int(np.sum(v<0))} for k,v in deltas.items()},'subsets':subsets,'folds':folds,'portable_parity_max_error':parity,'seconds':time.monotonic()-start,'labels_seen_before_design':True,'exploratory':True,'supervised_overlap':SPEC['supervised_overlap'],'all_pipeline_unseen_creator_claim':False,'selected_head':None,'production_promotion':False,'promotion_allowed':False,'heldout_opened':False,'production_changed':False}
 base.prior.old.frozen(out/'training_report.json',report);base.prior.old.frozen(out/'diagnostic_weights.json',{'schema_version':1,'heads':heads,'exploratory':True,'selected_head':None,'production_usable':False,'promotion_allowed':False,'source_spec_sha256':base.prior.old.sha(out/'before-first-fit.json'),'report_sha256':base.prior.old.sha(out/'training_report.json')});return {k:report[k] for k in ('macro_accuracy','paired_macro_gains','paired_creator_bootstrap_95','subsets','seconds','selected_head','promotion_allowed')}

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['prepare','fit']);p.add_argument('--cohort',type=Path,default=base.COHORT);p.add_argument('--face-report',type=Path,default=auxiliary.FACE_REPORT);p.add_argument('--aux',type=Path,default=AUX);p.add_argument('--out',type=Path,default=OUT);a=p.parse_args();signal.alarm(180);print(json.dumps({'prepare':prepare,'fit':fit_round}[a.mode](a.cohort,a.face_report,a.aux,a.out)))
