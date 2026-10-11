"""Whole-retention feature PREPARATION only: frozen archives/NPZ, no DB, intake or fit."""
from __future__ import annotations
import argparse,copy,ctypes,hashlib,io,json,math,os,signal,struct,tempfile,time,zipfile
PROCESS_START=time.monotonic()
from pathlib import Path
import numpy as np
import whole_round_prepare as whole
import whole_current_labels as history
import whole_review_inputs as recipe
import archived_audio as archive
import training_snapshots as snapshots
ROOT=whole.base.LAB/'data/model-completion-20261010'
OUT=ROOT/'whole-feature-inputs-v1'
POLICY='whole-feature-inputs-v1'
MAX_BYTES=256*1024*1024
MAX_FILE=64*1024*1024+65536
MAX_SECONDS=180

class Unavailable(ValueError):pass

def sha(raw):return hashlib.sha256(raw).hexdigest()
def digest(value):return whole.digest(value)

class Budget:
 def __init__(self,device_root,started=None,max_bytes=MAX_BYTES):
  self.device=Path(device_root).stat().st_dev;self.started=PROCESS_START if started is None else started;self.maximum=max_bytes;self.used=0;self.receipts={}
 def check(self):
  if time.monotonic()-self.started>=MAX_SECONDS:raise TimeoutError('Whole preparation180s total deadline')
 def charge(self,size):
  self.check()
  if type(size) is not int or size<0 or self.used+size>self.maximum:raise ValueError('Whole preparation256MiB total read/decompression bound')
  self.used+=size
 def read(self,path,maximum=MAX_FILE,expected=None):
  path=Path(path)
  if not path.is_absolute() or path.resolve()!=path:raise ValueError('Absolute local immutable input path required')
  st=path.stat()
  if st.st_dev!=self.device or not path.is_file() or st.st_size>maximum:raise ValueError('Bounded SSD numeric/metadata input required')
  before=(st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns);self.charge(st.st_size);raw=path.read_bytes();after=path.stat()
  if before!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns) or len(raw)!=st.st_size:raise ValueError('Input changed during numeric read')
  checksum=sha(raw)
  if expected is not None and checksum!=expected:raise ValueError('Frozen input checksum differs')
  receipt={'path':str(path),'sha256':checksum,'bytes':len(raw),'stat':list(before)}
  if str(path) in self.receipts and self.receipts[str(path)]!=receipt:raise ValueError('Conflicting frozen input reads')
  self.receipts[str(path)]=receipt;return raw
 def stable(self):
  self.check()
  for r in self.receipts.values():
   st=Path(r['path']).stat()
   if list((st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns))!=r['stat']:raise ValueError('Frozen input changed before receipt publication')

# Lexically skip JSON values. Never decode skipped tasks or excluded creators' outcomes.
def end_value(text,start):
 i=start
 while i<len(text) and text[i].isspace():i+=1
 if i==len(text):raise ValueError('Truncated JSON')
 if text[i]=='"':
  i+=1
  while i<len(text):
   if text[i]=='\\':i+=2
   elif text[i]=='"':return i+1
   else:i+=1
  raise ValueError('Truncated JSON string')
 if text[i] in '[{':
  closing=']' if text[i]=='[' else '}';i+=1
  while i<len(text):
   if text[i].isspace() or text[i] in ',:':i+=1
   elif text[i]==closing:return i+1
   else:i=end_value(text,i)
  raise ValueError('Truncated JSON container')
 while i<len(text) and text[i] not in ',]} \t\r\n':i+=1
 if i==start:raise ValueError('Invalid JSON token')
 return i

def fields(text):
 i=0
 while i<len(text) and text[i].isspace():i+=1
 if i==len(text) or text[i]!='{':raise ValueError('JSON object required')
 i+=1;result={}
 while True:
  while i<len(text) and text[i].isspace():i+=1
  if i>=len(text):raise ValueError('Truncated object')
  if text[i]=='}':
   if text[i+1:].strip():raise ValueError('Trailing JSON')
   return result
  if text[i]!='"':raise ValueError('JSON object key required')
  end=end_value(text,i);key=json.loads(text[i:end]);i=end
  while i<len(text) and text[i].isspace():i+=1
  if i>=len(text) or text[i]!=':':raise ValueError('JSON colon required')
  i+=1
  while i<len(text) and text[i].isspace():i+=1
  end=end_value(text,i)
  if key in result:raise ValueError('Duplicate JSON key')
  result[key]=text[i:end];i=end
  while i<len(text) and text[i].isspace():i+=1
  if i<len(text) and text[i]==',':i+=1
  elif i>=len(text) or text[i]!='}':raise ValueError('JSON comma required')

def items(text):
 text=text.strip()
 if not text.startswith('[') or not text.endswith(']'):raise ValueError('JSON array required')
 i=1
 while True:
  while i<len(text) and text[i].isspace():i+=1
  if i==len(text)-1:return
  end=end_value(text,i);yield text[i:end];i=end
  while i<len(text) and text[i].isspace():i+=1
  if i<len(text)-1 and text[i]==',':i+=1
  elif i!=len(text)-1:raise ValueError('JSON array comma required')

def allowed_history(eligibility_text,private,reserved):
 root=fields(eligibility_text)
 if json.loads(root['policy'])!=history.POLICY or private.get('policy')!=history.POLICY or json.loads(root['private_binding_sha256'])!=digest(private) or json.loads(root['semantics_sha256'])!=digest(history.SEMANTICS):raise ValueError('Historical semantics/private binding differs')
 mapping=private['recordings'];allowed={k for k,v in mapping.items() if whole.base.canon(v['channel']) and whole.base.canon(v['channel']) not in reserved};rows=[];seen=set()
 for raw in items(root['rows']):
  meta=fields(raw);alias=json.loads(meta['row'])
  if alias not in mapping or alias in seen:raise ValueError('Historical alias universe differs')
  seen.add(alias)
  if alias not in allowed:continue
  row=json.loads(raw)
  if row.get('label_policy')!=history.POLICY or row.get('label_target')!=recipe.TARGET or row.get('future_replacement_y') is not None or row.get('permanent_storage_y') is not None:raise ValueError('Unsupported historical whole target')
  if row['y'] is None:continue
  if type(row['y']) is not int or row['y'] not in (0,1) or row['reason']!=('explicit_keep_whole' if row['y']==1 else 'saved_all_proposals_skipped') or row['near_full_edited_clips_still_unknown']:raise ValueError('Unsupported explicit historical whole label')
  rows.append((row,copy.deepcopy(mapping[alias])))
 if seen!=set(mapping):raise ValueError('Historical alias universe incomplete')
 sources=json.loads(root['source_sha256'])
 return rows,sources,len(set(mapping)-allowed)

def feedback_inputs(snapshot_text,selected):
 root=fields(snapshot_text);keys={(p['video_id'],whole.generation_key(p['analyzed_at'])):p for _,p in selected};result={key:[] for key in keys};seen=set()
 # Only the records field is visited. In particular tasks, answers and fine cuts are never decoded.
 for raw in items(root['records']):
  meta=fields(raw);vid=json.loads(meta['video_id'])
  if vid not in {key[0] for key in keys}:continue
  generation=whole.generation_key(json.loads(meta['analyzed_at']));key=(vid,generation)
  if key not in keys:continue
  p=keys[key]
  if whole.base.canon(json.loads(meta['channel']))!=whole.base.canon(p['channel']):raise ValueError('Historical creator/generation binding differs')
  # Read detector metadata only: no saved verdict/reasons/start/end fallback.
  names=['id','video_id','analyzed_at','clip_id','channel','added','detected_start','detected_end','score']
  f={name:json.loads(meta[name]) for name in names}
  if f['id'] in seen:raise ValueError('Duplicate historical feedback identity')
  seen.add(f['id']);result[key].append(f)
 for key,p in keys.items():
  current=result[key];originals=[f for f in current if f['added'] is False]
  if len({f['clip_id'] for f in originals})!=len(originals) or set(f['clip_id'] for f in originals)!=set(p['original_clip_ids']) or not set(p['feedback_ids']).issubset({f['id'] for f in current}):raise ValueError('Frozen original/feedback universe differs')
 return result

def exact_archive(p,budget,archive_root):
 directory=Path(archive_root)/str(p['video_id']);matches=[];paths=sorted(directory.glob('review-*.json'))
 if len(paths)>100:raise ValueError('Historical archive generation count exceeds bound')
 for path in paths:
  text=budget.read(path.resolve(),8*1024*1024).decode();meta=fields(text)
  if whole.generation_key(json.loads(meta['analyzedAt']))!=whole.generation_key(p['analyzed_at']):continue
  saved=json.loads(text)
  if saved.get('format')!='kura-recording-training' or saved.get('version')!=1 or saved['source']['videoId']!=p['video_id']:raise ValueError('Historical archive source/generation differs')
  matches.append((saved,path.resolve()))
 if len(matches)>1:raise ValueError('Ambiguous exact historical generation archive')
 if not matches:raise Unavailable('exact_generation_archive_missing; ID-only/live/latest frames not eligible')
 saved,path=matches[0];features=saved['features'];index=features['index']
 if features['identity']!=archive.feature_identity(saved) or index['modelRevision']!=whole.base.VISUAL_PIN or index['intervalSeconds']!=5 or features['dimension']!=1152 or type(index['frameCount']) is not int or not 1<=index['frameCount']<=8000:raise ValueError('Exact archived frame/source/index identity differs')
 return saved,path

def original_proposals(saved,p,feedback):
 originals=[f for f in feedback if f['added'] is False];by={f['clip_id']:f for f in originals};raw=saved.get('proposals');clips=saved.get('clips',[])
 if not isinstance(clips,list) or len({c['id'] for c in clips})!=len(clips):raise ValueError('Archive clip identities differ')
 supplied={}
 if raw is not None:
  if not isinstance(raw,list) or len(raw)>60:raise ValueError('Bounded archive originals required')
  for row in raw:
   if row['id'].startswith('added-'):continue
   if row['id'] in supplied:raise ValueError('Duplicate archived original')
   supplied[row['id']]=row
  if set(supplied)!=set(p['original_clip_ids']):raise Unavailable('archive_original_universe_incomplete')
 detected={}
 for c in clips:
  if c['id'].startswith('added-'):continue
  if c['id'] not in by:raise ValueError('Archived original outside frozen feedback universe')
  if isinstance(c.get('detected'),dict):detected[c['id']]=c['detected']
 proposals=[]
 for key in sorted(by):
  f=by[key];a,b=f['detected_start'],f['detected_end'];candidate=supplied.get(key);d=detected.get(key)
  if a is None or b is None:raise Unavailable('original_detector_bounds_missing; final trims forbidden')
  if candidate and (candidate['start_seconds']!=a or candidate['end_seconds']!=b or candidate['score']!=f['score']):raise ValueError('Archive original differs from frozen detector receipt')
  if d and (d.get('start_seconds')!=a or d.get('end_seconds')!=b):raise ValueError('Archived detected bounds disagree')
  proposals.append({'id':key,'start':a,'end':b,'score':f['score']})
 return proposals

def archive_frames(saved,budget,archive_root):
 vid=saved['source']['videoId'];f=saved['features'];name=f['file']
 if not isinstance(name,str) or Path(name).name!=name or not name.startswith('features-'):raise ValueError('Invalid archived frame path')
 raw=budget.read((Path(archive_root)/str(vid)/name).resolve(),MAX_FILE,f['sha256'])
 if len(raw)!=f['bytes'] or raw[:8]!=b'KURAFEAT' or len(raw)<12:raise ValueError('Archived frame bytes/header differs')
 size=struct.unpack_from('<I',raw,8)[0]
 if size>65536 or size+12>len(raw):raise ValueError('Invalid bounded archived header')
 header=json.loads(raw[12:12+size]);count=f['index']['frameCount'];offset=12+size
 if header!={'version':1,'identity':f['identity'],'index':f['index'],'dimension':1152,'timestamps':'float64-le','embeddings':'float32-le'} or offset+count*(8+1152*4)!=len(raw):raise ValueError('Exact archived numeric header/shape differs')
 t=np.frombuffer(raw,dtype='<f8',count=count,offset=offset).copy();v=np.frombuffer(raw,dtype='<f4',count=count*1152,offset=offset+count*8).reshape(count,1152).copy();return t,v

def new_frames(p,budget):
 r=p['frame_checkpoint'];path=Path(r['path']);raw=budget.read(path,MAX_FILE,r['sha256'])
 if len(raw)!=r['bytes']:raise ValueError('New whole checkpoint byte receipt differs')
 with zipfile.ZipFile(io.BytesIO(raw)) as z:
  if len(z.infolist())!=3 or set(z.namelist())!={'t.npy','v.npy','identity_sha256.npy'}:raise ValueError('Exact whole checkpoint members required')
  count=sum(i.file_size for i in z.infolist())
  if count>MAX_FILE:raise ValueError('Bounded whole checkpoint expansion required')
  budget.charge(count)
 with np.load(io.BytesIO(raw),allow_pickle=False) as z:
  if z['identity_sha256'].shape!=() or str(z['identity_sha256'])!=digest(p['numeric_identity']) or r['identity_sha256']!=digest(p['numeric_identity']):raise ValueError('New whole numeric identity differs')
  t=z['t'].copy();v=z['v'].copy()
 if t.shape!=(p['candidate']['index']['frame_count'],) or v.shape!=(len(t),1152):raise ValueError('New whole full-frame shape differs')
 x,visual=recipe.features(p['proposals'],p['candidate']['duration_seconds'],t,v)
 if visual is None or not np.allclose(x,p['features'],rtol=0,atol=1e-12) or not np.allclose(visual,p['visual_mean'],rtol=0,atol=1e-12):raise ValueError('New whole frozen recipe recomputation differs')
 return x,visual

def historical_features(props,duration,t,v):
 # A correctly hashed legacy snapshot may still lack full-range coverage or usable originals.
 try:return recipe.features(props,duration,t,v)
 except ValueError as error:
  if str(error) in ('Entire recording point-frame coverage required','Original detector proposals required; decisions cannot replace source ranges'):
   raise Unavailable('legacy_whole_coverage_or_original_geometry_unavailable') from error
  raise

def source_pins(budget):
 paths=[Path(__file__),Path(__file__).with_name('whole_feature_inputs_test.py'),Path(recipe.__file__),Path(history.__file__),Path(whole.__file__),Path(archive.__file__),Path(snapshots.__file__)]
 return [{'path':str(p.resolve()),'sha256':sha(budget.read(p.resolve(),8*1024*1024))} for p in paths]

def row(alias,channel,y,origin,x,visual):
 return {'row':alias,'group':sha(whole.base.canon(channel).encode())[:24],'y':y,'label_target':recipe.TARGET,'label_origin':origin,'features':x,'visual_mean':visual,'clip_current_acceptability_y':None,'cut_gold':None,'permanent_storage_y':None,'future_replacement_y':None}

def build(root,new_root,manifest_sha,budget,reserved,holdout,archive_root=snapshots.ROOT):
 root=Path(root);new_root=Path(new_root);pins=source_pins(budget)
 private=json.loads(budget.read((whole.HIST/whole.HISTORY_FILES[1]).resolve(),8*1024*1024))
 historical_text=budget.read((whole.HIST/whole.HISTORY_FILES[0]).resolve(),8*1024*1024).decode()
 selected,sources,excluded=allowed_history(historical_text,private,reserved)
 # Immutable old feature cohort is pinned but never decoded/reused.
 budget.read((root/'cohort.json').resolve(),8*1024*1024,sources['cohort.json'])
 snapshot=budget.read((root/'private_snapshot.json').resolve(),16*1024*1024,sources['private_snapshot.json']).decode();feedback=feedback_inputs(snapshot,selected)
 text=budget.read((new_root/'private_manifest.json').resolve(),8*1024*1024,manifest_sha).decode();meta=fields(text)
 # Screen metadata-only task contexts BEFORE any per-source numerics or any prospective labels.
 tasks=json.loads(meta['rows'])
 if any(whole.labels.metadata(t,reserved) is None for t in tasks):raise ValueError('New whole metadata target unsupported')
 manifest=json.loads(text);whole.validate_manifest(manifest,reserved,holdout)
 if len(manifest['rows'])!=16:raise ValueError('Exact reviewed16 new whole sources required')
 for d in manifest['dependencies']:budget.read(Path(d['path']),8*1024*1024,d['sha256'])
 if manifest.get('consumer_sources')!=whole.consumer_pins() or manifest.get('source_sha256')!=whole.base.digest(Path(whole.__file__)):raise ValueError('Whole consumer source drift')
 rows=[];identities={};missing=[];source_keys=set()
 for label,p in selected:
  budget.check();key=whole.source_key(p)
  if key in source_keys:raise ValueError('Duplicate whole historical source')
  source_keys.add(key)
  try:
   saved,path=exact_archive(p,budget,archive_root);props=original_proposals(saved,p,feedback[key]);t,v=archive_frames(saved,budget,archive_root);duration=saved['source']['durationSeconds'];x,visual=historical_features(props,duration,t,v)
   if visual is None:raise Unavailable('whole_frame_coverage_missing')
  except Unavailable as error:
   missing.append({'row':label['row'],'reason':str(error),'label_available':True,'features_available':False});continue
  rows.append(row(label['row'],p['channel'],label['y'],history.POLICY,x,visual));identities[label['row']]={'kind':'historical_exact_generation_archive','historical':p,'archive_path':str(path),'source':saved['source'],'analyzed_at':saved['analyzedAt'],'frame_identity':saved['features']['identity'],'frame_sha256':saved['features']['sha256'],'original_proposals':props,'detector_feedback_ids':[f['id'] for f in feedback[key] if f['added'] is False]}
 for idx,(task,p) in enumerate(zip(manifest['rows'],manifest['private_sources'])):
  c=p['candidate'];key=whole.source_key(c)
  if key in source_keys:raise ValueError('New source repeats labeled historical generation')
  source_keys.add(key);x,visual=new_frames(p,budget);alias=f'n{idx:03d}'
  rows.append(row(alias,c['channel'],None,'prospective_whole_round_unanswered_no_intake',x,visual));identities[alias]={'kind':'new_frozen_whole_manifest','batch':task['batch'],'position':task['position'],'candidate':c,'original_proposals':p['proposals'],'proposal_origin':p['proposal_origin'],'numeric_identity':p['numeric_identity'],'frame_checkpoint':p['frame_checkpoint']}
 positive=[r for r in rows if r['y']==1];negative=[r for r in rows if r['y']==0]
 cohort={'schema_version':1,'policy':POLICY,'target':recipe.TARGET,'feature_recipe':recipe.RECIPE,'feature_names':recipe.FEATURES,'visual_recipe':recipe.VISUAL_RECIPE,'rows':rows,'counts':{'historical_known_screened':len(selected),'historical_features_available':len(rows)-16,'historical_unavailable':len(missing),'historical_reserved_excluded':excluded,'new_unlabeled':16,'positive':len(positive),'negative':len(negative),'positive_creators':len({r['group'] for r in positive}),'negative_creators':len({r['group'] for r in negative})},'unavailable':missing,'new_labels_intaken':False,'historical_near_full_reinterpreted':False,'whole_fit_count':0,'probability_calibrated':False,'automatic_action':False,'enabled':False,'fit_gate':'Not evaluated. Future all-fold creator/class preflight required; preparation creates no predictions or deployable model.'}
 binding={'policy':POLICY,'rows':identities};budget.stable()
 receipt={'schema_version':1,'policy':POLICY,'source_pins':pins,'inputs':list(budget.receipts.values()),'new_manifest_sha256':manifest_sha,'holdout_dependency':holdout,'excluded_holdout_creators':sorted(reserved),'cohort_sha256':sha(whole.canonical(cohort)+b'\n'),'private_binding_sha256':sha(whole.canonical(binding)+b'\n'),'read_and_expansion_bytes':budget.used,'limits':{'bytes':MAX_BYTES,'seconds':MAX_SECONDS},'historical_original_strategy':'Exact generation archive + frozen immutable detector feedback universe only. No live/ID-only/latest frame fallback; missing archive/detector provenance explicitly unavailable.','source_media_reads':0,'database_access':False,'outcome_intake':False,'model_fits':0,'enabled':False}
 return cohort,binding,receipt

def publish(out,cohort,private,receipt):
 out=Path(out);values={'feature_cohort.json':cohort,'private_identity.json':private,'input_receipt.json':receipt};payloads={k:whole.canonical(v)+b'\n' for k,v in values.items()}
 if out.exists():
  if not out.is_dir() or out.stat().st_mode&0o077 or set(p.name for p in out.iterdir())!=set(payloads):raise ValueError('Immutable preparation output differs')
  for name,raw in payloads.items():
   path=out/name
   if path.stat().st_mode&0o077 or path.read_bytes()!=raw:raise ValueError('Existing whole preparation cannot be overwritten')
  return
 out.parent.mkdir(parents=True,exist_ok=True);temp=Path(tempfile.mkdtemp(prefix='.whole-preparation-',dir=out.parent));temp.chmod(0o700)
 try:
  for name,raw in payloads.items():
   with (temp/name).open('xb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
   (temp/name).chmod(0o600)
  # Linux RENAME_NOREPLACE prevents even an empty concurrently-created output from being replaced.
  libc=ctypes.CDLL(None,use_errno=True);rename=libc.renameat2
  rename.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint];rename.restype=ctypes.c_int
  if rename(-100,os.fsencode(temp),-100,os.fsencode(out),1)!=0:
   error=ctypes.get_errno();raise OSError(error,os.strerror(error),str(out))
 finally:
  if temp.exists():
   for p in temp.iterdir():p.unlink()
   temp.rmdir()

def run(root,new_root,manifest_sha,out):
 budget=Budget(root)
 ancestor=Path(out).resolve()
 while not ancestor.exists():ancestor=ancestor.parent
 if ancestor.stat().st_dev!=budget.device:raise ValueError('Whole preparation output must remain on local SSD')
 reserved,holdout=whole.safe.previous.holdout_contract();cohort,private,receipt=build(root,new_root,manifest_sha,budget,reserved,holdout);publish(out,cohort,private,receipt)
 print(json.dumps({'status':'prepared_only','output':str(out),'counts':cohort['counts'],'numeric_bytes':budget.used,'new_labels_intaken':False,'model_fits':0,'enabled':False}));return receipt

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=ROOT);p.add_argument('--new-root',type=Path,default=whole.OUT);p.add_argument('--manifest-sha256',required=True);p.add_argument('--out',type=Path,default=OUT);a=p.parse_args()
 def expired(*_):raise TimeoutError('Whole preparation hard180s deadline')
 signal.signal(signal.SIGALRM,expired);signal.alarm(max(1,math.ceil(MAX_SECONDS-(time.monotonic()-PROCESS_START))));run(a.root,a.new_root,a.manifest_sha256,a.out)
