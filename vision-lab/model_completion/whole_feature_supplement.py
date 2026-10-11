"""One-source whole-feature supplement, metadata/numeric only; frozen v1 never changes."""
from __future__ import annotations
import argparse,copy,json,math,signal,time
PROCESS_START=time.monotonic()
from pathlib import Path
import numpy as np
import whole_feature_inputs as w
POLICY='whole-feature-inputs-v2'
TRAINING_SHA='014b9a6c69e1d55eeff0f9af0daf2e3f3f7c33437255ee88d04cbf9c00099a98'
CACHE_IDENTITY='2d931eb60bef4cfaf8636b27bd73488db6bbaf6708e3a6686762f31d12222907'
MAX_SECONDS=120
MAX_BYTES=64*1024*1024
OUT=w.ROOT/'whole-feature-inputs-v2'

class Budget(w.Budget):
 def __init__(self,root,started=None):super().__init__(root,PROCESS_START if started is None else started,MAX_BYTES)
 def check(self):
  if time.monotonic()-self.started>=MAX_SECONDS:raise TimeoutError('Whole supplement120s total deadline')
 def charge(self,size):
  self.check()
  if type(size) is not int or size<0 or self.used+size>self.maximum:raise ValueError('Whole supplement64MiB read/decompression bound')
  self.used+=size

def decode_metadata(raw):
 f=w.fields(raw);names=('video_id','analyzed_at','channel','group','reserved_fine_holdout','fine_data_role','pair_creators')
 return f,{k:json.loads(f[k]) for k in names if k in f}

def candidates(training_text,selected,reserved,cache):
 targets={w.whole.source_key(p):(label,p) for label,p in selected};top=w.fields(training_text);result=[]
 for raw in w.items(top['rows']):
  fields,meta=decode_metadata(raw)
  # Never decode fine answers, cuts or numerical values until global creator/role exclusion passes.
  group=w.whole.base.canon(meta.get('channel',''))
  if not group or group in reserved or meta.get('reserved_fine_holdout') is not False or meta.get('fine_data_role')!='training' or any(w.whole.base.canon(c) in reserved for c in meta.get('pair_creators',[])):continue
  key=w.whole.source_key(meta)
  if key not in targets:continue
  label,p=targets[key]
  if group!=w.whole.base.canon(p['channel']) or meta.get('group')!=group:raise ValueError('Historical/cache creator differs')
  path=Path(json.loads(fields['frame_cache']))
  if path!=cache:continue # Only the independently audited ONE checkpoint may supplement v1.
  names=('numeric_identity','frame_checkpoint','duration_seconds','source_fingerprint','index')
  numeric={k:json.loads(fields[k]) for k in names}
  result.append((label,p,numeric))
 if len(result)!=1:raise ValueError('Exactly one audited historical cache source required')
 return result[0]

def exact_originals(identity,p,feedback):
 original=[f for f in feedback if f['added'] is False];by={f['clip_id']:f for f in original};props=identity['proposals']
 if len(props)!=len(by) or len({q['id'] for q in props})!=len(props) or {q['id'] for q in props}!=set(p['original_clip_ids']) or set(by)!=set(p['original_clip_ids']):raise ValueError('Complete immutable original detector universe differs')
 for q in props:
  f=by[q['id']]
  if f['detected_start'] is None or f['detected_end'] is None or [q['start'],q['end'],q['score']]!=[f['detected_start'],f['detected_end'],f['score']]:raise ValueError('Original bounds/raw score differ; final trims forbidden')
 return props

def verify_identity(numeric,p,old_index):
 identity=numeric['numeric_identity'];index=identity['index'];fp=identity['source_fingerprint'];r=numeric['frame_checkpoint']
 if identity.get('video_id')!=p['video_id'] or w.whole.generation_key(identity['analyzed_at'])!=w.whole.generation_key(p['analyzed_at']) or index!=numeric['index'] or fp!=numeric['source_fingerprint'] or identity['duration']!=numeric['duration_seconds']:raise ValueError('Exact whole source/generation/index/fingerprint differs')
 if set(fp)!={'size_bytes','mtime_ns','path_identity_sha256'} or type(fp['size_bytes']) is not int or fp['size_bytes']<0 or not isinstance(fp['mtime_ns'],str) or not fp['mtime_ns'].isdigit() or not isinstance(fp['path_identity_sha256'],str) or len(fp['path_identity_sha256'])!=64:raise ValueError('Source fingerprint invalid')
 names=['model_revision','frame_count','interval_seconds','storyboard_generated_at','indexed_at']
 if not isinstance(old_index,list) or len(old_index)!=5 or set(index)!=set(names) or index['model_revision']!=w.whole.base.VISUAL_PIN or type(index['frame_count']) is not int or not 1<=index['frame_count']<=8000 or index['interval_seconds']!=5:raise ValueError('Frozen whole visual index required')
 for key,value in zip(names,old_index):
  same=w.whole.generation_key(index[key])==w.whole.generation_key(value) if key in ('storyboard_generated_at','indexed_at') else index[key]==value
  if not same:raise ValueError('Historical visual index generation differs')
 if w.digest(identity)!=CACHE_IDENTITY or r.get('identity_sha256')!=CACHE_IDENTITY:raise ValueError('Audited one-cache identity differs')
 return identity

def source_paths():return [Path(__file__),Path(__file__).with_name('whole_feature_supplement_test.py'),Path(w.__file__),Path(w.recipe.__file__),Path(w.history.__file__)]

def build(root,parent,budget,reserved,holdout):
 root=Path(root);parent=Path(parent);names=('feature_cohort.json','private_identity.json','input_receipt.json');raws={n:budget.read((parent/n).resolve(),8*1024*1024) for n in names};old,private,receipt=(json.loads(raws[n]) for n in names)
 if receipt.get('policy')!=w.POLICY or old.get('policy')!=w.POLICY or private.get('policy')!=w.POLICY or receipt.get('holdout_dependency')!=holdout or receipt.get('excluded_holdout_creators')!=sorted(reserved) or receipt.get('cohort_sha256')!=w.sha(raws[names[0]]) or receipt.get('private_binding_sha256')!=w.sha(raws[names[1]]):raise ValueError('Literal v1 cohort/private/holdout bindings differ')
 if old.get('target')!=w.recipe.TARGET or old.get('feature_recipe')!=w.recipe.RECIPE or old.get('feature_names')!=w.recipe.FEATURES or old.get('visual_recipe')!=w.recipe.VISUAL_RECIPE or old.get('new_labels_intaken') is not False or old.get('historical_near_full_reinterpreted') is not False or old.get('enabled') is not False or old.get('whole_fit_count')!=0:raise ValueError('Frozen whole v1 scope differs')
 if len(old['rows'])!=20 or len(private['rows'])!=20 or old['counts']['historical_features_available']!=4 or old['counts']['historical_unavailable']!=38 or old['counts']['new_unlabeled']!=16:raise ValueError('Audited v1 counts differ')
 for r in old['rows']:
  p=private['rows'][r['row']]
  if p['kind']=='new_frozen_whole_manifest' and r['y'] is not None:raise ValueError('Prospective whole labels cannot be intaken here')
  if r['group'] in {w.sha(c.encode())[:24] for c in reserved}:raise ValueError('Reserved creator in parent whole features')
 input_shas={r['path']:r['sha256'] for r in receipt['inputs']}
 historical_private_path=(w.whole.HIST/w.whole.HISTORY_FILES[1]).resolve();historical_labels_path=(w.whole.HIST/w.whole.HISTORY_FILES[0]).resolve()
 hp=json.loads(budget.read(historical_private_path,8*1024*1024,input_shas[str(historical_private_path)]));history_text=budget.read(historical_labels_path,8*1024*1024,input_shas[str(historical_labels_path)]).decode();selected,sources,_=w.allowed_history(history_text,hp,reserved)
 missing={r['row'] for r in old['unavailable']};selected=[(r,p) for r,p in selected if r['row'] in missing]
 snapshot=budget.read((root/'private_snapshot.json').resolve(),16*1024*1024,sources['private_snapshot.json']).decode()
 metadata=w.fields(snapshot);indices=w.fields(metadata['indices']);training=budget.read((root/'new-round-training/feature_cohort.json').resolve(),8*1024*1024,TRAINING_SHA).decode();cache=(root/'new-round-training/frames'/f'{CACHE_IDENTITY}.npz').resolve();label,p,numeric=candidates(training,selected,reserved,cache)
 feedback=w.feedback_inputs(snapshot,[(label,p)])[w.whole.source_key(p)];identity=verify_identity(numeric,p,json.loads(indices[str(p['video_id'])]));props=exact_originals(identity,p,feedback)
 if label['row'] in private['rows'] or label.get('near_full_edited_clips_still_unknown') or label['y'] not in (0,1):raise ValueError('Only one previously unavailable explicit historical label may enter')
 # Reuse v1's strict NPZ reader; no fine-domain feature values are reused.
 r=copy.deepcopy(numeric['frame_checkpoint']);r.update(path=str(cache),bytes=cache.stat().st_size)
 import io,zipfile
 raw=budget.read(cache,MAX_BYTES,r['sha256'])
 with zipfile.ZipFile(io.BytesIO(raw)) as z:
  if len(z.infolist())!=3 or set(z.namelist())!={'t.npy','v.npy','identity_sha256.npy'}:raise ValueError('Exact bounded whole numeric checkpoint members required')
  expanded=sum(i.file_size for i in z.infolist())
  if expanded>MAX_BYTES:raise ValueError('Whole checkpoint expansion exceeds64MiB')
  budget.charge(expanded)
 with np.load(io.BytesIO(raw),allow_pickle=False) as z:
  if z['identity_sha256'].shape!=() or str(z['identity_sha256'])!=CACHE_IDENTITY or z['t'].shape!=(identity['index']['frame_count'],) or z['v'].shape!=(len(z['t']),1152):raise ValueError('Stored exact whole identity/shape differs')
  x,visual=w.recipe.features(props,identity['duration'],z['t'],z['v'])
 if visual is None:raise ValueError('Entire recording frames required')
 value=copy.deepcopy(old);binding=copy.deepcopy(private);value['policy']=binding['policy']=POLICY;value['rows'].append(w.row(label['row'],p['channel'],label['y'],w.history.POLICY,x,visual));value['unavailable']=[r for r in value['unavailable'] if r['row']!=label['row']]
 binding['rows'][label['row']]={'kind':'historical_exact_generation_numeric_checkpoint','historical':p,'numeric_identity':identity,'original_proposals':props,'frame_checkpoint':r,'historical_index':json.loads(indices[str(p['video_id'])]),'detector_feedback_ids':[f['id'] for f in feedback if f['added'] is False],'training_cohort_path':str((root/'new-round-training/feature_cohort.json').resolve()),'training_cohort_sha256':TRAINING_SHA}
 positive=[r for r in value['rows'] if r['y']==1];negative=[r for r in value['rows'] if r['y']==0];value['counts'].update(historical_features_available=5,historical_unavailable=37,positive=len(positive),negative=len(negative),positive_creators=len({r['group'] for r in positive}),negative_creators=len({r['group'] for r in negative}));value['supplement_count']=1
 pins=[]
 for path in source_paths():pins.append({'path':str(path.resolve()),'sha256':w.sha(budget.read(path.resolve(),8*1024*1024))})
 budget.stable();new_receipt={'schema_version':1,'policy':POLICY,'parent_inputs':[{'path':str((parent/n).resolve()),'sha256':w.sha(raws[n])} for n in names],'inputs':list(budget.receipts.values()),'source_pins':pins,'cohort_sha256':w.sha(w.whole.canonical(value)+b'\n'),'private_binding_sha256':w.sha(w.whole.canonical(binding)+b'\n'),'holdout_dependency':holdout,'excluded_holdout_creators':sorted(reserved),'supplement_count':1,'new_manifest_sha256':receipt['new_manifest_sha256'],'new_labels_intaken':False,'historical_near_full_reinterpreted':False,'read_and_expansion_bytes':budget.used,'limits':{'bytes':MAX_BYTES,'seconds':MAX_SECONDS},'source_media_reads':0,'database_access':False,'outcome_intake':False,'model_fits':0,'enabled':False}
 return value,binding,new_receipt

def run(root,parent,out):
 budget=Budget(root);ancestor=Path(out).resolve()
 while not ancestor.exists():ancestor=ancestor.parent
 if ancestor.stat().st_dev!=budget.device:raise ValueError('Whole supplement output must remain on SSD')
 reserved,holdout=w.whole.safe.previous.holdout_contract();cohort,private,receipt=build(root,parent,budget,reserved,holdout);w.publish(out,cohort,private,receipt);print(json.dumps({'status':'prepared_one_source_only','output':str(out),'counts':cohort['counts'],'new_unlabeled':16,'fits':0,'enabled':False}));return receipt

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=w.ROOT);p.add_argument('--parent',type=Path,default=w.OUT);p.add_argument('--out',type=Path,default=OUT);a=p.parse_args()
 def expired(*_):raise TimeoutError('Whole supplement hard120s deadline')
 signal.signal(signal.SIGALRM,expired);signal.alarm(max(1,math.ceil(MAX_SECONDS-(time.monotonic()-PROCESS_START))));run(a.root,a.parent,a.out)
