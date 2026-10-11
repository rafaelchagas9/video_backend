"""Fine visual frames fused with already validated dense audio, no media reads."""
import argparse,json,time
from pathlib import Path
import numpy as np
from cut_and_whole import fine_boundaries
import frame_cuts as fc
import dense_boundary_audio as d
from constrained_boundary_audio import constrained_objective

def main():
 p=argparse.ArgumentParser();p.add_argument('--cohort',type=Path,required=True);p.add_argument('--dense',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();c=json.loads(a.cohort.read_text());fine=fine_boundaries(c,a.cohort.parent);manifest=json.loads((a.dense/'staging_manifest.json').read_text());mapping={r['row']:r for r in manifest['rows']};rows=fc.build([r for r in fine if r['row'] in mapping],a.cohort.parent)
 for r in rows:
  source=mapping[r['row']]
  with np.load(a.dense/'embeddings'/f"{r['row']}.npz") as z:v=z['v'];times=source['absolute_start']+z['offsets']+10
  interpolated=np.stack([np.interp(r['times'],times,v[:,i]) for i in range(768)],1);interpolated/=np.maximum(np.linalg.norm(interpolated,axis=1,keepdims=True),1e-9);r['X']=np.concatenate([r['X'][:,:1152],interpolated,r['X'][:,-4:]],1).astype(np.float32)
 fc.objective=constrained_objective;d.evaluate(rows,a.output,time.monotonic()+110)
 for name in ('dense_boundary_envelope.json','dense_boundary_report.json'):
  path=a.output/name;value=json.loads(path.read_text());value['temporal_recipe']='Unit original cached visual frames plus linearly interpolated and renormalized dense20s audio vectors; original frame timestamps';value['numeric_features']=fc.NAMES;value['inner_objective']='Maximum channel-macro IoU subject to retained duration>=97% and p10>=90%';d.save(path,value)
if __name__=='__main__':main()
