"""Fixed, disabled whole-as-is current-retention head; exact explicit labels only.

Source and metrics policy freeze before first fit AFTER observed historical and
human outcomes, never outcome-blind. Original detector scores retain globally
fixed Stage1 supervision provenance: whole-head LOCO is not whole-pipeline LOCO.
"""
from __future__ import annotations
import argparse,copy,hashlib,json,math,signal,time
PROCESS_START=time.monotonic()
from pathlib import Path
import numpy as np
from sklearn.decomposition import PCA
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score,average_precision_score,brier_score_loss
import whole_feature_inputs as inputs
import whole_feature_supplement as supplement
import whole_round_intake as intake
import whole_review_inputs as recipe

ROOT=inputs.ROOT
OUT=ROOT/'whole-current-train-v1'
SPEC={'schema_version':1,'target':recipe.TARGET,'feature_recipe':recipe.RECIPE,'feature_names':recipe.FEATURES,'visual_recipe':recipe.VISUAL_RECIPE,'heads':['numeric8','numeric8_visual_pca8'],'C':1.,'fit_intercept':True,'PCA_components':8,'seed':42,'threshold':.5,'creator_weights':'Each training creator has total weight1; scaler and logistic receive the same weights. Ordinary PCA8 fits only the training whole-recording vectors; no held-creator inputs.','evaluation':'Leave one complete creator out; numeric and visual heads and weighted training-prevalence constant on identical rows. All fold class/node preflight completes before any PCA, scaler or logistic fit.','minimum_positive_rows':5,'minimum_negative_rows':5,'minimum_positive_creators':3,'minimum_negative_creators':3,'minimum_training_nodes':9,'metrics':'Raw fold predict_proba, uncalibrated. Pooled AUC/AP/Brier; creator-macro correctness; class recall macroaveraged over creators possessing that class, then balanced over the two classes. Fixed0.5 threshold; no threshold tuning.','bootstrap_draws':2000,'bootstrap_seed':42,'bootstrap_minimum_valid':1000,'bootstrap':'Paired visual-minus-numeric pooled AUC, sampling creators with replacement and retaining every sampled creator row. Count/discard single-class draws.','gate':{'macro_balanced_accuracy_min':.75,'visual_AUC_min':.8,'visual_minus_numeric_AUC_min':.05,'paired_creator_AUC_gain_CI_lower_strict_positive':True},'timing':'Policy frozen before first fit AFTER historical and completed new outcomes may have been observed; NOT outcome-blind preregistration.','interpretation':'Current decision to retain the entire recording as-is. Purposive creator-balanced sample, not population prevalence, calibrated probability, generic clip acceptability or permanent storage-worth.','Stage1_provenance':'Immutable original detector scores include fixed globally trained Stage1 history. Training-fold whole PCA/scaling/classifier exclude held creators; the entire feature pipeline is not independently retrained inside each fold.','historical_near_full_unknowns':'The14 clarified near-full edited-clip recordings remain unknown in their immutable historical receipt; never manufacture whole positives or negatives.','enabled':False,'probability_calibrated':False,'automatic_action':False,'production_promotion':False,'budget_seconds':180,'max_metadata_bytes':32*1024**2,'hyperparameter_search':False}


def digest_bytes(raw):return hashlib.sha256(raw).hexdigest()
def finite(x):return math.isfinite(float(x)) if isinstance(x,(int,float,np.integer,np.floating)) and not isinstance(x,(bool,np.bool_)) else False
def sha(path):return digest_bytes(Path(path).read_bytes())
def check(deadline):
 if time.monotonic()>=deadline:raise TimeoutError('Whole training180s deadline')
def read_json(path,expected=None):
 path=Path(path)
 if not path.is_file() or path.stat().st_size>SPEC['max_metadata_bytes']:raise ValueError('Bounded immutable numeric metadata required')
 raw=path.read_bytes()
 if expected is not None and digest_bytes(raw)!=expected:raise ValueError('Exact frozen artifact checksum differs')
 return json.loads(raw),digest_bytes(raw)
def write(path,value):inputs.whole.immutable_write(Path(path),value)
def helper_pins():
 paths=[Path(__file__),Path(inputs.__file__),Path(intake.__file__),Path(intake.contract.__file__),Path(intake.contract.labels.__file__),Path(recipe.__file__),Path(inputs.history.__file__),Path(supplement.__file__)]
 return [{'path':str(p.resolve()),'sha256':sha(p)} for p in paths]


def validate_metadata(cohort,binding,manifest,reserved,holdout):
 """Only metadata/features; called before any completed-answer file is decoded."""
 if cohort.get('policy') not in (inputs.POLICY,supplement.POLICY) or binding.get('policy')!=cohort.get('policy') or cohort.get('schema_version')!=1 or any(cohort.get(k)!=v for k,v in {'target':recipe.TARGET,'feature_recipe':recipe.RECIPE,'feature_names':recipe.FEATURES,'visual_recipe':recipe.VISUAL_RECIPE,'new_labels_intaken':False,'historical_near_full_reinterpreted':False,'whole_fit_count':0,'probability_calibrated':False,'automatic_action':False,'enabled':False}.items()):raise ValueError('Unsupported frozen whole-feature target/recipe')
 intake.contract.validate_manifest(manifest,reserved,holdout)
 if len(manifest['rows'])!=16:raise ValueError('Exactly16 frozen explicit whole tasks required')
 rows=cohort.get('rows');identities=binding.get('rows')
 if not isinstance(rows,list) or not isinstance(identities,dict) or len({r['row'] for r in rows})!=len(rows) or {r['row'] for r in rows}!=set(identities):raise ValueError('Exact feature/private source universe required')
 plans={intake.contract.task_key(t):(t,p) for t,p in zip(manifest['rows'],manifest['private_sources'])};new={};source_keys=set()
 for r in rows:
  p=identities[r['row']];kind=p.get('kind')
  if any(r.get(k) is not None for k in ('clip_current_acceptability_y','cut_gold','permanent_storage_y','future_replacement_y')) or r.get('label_target')!=recipe.TARGET:raise ValueError('No clip/cut/permanent labels may define whole target')
  if kind=='new_frozen_whole_manifest':
   key=(p['batch'],p['position'])
   if key not in plans or key in new or r.get('y') is not None or r.get('label_origin')!='prospective_whole_round_unanswered_no_intake':raise ValueError('Exact new unlabeled whole task required')
   task,private=plans[key];c=private['candidate']
   expected={'kind':kind,'batch':task['batch'],'position':task['position'],'candidate':c,'original_proposals':private['proposals'],'proposal_origin':private['proposal_origin'],'numeric_identity':private['numeric_identity'],'frame_checkpoint':private['frame_checkpoint']}
   if p!=expected or r['features']!=private['features'] or r['visual_mean']!=private['visual_mean']:raise ValueError('New whole numeric generation/private binding differs')
   new[key]=r['row'];duration=c['duration_seconds'];channel=c['channel'];source_key=intake.contract.source_key(c);props=p['original_proposals']
  elif kind in ('historical_exact_generation_archive','historical_exact_generation_numeric_checkpoint'):
   historical=p['historical'];channel=historical['channel'];source_key=intake.contract.source_key(historical);props=p['original_proposals']
   if r.get('label_origin')!=inputs.history.POLICY or type(r.get('y')) is not int or r['y'] not in (0,1):raise ValueError('Explicit historical target required')
   if kind=='historical_exact_generation_archive':
    source=p['source'];duration=source['durationSeconds']
    if source['videoId']!=historical['video_id'] or intake.contract.generation_key(p['analyzed_at'])!=source_key[1] or not isinstance(p.get('frame_identity'),str) or len(p['frame_identity'])!=64 or not isinstance(p.get('frame_sha256'),str) or len(p['frame_sha256'])!=64:raise ValueError('Explicit historical source/generation target required')
   else:
    identity=p['numeric_identity'];duration=identity['duration'];numeric={'numeric_identity':identity,'index':identity['index'],'source_fingerprint':identity['source_fingerprint'],'duration_seconds':duration,'frame_checkpoint':p['frame_checkpoint']}
    supplement.verify_identity(numeric,historical,p['historical_index'])
    if props!=identity['proposals'] or p['training_cohort_sha256']!=supplement.TRAINING_SHA:raise ValueError('Supplement exact original/source provenance differs')
  else:raise ValueError('Unsupported whole source generation')
  canonical=intake.base.canon(channel);group=digest_bytes(canonical.encode())[:24]
  if not canonical or canonical in reserved or r['group']!=group or source_key in source_keys:raise ValueError('Reserved, duplicate or mismatched whole creator/source')
  source_keys.add(source_key);x=r['features'];visual=r['visual_mean']
  if not isinstance(x,list) or len(x)!=8 or not all(finite(v) for v in x) or not isinstance(visual,list) or len(visual)!=1152 or not all(finite(v) for v in visual) or abs(np.linalg.norm(visual)-1)>.02:raise ValueError('Finite full-recording numeric/visual features required')
  rebuilt,_=recipe.features(props,duration,[],np.empty((0,1152)))
  if not np.allclose(x[:5],rebuilt[:5],atol=1e-12,rtol=0) or not 0<=x[5]<=2 or not 0<=x[6]<=2 or x[7]!=1:raise ValueError('Original full-recording feature context differs')
 if set(new)!=set(plans):raise ValueError('Exactly16 new unlabeled bindings required')
 return new


def join_answers(cohort,binding,manifest,snapshot,reserved,holdout):
 new=validate_metadata(cohort,binding,manifest,reserved,holdout)
 if snapshot.get('schema_version')!=1 or snapshot.get('manifest_sha256')!=digest_bytes(intake.contract.canonical(manifest)+b'\n') or snapshot.get('intake_source_sha256')!=sha(intake.__file__) or snapshot.get('labels_source_sha256')!=sha(intake.contract.labels.__file__):raise ValueError('Exact completed whole intake manifest/helpers required')
 payload=snapshot.get('answers') or {};observed=payload.get('whole_rows')
 if payload.get('status')!='complete' or not isinstance(observed,list) or len(observed)!=16 or len({r['task_id'] for r in observed})!=16 or len({(r['batch'],r['position']) for r in observed})!=16:raise ValueError('Complete exact16 explicit outcomes required')
 by={(r['batch'],r['position']):r for r in observed};tasks=[]
 for plan in manifest['rows']:
  key=intake.contract.task_key(plan)
  if key not in by:raise ValueError('Outcome outside exact whole task')
  answer=by[key];task=dict(copy.deepcopy(plan),id=answer['task_id'],answer=answer['answer'],answered_at=answer['answered_at'],reasons=[],detail=None)
  if intake.contract.labels.contract(task,reserved)!=answer:raise ValueError('Saved whole answer semantics or generation drift')
  tasks.append(task)
 if intake.checked_answers(tasks,manifest,reserved)!=payload:raise ValueError('Completed whole count/target contract differs')
 rows=copy.deepcopy(cohort['rows']);by_alias={r['row']:r for r in rows}
 for key,alias in new.items():
  answer=by[key];by_alias[alias].update(y=intake.contract.labels.ANSWERS[answer['answer']],label_origin=intake.contract.labels.POLICY,task_id=answer['task_id'],answer=answer['answer'],answered_at=answer['answered_at'])
 return rows



def check_preparation_chain(root,cohort,binding,receipt,reserved,holdout):
 """Validate v1 literals or v2's exact v1 parent plus one supported numeric source."""
 policy=cohort.get('policy')
 if policy not in (inputs.POLICY,supplement.POLICY) or receipt.get('policy')!=policy or binding.get('policy')!=policy or receipt.get('holdout_dependency')!=holdout or receipt.get('excluded_holdout_creators')!=sorted(reserved) or any(receipt.get(k)!=v for k,v in {'source_media_reads':0,'database_access':False,'outcome_intake':False,'model_fits':0,'enabled':False}.items()):raise ValueError('Frozen preparation target/holdout receipt required')
 expected_sources=({str(p.resolve()) for p in supplement.source_paths()} if policy==supplement.POLICY else {str(p.resolve()) for p in (Path(inputs.__file__),Path(inputs.__file__).with_name('whole_feature_inputs_test.py'),Path(recipe.__file__),Path(inputs.history.__file__),Path(intake.contract.__file__),Path(inputs.archive.__file__),Path(inputs.snapshots.__file__))})
 if {d['path'] for d in receipt.get('source_pins',[])}!=expected_sources:raise ValueError('Exact preparation source pins required')
 for d in receipt['source_pins']:
  if sha(d['path'])!=d['sha256']:raise ValueError('Feature preparation helper drift')
 for d in receipt['inputs']:
  st=Path(d['path']).stat()
  if list((st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns))!=d['stat']:raise ValueError('Frozen preparation input changed')
 merged={d['path']:d['sha256'] for d in receipt['inputs']}
 if policy==supplement.POLICY:
  parents=receipt.get('parent_inputs',[])
  if len(parents)!=3 or {Path(d['path']).name for d in parents}!={'feature_cohort.json','private_identity.json','input_receipt.json'} or len({str(Path(d['path']).parent) for d in parents})!=1:raise ValueError('Exact v1 three-file parent chain required')
  by={Path(d['path']).name:d for d in parents};old,_=read_json(by['feature_cohort.json']['path'],by['feature_cohort.json']['sha256']);private,_=read_json(by['private_identity.json']['path'],by['private_identity.json']['sha256']);previous,_=read_json(by['input_receipt.json']['path'],by['input_receipt.json']['sha256'])
  if old.get('policy')!=inputs.POLICY or previous['cohort_sha256']!=by['feature_cohort.json']['sha256'] or previous['private_binding_sha256']!=by['private_identity.json']['sha256'] or len(old['rows'])!=20 or cohort['rows'][:-1]!=old['rows'] or cohort.get('supplement_count')!=1 or receipt.get('supplement_count')!=1 or previous['new_manifest_sha256']!=receipt['new_manifest_sha256']:raise ValueError('Literal parent whole20 rows changed')
  added=cohort['rows'][-1]['row']
  if added in private['rows'] or set(binding['rows'])!=set(private['rows'])|{added} or any(binding['rows'][k]!=v for k,v in private['rows'].items()) or binding['rows'][added]['kind']!='historical_exact_generation_numeric_checkpoint':raise ValueError('One exact supplemental historical binding required')
  excluded={'policy','rows','counts','unavailable','supplement_count'}
  if {k:v for k,v in cohort.items() if k not in excluded}!={k:v for k,v in old.items() if k not in excluded} or added not in {r['row'] for r in old['unavailable']} or cohort['unavailable']!=[r for r in old['unavailable'] if r['row']!=added]:raise ValueError('Supplement altered parent scope/unavailable evidence')
  merged.update(check_preparation_chain(Path(by['input_receipt.json']['path']).parent,old,private,previous,reserved,holdout))
 return merged


def load_inputs(features_root,round_root,manifest_sha,snapshot_sha,deadline):
 features_root=Path(features_root);round_root=Path(round_root);receipt,_=read_json(features_root/'input_receipt.json');cohort,cohort_sha=read_json(features_root/'feature_cohort.json',receipt['cohort_sha256']);binding,binding_sha=read_json(features_root/'private_identity.json',receipt['private_binding_sha256'])
 reserved,holdout=intake.contract.safe.previous.holdout_contract()
 historical_pins=check_preparation_chain(features_root,cohort,binding,receipt,reserved,holdout)
 if receipt.get('new_manifest_sha256')!=manifest_sha:raise ValueError('Prepared task manifest differs')
 manifest,actual_manifest=read_json(round_root/'private_manifest.json',manifest_sha)
 if manifest.get('source_sha256')!=sha(intake.contract.__file__) or manifest.get('consumer_sources')!=intake.contract.consumer_pins():raise ValueError('Whole task source/consumer drift')
 if {d['path'] for d in manifest.get('dependencies',[])}!={str(p.resolve()) for p in intake.contract.dependencies()}:raise ValueError('Exact whole metadata dependencies required')
 for d in manifest['dependencies']:
  if sha(d['path'])!=d['sha256']:raise ValueError('Whole task metadata dependency drift')
 validate_metadata(cohort,binding,manifest,reserved,holdout)
 historical_private_path=intake.contract.HIST/intake.contract.HISTORY_FILES[1];historical_labels_path=intake.contract.HIST/intake.contract.HISTORY_FILES[0]
 if any(str(p.resolve()) not in historical_pins for p in (historical_private_path,historical_labels_path)):raise ValueError('Authoritative historical whole receipts missing')
 historical_private,_=read_json(historical_private_path,historical_pins[str(historical_private_path.resolve())]);history_raw=historical_labels_path.read_bytes()
 if len(history_raw)>SPEC['max_metadata_bytes'] or digest_bytes(history_raw)!=historical_pins[str(historical_labels_path.resolve())]:raise ValueError('Historical whole label receipt checksum differs')
 selected,_,_=inputs.allowed_history(history_raw.decode(),historical_private,reserved);historical={label['row']:(label,p) for label,p in selected}
 for r in cohort['rows']:
  p=binding['rows'][r['row']]
  if p['kind'] in ('historical_exact_generation_archive','historical_exact_generation_numeric_checkpoint') and (r['row'] not in historical or r['y']!=historical[r['row']][0]['y'] or p['historical']!=historical[r['row']][1]):raise ValueError('Historical explicit labels/private generation changed')
 check(deadline)
 # No completed outcome file is visited before all metadata/source/generation checks.
 snapshot,snapshot_hash=read_json(round_root/'answer-snapshots'/f'answers.{snapshot_sha}.json',snapshot_sha);rows=join_answers(cohort,binding,manifest,snapshot,reserved,holdout)
 return rows,{'feature_cohort_sha256':cohort_sha,'private_binding_sha256':binding_sha,'manifest_sha256':actual_manifest,'snapshot_sha256':snapshot_hash,'input_receipt_sha256':sha(features_root/'input_receipt.json'),'helper_sources':helper_pins(),'reserved_creators_excluded':sorted(reserved),'historical_near_full_unknowns_relabelled':0}


def counts(rows):
 known=[r for r in rows if r['y'] is not None]
 return {'total':len(rows),'known':len(known),'unknown':len(rows)-len(known),'positive':sum(r['y']==1 for r in known),'negative':sum(r['y']==0 for r in known),'positive_creators':len({r['group'] for r in known if r['y']==1}),'negative_creators':len({r['group'] for r in known if r['y']==0})}
def preflight(rows):
 summary=counts(rows);known=[r for r in rows if r['y'] is not None];reasons=[]
 for key,minimum in [('positive',5),('negative',5),('positive_creators',3),('negative_creators',3)]:
  if summary[key]<minimum:reasons.append(f'{key}:{summary[key]}<{minimum}')
 for r in known:
  if type(r['y']) is not int or r['y'] not in (0,1) or r['label_target']!=recipe.TARGET or any(r.get(k) is not None for k in ('clip_current_acceptability_y','cut_gold','permanent_storage_y','future_replacement_y')) or len(r['features'])!=8 or len(r['visual_mean'])!=1152 or not all(finite(x) for x in r['features']+r['visual_mean']) or abs(np.linalg.norm(r['visual_mean'])-1)>.02:raise ValueError('Explicit known whole training row required')
 if len({r['row'] for r in rows})!=len(rows):raise ValueError('Duplicate source row')
 groups=sorted({r['group'] for r in known});folds=[]
 for group in groups:
  train=[r for r in known if r['group']!=group];test=[r for r in known if r['group']==group]
  if set(r['y'] for r in train)!={0,1}:reasons.append('fold_training_class_missing:'+group)
  if len(train)<9:reasons.append('fold_PCA8_nodes_missing:'+group)
  folds.append({'held_creator':group,'train_rows':[r['row'] for r in train],'test_rows':[r['row'] for r in test]})
 return {'status':'eligible' if not reasons else 'insufficient','counts':summary,'reasons':reasons,'folds':folds,'fits':0}
def weights(rows):
 sizes={g:sum(r['group']==g for r in rows) for g in {r['group'] for r in rows}}
 return np.asarray([1/sizes[r['group']] for r in rows])


class Fit:
 def fit(self,rows):
  if len(rows)<9 or set(r['y'] for r in rows)!={0,1}:raise ValueError('Train-fold class/PCA8 support required')
  X=np.asarray([r['features'] for r in rows]);V=np.asarray([r['visual_mean'] for r in rows]);Y=np.asarray([r['y'] for r in rows]);w=weights(rows)
  self.pca=PCA(n_components=8,svd_solver='full',random_state=42).fit(V);self.models={};self.scalers={}
  for kind,z in [('numeric',X),('visual',np.c_[X,self.pca.transform(V)])]:
   scaler=StandardScaler().fit(z,sample_weight=w);model=LogisticRegression(C=1.,fit_intercept=True,solver='lbfgs',max_iter=2000,random_state=42).fit(scaler.transform(z),Y,sample_weight=w)
   if np.any(model.n_iter_>=2000):raise ValueError('Fixed whole head did not converge within2000 iterations')
   if not np.isfinite(model.coef_).all() or not np.isfinite(model.intercept_).all():raise ValueError('Nonfinite fitted whole head')
   self.scalers[kind]=scaler;self.models[kind]=model
  self.groups={r['group'] for r in rows};self.row_ids={r['row'] for r in rows};return self
 def design(self,rows,kind):
  X=np.asarray([r['features'] for r in rows]);return X if kind=='numeric' else np.c_[X,self.pca.transform(np.asarray([r['visual_mean'] for r in rows]))]
 def probability(self,rows,kind):return self.models[kind].predict_proba(self.scalers[kind].transform(self.design(rows,kind)))[:,1]
 def export(self,kind):
  scaler=self.scalers[kind];model=self.models[kind];raw=model.coef_[0]/scaler.scale_;nw=raw[:8];vw=np.zeros(1152);bias=float(model.intercept_[0]-raw@scaler.mean_)
  if kind=='visual':vw=raw[8:]@self.pca.components_;bias-=float(vw@self.pca.mean_)
  head={'schema_version':1,'kind':'current_whole_recording_linear','target':recipe.TARGET,'feature_recipe':recipe.RECIPE,'feature_names':recipe.FEATURES,'visual_recipe':recipe.VISUAL_RECIPE,'weights':nw.tolist(),'visual_weights':vw.tolist(),'bias':bias,'enabled':False,'probability_calibrated':False,'automatic_action':False}
  recipe.score(head,[0.]*8,[1.]+[0.]*1151);return head


def metrics(y,p,groups):
 y=np.asarray(y);p=np.asarray(p,float);groups=np.asarray(groups)
 if y.shape!=p.shape or y.shape!=groups.shape or set(y.tolist())!={0,1} or not np.isfinite(p).all() or np.any(p<0) or np.any(p>1):raise ValueError('Matched two-class finite whole probabilities required')
 correct=(p>=.5)==y;recall={}
 for label in (0,1):recall[str(label)]=float(np.mean([correct[(groups==g)&(y==label)].mean() for g in sorted(set(groups[y==label]))]))
 return {'AUC':float(roc_auc_score(y,p)),'AP':float(average_precision_score(y,p)),'Brier':float(brier_score_loss(y,p)),'creator_macro_correct':float(np.mean([correct[groups==g].mean() for g in sorted(set(groups))])),'class_creator_macro_recall':recall,'macro_balanced_accuracy':(recall['0']+recall['1'])/2}
def bootstrap(y,a,b,groups,deadline=None):
 metrics(y,a,groups);metrics(y,b,groups)
 y=np.asarray(y);a=np.asarray(a);b=np.asarray(b);groups=np.asarray(groups);unique=sorted(set(groups));rng=np.random.default_rng(42);gains=[];invalid=0
 for draw in range(2000):
  if deadline is not None and draw%100==0:check(deadline)
  selected=rng.choice(unique,len(unique),replace=True);ids=np.concatenate([np.flatnonzero(groups==g) for g in selected])
  if len(set(y[ids]))!=2:invalid+=1;continue
  gains.append(float(roc_auc_score(y[ids],a[ids])-roc_auc_score(y[ids],b[ids])))
 return {'draws':2000,'valid':len(gains),'invalid_single_class':invalid,'gain_CI95':np.percentile(gains,[2.5,97.5]).tolist() if gains else None,'seed':42}
def gate(visual,numeric,confidence):
 ci=confidence['gain_CI95']
 return visual['macro_balanced_accuracy']>=.75 and visual['AUC']>=.8 and visual['AUC']-numeric['AUC']>=.05 and confidence['valid']>=1000 and ci is not None and ci[0]>0


def prepare(features_root,round_root,manifest_sha,snapshot_sha,out=OUT):
 rows,pins=load_inputs(features_root,round_root,manifest_sha,snapshot_sha,time.monotonic()+180);status=preflight(rows);spec={'policy':SPEC,'pins':pins,'features_root':str(Path(features_root).resolve()),'round_root':str(Path(round_root).resolve()),'preflight':status};write(Path(out)/'before-fit.json',spec)
 print(json.dumps({'status':'prepared_no_fit','counts':status['counts'],'eligibility':status['status'],'deficits':status['reasons'],'spec_sha256':sha(Path(out)/'before-fit.json'),'fits':0}));return spec

def run(out=OUT):
 started=time.monotonic();deadline=started+180;path=Path(out)/'before-fit.json';spec,_=read_json(path)
 if spec['policy']!=SPEC:raise ValueError('Frozen whole policy differs')
 rows,pins=load_inputs(spec['features_root'],spec['round_root'],spec['pins']['manifest_sha256'],spec['pins']['snapshot_sha256'],deadline);status=preflight(rows)
 if pins!=spec['pins'] or status!=spec['preflight']:raise ValueError('Reviewed whole inputs/preflight changed')
 if status['status']!='eligible':
  report={'status':'insufficient_explicit_whole_support','counts':status['counts'],'deficits':status['reasons'],'model_fits':0,'enabled':False,'historical_near_full_unknowns_relabelled':0};write(Path(out)/'status.json',report);print(json.dumps(report));return report
 if (Path(out)/'attempt.json').exists():raise ValueError('One whole training attempt only; no retry')
 write(Path(out)/'attempt.json',{'spec_sha256':sha(path),'attempts':1,'budget_seconds':180});known=[r for r in rows if r['y'] is not None];predictions=[]
 for fold in status['folds']:
  check(deadline);train=[r for r in known if r['row'] in fold['train_rows']];test=[r for r in known if r['row'] in fold['test_rows']];model=Fit().fit(train);prior=float(np.average([r['y'] for r in train],weights=weights(train)));probs={kind:model.probability(test,kind) for kind in ('numeric','visual')}
  for i,r in enumerate(test):predictions.append({'row':r['row'],'group':r['group'],'y':r['y'],'numeric':float(probs['numeric'][i]),'visual':float(probs['visual'][i]),'constant':prior})
 predictions.sort(key=lambda r:r['row']);y=[r['y'] for r in predictions];groups=[r['group'] for r in predictions];scores={kind:metrics(y,[r[kind] for r in predictions],groups) for kind in ('numeric','visual','constant')};check(deadline);confidence=bootstrap(y,[r['visual'] for r in predictions],[r['numeric'] for r in predictions],groups,deadline);passed=gate(scores['visual'],scores['numeric'],confidence);check(deadline);model=Fit().fit(known);heads={kind:model.export(kind) for kind in ('numeric','visual')}
 for kind,head in heads.items():
  portable=np.asarray([recipe.score(head,r['features'],r['visual_mean']) for r in known]);actual=model.models[kind].decision_function(model.scalers[kind].transform(model.design(known,kind)))
  if not np.allclose(portable,actual,atol=1e-10,rtol=0):raise ValueError('Actual whole Python portable score parity failed')
 check(deadline);report={'status':'evaluated_disabled','policy':SPEC,'spec_sha256':sha(path),'pins':pins,'counts':status['counts'],'fold_count':len(status['folds']),'metrics':scores,'paired_creator_bootstrap':confidence,'candidate_gate_passed':passed,'predictions':predictions,'seconds':time.monotonic()-started,'enabled':False,'probability_calibrated':False,'automatic_action':False,'production_changed':False,'reserved_outcomes_opened':False,'historical_near_full_unknowns_relabelled':0};write(Path(out)/'report.json',report)
 for kind,head in heads.items():write(Path(out)/f'{kind}_disabled_head.json',head)
 print(json.dumps({'status':report['status'],'counts':report['counts'],'metrics':scores,'paired_creator_bootstrap':confidence,'candidate_gate_passed':passed,'enabled':False,'seconds':report['seconds'],'report_sha256':sha(Path(out)/'report.json')}));return report

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['prepare','run']);p.add_argument('--features-root',type=Path,default=ROOT/'whole-feature-inputs-v2');p.add_argument('--round-root',type=Path,default=intake.contract.OUT);p.add_argument('--manifest-sha256');p.add_argument('--snapshot-sha256');p.add_argument('--out',type=Path,default=OUT);a=p.parse_args();signal.alarm(max(1,math.ceil(180-(time.monotonic()-PROCESS_START))))
 if a.mode=='prepare':
  if not a.manifest_sha256 or not a.snapshot_sha256:p.error('prepare requires exact manifest and completed snapshot SHAs')
  prepare(a.features_root,a.round_root,a.manifest_sha256,a.snapshot_sha256,a.out)
 else:run(a.out)
