"""Actual TypeScript production loader/detector parity on private numeric caches only."""
import os,sys,json,subprocess,hashlib
from pathlib import Path
os.environ.setdefault('OMP_NUM_THREADS','2');os.environ.setdefault('OPENBLAS_NUM_THREADS','2')
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT));sys.path.insert(0,str(Path(__file__).parent))
import numpy as np,psycopg
import stage1_complete as stage
import deployed_clipper as dc
from label_server import PG
OUT=stage.OUT;ART=OUT/'parity';ART.mkdir(parents=True,exist_ok=True);ART.chmod(0o700)
with psycopg.connect(PG) as conn:
 conn.execute('SET TRANSACTION READ ONLY')
 settings=dict(conn.execute("select key,value from app_settings where key in ('recordings_sensitivity','recordings_detector','recordings_highlight_states')").fetchall())
 audits=conn.execute("select id,video_id,start_seconds,end_seconds,stratum from recording_label_tasks where kind='recall-audit' and answer='keep' order by id").fetchall()
sensitivity=float(settings.get('recordings_sensitivity','1.4')) or 1.4
states=tuple(x.strip() for x in settings.get('recordings_highlight_states','nude,explicit').split(',') if x.strip() in dc.CLASSES) or ('nude','explicit')
raw=json.loads((OUT/'candidate.json').read_text());probe={'W':np.asarray(raw['weights']),'b':np.asarray(raw['bias']),'radius':raw['context_radius']}
inputs=json.loads((OUT/'inputs.json').read_text());ids=sorted(int(v) for v in inputs['clips']);cached=[(v,stage.archived_frames(v)) for v in ids];cached=[(v,f) for v,f in cached if f is not None and len(f[0])>=4]
extra=[min(cached,key=lambda x:len(x[1][0]))[0],max(cached,key=lambda x:len(x[1][0]))[0]]
selected=list(dict.fromkeys([a[1] for a in audits]+extra));fixture={'candidate':str(OUT/'candidate.json'),'sensitivity':sensitivity,'states':states,'samples':[]};expected={};audit_coverage=[]
for index,vid in enumerate(selected):
 found=stage.archived_frames(vid);assert found is not None;t,v,_=found
 rows=inputs['clips'].get(str(vid),[]);duration=next((x['recording_seconds'] for x in rows if x['recording_seconds']),float(t[-1]+5));sample=f's{index:03d}'
 path=ART/f'{sample}.f32';v.astype('<f4').tofile(path);path.chmod(0o600)
 # An extra fractional end cap tests production clamping, without probing source media.
 durations=list(dict.fromkeys([float(duration),float(t[-1]+3.25)]))
 fixture['samples'].append({'sample':sample,'vectors':str(path),'timestamps':t.tolist(),'durations':durations})
 for limit in durations:
  clips=dc.detect(probe,t,v,limit,sensitivity,states);probs=dc.classify(probe['W'],probe['b'],dc.context(v,probe['radius']));score=dc.highlight_scores(probs,states)
  curve=score if len(score)<=240 else np.array([score[int(i*len(score)/240):max(int(i*len(score)/240)+1,int((i+1)*len(score)/240))].max() for i in range(240)])
  expected[(sample,limit)]={'clips':clips,'curve':[dc.js_round(float(x)*1000)/1000 for x in curve]}
 for task,avid,a,b,stratum in audits:
  if avid==vid:
   clips=expected[(sample,float(duration))]['clips'];covered=sum(max(0,min(b,c['end_seconds'])-max(a,c['start_seconds'])) for c in clips)
   audit_coverage.append({'audit':f'a{task:03d}','window_seconds':b-a,'candidate_covered_seconds':covered,'coverage_fraction':covered/(b-a),'has_proposal_overlap':covered>0,'stratum':stratum})
fixture_path=ART/'inputs.json';fixture_path.write_text(json.dumps(fixture));fixture_path.chmod(0o600)
result=subprocess.run(['nice','-n','10','bun','run',str(Path(__file__).with_suffix('.ts')),str(fixture_path)],cwd=ROOT.parent,capture_output=True,text=True,timeout=120)
if result.returncode:raise RuntimeError('Production parity runner failed: '+result.stderr[-1000:])
actual=json.loads(result.stdout);assert actual['production_schema_validated'];assert abs(actual['threshold']-dc.probe_threshold(sensitivity))<1e-12
checks=[]
for value in actual['outputs']:
 ref=expected[(value['sample'],value['duration'])];assert len(value['clips'])==len(ref['clips']),f"clip count parity {value['sample']}"
 for a,b in zip(value['clips'],ref['clips']):
  for key in ('start_seconds','end_seconds','peak_seconds','score','label','keep'):assert a[key]==b[key],f"clip parity {value['sample']} {key}: {a[key]} vs {b[key]}"
 assert value['curve']==ref['curve'],f"curve parity {value['sample']}"
 checks.append({'sample':value['sample'],'duration_seconds':value['duration'],'clips':len(value['clips']),'curve_points':len(value['curve']),'exact_match':True})
report={'production_schema_validated':True,'production_python_ts_parity':True,'tested_recordings':len(selected),'tested_duration_cases':len(checks),'runtime':{'detector':settings.get('recordings_detector','trained'),'sensitivity':sensitivity,'threshold':actual['threshold'],'highlight_states':states,'matches_evaluated_threshold':abs(actual['threshold']-.45)<1e-12},'checks':checks,'positive_audit_coverage':audit_coverage,'positive_audits_covered':sum(a['has_proposal_overlap'] for a in audit_coverage),'positive_audits_total':len(audit_coverage),'production_changed':False,'candidate_sha256':hashlib.sha256((OUT/'candidate.json').read_bytes()).hexdigest(),'limitations':['Duration fixtures use saved numeric feedback durations and a fractional synthetic end cap; raw source durations were not probed.','Positive audit windows identify useful stretches, not exact frame-by-frame useful-event timestamps.']}
stage.save('parity_report.json',report);print(json.dumps(report,indent=2))
