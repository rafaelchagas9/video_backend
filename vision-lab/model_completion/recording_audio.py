"""Complete-original-proposal recording triage; never final-storage preference."""
import argparse,json,math
from pathlib import Path
import numpy as np
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from cut_and_whole import recording_rows,classification_metrics,splits,save
PIN='914f7f89142e33e77833254d9c9b90c3cef7303b'
def fit(rows,kind,C):
 X=np.array([r['features'] for r in rows]);A=np.array([r['audio'] for r in rows]);scale=StandardScaler().fit(X);pca=PCA(n_components=min(16,len(rows)-1),svd_solver='full').fit(A);ps=StandardScaler().fit(pca.transform(A));V=transform((scale,pca,ps,None,kind),rows)
 model=LogisticRegression(C=C,solver='liblinear',max_iter=1000,random_state=29).fit(V,[r['any_keep'] for r in rows]);return scale,pca,ps,model,kind
def transform(model,rows):
 scale,pca,ps,_,kind=model;X=scale.transform(np.array([r['features'] for r in rows]));A=ps.transform(pca.transform(np.array([r['audio'] for r in rows])))
 return X if kind=='numeric' else A if kind=='audio' else np.concatenate([X,A],1)
def pred(m,rows):return m[3].predict_proba(transform(m,rows))[:,1]
def choose(rows):
 options=[]
 for kind in ('numeric','audio','combined'):
  for C in (.1,1.,10.):
   held=np.zeros(len(rows))
   for tr,te in splits(rows,3):
    a=[rows[i] for i in tr];b=[rows[i] for i in te]
    held[te]=np.mean([r['any_keep'] for r in a]) if len({r['any_keep'] for r in a})<2 else pred(fit(a,kind,C),b)
   options.append((classification_metrics([r['any_keep'] for r in rows],held)['brier'],C,kind))
 _,C,kind=min(options);return kind,C

def main():
 a=argparse.ArgumentParser();a.add_argument('--cohort',type=Path,required=True);a.add_argument('--output',type=Path,required=True);a=a.parse_args();c=json.loads(a.cohort.read_text());folder=a.cohort.parent/'audio'/'embeddings';index={};lookup={(r['video_id'],r['clip_id']):r for r in c['rows']}
 for r in c['rows']:
  p=folder/f"{r['row']}.npz"
  if not p.exists():continue
  with np.load(p) as z:
   v=z['embedding'];valid=v.shape==(768,) and np.isfinite(v).all() and str(z['revision'])==PIN and int(z['feedback_id'])==r['feedback_id'] and abs(float(z['start'])-r['detected_start'])<.001 and abs(float(z['end'])-r['detected_end'])<.001
   if valid:index[(r['video_id'],r['clip_id'])]=v.copy()
 rows=[];missing=0
 for r in recording_rows(c):
  proposals=r.get('original_proposals',[]);keys=[(r['video_id'],p['id']) for p in proposals]
  if not keys or any(k not in index for k in keys):missing+=1;continue
  # Mean all ORIGINAL proposals equally; none filtered by review choice.
  mean=np.mean([index[k] for k in keys],0);mean/=max(np.linalg.norm(mean),1e-9);rows.append(dict(r,audio=mean))
 if len(rows)<15 or len({r['any_keep'] for r in rows})<2:save(a.output/'recording_audio_report.json',{'eligible':len(rows),'ineligible_missing_original_embedding':missing,'enabled':False,'reason':'Insufficient complete recording coverage'});return
 predictions=np.zeros(len(rows));baseline=np.zeros(len(rows));numeric=np.zeros(len(rows));folds=[]
 for tr,te in splits(rows):
  train=[rows[i] for i in tr];test=[rows[i] for i in te];kind,C=choose(train);predictions[te]=pred(fit(train,kind,C),test);numeric[te]=pred(fit(train,'numeric',1.),test);baseline[te]=np.mean([r['any_keep'] for r in train]);folds.append({'train':len(train),'test':len(test),'kind':kind,'C':C})
 y=[r['any_keep'] for r in rows];report={'eligible':len(rows),'channels':len({r['group'] for r in rows}),'ineligible_missing_original_embedding':missing,'target':'Coarse recording triage potential (any saved keep), not final storage worth','all_original_proposals_required':True,'validation':'Whole-channel outer5 folds; modality and C picked in inner3; scaling and PCA trained inside every fold','baseline':classification_metrics(y,baseline),'numeric':classification_metrics(y,numeric),'candidate':classification_metrics(y,predictions),'folds':folds,'enabled':False}
 # This is a diagnostic complete-case subset, never a deployable final-worth head.
 save(a.output/'recording_audio_report.json',report);save(a.output/'recording_audio_predictions.json',{'rows':[{'video_id':r['video_id'],'group':r['group'],'y':int(r['any_keep']),'baseline':float(b),'numeric':float(n),'candidate':float(p)} for r,b,n,p in zip(rows,baseline,numeric,predictions)]});print(json.dumps(report,indent=2))
if __name__=='__main__':main()
