"""Current-acceptability adaptation from coarse audio; entire held-out channels excluded from both tasks."""
import sys,json,time
from pathlib import Path
import numpy as np
from scipy.optimize import minimize
from scipy.special import expit
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score,brier_score_loss
sys.path.insert(0,str(Path(__file__).resolve().parent))
import prepare as p
import audio_complete as audio
import fine_labels as fl
ROOT=p.ROOT;FINE=ROOT.parent/'preference-audio-20261010'

def current_metrics(rows,scores):
 verified=fl.absolute_rows(rows);labels=np.asarray([r['y'] for r in verified]);fl.require_binary(labels,'current-acceptability metrics')
 return {'auroc':float(roc_auc_score(labels,scores)),'brier':float(brier_score_loss(labels,expit(scores))),**fl.strict_pair_metrics(verified,scores)}

def _main():
 fl.freeze_semantics(ROOT/'label-semantics'/f'{fl.POLICY}.json')
 start=time.monotonic();private=json.loads((FINE/'private_manifest.json').read_text());public=json.loads((FINE/'features_with_embeddings.json').read_text());by={r['row']:r for r in private['rows']};cohort=json.loads((ROOT/'cohort.json').read_text());cg={r['video_id']:r['group'] for r in cohort['rows']};fine=[];FX=[];FE=[];window_meta={w['id']:w for w in private['windows']};snapshot=json.loads((ROOT/'private_snapshot.json').read_text());channel_group={p.dd.channel_key(r['channel']):cg[r['video_id']] for r in snapshot['records'] if r['video_id'] in cg};task_channel={t['id']:p.dd.channel_key(t['channel']) for t in snapshot['tasks']};fgmap={r['group']:channel_group.get(task_channel[r['task_id']],'fine-only-'+r['group']) for r in private['rows']};annotated=fl.annotate_rows(public['rows'],private['rows'],snapshot['tasks']);label_summary=fl.summary(annotated);public=dict(public,rows=fl.absolute_rows(annotated))
 for row in public['rows']:
  meta=by[row['row']];windows=[w for w in row['windows'] if w.get('gemma_audio') is not None];assert len(windows)==3
  # Existing uniformly selected samples; no post-answer chosen edges enter features.
  vectors=np.array([w['gemma_audio'] for w in [w for w in windows if window_meta[w['id']].get('selection')!='heard_preview']]);embedding=p.unit(vectors.mean(0));fine.append({**row,'coarse_group':fgmap.get(meta['group'],'fine-only-'+meta['group'])});FX.append(row['base']);FE.append(embedding)
 FX=np.array(FX);FE=np.array(FE);fy=np.array([r['y'] for r in fine]);groups=np.array([r['group'] for r in fine]);fl.require_binary(fy,'fine residual absolute cohort')
 # Fail before any fitting or cache restoration when inner/outer class coverage is absent.
 for group in sorted(set(groups)):
  tr=np.flatnonzero(groups!=group);fl.require_binary(fy[tr],'fine residual outer training fold');buckets={g:i%3 for i,g in enumerate(sorted(set(groups[tr])))}
  for fold in range(3):
   it=[i for i in tr if buckets[groups[i]]!=fold];fl.require_binary(fy[it],'fine residual inner training fold')
 coarse=[];CX=[];CE=[]
 for row in json.loads((ROOT/'audio/private_manifest.json').read_text())['rows']:
  v=audio.validate_checkpoint(row)
  if v is not None:coarse.append(row);CX.append(row['features'][:2]);CE.append(v)
 CX=np.array(CX);CE=np.array(CE);cy=np.array([r['y'] for r in coarse]);groups=np.array([r['group'] for r in fine]);cgroups=np.array([r['group'] for r in coarse])
 def prediction(tr,te,C,blocked=()):
  excluded={fine[i]['coarse_group'] for i in te}|set(blocked);ci=np.array([g not in excluded for g in cgroups]);assert not excluded.intersection(cgroups[ci]);scale=StandardScaler().fit(CX[ci]);pc=PCA(16,svd_solver='full').fit(CE[ci]);ls=StandardScaler().fit(pc.transform(CE[ci]));z=np.c_[scale.transform(CX[ci]),ls.transform(pc.transform(CE[ci]))];prior=LogisticRegression(C=1.,solver='liblinear',max_iter=5000).fit(z,cy[ci]);fz=np.c_[scale.transform(FX),ls.transform(pc.transform(FE))];prior_logits=prior.decision_function(fz)
  fs=StandardScaler().fit(fz[tr]);A=np.c_[np.ones(len(tr)),fs.transform(fz[tr])];B=np.c_[np.ones(len(te)),fs.transform(fz[te])]
  def objective(w):
   logits=prior_logits[tr]+A@w;probs=expit(logits);return np.sum(np.logaddexp(0,logits)-fy[tr]*logits)+.5*np.sum(w*w)/C,A.T@(probs-fy[tr])+w/C
  fit=minimize(objective,np.zeros(A.shape[1]),jac=True,method='L-BFGS-B',options={'maxiter':1000,'gtol':1e-6});assert fit.success
  return prior_logits[te]+B@fit.x,prior_logits[te]
 out=np.zeros(len(fine));base=np.zeros(len(fine));prior=np.zeros(len(fine));selection=[]
 for group in sorted(set(groups)):
  tr=np.where(groups!=group)[0];te=np.where(groups==group)[0];trials=[]
  for C in (.01,.1,1.):
   q=np.zeros(len(fine));innergroups=sorted(set(groups[tr]));buckets={g:i%3 for i,g in enumerate(innergroups)}
   for fold in range(3):
    it=np.array([i for i in tr if buckets[groups[i]]!=fold]);ie=np.array([i for i in tr if buckets[groups[i]]==fold]);q[ie],_=prediction(it,ie,C,{fine[i]['coarse_group'] for i in te})
   trials.append((brier_score_loss(fy[tr],expit(q[tr])),C))
  C=min(trials)[1];out[te],prior[te]=prediction(tr,te,C);sc=StandardScaler().fit(FX[tr]);m=LogisticRegression(C=1.,solver='liblinear').fit(sc.transform(FX[tr]),fy[tr]);base[te]=m.decision_function(sc.transform(FX[te]));selection.append({'channel':group,'C':C})
 def metrics(scores):return current_metrics(fine,scores)
 report={'label_contract':label_summary,'training_targets':{'baseline':'verified fine current-acceptability labels','coarse_transfer':'coarse triage labels only','adapted':'coarse prior plus verified fine current-acceptability residual labels'},'target':'Current keep acceptability of offered cuts; separate relative winners, future replacement and permanent storage worth','rows':len(fine),'channels':len(set(groups)),'keeps':int(fy.sum()),'validation':'leave-whole-channel-out; coarse prior excludes every test channel; fine residual C chosen inside training channels','baseline':metrics(base),'coarse_transfer':metrics(prior),'adapted':metrics(out),'folds':selection,'seconds':time.monotonic()-start,'production_changed':False,'limitation':'All verified current candidates; two negative channels can leave inner training without both classes; exploratory reused corpus, not independent final audit'};p.save(ROOT/f'fine_transfer_report.{fl.POLICY}.json',report);p.save(ROOT/f'fine_transfer_predictions.{fl.POLICY}.json',{'rows':[r['row'] for r in fine],'adapted':out.tolist(),'prior':prior.tolist(),'base':base.tolist()});print(json.dumps(report))
def main():
 try:_main()
 except (fl.InsufficientAbsoluteLabels,fl.FineLabelContractError) as error:
  report={'status':'insufficient_explicit_labels_or_provenance','policy':fl.POLICY,'error':str(error),'model_fitted':False,'production_changed':False};p.save(ROOT/f'fine_transfer_report.{fl.POLICY}.json',report);print(json.dumps(report))
if __name__=='__main__':main()
