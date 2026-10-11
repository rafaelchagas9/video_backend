"""Full-recording inputs for an explicit current whole-retention decision, never clip outcomes."""
from __future__ import annotations
import math
import numpy as np
RECIPE='whole-recording-v1'
TARGET='current_whole_recording_review'
FEATURES=['log_seconds','log_proposals','score_mean','score_max','proposed_coverage','whole_dispersion_mean','whole_transition_mean','has_frames']
VISUAL_RECIPE='unit_mean_unit_point_frames_entire_recording'
DIMENSION=1152
MAX_FRAMES=8000
MAX_PROPOSALS=60

def features(proposals,duration,t,v):
 if isinstance(duration,bool) or not isinstance(duration,(float,int)) or not math.isfinite(duration) or duration<=0:raise ValueError('Positive finite actual recording duration required')
 if any(not isinstance(p,dict) or not isinstance(p.get('id'),str) or not p['id'] for p in proposals):raise ValueError('Original proposal identities required')
 rows=[p for p in proposals if not p['id'].startswith('added-')]
 if len(rows)>MAX_PROPOSALS or len({p['id'] for p in rows})!=len(rows) or any(not isinstance(p['id'],str) or not p['id'] or any(isinstance(p[k],bool) or not isinstance(p[k],(float,int)) or not math.isfinite(p[k]) for k in ('start','end','score')) or not 0<=p['start']<p['end']<=duration for p in rows):raise ValueError('Original detector proposals required; decisions cannot replace source ranges')
 t=np.asarray(t,dtype=np.float64);v=np.asarray(v,dtype=np.float64)
 if v.size==0:v=np.empty((0,DIMENSION),dtype=np.float64)
 if t.ndim!=1 or v.ndim!=2 or v.shape!=(len(t),DIMENSION) or t.shape!=(len(v),) or len(v)>MAX_FRAMES or not np.isfinite(t).all() or not np.isfinite(v).all() or np.any(t<0) or np.any(t>duration) or np.any(np.diff(t)<=0):raise ValueError('Bounded full-recording numeric frames required')
 visual=None;dispersion=transition=0.
 if len(v):
  if t[0]>5.001 or np.any(np.diff(t)>10.001) or t[-1]+10<duration:raise ValueError('Entire recording point-frame coverage required')
  with np.errstate(over='ignore',invalid='ignore'):norms=np.linalg.norm(v,axis=1)
  if not np.isfinite(norms).all() or np.any(norms<1e-12):raise ValueError('Zero point-frame embedding')
  unit=v/norms[:,None];centre=unit.mean(0);norm=np.linalg.norm(centre)
  if norm<1e-12:raise ValueError('Cancelling whole-recording visual mean')
  visual=centre/norm;dispersion=float(np.clip(1-unit@visual,0,2).mean());transition=float(np.clip(1-np.sum(unit[:-1]*unit[1:],axis=1),0,2).mean()) if len(unit)>1 else 0.
 end=covered=0.
 for a,b in sorted((p['start'],p['end']) for p in rows):covered+=max(0,b-max(a,end));end=max(end,b)
 scores=[p['score'] for p in rows]
 x=[math.log(max(1.,duration)),math.log1p(len(rows)),float(np.mean(scores)) if scores else 0.,max(scores) if scores else 0.,covered/duration,dispersion,transition,float(bool(len(v)))]
 if not np.isfinite(x).all():raise ValueError('Nonfinite whole input')
 return x,None if visual is None else visual.tolist()

def score(head,x,visual):
 keys={'schema_version','kind','target','feature_recipe','feature_names','visual_recipe','weights','visual_weights','bias','enabled','probability_calibrated','automatic_action'}
 if not isinstance(head,dict) or set(head)!=keys or type(head['schema_version']) is not int or head['schema_version']!=1 or type(head['enabled']) is not bool or head['kind']!='current_whole_recording_linear' or head['target']!=TARGET or head['feature_recipe']!=RECIPE or head['feature_names']!=FEATURES or head['visual_recipe']!=VISUAL_RECIPE or head['automatic_action'] is not False or head['probability_calibrated'] is not False:raise ValueError('Unsupported explicit whole-retention head')
 def numeric(values):
  return all(not isinstance(z,(bool,np.bool_)) and isinstance(z,(int,float,np.integer,np.floating)) and math.isfinite(float(z)) for z in np.asarray(values,dtype=object).flat)
 if not isinstance(head['weights'],list) or not isinstance(head['visual_weights'],list) or not all(numeric(a) for a in (head['weights'],head['visual_weights'],x)) or (visual is not None and not numeric(visual)):raise ValueError('Boolean/non-numeric portable whole inputs')
 w=np.asarray(head['weights'],dtype=float);vw=np.asarray(head['visual_weights'],dtype=float);x=np.asarray(x,dtype=float);bias=head['bias']
 if w.shape!=(8,) or vw.shape!=(DIMENSION,) or x.shape!=(8,) or not np.isfinite(w).all() or not np.isfinite(vw).all() or not np.isfinite(x).all() or isinstance(bias,bool) or not isinstance(bias,(float,int)) or not math.isfinite(bias):raise ValueError('Finite portable whole head required')
 if visual is None:
  if np.any(vw!=0):raise ValueError('Whole visual head requires full recording inputs')
  value=float(w@x+bias)
 else:
  visual=np.asarray(visual,dtype=float)
  if visual.shape!=(DIMENSION,) or not np.isfinite(visual).all() or abs(np.linalg.norm(visual)-1)>.02:raise ValueError('Invalid full-recording visual mean')
  value=float(w@x+vw@visual+bias)
 if not math.isfinite(value):raise ValueError('Nonfinite whole score')
 return value
