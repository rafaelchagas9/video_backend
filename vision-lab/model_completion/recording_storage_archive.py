"""One HDD reader with a parallel NAS checksum reader. Sources are never deleted here."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import hashlib,json,os,subprocess,time,uuid,threading
ROOT=Path(__file__).resolve().parents[2]
PREP=ROOT/'vision-lab/data/recording-storage-archive-20261010'
manifest=json.loads((PREP/'inventory.json').read_text())
NAS=Path(manifest['nas_destination'])
if str(NAS)!='/mnt/nas/backup/kura/recordings-20261010' or manifest.get('cleanup_scope')!='handled_only':raise RuntimeError('Unexpected archive scope')
if not os.path.ismount('/mnt/nas'):raise RuntimeError('NAS is not mounted')
NAS.mkdir(parents=True,exist_ok=True,mode=0o700)
lock=threading.RLock()
started=time.time()
requested=[r for r in manifest['recordings'] if r['source_exists'] and r['archive_requested']]
requested_ids={r['video_id'] for r in requested}
state={'status':'preparing_training_archive','started_at':started,'total_files':len(requested),'total_bytes':sum(r['size_bytes'] for r in requested),'verified_files':0,'verified_bytes':0,'sources_deleted':0,'destination':str(NAS),'cleanup_scope':'handled_only','originals_compressed':False,'hdd_readers':1,'nas_verifiers':1}
def atomic_json(p,value):
 tmp=p.with_name(p.name+'.'+uuid.uuid4().hex+'.tmp')
 with open(tmp,'x') as f:json.dump(value,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
 os.chmod(tmp,0o600);os.replace(tmp,p)
def status(**updates):
 with lock:state.update(updates);state['updated_at']=time.time();atomic_json(PREP/'archive-state.json',state)
def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for block in iter(lambda:f.read(8*1024*1024),b''):h.update(block)
 return h.hexdigest()
def signature(s):return {'size_bytes':s.st_size,'mtime_ns':str(s.st_mtime_ns),'ctime_ns':str(s.st_ctime_ns),'inode':str(s.st_ino),'device':str(s.st_dev)}
def record(value):
 with lock:
  line=json.dumps(value,separators=(',',':'))+'\n'
  for p in (PREP/'archive-receipts.jsonl',NAS/'archive-receipts.jsonl'):
   with p.open('a') as f:f.write(line);f.flush();os.fsync(f.fileno())
status()
try:
 # Reconcile only durable verified receipts. Never infer completion from filename/size alone.
 old=[]
 if (NAS/'archive-receipts.jsonl').exists():
  old=[json.loads(line) for line in (NAS/'archive-receipts.jsonl').read_text().splitlines() if line]
  local=[json.loads(line) for line in (PREP/'archive-receipts.jsonl').read_text().splitlines() if line]
  if old!=local:raise RuntimeError('Receipt journals differ; manual reconciliation required')
 verified_ids=set()
 for receipt in old:
  r=next((r for r in manifest['recordings'] if r['video_id']==receipt['video_id']),None)
  if not r or not receipt.get('nas_checksum_verified') or receipt['destination']!=str(NAS/r['nas_relative_path']):raise RuntimeError('Unrecognized old receipt')
  if signature(Path(receipt['destination']).stat())!=receipt['destination_signature']:raise RuntimeError('Previously verified NAS file changed')
  if r['video_id'] in requested_ids:verified_ids.add(r['video_id'])
 status(verified_files=len(verified_ids),verified_bytes=sum(r['size_bytes'] for r in requested if r['video_id'] in verified_ids),previous_extra_copies=len(old)-len(verified_ids))
 # Exclude local connection settings; do not make a blanket credentials-free claim.
 package=PREP/'training-package.tar.zst';temp_package=PREP/'training-package.replacement.tar.zst'
 inputs=['data/recording-training-snapshots','data/models','vision-lab/data','vision-lab/model_completion','vision-lab/colab_audio_pilot']
 inputs += [str(p.relative_to(ROOT)) for p in sorted((ROOT/'vision-lab').glob('*.py')) if p.name!='label_server.py']
 old_receipt=NAS/'training-package.receipt.json'
 if old_receipt.exists():
  receipt=json.loads(old_receipt.read_text());receipt.pop('contains_auth_credentials',None);receipt['status']='being_replaced_with_connection_settings_excluded';atomic_json(old_receipt,receipt)
 with (PREP/'training-package.log').open('w') as log:
  subprocess.run(['tar','--exclude=vision-lab/data/recording-storage-archive-20261010/training-package*','--exclude=__pycache__','--exclude=.env','--exclude=label_server.py','--use-compress-program=zstd -3 -T1','-cf',str(temp_package),*inputs],cwd=ROOT,check=True,stdout=log,stderr=log)
 os.replace(temp_package,package);package_hash=digest(package);target=NAS/'training-package.tar.zst';partial=NAS/'training-package.replacement.partial'
 with package.open('rb') as source,partial.open('wb') as out:
  for block in iter(lambda:source.read(8*1024*1024),b''):out.write(block)
  out.flush();os.fsync(out.fileno())
 os.replace(partial,target)
 if digest(target)!=package_hash:raise RuntimeError('NAS training package checksum mismatch')
 subprocess.run(['tar','--use-compress-program=zstd -d -T1','-tf',str(target)],check=True,stdout=subprocess.DEVNULL)
 atomic_json(NAS/'training-package.receipt.json',{'status':'verified','file':target.name,'sha256':package_hash,'bytes':target.stat().st_size,'nas_checksum_verified':True,'tar_entries_checked':True,'excluded_local_config_files':['.env','vision-lab/label_server.py']})
 atomic_json(NAS/'inventory.json',manifest)
 status(status='copying_originals',training_package_sha256=package_hash,training_package_bytes=target.stat().st_size)
 def verify(r,dst,source_hash,expected):
  if digest(dst)!=source_hash:raise RuntimeError(f"NAS checksum mismatch: {r['video_id']}")
  receipt={'video_id':r['video_id'],'source_signature':expected,'destination':str(dst),'destination_signature':signature(dst.stat()),'sha256':source_hash,'bytes':r['size_bytes'],'nas_checksum_verified':True,'verified_at':time.time(),'removal_eligible':r['remove_after_verified_archive']}
  record(receipt)
  with lock:
   status(verified_files=state['verified_files']+1,verified_bytes=state['verified_bytes']+r['size_bytes'])
   print(json.dumps({'verified':state['verified_files'],'total':state['total_files'],'bytes':state['verified_bytes'],'elapsed_seconds':round(time.time()-started,1)}),flush=True)
 pending=[r for r in requested if r['video_id'] not in verified_ids]
 pending.sort(key=lambda r:(not r['remove_after_verified_archive'],r['size_bytes'],r['video_id']))
 futures=[]
 with ThreadPoolExecutor(max_workers=1,thread_name_prefix='nas-checksum') as pool:
  for r in pending:
   if len(futures)>=2:futures.pop(0).result()
   src=Path(r['real_path']);dst=NAS/r['nas_relative_path'];dst.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
   expected={k:r[k] for k in ('size_bytes','mtime_ns','ctime_ns','inode','device')}
   if signature(src.stat())!=expected:raise RuntimeError(f"Source changed before archive: {r['video_id']}")
   temp=dst.with_name(dst.name+'.'+uuid.uuid4().hex+'.partial');h=hashlib.sha256();copied=0;last=time.monotonic()
   status(current_video_id=r['video_id'],current_phase='copy',current_copied_bytes=0)
   with src.open('rb') as f,temp.open('xb') as out:
    if signature(os.fstat(f.fileno()))!=expected:raise RuntimeError('Opened source differs')
    for block in iter(lambda:f.read(8*1024*1024),b''):
     out.write(block);h.update(block);copied+=len(block)
     if time.monotonic()-last>=10:status(current_copied_bytes=copied);last=time.monotonic()
    out.flush();os.fsync(out.fileno())
    if signature(os.fstat(f.fileno()))!=expected:raise RuntimeError('Source changed during copy')
   if copied!=r['size_bytes'] or signature(src.stat())!=expected:raise RuntimeError('Source incomplete or changed')
   os.replace(temp,dst);futures.append(pool.submit(verify,r,dst,h.hexdigest(),expected))
  for future in futures:future.result()
 status(status='archive_verified',current_phase=None,current_video_id=None);atomic_json(NAS/'archive-complete.json',state)
 print(json.dumps(state),flush=True)
except BaseException as e:
 status(status='failed',error=str(e));print(json.dumps({'status':'failed','error':str(e)}),flush=True);raise
