"""Local matched benchmark runner, no upload and no transcript output."""
import argparse,json,time,sys,traceback
from pathlib import Path
import models_v2 as models
import pipeline as p
ROOT=p.ROOT/'data'/'audio-comparison-v2-20261009'

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--benchmark',action='store_true');parser.add_argument('--seconds',type=int,default=480);args=parser.parse_args()
    cohort=json.loads((ROOT/'cohort.json').read_text())
    items=[{'window':w['id'],'path':str(ROOT/'audio'/f"{w['id']}.flac")} for r in cohort['rows'] for w in r['windows']]
    if args.benchmark:
        items=[{'window':r['windows'][i%4]['id'],'path':str(ROOT/'audio'/f"{r['windows'][i%4]['id']}.flac")} for i,r in enumerate(cohort['rows'][:8])]
    out=ROOT/('benchmark' if args.benchmark else 'results')
    started=time.monotonic()
    try:
        report=models.run_windows(items,out,deadline=started+args.seconds,batch_size=2)
        summary={'status':'completed','windows':len(items),'elapsed_seconds':round(time.monotonic()-started,2),'coverage':report['coverage'],'batches':report['batches']}
    except Exception as error:
        causes=[];cause=error
        while cause is not None:
            causes.append({'type':type(cause).__name__,'frames':[{'file':Path(f.filename).name,'line':f.lineno,'function':f.name} for f in traceback.extract_tb(cause.__traceback__)]})
            cause=cause.__context__
        summary={'status':'failed','elapsed_seconds':round(time.monotonic()-started,2),'diagnostic':causes}
    p.save_json(ROOT/('benchmark_summary.json' if args.benchmark else 'run_summary.json'),summary)
    print(json.dumps({k:v for k,v in summary.items() if k!='batches'}),flush=True)
    if summary['status']!='completed':sys.exit(1)
if __name__=='__main__':main()
