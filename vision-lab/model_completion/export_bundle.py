"""Export validated heads with explicit fallbacks; promotion is a separate atomic action."""
import hashlib,json,sys
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parent))
import prepare as p
import rank as r

def main():
 data=json.loads((p.ROOT/'cohort.json').read_text());rows=[x for x in data['rows'] if x['has_original_edges']];X=np.array([x['features'] for x in rows]);ranking=json.loads((p.ROOT/'ranking_report.json').read_text());audio=json.loads((p.ROOT/'audio'/'report.json').read_text());accepted=json.loads((p.ROOT/'audio'/'audio_acceptance.json').read_text());candidate=json.loads((p.ROOT/'ranking_candidate.json').read_text())
 base=r.Model(r.SPECS[1],1.).fit(rows,X).export(True)
 # Baseline classifier is validated against prevalence; new ranking models did not pass.
 base_report=ranking['reports']['base_point'];assert base_report['auroc']>.7
 base_validation={'rows':len(rows),'channels':base_report['channels'],'auroc':base_report['auroc'],'brier':ranking['acceptance']['base_brier'],'target':'coarse triage potential','normalization':'whole-channel held-out, training-fold only','automatic_pruning':False}
 assert base_validation['brier']<np.mean([x['y'] for x in rows])*(1-np.mean([x['y'] for x in rows]))
 assert accepted['gate_passed'] and accepted['validated_spec']['C']==.1
 bundle={**candidate,'version':'recording-model-20261010-v1','heads':{'triage':candidate['heads']['triage'],'acceptance':base,'audio_acceptance':accepted},'validation':{**candidate['validation'],'acceptance_fallback':base_validation,'audio_acceptance':{'report_sha256':hashlib.sha256((p.ROOT/'audio'/'report.json').read_bytes()).hexdigest(),'gate_passed':True,'target':'coarse triage potential'},'ranking':'retain shipped ordering; candidates failed held-out gate','automatic_pruning':False,'storage_preference':'separate evaluation pending exact matching-window confirmation','cuts':'candidates remain disabled until a retained-footage boundary gate passes'}}
 cuts=p.ROOT/'artifacts'/'cuts.json'
 if cuts.exists():bundle['cut']=json.loads(cuts.read_text())
 p.save(p.ROOT/'recording-model-bundle.json',bundle)
 p.save(p.ROOT/'bundle_manifest.json',{'version':bundle['version'],'bundle_sha256':hashlib.sha256((p.ROOT/'recording-model-bundle.json').read_bytes()).hexdigest(),'snapshot_sha256':hashlib.sha256((p.ROOT/'cohort.json').read_bytes()).hexdigest(),'features':p.FEATURES,'enabled':['validated numeric classifier','validated audio classifier'],'disabled':['new ranking','learned cut offsets','automatic pruning','automatic whole-recording verdict'],'no_label_writes':True})
 print(json.dumps({'version':bundle['version'],'features':len(p.FEATURES),'numeric_fallback':base_validation,'audio_classifier':accepted['validated_spec'],'cut_enabled':bundle.get('cut',{}).get('enabled',False)}))
if __name__=='__main__':main()
