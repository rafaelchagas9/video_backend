"""Fixed22-strict preference iteration draft; fits require reviewed frozen specification.

Labels are already observed. This specification is before first fit, not outcome-blind
preregistration. Reserved creator outcomes remain sealed. New version labels never pass
through fine_labels and do not become acceptance/cut/recording-worth labels.
"""
from __future__ import annotations
import argparse,collections,copy,json,math,signal,time
from pathlib import Path
import numpy as np
import learned_preference_round as old
import blind_preference_features as features
import blind_version_counterbalanced as blind
OLD_HEAD_SHA='3114ca40a532a5b3cff59ca963b3fac204f8c34bd7e352e5177060f11943ff37'
OLD_HEAD_PATH=features.ROOT/'completed-round-20261010/preference-v2/frozen_candidate.json'
OUT=features.ROOT/'combined-blind-preference'
SPEC={'schema_version':1,'timing':'Frozen before first fit AFTER six blind pilot labels were observed; not outcome-blind preregistration.','target':'preferred_version_if_keep_one','historical_ordinary_target':old.SPEC['target'],'viewing_scope':'New user-declared preference for presented versions with available context; app events do not prove full viewing. Historical ordinary full-clip judgment was separately user-confirmed.','primary':'numeric13+training_PCA8+two_soft_duration_hinges','control':'numeric13+zero8+zero2','predecessor':'numeric13+training_PCA8+zero2; eligible predeclared B fallback, not posthoc candidate selection','duration_prior':'[max(0,ln(180/L)),max(0,ln(L/900))]; learned soft coefficients, no cap or automatic deletion','C':1.0,'fit_intercept':False,'PCA_components':8,'random_seed':42,'training':old.SPEC['training'],'visual_sampling':old.SPEC['visual_sampling'],'folds':old.SPEC['folds'],'gate':old.SPEC['gate'],'incremental_duration_gate':{'minimum_macro_accuracy':.75,'minimum_macro_gain_vs_predecessor':.05,'creator_macro_bootstrap_lower_vs_predecessor':0.0},'selection_policy':'FIRST B-vs-A must pass. Then C only if overall C-vs-A AND incremental C-vs-B gates pass; otherwise retain B. If B-vs-A fails, no eligible head.','minimum_counts_fixed':{'old_sides':48,'blind_sides':12,'old_strict_pairs':17,'blind_strict_pairs':5,'combined_strict_pairs':22},'reserved_creators':'Four globally excluded; no outcomes consulted. Open only after training gate and frozen candidate under separate authorization.','report':'Separate ordinary17/blind5 and blind long3/control2. Same fold bootstrap/gate; no scope/target substitution.','scope':'Exact offered versions only; no calibrated acceptance, cut gold, original-proposal/whole permanent-worth, expiry or deletion','budget_seconds':180,'labels_seen_before_design':True,'duration_weight_limit':'Unconstrained learned hinge coefficients are not guaranteed penalties or preferred-interval utility; report coefficient signs and effective log-duration slopes. No hard cap.','production_promotion':False}


def hinges(length):
 if isinstance(length,bool) or not math.isfinite(length) or length<=0:raise ValueError('Positive finite offered duration required')
 return np.asarray([max(0.,math.log(180./length)),max(0.,math.log(length/900.))])



def verify_provenance(data):
 base,manifest,payload,reserved=features.inputs()
 headers={'format':'isolated_combined_offered_preference_features','source_sha256':old.sha(Path(features.__file__)),'numeric_source_sha256':old.sha(Path(features.numeric.__file__)),'feature_recipe_source_sha256':old.sha(Path(features.numeric.recipe.__file__)),'intake_source_sha256':old.sha(Path(features.intake.__file__)),'blind_generator_source_sha256':old.sha(Path(blind.__file__)),'old_cohort_sha256':features.BASE_SHA,'blind_snapshot_sha256':features.SNAPSHOT_SHA,'blind_manifest_sha256':features.intake.FINAL_SHA,'feature_names':features.numeric.recipe.FEATURES,'feature_recipe':'recording-v1-replace-exact-offered-proposal','visual_sampling':old.SPEC['visual_sampling'],'reserved_creators_excluded':sorted(reserved),'coarse_reserved_groups_excluded':base['coarse_reserved_groups_excluded'],'new_current_acceptability':'unknown','new_cut_gold':'unknown','media_reads':0,'audio_features_used':0,'GPU':False,'production_writes':0}
 if any(data.get(k)!=v for k,v in headers.items()) or data.get('old_rows')!=base['rows']:raise ValueError('Authoritative source/header/reserved/immutable old48 cohort differs')
 private={r['position']:r for r in manifest['private_assignments']};preferences={r['task_id']:r for r in payload['preference_rows']};seen=set()
 for row in data['version_rows']:
  pair=preferences.get(row['task_id']);key=row['side']
  if pair is None or key not in ('a','b') or (row['task_id'],key) in seen:raise ValueError('Unexpected/duplicate blind task side')
  seen.add((row['task_id'],key));public=pair[key];source=private[pair['position']]['source'];a,b=public['range']
  expected={'position':pair['position'],'answer':pair['answer'],'target':'preferred_version_if_keep_one','ranking_y':int(pair['answer']==key) if pair['answer'] in ('a','b') else None,'current_acceptability_y':None,'absolute_y':None,'cut_gold':None,'kind':'version-versus','cohort_kind':'blind_version_preference','group':source['channel_key'],'channel':source['channel'],'offered_range':[a,b],'original_range':source['clip'],'start':a,'end':b,'score':source['score'],'duration_seconds':source['duration_seconds'],'reserved_fine_holdout':False,'fine_data_role':'training','comparison_scope':'same_channel','pair_creators':[source['channel_key']],'pilot_role_private':private[pair['position']]['pilot_role'],'future_replacement':'unknown','permanent_storage_worth':'unknown'}
  expected.update({k:source[k] for k in ('feedback_id','video_id','analyzed_at','source_fingerprint','index')})
  if any(row.get(k)!=v for k,v in expected.items()):raise ValueError('Authoritative blind task/source/range/ranking differs')
  identity=row['numeric_identity'];identity_expected={k:source[k] for k in ('video_id','analyzed_at','source_fingerprint','index')};identity_expected['duration']=source['duration_seconds']
  if any(identity.get(k)!=v for k,v in identity_expected.items()):raise ValueError('Frozen numeric generation identity differs')
  proposals=identity['proposals'];matches=[p for p in proposals if p['id']==row['original_proposal_id']]
  if len(matches)!=1 or [matches[0]['start'],matches[0]['end']]!=source['clip'] or matches[0]['score']!=source['score']:raise ValueError('Original detected proposal context differs')
  frame_receipt=data['frame_sources'].get(str(source['feedback_id']))
  if not frame_receipt or frame_receipt['identity_sha256']!=features.numeric.digest(identity) or frame_receipt['frame_count']!=source['index']['frame_count']:raise ValueError('Numeric frame generation receipt differs')
 if len(seen)!=12 or set(preferences)!={r['task_id'] for r in data['version_rows']}:raise ValueError('Exactly twelve authoritative blind sides required')
 return reserved


def validated(data):
 verify_provenance(data)
 reserved=set(data['reserved_creators_excluded']);nodes,pairs=old.validated(data['old_rows'],reserved);nodes=dict(nodes);pairs=[dict(p,cohort_kind='ordinary',subkind='ordinary') for p in pairs];lengths={};by=collections.defaultdict(list);identities=set()
 for row in data['old_rows']:lengths[old.node_key(row)]=row['end']-row['start']
 for row in data['version_rows']:
  if row['kind']!='version-versus' or row['target']!='preferred_version_if_keep_one' or row.get('current_acceptability_y') is not None or row.get('absolute_y') is not None or row.get('cut_gold') is not None or row.get('future_replacement')!='unknown' or row.get('permanent_storage_worth')!='unknown':raise ValueError('Blind pure preference cannot supply legacy acceptance/cut labels')
  if row['reserved_fine_holdout'] is not False or row['fine_data_role']!='training' or row['group'] in reserved or row['group']!=blind.base.canon(row['channel']):raise ValueError('Reserved or wrong per-side creator')
  identity=(row['task_id'],row['side'])
  if identity in identities:raise ValueError('Duplicate blind side')
  identities.add(identity);X=np.asarray(row['features'],float);V=np.asarray(row['visual_mean'],float);a,b=row['offered_range'];lo,hi=row['original_range']
  if X.shape!=(13,) or V.shape!=(1152,) or not np.isfinite(X).all() or not np.isfinite(V).all() or abs(np.linalg.norm(V)-1)>.02 or not 0<=lo<=a<b<=hi or row['start']!=a or row['end']!=b:raise ValueError('Invalid exact blind numeric/visual/range inputs')
  key=old.node_key(row);value=(row['group'],X,V)
  if key in nodes and (nodes[key][0]!=value[0] or not np.array_equal(nodes[key][1],X) or not np.array_equal(nodes[key][2],V)):raise ValueError('Exact old/new offered-node conflict')
  if key in lengths and lengths[key]!=b-a:raise ValueError('Same-node duration conflict')
  nodes[key]=value;lengths[key]=b-a;by[row['task_id']].append(row)
 for tid,rows in sorted(by.items()):
  if len(rows)!=2 or {r['side'] for r in rows}!={'a','b'} or len({r['answer'] for r in rows})!=1 or len({r['group'] for r in rows})!=1 or any(rows[0][k]!=rows[1][k] for k in ('feedback_id','video_id','analyzed_at','source_fingerprint','index','original_range','pilot_role_private')):raise ValueError('Complete same-source blind comparison required')
  answer=rows[0]['answer'];ys=[r['ranking_y'] for r in rows]
  if answer in ('both','neither'):
   if ys!=[None,None]:raise ValueError('Tie/abstention cannot become logistic loss')
   continue
  if answer not in ('a','b') or any(r['ranking_y']!=int(r['side']==answer) for r in rows):raise ValueError('Blind preference direction differs')
  winner=next(r for r in rows if r['side']==answer);loser=next(r for r in rows if r['side']!=answer)
  if old.node_key(winner)==old.node_key(loser):raise ValueError('Exact duplicate blind versions')
  if any(p['task_id']==tid for p in pairs):raise ValueError('Old/new task identity collision')
  pairs.append({'task_id':tid,'winner':old.node_key(winner),'loser':old.node_key(loser),'creators':[winner['group']],'cohort_kind':'blind','subkind':winner['pilot_role_private']})
 if len(data['old_rows'])!=48 or len(data['version_rows'])!=12 or len(pairs)!=22 or sum(p['cohort_kind']=='ordinary' for p in pairs)!=17 or sum(p['subkind']=='long_vs_compact' for p in pairs)!=3 or sum(p['subkind']=='equal_duration_control' for p in pairs)!=2:raise ValueError('Frozen48/12/17+5/3+2 comparison counts differ')
 return nodes,pairs,lengths,reserved


def selected_head(gates):
 if not gates['predecessor_vs_numeric']:return None
 return 'primary' if gates['primary_vs_numeric'] and gates['primary_vs_predecessor'] else 'predecessor'

def training_pairs(pairs,held):return [p for p in pairs if not set(p['creators'])&set(held)]

class Fit:
 def fit(self,nodes,pairs,lengths):
  keys=sorted({p[k] for p in pairs for k in ('winner','loser')})
  if len(keys)<9 or not pairs:raise ValueError('Insufficient distinct training nodes for fixed PCA8')
  self.keys=keys;self.groups=sorted({nodes[k][0] for k in keys});X=np.asarray([nodes[k][1] for k in keys]);V=np.asarray([nodes[k][2] for k in keys]);H=np.asarray([hinges(lengths[k]) for k in keys]);self.pca=old.PCA(n_components=8,svd_solver='full').fit(V);primary=np.c_[X,self.pca.transform(V),H];index={k:i for i,k in enumerate(keys)};diff=np.asarray([primary[index[p['winner']]]-primary[index[p['loser']]] for p in pairs]);self.scale=old.StandardScaler().fit(np.r_[diff,-diff]);self.models={}
  for kind in ('primary','numeric','predecessor'):
   z=self.design(X,V,H,kind);z=self.scale.transform(z);d=np.asarray([z[index[p['winner']]]-z[index[p['loser']]] for p in pairs])
   self.models[kind]=old.LogisticRegression(C=1.,fit_intercept=False,solver='liblinear',max_iter=5000,tol=1e-9,random_state=42).fit(np.r_[d,-d],np.r_[np.ones(len(d)),np.zeros(len(d))],sample_weight=np.full(2*len(d),.5))
  return self
 def design(self,X,V,H,kind):
  z=np.c_[X,self.pca.transform(V),H]
  if kind=='numeric':z[:,13:]=0
  elif kind=='predecessor':z[:,21:]=0
  elif kind!='primary':raise ValueError('Unknown fixed model role')
  return z
 def score(self,nodes,lengths,kind):
  keys=sorted(nodes);X=np.asarray([nodes[k][1] for k in keys]);V=np.asarray([nodes[k][2] for k in keys]);H=np.asarray([hinges(lengths[k]) for k in keys]);scores=self.models[kind].decision_function(self.scale.transform(self.design(X,V,H,kind)));return dict(zip(keys,map(float,scores)))
 def export(self,kind):
  raw=self.models[kind].coef_[0]/self.scale.scale_;vw=raw[13:21]@self.pca.components_ if kind!='numeric' else np.zeros(1152);hw=raw[21:23] if kind=='primary' else np.zeros(2);bias=-float(raw@self.scale.mean_+vw@self.pca.mean_)
  return {'schema_version':1,'kind':'offered_version_preference_linear','numeric_weights':raw[:13].tolist(),'visual_weights':vw.tolist(),'duration_weights':hw.tolist(),'soft_preferred_seconds':[180,900],'visual_recipe':'unit_mean_unit_frames_inside_exact_offered_range','feature_recipe':'recording-v1-replace_exact_offered_proposal','bias':bias,'target':SPEC['target'],'duration_recipe':'log_hinges_180_900_v1','probability_calibrated':False,'automatic_action':False}


def portable(head,nodes,lengths):return {k:float(head['bias']+np.dot(head['numeric_weights'],n[1])+np.dot(head['visual_weights'],n[2])+np.dot(head['duration_weights'],hinges(lengths[k]))) for k,n in nodes.items()}

def prepare(cohort,out):
 data=json.loads(Path(cohort).read_text());nodes,pairs,lengths,reserved=validated(data)
 groups=sorted({g for p in pairs for g in p['creators']})
 for group in groups:
  train=training_pairs(pairs,{group});keys={p[k] for p in train for k in ('winner','loser')}
  if len(keys)<9 or any(nodes[k][0]==group for k in keys):raise ValueError('Fold coverage/exclusion invalid before any fit')
 spec=dict(SPEC,cohort_sha256=old.sha(cohort),source_sha256=old.sha(__file__),export_source_sha256=old.sha(Path(features.__file__)),numeric_source_sha256=old.sha(Path(features.numeric.__file__)),feature_recipe_source_sha256=old.sha(Path(features.numeric.recipe.__file__)),old_fit_source_sha256=old.sha(Path(old.__file__)),intake_source_sha256=old.sha(Path(features.intake.__file__)),blind_generator_source_sha256=old.sha(Path(blind.__file__)),base_cohort_sha256=features.BASE_SHA,blind_manifest_sha256=features.intake.FINAL_SHA,blind_snapshot_sha256=features.SNAPSHOT_SHA,old_frozen_head_sha256=OLD_HEAD_SHA,creator_folds=len(groups),reserved_creators=sorted(reserved));old.frozen(out/'before-first-fit.json',spec)
 print(json.dumps({'status':'prepared_no_fit','strict_pairs':len(pairs),'creator_folds':len(groups),'spec_sha256':old.sha(out/'before-first-fit.json'),'labels_seen_before_design':True}));return spec


def verify(cohort,out):
 spec=json.loads((out/'before-first-fit.json').read_text())
 expected=dict(SPEC,cohort_sha256=old.sha(cohort),source_sha256=old.sha(__file__),export_source_sha256=old.sha(Path(features.__file__)),numeric_source_sha256=old.sha(Path(features.numeric.__file__)),feature_recipe_source_sha256=old.sha(Path(features.numeric.recipe.__file__)),old_fit_source_sha256=old.sha(Path(old.__file__)),intake_source_sha256=old.sha(Path(features.intake.__file__)),blind_generator_source_sha256=old.sha(Path(blind.__file__)),base_cohort_sha256=features.BASE_SHA,blind_manifest_sha256=features.intake.FINAL_SHA,blind_snapshot_sha256=features.SNAPSHOT_SHA,old_frozen_head_sha256=OLD_HEAD_SHA,creator_folds=spec['creator_folds'],reserved_creators=spec['reserved_creators'])
 if spec!=expected:raise ValueError('Reviewed source/spec/cohort dependency changed')
 return spec


def transfer(cohort,out):
 data=json.loads(Path(cohort).read_text());nodes,pairs,lengths,reserved=validated(data)
 if old.sha(OLD_HEAD_PATH)!=OLD_HEAD_SHA:raise ValueError('Immutable predecessor head checksum differs')
 candidate=json.loads(OLD_HEAD_PATH.read_text())
 if candidate['cohort_sha256']!=features.BASE_SHA or candidate['fit_source_sha256']!=old.sha(Path(old.__file__)) or set(candidate['reserved_creators'])!=reserved:raise ValueError('Old fixed head source/cohort/heldout contract differs')
 keys={old.node_key(r) for r in data['version_rows']};newnodes={k:nodes[k] for k in keys};predictions={kind:old.portable_score(candidate['heads'][kind],newnodes) for kind in ('visual','numeric')}
 artifact={'schema_version':1,'head_sha256':OLD_HEAD_SHA,'cohort_sha256':old.sha(cohort),'prediction_scope':'All12 exact blind offered versions; fixed existing heads, no fit; labels already observed by primary session.','predictions':predictions,'model_fits':0};old.frozen(out/'fixed-predecessor-predictions.json',artifact)
 # Join labels only after prediction artifact is immutable.
 newpairs=[p for p in pairs if p['cohort_kind']=='blind'];seen=set(candidate['training_creators']);report={}
 for scope,test in [('all_blind',newpairs),('long_vs_compact',[p for p in newpairs if p['subkind']=='long_vs_compact']),('equal_duration_control',[p for p in newpairs if p['subkind']=='equal_duration_control']),('fresh_creator',[p for p in newpairs if not set(p['creators'])&seen]),('seen_creator',[p for p in newpairs if set(p['creators'])&seen])]:
  report[scope]={'strict_pairs':len(test),**{kind:{'accuracy':old.accuracy(list(old.margins(test,predictions[kind]).values())),'margins':old.margins(test,predictions[kind])} for kind in predictions}}
 result={'status':'descriptive_fixed_head_transfer','reports':report,'predictions_sha256':old.sha(out/'fixed-predecessor-predictions.json'),'old_training_gate_passed':candidate['training_gate_passed'],'no_retraining_or_model_selection':True,'heldout_opened':False,'production_changed':False};old.frozen(out/'fixed-predecessor-transfer.json',result);print(json.dumps({'status':result['status'],'reports':{k:{'strict_pairs':v['strict_pairs'],**{kind:v[kind]['accuracy'] for kind in ('visual','numeric')}} for k,v in report.items()},'model_fits':0}));return result


def fit_round(cohort,out):
 spec=verify(cohort,out);start=time.monotonic();deadline=start+180;data=json.loads(Path(cohort).read_text());nodes,pairs,lengths,reserved=validated(data);groups=sorted({g for p in pairs for g in p['creators']});folds=[];unique=collections.defaultdict(lambda:collections.defaultdict(list))
 for group in groups:
  old.check(deadline);train=training_pairs(pairs,{group});test=[p for p in pairs if group in p['creators']];model=Fit().fit(nodes,train,lengths)
  if group in model.groups:raise ValueError('Held creator entered PCA/scaler/head')
  results={}
  for kind in ('primary','numeric','predecessor'):
   m=old.margins(test,model.score(nodes,lengths,kind));results[kind]={'accuracy':old.accuracy(list(m.values())),'margins':m}
   for tid,value in m.items():unique[tid][kind].append(value)
  folds.append({'held_creator':group,'train_nodes':model.keys,'train_creators':model.groups,'training_pairs':len(train),'testing_pairs':len(test),'results':results})
 deltas={'primary_vs_numeric':np.asarray([f['results']['primary']['accuracy']-f['results']['numeric']['accuracy'] for f in folds]),'predecessor_vs_numeric':np.asarray([f['results']['predecessor']['accuracy']-f['results']['numeric']['accuracy'] for f in folds]),'primary_vs_predecessor':np.asarray([f['results']['primary']['accuracy']-f['results']['predecessor']['accuracy'] for f in folds])};rng=np.random.default_rng(42);indices=rng.integers(0,len(folds),size=(2000,len(folds)));intervals={key:np.quantile(np.mean(value[indices],axis=1),[.025,.975]).tolist() for key,value in deltas.items()};delta=deltas['primary_vs_numeric'];ci=intervals['primary_vs_numeric'];macro={kind:float(np.mean([f['results'][kind]['accuracy'] for f in folds])) for kind in ('primary','numeric','predecessor')};subset={}
 for scope,test in [('ordinary',[p for p in pairs if p['cohort_kind']=='ordinary']),('blind',[p for p in pairs if p['cohort_kind']=='blind']),('blind_long',[p for p in pairs if p['subkind']=='long_vs_compact']),('blind_control',[p for p in pairs if p['subkind']=='equal_duration_control'])]:subset[scope]={'strict_pairs':len(test),'unique_accuracy':{kind:old.accuracy([float(np.mean(unique[p['task_id']][kind])) for p in test]) for kind in macro}}
 enough=len(pairs)>=12 and len(groups)>=6
 gates={'predecessor_vs_numeric':bool(enough and macro['predecessor']>=.75 and deltas['predecessor_vs_numeric'].mean()>=.05 and intervals['predecessor_vs_numeric'][0]>0),'primary_vs_numeric':bool(enough and macro['primary']>=.75 and deltas['primary_vs_numeric'].mean()>=.05 and intervals['primary_vs_numeric'][0]>0),'primary_vs_predecessor':bool(enough and macro['primary']>=.75 and deltas['primary_vs_predecessor'].mean()>=.05 and intervals['primary_vs_predecessor'][0]>0)}
 selected=selected_head(gates)
 gate=selected is not None
 final=Fit().fit(nodes,pairs,lengths);heads={kind:final.export(kind) for kind in macro}
 for kind,head in heads.items():
  direct=final.score(nodes,lengths,kind);got=portable(head,nodes,lengths)
  if max(abs(direct[k]-got[k]) for k in nodes)>1e-7:raise ValueError('Portable soft-duration score parity failed')
 duration_effects={kind:{'duration_weights':head['duration_weights'],'log_seconds_weight':head['numeric_weights'][0],'effective_log_seconds_slopes':{'below180':head['numeric_weights'][0]-head['duration_weights'][0],'180to900':head['numeric_weights'][0],'above900':head['numeric_weights'][0]+head['duration_weights'][1]},'limit':'Partial feature contribution holding other context features fixed; numeric length-related context is correlated. Unconstrained coefficients are not guaranteed penalties.'} for kind,head in heads.items()}
 report={'selection_policy':SPEC['selection_policy'],'selected_head':selected,'paired_gates':gates,'paired_macro_gains':{key:float(value.mean()) for key,value in deltas.items()},'paired_creator_macro_bootstrap_95':intervals,'duration_effects':duration_effects,'strict_unique_pairs':len(pairs),'creator_folds':len(groups),'macro_accuracy':macro,'macro_gain':float(delta.mean()),'creator_macro_bootstrap_95':ci,'gate_passed':gate,'subsets':subset,'folds':folds,'seconds':time.monotonic()-start,'labels_seen_before_design':True,'heldout_opened':False,'production_changed':False};old.frozen(out/'training_report.json',report);old.frozen(out/'frozen_candidate.json',{'schema_version':1,'heads':heads,'training_gate_passed':gate,'selected_head':selected,'training_creators':groups,'reserved_creators':sorted(reserved),'cohort_sha256':old.sha(cohort),'spec_sha256':old.sha(out/'before-first-fit.json'),'report_sha256':old.sha(out/'training_report.json'),'automatic_action':False})
 print(json.dumps({k:report[k] for k in ('strict_unique_pairs','creator_folds','macro_accuracy','macro_gain','creator_macro_bootstrap_95','gate_passed','selected_head','paired_gates','paired_macro_gains','paired_creator_macro_bootstrap_95','subsets','seconds')}));return report

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['prepare','transfer','fit']);parser.add_argument('--cohort',type=Path,default=features.OUT/'feature_cohort.json');parser.add_argument('--out',type=Path,default=OUT);args=parser.parse_args();signal.alarm(180);{'prepare':prepare,'transfer':transfer,'fit':fit_round}[args.mode](args.cohort,args.out)
