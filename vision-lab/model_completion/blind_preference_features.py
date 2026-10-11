"""Bounded numeric-only exact offered-version export; no audio/media/GPU/fits.

Old48 side rows stay unchanged; new12 blind sides retain unknown acceptance/cuts.
Generation/source/index and original-proposal context are validated, never latest-by-video.
"""
from __future__ import annotations
import argparse,copy,json,math,os,signal,tempfile,time
from pathlib import Path
import numpy as np
import new_round_features as numeric
import learned_preference_round as oldrank
import blind_version_counterbalanced as blind
import blind_version_counterbalanced_intake as intake
BASE_SHA='014b9a6c69e1d55eeff0f9af0daf2e3f3f7c33437255ee88d04cbf9c00099a98'
SNAPSHOT_SHA='bec1b35fadc52669a9f030d5c5f7bdd3cea9988d85d55e4c2fa6eb05c04b46ec'
ROOT=numeric.ROOT
OUT=ROOT/'blind-preference-features'
MAX_SECONDS=90
MAX_CHECKPOINT_BYTES=64*1024*1024
MAX_TOTAL_FRAME_BYTES=192*1024*1024


def inputs(root=ROOT):
 basepath=root/'new-round-training/feature_cohort.json';snapshotpath=blind.OUT/'answer-snapshots'/f'answers.{SNAPSHOT_SHA}.json'
 if oldrank.sha(basepath)!=BASE_SHA or blind.base.digest(snapshotpath)!=SNAPSHOT_SHA or snapshotpath.stat().st_size>1024*1024:raise ValueError('Pinned base/complete blind answer checksum differs')
 old=json.loads(basepath.read_text());manifest,reserved,receipt=intake.load_contract(blind.OUT);snap=json.loads(snapshotpath.read_text())
 if snap['schema_version']!=1 or snap['manifest_sha256']!=intake.FINAL_SHA or snap['intake_source_sha256']!=blind.base.digest(Path(intake.__file__)):raise ValueError('Blind complete snapshot source differs')
 oldrank.validated(old['rows'],reserved)
 if len(old['rows'])!=48 or old['reserved_creators_excluded']!=sorted(reserved):raise ValueError('Old48/reserved creator contract differs')
 payload=snap['answers'];by={r['position']:r for r in payload['preference_rows']};tasks=[]
 for plan in manifest['rows']:
  r=by[plan['position']];tasks.append(dict(copy.deepcopy(plan),id=r['task_id'],answer=r['answer'],reasons=r['reasons'],detail=None if r['viewing'] is None else {'viewing':r['viewing']},answered_at=r['answered_at']))
 if intake.checked_answers(tasks,manifest)!=payload:raise ValueError('Complete blind preference snapshot reconstruction differs')
 return old,manifest,payload,reserved


def check_vectors(t,v,context,duration):
 if t.shape!=(len(v),) or v.shape!=(context['index']['frame_count'],1152) or not len(v) or not np.isfinite(t).all() or not np.isfinite(v).all() or t[0]>5.001 or np.any(np.diff(t)<=0) or np.any(np.diff(t)>10.001) or t[-1]+10<duration or not np.all(np.abs(np.linalg.norm(v,axis=1)-1)<.02):raise ValueError('Exact full generation numeric frames invalid')


def cached_inputs(old,source,live):
 matches=[r for r in old['rows'] if r['video_id']==source['video_id'] and r['analyzed_at']==source['analyzed_at']]
 for row in matches:
  identity=row['numeric_identity']
  if any(identity[k]!=source[k] for k in ('video_id','analyzed_at','index','source_fingerprint')):continue
  path=Path(row['frame_cache']);receipt=row['frame_checkpoint']
  if not path.is_file() or path.stat().st_size>64*1024*1024 or numeric.base.digest(path)!=receipt['sha256']:raise ValueError('Pinned cached numeric frame checksum differs')
  with np.load(path,allow_pickle=False) as stored:
   if str(stored['identity_sha256'])!=receipt['identity_sha256'] or receipt['identity_sha256']!=numeric.digest(identity):raise ValueError('Cached numeric identity differs')
   t=stored['t'].copy();v=stored['v'].copy()
  check_vectors(t,v,source,live['duration']);proposals=identity['proposals']
  exact=[p for p in proposals if p['id']==live['clip_id']]
  if len(exact)!=1 or [exact[0]['start'],exact[0]['end']]!=source['clip'] or identity['duration']!=live['duration']:raise ValueError('Cached original-proposal universe differs')
  return t,v,proposals,identity,str(path)
 return None



def checkpoint(out,t,v,identity):
 identity_sha=numeric.digest(identity);directory=out/'frames';directory.mkdir(parents=True,exist_ok=True,mode=0o700);directory.chmod(0o700);path=directory/f'{identity_sha}.npz'
 if t.nbytes+v.nbytes>MAX_CHECKPOINT_BYTES:raise ValueError('Numeric checkpoint exceeds bounded size')
 if not path.exists():
  fd,tmp=tempfile.mkstemp(prefix='.frame-',dir=directory)
  try:
   with os.fdopen(fd,'wb') as f:np.savez_compressed(f,t=t,v=v.astype(np.float32),identity_sha256=identity_sha);f.flush();os.fsync(f.fileno())
   if Path(tmp).stat().st_size>MAX_CHECKPOINT_BYTES:raise ValueError('Compressed numeric checkpoint exceeds bound')
   os.chmod(tmp,0o600)
   try:os.link(tmp,path)
   except FileExistsError:pass
   descriptor=os.open(directory,os.O_RDONLY)
   try:os.fsync(descriptor)
   finally:os.close(descriptor)
  finally:os.unlink(tmp)
 if path.stat().st_size>MAX_CHECKPOINT_BYTES:raise ValueError('Existing numeric checkpoint exceeds bound')
 with np.load(path,allow_pickle=False) as stored:
  if str(stored['identity_sha256'])!=identity_sha or not np.array_equal(stored['t'],t) or not np.array_equal(stored['v'],v.astype(np.float32)):raise ValueError('Immutable numeric checkpoint contents differ')
 return str(path.resolve()),{'sha256':numeric.base.digest(path),'identity_sha256':identity_sha,'bytes':path.stat().st_size}


def row_features(preference,key,source,live,frames,oldnodes):
 public=preference[key];a,b=public['range'];t,v,proposals,identity,path=frames
 if any(public[k]!=source[k] for k in ('feedback_id','video_id','analyzed_at','source_fingerprint','index','detector','channel_key')) or public['original_range']!=source['clip']:raise ValueError('Blind offered generation/source/index/original identity differs')
 group=source['channel_key'];fx,visual=numeric.domain_features({'group':group},source,live,t,v,proposals,a,b)
 if visual is None:raise ValueError('Blind exact offered range lacks observed point frames')
 if np.asarray(visual).shape!=(1152,) or not np.isfinite(visual).all() or abs(np.linalg.norm(visual)-1)>.02:raise ValueError('Blind point-frame mean is zero/nonunit/invalid')
 row={'row':f"version{preference['task_id']}{key}",'task_id':preference['task_id'],'position':preference['position'],'side':key,'kind':'version-versus','cohort_kind':'blind_version_preference','answer':preference['answer'],'target':'preferred_version_if_keep_one','ranking_y':int(preference['answer']==key) if preference['answer'] in ('a','b') else None,'current_acceptability_y':None,'absolute_y':None,'cut_gold':None,'future_replacement':'unknown','permanent_storage_worth':'unknown','video_id':source['video_id'],'feedback_id':source['feedback_id'],'group':group,'channel':source['channel'],'analyzed_at':source['analyzed_at'],'source_fingerprint':source['source_fingerprint'],'index':source['index'],'original_range':source['clip'],'offered_range':[a,b],'start':a,'end':b,'features':fx,'visual_mean':visual,'numeric_identity':identity,'original_proposal_id':live['clip_id'],'frame_cache':path,'duration_seconds':live['duration'],'score':source['score'],'reserved_fine_holdout':False,'fine_data_role':'training','comparison_scope':'same_channel','pair_creators':[group]}
 node=oldrank.node_key(row)
 if node in oldnodes:
  previous=oldnodes[node];X=np.asarray(fx);V=np.asarray(visual)
  if previous[0]!=group or not np.allclose(previous[1],X,atol=1e-9,rtol=0) or not np.allclose(previous[2],V,atol=1e-7,rtol=0):raise ValueError('Exact old/new offered node input conflict')
  row['features']=previous[1].tolist();row['visual_mean']=previous[2].tolist();row['old_node_exact_values_reused']=True
 else:row['old_node_exact_values_reused']=False
 return row


def export(root=ROOT,out=OUT):
 import psycopg
 started=time.monotonic();total_frame_bytes=0;old,manifest,payload,reserved=inputs(root);oldnodes,_=oldrank.validated(old['rows'],reserved);private={r['position']:r for r in manifest['private_assignments']};preferences=payload['preference_rows'];output=[];frame_sources={}
 ids=sorted({r['source']['feedback_id'] for r in private.values()})
 with psycopg.connect(numeric.base.pg_config()) as pg:
  pg.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');pg.execute("SET statement_timeout='20s'")
  live=numeric.connected.load_rows(pg,ids)
  if set(live)!=set(ids):raise ValueError('All six exact source generations required')
  for preference in preferences:
   if time.monotonic()-started>=MAX_SECONDS:raise TimeoutError('Bounded blind numeric export expired')
   source=private[preference['position']]['source'];row=live[source['feedback_id']];numeric.validate_live({'group':source['channel_key']},source,row)
   if source['channel_key'] in reserved or row['is_available'] is not True:raise ValueError('Reserved/unavailable blind source')
   frames=cached_inputs(old,source,row)
   if frames is None:
    t,v,proposals,identity=numeric.frame_inputs(row,source,pg)
    if time.monotonic()-started>=MAX_SECONDS:raise TimeoutError('Export deadline before checkpoint')
    path,frame_receipt=checkpoint(out,t,v,identity);frames=(t,v,proposals,identity,path)
   else:
    frame_receipt={'sha256':numeric.base.digest(Path(frames[4])),'identity_sha256':numeric.digest(frames[3]),'bytes':Path(frames[4]).stat().st_size}
   total_frame_bytes+=frame_receipt['bytes']
   if total_frame_bytes>MAX_TOTAL_FRAME_BYTES:raise ValueError('Total numeric frame read/export bound exceeded')
   for key in ('a','b'):
    value=row_features(preference,key,source,row,frames,oldnodes);value['pilot_role_private']=private[preference['position']]['pilot_role'];value['frame_checkpoint']=frame_receipt;output.append(value)
   frame_sources[str(source['feedback_id'])]={'identity_sha256':numeric.digest(frames[3]),'frame_count':len(frames[0]),'checkpoint_sha256':frame_receipt['sha256'],'checkpoint_bytes':frame_receipt['bytes'],'frame_cache':frames[4],'source':'new_read_only_DB_numeric_checkpoint' if Path(frames[4]).is_relative_to(out.resolve()) else 'existing_exact_numeric_checkpoint'}
 if len(output)!=12 or len({r['task_id'] for r in output if r['ranking_y'] is not None})!=5:raise ValueError('Exactly12 blind sides/5 strict edges required')
 data={'schema_version':1,'format':'isolated_combined_offered_preference_features','source_sha256':numeric.base.digest(Path(__file__)),'numeric_source_sha256':numeric.base.digest(Path(numeric.__file__)),'feature_recipe_source_sha256':numeric.base.digest(Path(numeric.recipe.__file__)),'intake_source_sha256':numeric.base.digest(Path(intake.__file__)),'blind_generator_source_sha256':numeric.base.digest(Path(blind.__file__)),'old_cohort_sha256':BASE_SHA,'blind_snapshot_sha256':SNAPSHOT_SHA,'blind_manifest_sha256':intake.FINAL_SHA,'old_rows':old['rows'],'version_rows':output,'reserved_creators_excluded':sorted(reserved),'coarse_reserved_groups_excluded':old['coarse_reserved_groups_excluded'],'feature_names':numeric.recipe.FEATURES,'feature_recipe':'recording-v1-replace-exact-offered-proposal','visual_sampling':oldrank.SPEC['visual_sampling'],'frame_sources':frame_sources,'old_current_acceptability':'preserved_only','new_current_acceptability':'unknown','new_cut_gold':'unknown','media_reads':0,'audio_features_used':0,'GPU':False,'production_writes':0}
 if data['old_rows']!=old['rows']:raise ValueError('Old48 rows altered')
 numeric.base.save_frozen(out/'feature_cohort.json',data);summary={'old_sides':48,'blind_version_sides':12,'old_strict_pairs':17,'blind_strict_pairs':5,'combined_strict_pairs':22,'reserved_creators':len(reserved),'cohort_sha256':numeric.base.digest(out/'feature_cohort.json'),'numeric_checkpoint_sources':sum(v['source']=='existing_exact_numeric_checkpoint' for v in frame_sources.values()),'DB_numeric_sources':sum(v['source']=='new_read_only_DB_numeric_checkpoint' for v in frame_sources.values()),'seconds':round(time.monotonic()-started,2),'fits':0,'media_reads':0,'GPU':False};numeric.base.save_frozen(out/'summary.json',summary);print(json.dumps(summary));return data

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=ROOT);parser.add_argument('--out',type=Path,default=OUT);args=parser.parse_args();signal.alarm(MAX_SECONDS);export(args.root,args.out)
