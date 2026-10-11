"""Matched dense original-range joint interaction versus cached audio/SigLIP controls."""
import hashlib
import numpy as np
import joint_window_boundaries as jw
import dense_original_window_boundaries as da

def load(cohort_file,cache):
 audio_cache=cohort_file.parent/'joint-gemma/dense-original-audio';base,excluded=da.load(cohort_file,audio_cache);rows=[]
 for r in base:
  path=cache/'embeddings'/f"{r['row']}.npz"
  if not path.exists():excluded.append({'row':r['row'],'reason':'missing_dense_joint_checkpoint'});continue
  with np.load(path) as z:values={k:z[k].copy() for k in z.files}
  n=len(r['offsets']);a,b=r['detected_start'],r['detected_end'];audio_path=audio_cache/'embeddings'/f"{r['row']}.npz"
  assert str(values['revision'])==jw.PIN and abs(float(values['absolute_start'])-a)<.001 and abs(float(values['duration'])-(b-a))<.001
  assert str(values['alignment'])=='aresample_async_first_pts_0' and np.array_equal(values['offsets'],r['offsets'])
  assert str(values['audio_checkpoint_sha256'])==hashlib.sha256(audio_path.read_bytes()).hexdigest()
  if len(values['joint'])!=n or len(values['audio'])!=n:excluded.append({'row':r['row'],'reason':'incomplete_dense_joint_checkpoint'});continue
  for key in ('joint','audio'):
   assert values[key].shape==(n,768) and np.isfinite(values[key]).all() and np.allclose(np.linalg.norm(values[key],axis=1),1,atol=.015)
  assert np.array_equal(values['audio'],r['arrays']['audio']) and np.all(values['decoded_samples']==320000) and values['decoded_samples'].shape==(n,)
  assert values['frame_times'].shape==(n,2) and np.allclose(values['frame_times'],r['frame_times'],atol=.001)
  r['arrays'].update(joint=values['joint'],joint_numeric=values['joint'],joint_siglip=np.concatenate([r['arrays']['siglip'],values['joint']],1));r['recipe']=str(values['recipe']);rows.append(r)
 return rows,excluded

if __name__=='__main__':
 jw.load=load;jw.FAMILIES=['siglip','audio_pure','audio','late_siglip','joint','joint_numeric','joint_siglip'];jw.CONTROL_FAMILIES=('siglip','audio_pure','audio','late_siglip');jw.JOINT_FAMILIES=('joint','joint_numeric','joint_siglip');jw.RECIPES=[(family,'basic',C) for family in jw.FAMILIES for C in (.1,1.,10.)]+[(family,'relative',1.) for family in ('audio_pure','audio','late_siglip','joint','joint_numeric','joint_siglip')];jw.REPORT_PREFIX='dense_original_joint';jw.ARTIFACT_KIND='matched_dense_joint_window_boundary';jw.SAMPLING_DESCRIPTION='Contiguous 20-second windows across each complete immutable original; same joint images, frozen SigLIP windows and cached audio vectors with exact offset/hash parity; no extrapolation beyond coverage';jw.main()
