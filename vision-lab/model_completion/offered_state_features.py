"""Isolated fixed Stage1 auxiliary state features; numeric inputs only, no fitting.

The explicit state is an action proxy, not a human action/absence label. Classify
an entire identity-checked recording generation before pooling offered points.
The globally fixed probe was trained on historical coarse frame labels; it is
not an auxiliary detector retrained inside future fine-preference folds. Report
that provenance and check source overlap in any downstream evaluation.
"""
from __future__ import annotations
import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path
import numpy as np

PROBE_SHA256='da968dbf33bc6308f64e67749aea6efcec167305ce8fe3fe569f353c2b0201f4'
VISUAL_PIN='siglip2/so400m-patch16-256'
RECIPE='offered-point-state-action-proxy-v1'
STATES=('idle','tease','nude','explicit')
FEATURE_NAMES=['state_idle_mean','state_tease_mean','state_nude_mean','state_explicit_mean',
               'action_proxy_max','action_proxy_p90','action_proxy_fraction_ge_055',
               'action_proxy_original_mass_retained']
DIMENSION=1152
MAX_FRAMES=8000
THRESHOLD=.55


def identity_sha256(identity):
 return hashlib.sha256(json.dumps(identity,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()


def finite_number(value):
 return not isinstance(value,(bool,np.bool_)) and isinstance(value,(int,float,np.integer,np.floating)) and math.isfinite(float(value))


@dataclass(frozen=True)
class FixedProbe:
 weights: np.ndarray
 bias: np.ndarray
 radius: int
 sha256: str


@dataclass(frozen=True)
class OriginalStateContext:
 timestamps: np.ndarray
 probabilities: np.ndarray
 identity_json: str
 identity_sha256: str
 probe_sha256: str


def load_probe(path=None):
 """Only the exact fixed production artifact; no latest-model substitution."""
 if path is None:path=Path(__file__).resolve().parents[2]/'data/models/recordings-highlight-probe.json'
 raw_bytes=Path(path).read_bytes()
 if len(raw_bytes)>256*1024 or hashlib.sha256(raw_bytes).hexdigest()!=PROBE_SHA256:raise ValueError('Fixed Stage1 probe checksum differs')
 raw=json.loads(raw_bytes)
 if raw.get('model_revision')!=VISUAL_PIN or raw.get('dimension')!=DIMENSION or raw.get('classes')!=list(STATES) or type(raw.get('context_radius')) is not int or raw['context_radius']!=2:raise ValueError('Fixed Stage1 probe contract differs')
 if not all(finite_number(z) for a in (raw['weights'],raw['bias']) for z in np.asarray(a,dtype=object).flat):raise ValueError('Finite Stage1 weights required')
 # Production loadHighlightProbe stores weights as Float32Array, bias as JS numbers.
 weights=np.asarray(raw['weights'],dtype=np.float32);bias=np.asarray(raw['bias'],dtype=np.float64)
 if weights.shape!=(4,DIMENSION*2) or bias.shape!=(4,) or not np.isfinite(weights).all():raise ValueError('Fixed Stage1 shape differs')
 weights.setflags(write=False);bias.setflags(write=False)
 return FixedProbe(weights,bias,raw['context_radius'],PROBE_SHA256)


def validate_identity(identity,expected_identity,n):
 if not isinstance(identity,dict) or not isinstance(expected_identity,dict) or identity_sha256(identity)!=identity_sha256(expected_identity):raise ValueError('Exact generation/source identity differs')
 for key in ('video_id','analyzed_at','index','source_fingerprint','proposals','duration'):
  if key not in identity:raise ValueError('Complete generation receipt required')
 if type(identity['video_id']) is not int or identity['video_id']<=0 or not isinstance(identity['analyzed_at'],str) or not identity['analyzed_at'] or not finite_number(identity['duration']) or identity['duration']<=0:raise ValueError('Invalid recording identity/duration')
 index=identity['index'];source=identity['source_fingerprint']
 if not isinstance(index,dict) or index.get('model_revision')!=VISUAL_PIN or type(index.get('frame_count')) is not int or index['frame_count']!=n or index.get('interval_seconds')!=5 or not all(isinstance(index.get(k),str) and index[k] for k in ('storyboard_generated_at','indexed_at')):raise ValueError('Exact indexed generation required')
 if not isinstance(source,dict) or type(source.get('size_bytes')) is not int or source['size_bytes']<=0 or not isinstance(source.get('mtime_ns'),str) or not source['mtime_ns'].isdigit() or not isinstance(source.get('path_identity_sha256'),str) or len(source['path_identity_sha256'])!=64 or any(c not in '0123456789abcdef' for c in source['path_identity_sha256']):raise ValueError('Exact source fingerprint required')
 proposals=identity['proposals']
 if not isinstance(proposals,list) or len(proposals)>60:raise ValueError('Bounded original proposal context required')
 ids=[]
 for row in proposals:
  if not isinstance(row,dict) or not isinstance(row.get('id'),str) or not row['id'] or row['id'].startswith('added-') or any(not finite_number(row.get(k)) for k in ('start','end','score')) or not 0<=row['start']<row['end']<=identity['duration']:raise ValueError('Original detected proposal context required')
  ids.append(row['id'])
 if len(set(ids))!=len(ids):raise ValueError('Duplicate original proposal identity')
 return json.dumps(identity,sort_keys=True,separators=(',',':'),allow_nan=False)


def classify_original_context(probe,t,v,*,identity,expected_identity):
 """Matches Bun classifyFrames: RAW float32 frames, radius mean, float32 probs.

Full recording frames must be supplied even when the original proposal begins
later: its edge neighbourhood must retain the same recording context. Caller
must validate its frozen checkpoint checksum before supplying numeric arrays.
"""
 if not isinstance(probe,FixedProbe) or probe.sha256!=PROBE_SHA256:raise ValueError('Pinned Stage1 auxiliary probe required')
 # Require typed numeric cache arrays; do not allocate an object per1152x8000 float.
 # Typed float matrices cannot hide boolean elements, while raw mixed Python lists can.
 if not isinstance(v,np.ndarray) or v.dtype.kind!='f' or not isinstance(t,np.ndarray) or t.dtype.kind not in ('f','i','u'):raise ValueError('Typed numeric cached frame arrays required; booleans unsupported')
 t=np.asarray(t,dtype=np.float64)
 with np.errstate(over='ignore',invalid='ignore'):v=np.asarray(v,dtype=np.float32)
 if t.ndim!=1 or v.shape!=(len(t),DIMENSION) or not 1<=len(t)<=MAX_FRAMES or not np.isfinite(t).all() or not np.isfinite(v).all():raise ValueError('Bounded numeric point frames required')
 frozen=validate_identity(identity,expected_identity,len(t));duration=identity['duration']
 if np.any(t<0) or np.any(t>duration) or np.any(np.diff(t)<=0) or t[0]>5.001 or np.any(np.diff(t)>10.001) or t[-1]+10<duration:raise ValueError('Complete actual recording generation coverage required')
 norms=np.linalg.norm(v.astype(np.float64),axis=1)
 if not np.isfinite(norms).all() or np.any(np.abs(norms-1)>.02):raise ValueError('Stored SigLIP point vectors must be unit finite; do not silently renormalize')
 # Same cumulative float64 sums and unweighted neighbouring-frame mean as Bun.
 prefix=np.vstack([np.zeros((1,DIMENSION)),np.cumsum(v,axis=0,dtype=np.float64)])
 ix=np.arange(len(v));lo=np.maximum(0,ix-probe.radius);hi=np.minimum(len(v),ix+probe.radius+1)
 neighbour=(prefix[hi]-prefix[lo])/(hi-lo)[:,None]
 logits=v.astype(np.float64)@probe.weights[:,:DIMENSION].astype(np.float64).T+neighbour@probe.weights[:,DIMENSION:].astype(np.float64).T+probe.bias
 logits-=np.max(logits,axis=1,keepdims=True);p=np.exp(logits);p=(p/p.sum(axis=1,keepdims=True)).astype(np.float32)
 if not np.isfinite(p).all() or np.any(np.abs(p.astype(np.float64).sum(1)-1)>1e-6):raise ValueError('Nonfinite state probabilities')
 t=t.copy();t.setflags(write=False);p.setflags(write=False)
 return OriginalStateContext(t,p,frozen,hashlib.sha256(frozen.encode()).hexdigest(),probe.sha256)


def pool_state_features(context,*,original_proposal_id,original_range,offered_range):
 """Inclusive point pooling; original-relative action mass is a learned feature.

No observed probabilities establishes action truth or absence outside a cut.
Mass is a point-sum ratio, not elapsed-time coverage or a hard preservation rule.
"""
 if not isinstance(context,OriginalStateContext) or context.probe_sha256!=PROBE_SHA256 or hashlib.sha256(context.identity_json.encode()).hexdigest()!=context.identity_sha256:raise ValueError('Frozen source state context required')
 identity=json.loads(context.identity_json)
 matches=[p for p in identity['proposals'] if p['id']==original_proposal_id]
 if len(matches)!=1 or not isinstance(original_range,(list,tuple)) or len(original_range)!=2 or list(original_range)!=[matches[0]['start'],matches[0]['end']]:raise ValueError('Exact original detected range required')
 if not isinstance(offered_range,(list,tuple)) or len(offered_range)!=2 or any(not finite_number(x) for x in (*original_range,*offered_range)):raise ValueError('Finite exact offered bounds required')
 a,b=offered_range;lo,hi=original_range
 if not 0<=lo<=a<b<=hi<=identity['duration']:raise ValueError('Offered range outside original source')
 t=context.timestamps;p=context.probabilities
 if p.shape!=(len(t),4) or not np.isfinite(p).all() or np.any(p<0) or np.any(p>1) or np.any(np.abs(p.astype(np.float64).sum(1)-1)>1e-6):raise ValueError('Complete state probabilities required')
 selected=(t>=a)&(t<=b);original=(t>=lo)&(t<=hi)
 if not selected.any() or not original.any():raise ValueError('Exact offered/original point-frame coverage missing')
 action=p[selected,3].astype(np.float64);mass=float(p[original,3].astype(np.float64).sum())
 x=[*p[selected].astype(np.float64).mean(0).tolist(),float(action.max()),float(np.percentile(action,90,method='linear')),float(np.mean(action>=THRESHOLD)),float(action.sum()/mass) if mass>0 else 0.]
 if len(x)!=8 or not np.isfinite(x).all() or any(z<0 or z>1+1e-7 for z in x):raise ValueError('Invalid pooled state features')
 return x
