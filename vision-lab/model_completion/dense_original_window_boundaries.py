"""Complete immutable-original dense audio boundary check; frozen numeric caches only."""
import hashlib,json
from pathlib import Path
import numpy as np
import joint_window_boundaries as jw

def load(cohort_file,cache):
 pack=json.loads(cohort_file.read_text());receipt={r['row']:r for r in json.loads((cohort_file.parent/'joint-gemma/audio_reuse_manifest.json').read_text())['rows']};rows=[];excluded=[];frame_cache={}
 for r in pack['rows']:
  proof=receipt[r['row']]
  if not proof['complete_original_coverage']:excluded.append({'row':r['row'],'reason':'incomplete_original_audio_coverage'});continue
  path=cache/'embeddings'/f"{r['row']}.npz"
  if not path.exists():excluded.append({'row':r['row'],'reason':'missing_dense_original_checkpoint'});continue
  with np.load(path) as z:values={k:z[k].copy() for k in z.files}
  a,b=r['detected_start'],r['detected_end'];offsets=np.asarray(values['offsets'],float);n=len(offsets);expected=np.asarray(proof['dense_offsets'],float)
  assert str(values['revision'])==jw.PIN and abs(float(values['absolute_start'])-a)<.001 and abs(float(values['duration'])-(b-a))<.001
  assert str(values['alignment'])=='aresample_async_first_pts_0'
  if not n or not np.array_equal(offsets,expected) or len(values['v'])!=n:excluded.append({'row':r['row'],'reason':'incomplete_dense_original_checkpoint'});continue
  assert offsets[0]<=a+.05 and offsets[-1]+20>=b-.05 and np.all(np.diff(offsets)>0) and np.all(np.diff(offsets)<=20.1)
  assert np.all(offsets>=a-.001) and np.all(offsets+20<=b+.001)
  assert values['v'].shape==(n,768) and np.isfinite(values['v']).all() and np.allclose(np.linalg.norm(values['v'],axis=1),1,atol=.015)
  assert values['decoded_samples'].shape==(n,) and np.all(values['decoded_samples']==320000)
  vid=r['video_id']
  if vid not in frame_cache:
   file=Path(r['visual_frame_cache']);assert hashlib.sha256(file.read_bytes()).hexdigest()==r['visual_cache_sha256']
   with np.load(file) as z:t,v=z['t'].copy(),z['v'].astype(np.float32)
   v/=np.maximum(np.linalg.norm(v,axis=1,keepdims=True),1e-9);activity=None;cheap=cohort_file.parent.parent/'audio'/f'{vid}.npz'
   if cheap.exists():
    with np.load(cheap) as z:
     if 'db' in z.files and 'flux' in z.files:
      def robust(x):
       x=np.asarray(x,float);spread=1.4826*np.median(np.abs(x-np.median(x)));return np.clip((x-np.median(x))/(spread or 1),-5,5)
      activity=robust(z['db'])+robust(z['flux'])
   frame_cache[vid]=(t,v,activity)
  t,v,activity=frame_cache[vid];visual=[];frame_times=[]
  for offset in offsets:
   valid=np.flatnonzero((t>=offset-.001)&(t<offset+20))
   if len(valid)<2:break
   ids=[int(valid[np.argmin(abs(t[valid]-(offset+5)))]),int(valid[np.argmin(abs(t[valid]-(offset+15)))])]
   if ids[0]==ids[1]:break
   mean=v[ids].mean(0);visual.append(mean/max(np.linalg.norm(mean),1e-9));frame_times.append(t[ids].tolist())
  if len(visual)!=n:excluded.append({'row':r['row'],'reason':'missing_exact_window_frozen_visual_control'});continue
  visual=np.asarray(visual,np.float32);original=v[(t>=a)&(t<=b)];centre=original.mean(0);centre/=max(np.linalg.norm(centre),1e-9);times=offsets+10;transition=np.r_[0.,np.clip(1-np.sum(visual[1:]*visual[:-1],axis=1),0,2)];cheapvalues=np.zeros(n) if activity is None else activity[np.maximum(0,np.minimum(len(activity)-1,times.astype(int)))];numeric=np.stack([(times-a)/(b-a),visual@centre,transition,cheapvalues],1).astype(np.float32)
  overlap=np.maximum(0.,np.minimum(offsets+20,r['selected_end'])-np.maximum(offsets,r['selected_start']))/20;y=(overlap>=.8).astype(int);sample=[]
  for ids in (np.flatnonzero(overlap>=.8),np.flatnonzero(overlap<=.2)):
   if len(ids):sample.extend(ids[np.linspace(0,len(ids)-1,min(40,len(ids))).astype(int)].tolist())
  if not sample:excluded.append({'row':r['row'],'reason':'no_unambiguous_gold_window'});continue
  arrays={'siglip':visual,'audio_pure':values['v'],'audio':values['v'],'late_siglip':np.concatenate([visual,values['v']],1)}
  rows.append(dict(r,times=times,offsets=offsets,arrays=arrays,numeric=numeric,y=y,sample=np.array(sample),frame_times=frame_times,recipe='gemma2-audioonly-immutable-original-dense20s-validated-v1'))
 return rows,excluded

if __name__=='__main__':
 jw.load=load;jw.FAMILIES=['siglip','audio_pure','audio','late_siglip'];jw.CONTROL_FAMILIES=tuple(jw.FAMILIES);jw.JOINT_FAMILIES=();jw.RECIPES=[(family,'basic',C) for family in jw.FAMILIES for C in (.1,1.,10.)]+[(family,'relative',1.) for family in ('audio','late_siglip')];jw.REPORT_PREFIX='dense_original_audio';jw.ARTIFACT_KIND='matched_dense_audio_window_boundary';jw.SAMPLING_DESCRIPTION='Contiguous 20-second windows across each complete immutable original with final overlapping tail window; exact-window matched frozen storyboard vectors, no interpolation beyond coverage';jw.main()
