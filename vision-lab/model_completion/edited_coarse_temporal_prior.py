"""One fixed edited-coarse temporal choice prior; cached numeric data only."""
import argparse,hashlib,json,signal,time
PROCESS_STARTED=time.monotonic()
from collections import Counter,defaultdict
from pathlib import Path
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
import frame_cuts as fc
import joint_window_boundaries as jw
import nonlinear_boundary as nb
import raw_original_boundaries as raw
from cut_and_whole import eligible_cuts,splits,save
from pixel_temporal_boundaries import pair_bootstrap,exact_zero_diagnostic

FAMILIES=['visual_control_C1','visual_edited_prior_C1']
POLICY={'primary':FAMILIES[1],'control':FAMILIES[0],'prior_C':.1,'fine_C':1.,'coarse_selection':'Only genuinely inward edited >=5s valid original keeps; unchanged spans excluded','coarse_labels':'WEAK selected-interior occupancy vs deliberately omitted exterior; not final worth or true frame-class labels','sample_rule':'Maximum40 inside +40 outside per edited clip; omit five-second boundary band; no artificial class when interior is too short','prior_weight':'Each recording total80, shared equally by edited clips in that recording and sampled frames within each clip; balanced class logistic','fine_weight':'Each gold fine clip total80 across samples, balanced class logistic','features':'prior:visual1152+training-scalednumeric4; fine:visual1152+training-scalednumeric4+one prior logit; control pads prior logit with zero','folds':'Whole fine-channel outer5/inner3; exclude all fine channels absent from current training fold from every coarse prior fit','projection':'none','model_selection':'No C/family grid; each fixed C1 family chooses interval policy only on inner fine-channel folds','seconds':90,'production':'Disabled pending independent audit/parity; no new labels, source media, GPU, uploads or DB writes'}
COARSE=[];FINE_GROUPS=set();PRIORS={};PRIOR_RECEIPTS=[]
BASE_PREPARE=jw.prepare;BASE_TRANSFORM=jw.transform


def edited(row):
 a,b=row['detected_start'],row['detected_end'];s,e=row['selected_start'],row['selected_end']
 return a<=s<e<=b and (s-a>=5 or b-e>=5)


def verify_join(coarse,fine,snapshot):
 records={r['id']:r for r in snapshot['records']};groups={r['video_id']:r['group'] for r in coarse['recordings']};channels=defaultdict(set)
 for row in coarse['rows']+fine:
  record=records.get(row['feedback_id'])
  if record is None or record['video_id']!=row['video_id'] or record['clip_id']!=row['clip_id'] or groups.get(row['video_id'])!=row['group']:raise ValueError('immutable feedback/video/clip/group join mismatch')
  if not row.get('has_original_edges',True) or record['detected_start'] is None or record['detected_end'] is None:raise ValueError('unknown original row cannot supply temporal prior provenance')
  if abs(record['detected_start']-row['detected_start'])>.001 or abs(record['detected_end']-row['detected_end'])>.001:raise ValueError('immutable original range join mismatch')
  if not str(row.get('row','')).startswith('fine') and row.get('analyzed_at') is not None and row['analyzed_at']!=record.get('analyzed_at'):raise ValueError('coarse immutable analysis generation mismatch')
  channels[row['group']].add(record['channel'])
 if any(len(c)!=1 for c in channels.values()) or len({next(iter(c)) for c in channels.values()})!=len(channels):raise ValueError('pseudonymous channel join is not exact one-to-one')
 return {'status':'Exact feedback/video/clip/original-bounds/private channel join, one-to-one shared pseudonymous groups','groups':len(channels)}


def allowed(coarse,training_groups,all_fine_groups):
 blocked=set(all_fine_groups)-set(training_groups);pool=[r for r in coarse if r['group'] not in blocked]
 if {r['group'] for r in pool}&blocked:raise ValueError('held-out fine channel in coarse prior training')
 return pool,blocked


def prior_weights(rows):
 counts=Counter(r['video_id'] for r in rows)
 return np.concatenate([np.full(len(r['sample']),80/(counts[r['video_id']]*len(r['sample']))) for r in rows])


def sample_classes(times,start,end):
 positive=np.flatnonzero((times>=start+5)&(times<=end-5));negative=np.flatnonzero((times<start-5)|(times>end+5));out=[]
 for ids in (positive,negative):
  if len(ids):out.extend(ids[np.linspace(0,len(ids)-1,min(40,len(ids))).astype(int)].tolist())
 return np.array(out,dtype=int)


def load(root,deadline):
 cohort=json.loads((root/'cohort.json').read_text());snapshot=json.loads((root/'private_snapshot.json').read_text());fine=json.loads((root/'actual_fine_cohort.json').read_text())['rows'];recreated,_=raw.targets(root/'cohort.json');targets={r['row']:r for r in recreated}
 if len(fine)!=26 or set(targets)!={r['row'] for r in fine}:raise ValueError('fine26 immutable target identity mismatch')
 for r in fine:
  for key in ['video_id','group','detected_start','detected_end','selected_start','selected_end']:
   if r[key]!=targets[r['row']][key]:raise ValueError('fine finalcut provenance mismatch')
 eligible=eligible_cuts(cohort['rows']);changed=[r for r in eligible if edited(r)];join=verify_join(dict(cohort,rows=changed),fine,snapshot)
 if len(eligible)!=122 or len(changed)!=76:raise ValueError('fixed122/76 edited-only cohort mismatch')
 frameproof=[];files={r['video_id']:root/'frames'/f"{r['video_id']}.npz" for r in changed+fine};missing=[]
 for vid,path in sorted(files.items()):
  nb.check(deadline)
  if not path.exists():missing.append(vid);continue
  before=path.stat()
  if before.st_dev!=root.stat().st_dev:raise ValueError('numeric frame cache is outside frozen SSD device')
  cheap=root.parent/'audio'/f'{vid}.npz'
  if cheap.exists() and cheap.stat().st_dev!=root.stat().st_dev:raise ValueError('cheap numeric audio cache is outside frozen SSD device')
  data=path.read_bytes();digest=hashlib.sha256(data).hexdigest();after=path.stat()
  if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise ValueError('numeric frame cache changed during identity check')
  for r in fine:
   if r['video_id']==vid and digest!=r['visual_cache_sha256']:raise ValueError('fine frozen visual hash mismatch')
  frameproof.append({'video_id':vid,'size':before.st_size,'mtime_ns':before.st_mtime_ns,'sha256':digest})
 fine_built=fc.build(fine,root);coarse_built=fc.build(changed,root);nb.check(deadline)
 if len(fine_built)!=26 or len({r['group'] for r in fine_built})!=12 or len(coarse_built)!=74 or len({r['group'] for r in coarse_built})!=30:raise ValueError('exact26fine/74coarse cached-frame cohort mismatch')
 for r in fine_built+coarse_built:
  if r['X'].shape!=(len(r['times']),1156) or not np.isfinite(r['X']).all() or len(r['times'])<3 or not np.allclose(np.diff(r['times']),5.,atol=.001):raise ValueError('numeric frame shape/cadence/finiteness mismatch')
  expected=sample_classes(r['times'],r['selected_start'],r['selected_end'])
  if not np.array_equal(r['sample'],expected):raise ValueError('boundary-band/sample-cap recipe mismatch')
 for proof in frameproof:
  stat=files[proof['video_id']].stat()
  if [stat.st_size,stat.st_mtime_ns]!=[proof['size'],proof['mtime_ns']]:raise ValueError('numeric frame cache changed during loading')
 COARSE.clear();COARSE.extend(coarse_built);FINE_GROUPS.clear();FINE_GROUPS.update(r['group'] for r in fine_built);PRIORS.clear();PRIOR_RECEIPTS.clear()
 for r in fine_built:
  r['arrays']={family:r['X'][:,:1152] for family in FAMILIES};r['numeric']=np.c_[r['X'][:,-4:],np.zeros(len(r['times']))].astype(np.float32)
 return fine_built,{'join':join,'eligible_coarse_keeps':122,'edited_coarse_spans':76,'unchanged_spans_excluded':46,'recoverable_edited_spans':74,'edited_channels':30,'missing_numeric_frame_videos':missing,'coarse_sampled_frames':sum(len(r['sample']) for r in COARSE),'coarse_clips_without_sampled_positive':sum(not np.any(r['y'][r['sample']]) for r in COARSE),'frame_hash_receipts':frameproof}


def prior(rows):
 groups=frozenset(r['group'] for r in rows)
 if groups in PRIORS:return PRIORS[groups]
 train,blocked=allowed(COARSE,groups,FINE_GROUPS);X=np.concatenate([r['X'][r['sample']] for r in train]);y=np.concatenate([r['y'][r['sample']] for r in train]);w=prior_weights(train)
 if len(set(y))!=2:raise ValueError('coarse prior training lacks both weak occupancy classes')
 scale=StandardScaler().fit(X[:,-4:],sample_weight=w);X[:,-4:]=scale.transform(X[:,-4:]);model=LogisticRegression(C=.1,solver='liblinear',max_iter=2000,class_weight='balanced',random_state=29).fit(X,y,sample_weight=w);PRIORS[groups]=(scale,model)
 PRIOR_RECEIPTS.append({'fine_train_channels':sorted(groups),'blocked_fine_channels':sorted(blocked),'coarse_train_channels':sorted({r['group'] for r in train}),'coarse_clips':len(train),'coarse_frames':len(X),'positives':int(y.sum()),'negatives':int((1-y).sum()),'C':.1,'held_channel_overlap':0})
 return scale,model


def prepare(rows,recipe):
 pre=BASE_PREPARE(rows,recipe)
 if recipe[0]=='visual_edited_prior_C1':pre['coarse_prior']=prior(rows)
 return pre


def transform(pre,rows):
 matrices=BASE_TRANSFORM(pre,rows)
 if 'coarse_prior' in pre:
  scale,model=pre['coarse_prior']
  for r,X in zip(rows,matrices):
   original=r['X'].copy();original[:,-4:]=scale.transform(original[:,-4:]);X[:,-1]=model.decision_function(original)
 return matrices


def run(root,out):
 start=PROCESS_STARTED;deadline=start+90;save(out/'preregistered.json',dict(POLICY,started_monotonic=start));status={'status':'failed','enabled':False,'policy':POLICY}
 def expire(signum,frame):raise TimeoutError('90-second total numeric loading/evaluation deadline')
 signal.signal(signal.SIGALRM,expire);signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
 try:
  rows,provenance=load(root,deadline);jw.prepare=prepare;jw.transform=transform;jw.NUMERIC_NAMES=list(fc.NAMES)+['edited_coarse_choice_prior_logit'];jw.RECIPES=[(family,'basic',1.) for family in FAMILIES]
  pred={f:[None]*len(rows) for f in FAMILIES};probs={f:[None]*len(rows) for f in FAMILIES};folds=[]
  for tr,te in splits(rows,5):
   nb.check(deadline);train=[rows[i] for i in tr];test=[rows[i] for i in te];settings=jw.choose(train,deadline);chosen={}
   for j,family in enumerate(FAMILIES):
    nb.check(deadline);s=settings[j];ps=jw.probabilities(jw.fit(train,jw.RECIPES[j]),test);cuts=fc.intervals(test,ps,s['level'],s['mode'])
    for i,p,q in zip(te,cuts,ps):pred[family][i]=p;probs[family][i]=q
    chosen[family]=s
   folds.append({'train_groups':sorted({r['group'] for r in train}),'test_groups':sorted({r['group'] for r in test}),'settings':chosen})
   save(out/'partial_validation.json',{'complete':False,'completed_outer_folds':len(folds),'folds':folds,'prior_fits':PRIOR_RECEIPTS,'predictions':pred})
  identity=fc.metrics(rows,[[r['detected_start'],r['detected_end']] for r in rows]);comparisons={}
  for family in FAMILIES:
   nb.check(deadline);metric=fc.metrics(rows,pred[family]);boot=jw.channel_bootstrap(rows,pred[family]);diag=jw.error_diagnostic(rows,pred[family],probs[family]);exact=exact_zero_diagnostic([x['iou_delta'] for x in diag['per_channel']]);boot['exact_zero_mass']=exact;boot['stable']=bool(boot['stable'] and not exact['exact_lower_95percent_gain_cannot_be_positive']);comparisons[family]={'candidate':metric,'nominal_gate':jw.gate(identity,metric),'channel_bootstrap':boot,'passed_identity_gate':bool(jw.gate(identity,metric) and boot['stable']),'error_diagnostic':diag}
  matched=pair_bootstrap(rows,pred[FAMILIES[1]],pred[FAMILIES[0]]);passed=comparisons[FAMILIES[1]]['passed_identity_gate'] and matched['stable_gain'];nb.check(deadline)
  status={'status':'completed','policy':POLICY,'rows':26,'channels':12,'fine_sampled_frames':sum(len(r['sample']) for r in rows),'identity':identity,'comparisons':comparisons,'matched_control_bootstrap':matched,'primary_validation_passed':passed,'enabled':False,'provenance':provenance,'prior_fits':PRIOR_RECEIPTS,'folds':folds,'seconds':time.monotonic()-start,'no_media_reads':True,'no_gpu_cloud_or_db_writes':True}
  save(out/'edited_coarse_temporal_predictions.json',{'rows':[{'row':r['row'],'group':r['group'],'original':[r['detected_start'],r['detected_end']],'selected':[r['selected_start'],r['selected_end']],'predictions':{f:pred[f][i] for f in FAMILIES}} for i,r in enumerate(rows)]})
 except TimeoutError as error:status.update(status='expired',error=str(error),seconds=time.monotonic()-start,no_rerun=True,partial_prior_fits=PRIOR_RECEIPTS)
 except Exception as error:status.update(status='failed',error=f'{type(error).__name__}: {error}',seconds=time.monotonic()-start,no_rerun=True)
 signal.setitimer(signal.ITIMER_REAL,0);save(out/'edited_coarse_temporal_report.json',status);save(out/'edited_coarse_temporal_envelope.json',{'schema_version':1,'kind':'edited_coarse_temporal_boundary','enabled':False,'fallback':'original_range','automatic_action':False,'validation_passed':bool(status.get('primary_validation_passed',False))});print(json.dumps(status,indent=2));return status

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();run(a.root,a.output)
