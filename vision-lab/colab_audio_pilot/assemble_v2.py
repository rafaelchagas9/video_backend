"""Bind and assemble numeric-only model results for the local CPU comparison."""
import copy,json,hashlib,argparse
from pathlib import Path
import models_v2 as models
import pipeline as p
ROOT=p.ROOT/'data'/'audio-comparison-v2-20261009'

def inputs(cohort):
 return [{'window':w['id'],'path':str(ROOT/'audio'/f"{w['id']}.flac")} for r in cohort['rows'] for w in r['windows']]
def fingerprint(items):
 return hashlib.sha256(json.dumps([(i['window'],hashlib.sha256(Path(i['path']).read_bytes()).hexdigest()) for i in items]).encode()).hexdigest()
def seed():
 cohort=json.loads((ROOT/'cohort.json').read_text());items=inputs(cohort)
 dest=ROOT/'results'/'numeric_results.json'
 if dest.exists():return
 previous=json.loads((ROOT/'benchmark'/'numeric_results.json').read_text())
 bench=[{'window':r['windows'][i%4]['id'],'path':str(ROOT/'audio'/f"{r['windows'][i%4]['id']}.flac")} for i,r in enumerate(cohort['rows'][:8])]
 assert previous['cohort_sha256']==fingerprint(bench)
 assert previous['models']=={name:{'model':repo,'revision':rev} for name,(repo,rev) in models.MODEL_PINS.items()}
 cached={r['window']:r for r in previous['windows']}
 report=copy.deepcopy(previous);report['cohort_sha256']=fingerprint(items)
 report['batches']=[];report['windows']=[copy.deepcopy(cached[i['window']]) if i['window'] in cached else {'window':i['window'],**{f:None for f in models.FIELDS},'status':{f:-1 for f in models.FIELDS}} for i in items]
 dest.parent.mkdir(exist_ok=True);models._atomic(dest,report)
 print('Verified benchmark outputs seeded into full cohort.')
def assemble():
 cohort=json.loads((ROOT/'cohort.json').read_text());report=json.loads((ROOT/'results'/'numeric_results.json').read_text())
 assert report['cohort_sha256']==fingerprint(inputs(cohort))
 by_id={r['window']:r for r in report['windows']}
 for r in cohort['rows']:
  for w in r['windows']:
   source=by_id[w['id']];w.update({f:source[f] for f in models.FIELDS});w['status']=source['status']
 p.save_json(ROOT/'p002_results.json',cohort)
 print(json.dumps({'rows':len(cohort['rows']),'windows':len(by_id),'numeric_only':True}))
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('action',choices=['seed','assemble']);args=parser.parse_args();{'seed':seed,'assemble':assemble}[args.action]()
