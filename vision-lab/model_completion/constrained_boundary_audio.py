"""Predefined alternative: maximize IoU subject to inner-fold retention constraints."""
import argparse,json,sys,time
from pathlib import Path
import dense_boundary_audio as d
import known_boundary_audio as k
from cut_and_whole import fine_boundaries
import frame_cuts as fc

def constrained_objective(metric):
 return metric['channel_macro_iou'] if metric['channel_macro_retained']>=.97 and metric['retention_p10']>=.9 else -10.

def main():
 p=argparse.ArgumentParser();p.add_argument('--cohort',type=Path,required=True);p.add_argument('--dense',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
 c=json.loads(a.cohort.read_text());fine=fine_boundaries(c,a.cohort.parent);manifest=json.loads((a.dense/'staging_manifest.json').read_text());src=json.loads((a.cohort.parent.parent/'preference-audio-20261010'/'private_manifest.json').read_text());mapping={f"fine{r['task_id']}{r['row'][-1]}":r for r in src['rows']};score={r['row']:mapping[r['row']]['base'][1] for r in fine};rows=d.numeric_rows(fine,manifest['rows'],a.dense,a.cohort.parent,score)
 fc.objective=constrained_objective;d.evaluate(rows,a.output,time.monotonic()+110)
 sys.argv=['known_boundary_audio','--cohort',str(a.cohort),'--dense',str(a.dense),'--output',str(a.output)];k.main()
 for filename in ('dense_boundary_report.json','known_boundary_report.json'):
  f=a.output/filename;r=json.loads(f.read_text());r['inner_objective']='Maximum channel-macro IoU subject to retained selected duration>=97% and p10>=90%; held-out gate unchanged';d.save(f,r)
if __name__=='__main__':main()
