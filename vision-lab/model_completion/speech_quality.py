"""Numeric-only speech checkpoint quality aggregates; no transcript inference."""
import json,sys
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).parent));from prepare import ROOT,save
D=ROOT/'joint-gemma/dense-original-speech';fields=['asr_status','token_count','mean_logprob','mean_text_logprob','timestamp_valid','coverage_seconds','truncated','repetition_suspect','low_confidence','no_speech_probability'];parts={k:[] for k in fields}
for p in sorted((D/'embeddings').glob('*.npz')):
 with np.load(p) as z:
  m=z['asr_status']>=0
  for k in fields:parts[k].append(z[k][m])
v={k:np.concatenate(x) if x else np.array([]) for k,x in parts.items()};report={'evaluated_windows':len(v['asr_status']),'planned_windows':1149,'detected_language_ids_available':False,'language_limitation':'Short-form decoder language tokens existed only inside transient generation outputs and were not checkpointed; no extra inference or language guesses performed.','status_quality':{}}
for status in (0,1,2):
 m=v['asr_status']==status;n=int(m.sum());counts=v['token_count'][m];item={'windows':n,'token_count_le1':int(np.sum(counts<=1)),'token_count_ge2':int(np.sum(counts>=2)),'low_generated_confidence':int(np.sum(v['low_confidence'][m])),'low_text_logprob_lt_minus1':int(np.sum(v['mean_text_logprob'][m]<-1)),'truncated':int(np.sum(v['truncated'][m])),'repetition_suspect':int(np.sum(v['repetition_suspect'][m])),'timestamp_valid':int(np.sum(v['timestamp_valid'][m]))}
 for key in ['coverage_seconds','mean_logprob','mean_text_logprob','no_speech_probability']:item[key+'_quantiles']=np.quantile(v[key][m],[0,.1,.5,.9,1]).tolist() if n else []
 report['status_quality'][str(status)]=item
save(D/'quality_report.json',report);print(json.dumps(report))
