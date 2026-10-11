"""Preregistered low-cadence pixel proxies; one bounded local SSD-only comparison."""
import argparse,hashlib,io,json,os,time,signal
PROCESS_STARTED=time.monotonic()
from pathlib import Path
import numpy as np
from PIL import Image
from scipy.ndimage import laplace
import dense_original_window_boundaries as da
import joint_window_boundaries as jw
import frame_cuts as fc
import nonlinear_boundary as nb
from cut_and_whole import save,splits

PIXEL_NAMES=['gray_adjacent_abschange_mean','gray_adjacent_abschange_max','laplacian_variance_mean','laplacian_variance_adjacent_abschange_mean']
FAMILIES=['audio_control_C1','audio_pixel_C1']
FROZEN_GAP={'row':'fine337a','offset':1495.,'missing_frame':299,'missing_timestamp':1495.,'missing_page':11,'available_frames':[300,301,302],'available_timestamps':[1500.,1505.,1510.],'reason':'Frozen +5/+15 storyboard inventory omits the original first boundary page; use exactly three existing contiguous tiles and record five-second initial pixel gap'}
POLICY={'diagnosed_pixel_coverage_gap':FROZEN_GAP,'total_seconds_including_preflight_failure':90,'preflight_failure_seconds':0.9172403030097485,'continuation_seconds':89,'primary':'audio_pixel_C1','control':'audio_control_C1','C':1.0,'projection':'none','numeric_scaling':'all eight numeric features, training-fold clip-balanced weights','resize_long_side':96,'resize':'PIL BILINEAR, aspect preserving, rounded dimensions','gray':'PIL L luminance normalized /255','laplacian':'scipy.ndimage.laplace(mode=reflect), variance','window':'all frozen 5s tiles with offset <= timestamp < offset+20; no interpolation','features':PIXEL_NAMES,'folds':'outer5 inner3 whole channels, interval policy selected separately inside each training fold','family_selection':'none; pixel family is predeclared primary','seconds':90,'media':'197 existing SSD WEBP pages only; no original media, GPU, network or uploads','promotion':'disabled pending independent audit and production parity'}

def fingerprint(path):
 s=path.stat();return [s.st_size,s.st_mtime_ns]

def checked_bytes(path,expected,ssd_device,expected_hash=None):
 before=path.stat()
 if [before.st_size,before.st_mtime_ns]!=expected or before.st_dev!=ssd_device:raise ValueError('staged page fingerprint or SSD-device mismatch')
 data=path.read_bytes();digest=hashlib.sha256(data).hexdigest()
 if fingerprint(path)!=expected:raise ValueError('staged page changed during read')
 if expected_hash is not None and digest!=expected_hash:raise ValueError('staged page hash mismatch')
 return data,digest

def tile_gray(sheet,index,width,height):
 if width<1 or height<1:raise ValueError('invalid tile dimensions')
 slot=index%25;x=(slot%5)*width;y=(slot//5)*height
 if x+width>sheet.width or y+height>sheet.height:raise ValueError('tile exceeds actual sheet bounds')
 image=sheet.crop((x,y,x+width,y+height)).convert('L');ratio=min(1.,96/max(width,height));shape=(max(1,round(width*ratio)),max(1,round(height*ratio)))
 image=image.resize(shape,Image.Resampling.BILINEAR)
 return np.asarray(image,dtype=np.float32)/255.

def window_indices(times,offset,available_pages=None):
 times=np.asarray(times,float)
 if not np.isfinite(times).all() or (len(times)>1 and not np.allclose(np.diff(times),5.,atol=.001)):raise ValueError('frozen frame timestamp cadence is not 5s')
 indices=np.flatnonzero((times>=offset-.000001)&(times<offset+20-.000001))
 if available_pages is not None:indices=np.array([i for i in indices if int(i)//25 in available_pages],dtype=int)
 if len(indices)<3 or np.any(np.diff(indices)!=1):raise ValueError('window lacks contiguous original 5s tile coverage')
 return indices

def pixel_features(variances,changes):
 if len(variances)<3 or len(changes)!=len(variances)-1:raise ValueError('window feature coverage mismatch')
 a=np.asarray(variances,float);d=np.asarray(changes,float)
 return np.array([d.mean(),d.max(),a.mean(),np.abs(np.diff(a)).mean()],np.float32)

def exact_zero_diagnostic(gains):
 gains=np.asarray(gains,float);zero=np.isclose(gains,0,atol=1e-12);mass=float((zero.sum()/len(gains))**len(gains));nonnegative=bool(np.all(gains>=-1e-12))
 return {'channels':len(gains),'zero_gain_channels':int(zero.sum()),'all_channel_gains_nonnegative':nonnegative,'exact_probability_all_resampled_channels_zero':mass,'exact_lower_95percent_gain_cannot_be_positive':bool(nonnegative and mass>=.025),'meaning':'For nonnegative channel gains, the all-zero bootstrap mass bounds the exact lower quantile; mixed-sign gains require the full distribution.'}

def pair_bootstrap(rows,predicted,control):
 groups=sorted({r['group'] for r in rows});gain=[]
 for group in groups:
  sub=[r for r in rows if r['group']==group];pa=[p for r,p in zip(rows,predicted) if r['group']==group];pb=[p for r,p in zip(rows,control) if r['group']==group]
  gain.append(fc.metrics(sub,pa)['channel_macro_iou']-fc.metrics(sub,pb)['channel_macro_iou'])
 draws=np.random.default_rng(61010).integers(0,len(groups),(5000,len(groups)));values=np.array(gain)[draws].mean(1);ci=np.quantile(values,[.025,.975]).tolist();exact=exact_zero_diagnostic(gain)
 return {'gain_ci95':ci,'per_channel_gains':dict(zip(groups,gain)),'draws':5000,'exact_zero_mass':exact,'stable_gain':bool(ci[0]>0 and not exact['exact_lower_95percent_gain_cannot_be_positive'])}

def extract(rows,root,out,deadline):
 private={r['row']:r for r in json.loads((root/'joint-gemma/private_manifest.json').read_text())['rows']};pages={};tasks={};ssd_device=None;gaps=[]
 for r in rows:
  nb.check(deadline);m=private[r['row']]
  for key in ['video_id','group','feedback_id','clip_id','detected_start','detected_end','selected_start','selected_end','visual_index_provenance','visual_cache_sha256']:
   if m[key]!=r[key]:raise ValueError('immutable row identity mismatch: '+key)
  device=Path(m['audio_cache']).stat().st_dev
  if ssd_device is None:ssd_device=device
  if device!=ssd_device:raise ValueError('staged audio device mismatch')
  f=Path(m['visual_frame_cache']);raw=f.read_bytes()
  if hashlib.sha256(raw).hexdigest()!=m['visual_cache_sha256']:raise ValueError('frozen frame cache hash mismatch')
  with np.load(io.BytesIO(raw)) as z:t=z['t'].copy()
  if len(t)!=m['visual_index_provenance'][1] or float(m['visual_index_provenance'][2])!=5.:raise ValueError('frame index provenance mismatch')
  available_pages=set(map(int,m['pages']));ids=[]
  for offset in r['offsets']:
   all_ids=window_indices(t,float(offset));chosen=window_indices(t,float(offset),available_pages);missing=np.setdiff1d(all_ids,chosen)
   if len(missing):
    if r['row']!=FROZEN_GAP['row'] or float(offset)!=FROZEN_GAP['offset'] or missing.tolist()!=[299] or chosen.tolist()!=[300,301,302]:raise ValueError('unexpected missing pixel coverage outside diagnosed frozen gap')
    gaps.append(FROZEN_GAP)
   elif len(chosen)!=4:raise ValueError('unexpected full window tile count')
   ids.append(chosen)
  needed=set(np.concatenate(ids).tolist());vid=r['video_id'];entry=tasks.setdefault(vid,{'t':t,'needed':set(),'lap':{},'change':{}});
  if not np.array_equal(entry['t'],t):raise ValueError('same recording has conflicting frozen timestamps')
  entry['needed'].update(needed);r['pixel_ids']=ids
  for index,path in m['pages'].items():
   index=int(index);key=(vid,index);spec={'path':Path(path),'fingerprint':m['page_fingerprints'][str(index)],'width':m['sprite_width'],'height':m['sprite_height']}
   if key in pages and pages[key]!=spec:raise ValueError('conflicting shared page provenance')
   pages[key]=spec
  if any((vid,i//25) not in pages for i in needed):raise ValueError('needed frame missing frozen page identity')
 if gaps!=[FROZEN_GAP]:raise ValueError('diagnosed frozen gap contract changed')
 if len(pages)!=197:raise ValueError('preregistered 197-page cohort mismatch')
 proof=[];previous={};decoded=0
 def partial():
  save(out/'pixel_checkpoint.partial.json',{'complete':False,'pages':decoded,'page_hashes':proof,'frames':{str(vid):{'laplacian_variance':{str(k):v for k,v in task['lap'].items()},'adjacent_abschange':{str(k):v for k,v in task['change'].items()}} for vid,task in tasks.items()}})
 try:
  for (vid,index),spec in sorted(pages.items()):
   nb.check(deadline);data,digest=checked_bytes(spec['path'],spec['fingerprint'],ssd_device)
   with Image.open(io.BytesIO(data)) as sheet:
    if sheet.format!='WEBP' or sheet.width!=5*spec['width']:raise ValueError('frozen page format or tile columns mismatch')
    sheet.load();task=tasks[vid]
    for ix in sorted(i for i in task['needed'] if i//25==index):
     nb.check(deadline);gray=tile_gray(sheet,ix,spec['width'],spec['height']);task['lap'][ix]=float(np.var(laplace(gray,mode='reflect')))
     if vid in previous and previous[vid][0]==ix-1:
      old=previous[vid][1]
      if old.shape!=gray.shape:raise ValueError('adjacent frame resize geometry mismatch')
      task['change'][ix]=float(np.mean(np.abs(gray-old)))
     previous[vid]=(ix,gray)
   proof.append({'video_id':vid,'page':index,'fingerprint':spec['fingerprint'],'sha256':digest,'sheet_dimensions':[sheet.width,sheet.height],'tile_dimensions':[spec['width'],spec['height']]});decoded+=1
   if decoded%10==0:partial()
  for r in rows:
   task=tasks[r['video_id']];features=[]
   for ids in r['pixel_ids']:
    nb.check(deadline);features.append(pixel_features([task['lap'][int(i)] for i in ids],[task['change'][int(i)] for i in ids[1:]]))
   pix=np.asarray(features,np.float32);r['numeric']=np.concatenate([r['numeric'],pix],1);r['numeric_by_family']={'audio_control_C1':np.concatenate([r['numeric'][:,:4],np.zeros_like(pix)],1)};r['arrays']={name:r['arrays']['audio'] for name in FAMILIES}
   path=out/'features'/f"{r['row']}.npz";path.parent.mkdir(parents=True,exist_ok=True);tmp=path.with_suffix('.tmp.npz');np.savez_compressed(tmp,pixel=pix,offsets=r['offsets'],video_id=r['video_id'],original=[r['detected_start'],r['detected_end']],recipe='pixel-proxy-5s-gray96-v1');tmp.replace(path)
  save(out/'pixel_checkpoint.json',{'complete':True,'pages':decoded,'frames':sum(len(t['lap']) for t in tasks.values()),'page_hashes':proof,'hash_contract':'Existing frozen size/mtime/generation/frame-cache identity plus SHA256 of the same immutable bytes decoded; no preexisting page SHA was available. Each page is read once, hashed and decoded from those bytes, with stat parity before/after read.'})
 except BaseException:
  partial();raise
 return {'pages':decoded,'frames':sum(len(t['lap']) for t in tasks.values()),'page_hashes_recorded':len(proof),'pixel_coverage_gaps':gaps,'windows_with_three_tiles':1,'windows_with_four_tiles':1148,'no_original_media_reads':True}

def run(root,out,seconds=89):
 started=PROCESS_STARTED;deadline=started+seconds;save(out/'preregistered.json',dict(POLICY,started_monotonic=started));status={'status':'failed','enabled':False,'primary':'audio_pixel_C1'}
 def expire(signum,frame):raise TimeoutError('89-second diagnosed continuation deadline')
 signal.signal(signal.SIGALRM,expire);signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
 try:
  rows,excluded=da.load(root/'actual_fine_cohort.json',root/'joint-gemma/dense-original-audio');nb.check(deadline)
  if len(rows)!=21 or sum(len(r['offsets']) for r in rows)!=1149 or len({r['group'] for r in rows})!=10:raise ValueError('primary complete-original cohort mismatch')
  provenance=extract(rows,root,out,deadline);jw.NUMERIC_NAMES=list(fc.NAMES)+PIXEL_NAMES;jw.RECIPES=[(family,'basic',1.) for family in FAMILIES]
  pred={f:[None]*len(rows) for f in FAMILIES};probs={f:[None]*len(rows) for f in FAMILIES};folds=[]
  for tr,te in splits(rows,5):
   nb.check(deadline);train=[rows[i] for i in tr];test=[rows[i] for i in te];settings=jw.choose(train,deadline);chosen={}
   for j,family in enumerate(FAMILIES):
    nb.check(deadline);s=settings[j];ps=jw.probabilities(jw.fit(train,jw.RECIPES[j]),test);intervals=fc.intervals(test,ps,s['level'],s['mode'])
    for i,p,q in zip(te,intervals,ps):pred[family][i]=p;probs[family][i]=q
    chosen[family]=s
   folds.append({'train_groups':sorted({r['group'] for r in train}),'test_groups':sorted({r['group'] for r in test}),'settings':chosen})
  nb.check(deadline);identity=fc.metrics(rows,[[r['detected_start'],r['detected_end']] for r in rows]);comparisons={}
  for family in FAMILIES:
   metric=fc.metrics(rows,pred[family]);boot=jw.channel_bootstrap(rows,pred[family]);diag=jw.error_diagnostic(rows,pred[family],probs[family]);exact=exact_zero_diagnostic([x['iou_delta'] for x in diag['per_channel']]);boot['exact_zero_mass']=exact;boot['stable']=bool(boot['stable'] and not exact['exact_lower_95percent_gain_cannot_be_positive']);comparisons[family]={'candidate':metric,'nominal_gate':jw.gate(identity,metric),'channel_bootstrap':boot,'passed_identity_gate':bool(jw.gate(identity,metric) and boot['stable']),'error_diagnostic':diag}
  matched=pair_bootstrap(rows,pred['audio_pixel_C1'],pred['audio_control_C1']);passed=comparisons['audio_pixel_C1']['passed_identity_gate'] and matched['stable_gain'];nb.check(deadline)
  status={'status':'completed','rows':21,'channels':10,'windows':1149,'identity':identity,'comparisons':comparisons,'matched_control_bootstrap':matched,'primary_validation_passed':passed,'enabled':False,'promotion_status':'independent audit and production parity required','excluded':excluded,'provenance':provenance,'policy':POLICY,'folds':folds,'seconds':time.monotonic()-started,'no_gpu':True,'no_original_media_reads':True}
  save(out/'pixel_temporal_predictions.json',{'rows':[{'row':r['row'],'group':r['group'],'original':[r['detected_start'],r['detected_end']],'selected':[r['selected_start'],r['selected_end']],'predictions':{f:pred[f][i] for f in FAMILIES}} for i,r in enumerate(rows)]})
 except TimeoutError as error:status.update(status='expired',error=str(error),seconds=time.monotonic()-started,no_rerun=True)
 except Exception as error:status.update(status='failed',error=f'{type(error).__name__}: {error}',seconds=time.monotonic()-started,no_rerun=True)
 signal.setitimer(signal.ITIMER_REAL,0)
 save(out/'pixel_temporal_report.json',status);save(out/'pixel_temporal_envelope.json',{'schema_version':1,'kind':'pixel_temporal_boundary','enabled':False,'fallback':'original_range','automatic_action':False,'validation_passed':bool(status.get('primary_validation_passed',False))});print(json.dumps(status,indent=2));return status

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--seconds',type=int,default=89);a=p.parse_args()
 if a.seconds!=89:raise ValueError('Only the single diagnosed 89-second continuation is authorized')
 run(a.root,a.output,a.seconds)
