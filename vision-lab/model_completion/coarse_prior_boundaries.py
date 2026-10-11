"""One frozen coarse-audio direction transferred to fine boundary supervision."""
import hashlib,json,sys
from collections import Counter,defaultdict
from pathlib import Path
import numpy as np
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
import dense_original_window_boundaries as da
import joint_window_boundaries as jw
import frame_cuts as fc
from cut_and_whole import save
COARSE=[]
FINE_GROUPS=set()
FITS={}
JOIN_PROOF={}
BASE_PREPARE=jw.prepare
BASE_TRANSFORM=jw.transform

def load(cohort_file,cache):
 rows,excluded=da.load(cohort_file,cache);root=cohort_file.parent
 coarse=json.loads((root/'cohort.json').read_text());snap=json.loads((root/'private_snapshot.json').read_text());records={r['id']:r for r in snap['records']};byvideo={r['video_id']:r['group'] for r in coarse['recordings']};privategroups=defaultdict(set)
 for row in coarse['rows']:
  source=records[row['feedback_id']];assert source['video_id']==row['video_id'] and byvideo[row['video_id']]==row['group'];privategroups[row['group']].add(source['channel'])
 assert all(len(values)==1 for values in privategroups.values())
 for row in rows:
  source=records[row['feedback_id']];assert source['video_id']==row['video_id'] and row['group']==byvideo[row['video_id']] and source['channel'] in privategroups[row['group']]
  assert abs(source['detected_start']-row['detected_start'])<.001 and abs(source['detected_end']-row['detected_end'])<.001
  audio=row['arrays']['audio'];row['arrays']={'audio':audio,'audio_coarse_prior':audio};row['numeric']=np.c_[row['numeric'],np.zeros(len(audio))].astype(np.float32)
 FINE_GROUPS.clear();FINE_GROUPS.update(r['group'] for r in rows);COARSE.clear();FITS.clear()
 for row in coarse['rows']:
  file=root/'audio/embeddings'/f"{row['row']}.npz"
  if not file.exists():continue
  with np.load(file) as z:
   assert str(z['revision'])==jw.PIN and int(z['feedback_id'])==row['feedback_id'] and abs(float(z['start'])-row['detected_start'])<.001 and abs(float(z['end'])-row['detected_end'])<.001
   audio=z['embedding'].copy();assert audio.shape==(768,) and np.isfinite(audio).all() and .99<np.linalg.norm(audio)<1.01
  COARSE.append(dict(row,audio=audio))
 JOIN_PROOF.update({'status':'verified immutable video_id/feedback_id/private channel mapping to one shared cohort group namespace','fine_targets':len(rows),'coarse_audio_rows':len(COARSE),'coarse_audio_channels':len({r['group'] for r in COARSE}),'cohort_sha256':hashlib.sha256((root/'cohort.json').read_bytes()).hexdigest()})
 return rows,excluded

def prior(rows):
 train_groups=frozenset(r['group'] for r in rows)
 if train_groups in FITS:return FITS[train_groups]
 blocked=FINE_GROUPS-set(train_groups);train=[r for r in COARSE if r['group'] not in blocked];assert not {r['group'] for r in train}&blocked
 X=np.array([r['features'] for r in train],float);A=np.array([r['audio'] for r in train],float);y=np.array([r['y'] for r in train]);assert len(set(y))==2 and len(train)>16
 scale=StandardScaler().fit(X);pca=PCA(n_components=16,svd_solver='full').fit(A);latent=pca.transform(A);ps=StandardScaler().fit(latent);Z=np.c_[scale.transform(X),ps.transform(latent)];counts=Counter(r['video_id'] for r in train);w=np.array([1/counts[r['video_id']] for r in train])*len(train)/len(counts)
 model=LogisticRegression(C=.1,solver='liblinear',max_iter=5000,tol=1e-6).fit(Z,y,sample_weight=w);audio_weights=(model.coef_[0][13:]/ps.scale_)@pca.components_
 result={'audio_weights':audio_weights,'coarse_training_rows':len(train),'coarse_training_channels':len({r['group'] for r in train}),'coarse_positive_rows':int(y.sum()),'blocked_fine_channels':sorted(blocked),'fine_training_channels':sorted(train_groups),'C':.1,'PCA_components':16,'numeric_confounds_adjusted':13,'coarse_recording_weighted':True};FITS[train_groups]=result;return result

def prepare(rows,recipe):
 pre=BASE_PREPARE(rows,recipe)
 if recipe[0]=='audio_coarse_prior':pre['coarse_audio_prior']=prior(rows)
 return pre

def transform(pre,rows):
 matrices=BASE_TRANSFORM(pre,rows)
 if 'coarse_audio_prior' in pre:
  direction=pre['coarse_audio_prior']['audio_weights']
  for r,X in zip(rows,matrices):X[:,-1]=r['arrays']['audio_coarse_prior']@direction
 return matrices

def main():
 jw.load=load;jw.prepare=prepare;jw.transform=transform;jw.FAMILIES=['audio','audio_coarse_prior'];jw.CONTROL_FAMILIES=('audio',);jw.JOINT_FAMILIES=('audio_coarse_prior',);jw.NUMERIC_NAMES=list(fc.NAMES)+['frozen_coarse_audio_acceptance_direction'];jw.RECIPES=[(family,'basic',C) for family in jw.FAMILIES for C in (.1,1.,10.)]+[(family,'relative',1.) for family in jw.FAMILIES];jw.REPORT_PREFIX='coarse_prior';jw.ARTIFACT_KIND='coarse_prior_temporal_boundary';jw.SAMPLING_DESCRIPTION='Same21 fully covered immutable originals and exact dense20s audio windows; one frozen coarse audio acceptance direction as a numeric feature; fine gold only labels window training; no ASR support selection';jw.main()
 output=Path(sys.argv[sys.argv.index('--output')+1]);rp=output/'coarse_prior_boundary_report.json';report=json.loads(rp.read_text());report['coarse_transfer']={'join_proof':JOIN_PROOF,'recipe':'coarse original13 features + train-only audioPCA16 + train-only scaling, recording-weighted logistic C.1; transfer only fitted audio direction, fine-calibrate its scalar value','coarse_semantics':'keep means coarse proposal potential; no coarse-inside windows marked as final-worth positives','aggregation_domain_shift':'coarse unit normalized mean of two windows -> one unit local window; tested transfer, not equivalent input','exclusion_rule':'Every fine channel absent from current training fold is blocked in coarse fit, covering both outer and inner held-out channels','fits':[dict(v,audio_weights=None) for v in FITS.values()]};save(rp,report)
 ap=output/'coarse_prior_boundary_envelope.json';artifact=json.loads(ap.read_text())
 if artifact.get('enabled') and artifact.get('recipe',[None])[0]=='audio_coarse_prior':
  assert frozenset(FINE_GROUPS) in FITS;direction=FITS[frozenset(FINE_GROUPS)]['audio_weights'];artifact['coarse_audio_direction']=direction.tolist();artifact['coarse_audio_direction_recipe']=report['coarse_transfer']['recipe']
 save(ap,artifact);print(json.dumps({'join':JOIN_PROOF,'coarse_fits':len(FITS),'enabled':report['enabled']},indent=2))

if __name__=='__main__':main()
