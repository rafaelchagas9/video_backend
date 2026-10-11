"""Export the completed rounds' TRAINING sides from exact numeric generations.

No held-out answers, fitting, GPU, media decode, production writes or queue work.
Missing exact offered/cut audio stays missing; original-proposal means are not substitutes.
"""
from __future__ import annotations
import argparse,copy,hashlib,json,math,sys,time
from pathlib import Path
import numpy as np
import targeted_label_round as base
import connected_label_round as connected
import fine_labels as labels
import prepare as recipe
import task_generation_inputs as historical
import archived_audio as archived
import audio_cache_worker as audio

ROOT=recipe.ROOT
OUT=ROOT/'new-round-training'
SOURCES=(('targeted-label-round','427b2dea332252828071765d544aa361425cd5f2e1237deb7e232b92958daf79','training_rows','97138b934ec6c586a711c7c99d213c1707e2a36179e1fa1f3c8786be64e79fd3'),('connected-label-round','fd396120017ba57d5c83467af0c326c6d3ea9132f41ab8a92cb6eca0ea4617dc','current_candidate_rows','1d9fe39191cc0478b4710bc8d48b5997e28f4776f6421d7b0d1d8a698505cd43'))
MAX_SECONDS=180

def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def digest(value):return hashlib.sha256(canonical(value)).hexdigest()
def close(a,b):return abs(float(a)-float(b))<=.0001

def training_labels(root=ROOT):
 reserved,holdout=connected.holdout_contract();rows=[];plans={};receipts=[]
 for name,sha,key,manifest_sha in SOURCES:
  path=root/name/'answer-snapshots'/f'answers.{sha}.json';manifest_path=root/name/'private_manifest.json'
  if base.digest(path)!=sha or base.digest(manifest_path)!=manifest_sha:raise labels.FineLabelContractError('Pinned training answers/manifest checksum differs')
  payload=json.loads(path.read_text());manifest=json.loads(manifest_path.read_text())
  if payload['schema_version']!=1 or payload['manifest_sha256']!=manifest_sha or payload['fine_labels_source_sha256']!=base.digest(Path(labels.__file__)):raise labels.FineLabelContractError('Pinned answer policy/source provenance differs')
  # The targeted holdout_rows and tasks/outcomes are NEVER consulted.
  selected=copy.deepcopy(payload['answers'][key]);expected=8 if name=='targeted-label-round' else 40
  if len(selected)!=expected:raise labels.FineLabelContractError('Fixed training-side count differs')
  byposition={r['position']:r for r in manifest['rows']};allowed=list(range(4)) if name=='targeted-label-round' else list(range(20))
  grouped={}
  for row in selected:
   labels._checked(row);labels.require_fit_scope([row])
   if row['group'] in reserved:raise labels.ReservedFineHoldoutError('Reserved creator in new training sides')
   if row['fine_data_role']!='training' or row['reserved_fine_holdout'] is not False:raise labels.FineLabelContractError('Only predeclared training sides allowed')
   candidates=[r for r in manifest['rows'] if r['position'] in allowed and r['context'][row['side']]['feedback_id']==row['feedback_id'] and r['context'][row['side']]['video_id']==row['video_id']]
   # A recurring connected clip can occupy several tasks; resolve each two-sided pair below.
   grouped.setdefault(row['task_id'],[]).append((row,candidates))
  for task_id,pair in grouped.items():
   if len(pair)!=2 or {r['side'] for r,_ in pair}!={'a','b'}:raise labels.FineLabelContractError('Complete training pair required')
   common=[p for p in pair[0][1] if any(p==q for q in pair[1][1])]
   if len(common)!=1:raise labels.FineLabelContractError('Exact unique pre-answer pair context required')
   plan=common[0];task=dict(plan,id=task_id,answer=pair[0][0]['answer'],detail={'best':{}})
   if any(r['answer']!=task['answer'] for r,_ in pair):raise labels.FineLabelContractError('Pair answer mismatch')
   for row,_ in pair:
    cut=row['cut_gold']
    if cut is not None:
     if not isinstance(cut.get('accepted_offered_edges'),bool):raise labels.FineLabelContractError('Confirmed cut acceptance marker invalid')
     task['detail']['best'][row['side']]={'start_seconds':cut['start_seconds'],'end_seconds':cut['end_seconds'],'accepted':cut['accepted_offered_edges']}
   for row,_ in pair:
    ctx=plan['context'][row['side']];meta=dict(row,y=row['legacy_y']);verified=labels.contract(meta,task)
    if any(row[k]!=verified[k] for k in verified):raise labels.FineLabelContractError('Frozen training label contract differs')
    group=base.canon(ctx.get('channel') or plan['channel'])
    if row['group']!=group or any(row[k]!=ctx[k] for k in ('video_id','feedback_id','analyzed_at','source_fingerprint','index')) or row['original_range']!=ctx['clip'] or row['offered_range']!=[row['start'],row['end']]:raise labels.FineLabelContractError('Exact training side source/creator/generation/range differs')
    row['channel']=ctx.get('channel') or plan['channel'];row['comparison_scope']=plan['context'].get('comparison_scope','same_channel');row['pair_creators']=sorted({base.canon(plan['context'][k].get('channel') or plan['channel']) for k in ('a','b')});row['batch']=plan['batch']
    plans[row['row']]=ctx;rows.append(row)
  receipts.append({'batch':name,'answer_sha256':sha,'manifest_sha256':manifest_sha,'selected_field':key})
 if len(rows)!=48 or len({r['row'] for r in rows})!=48:raise labels.FineLabelContractError('Exactly48 unique training sides required')
 return rows,plans,reserved,receipts


def validate_live(row,context,live):
 got=base.side(live)
 if any(got[k]!=context[k] for k in ('video_id','feedback_id','clip','analyzed_at','source_fingerprint','index','detector','score')) or base.canon(live['channel'])!=row['group']:raise labels.FineLabelContractError('Frozen side generation/source/index/proposal differs from live numeric source')


def frame_inputs(live,context,connection,archive_root=historical.snapshots.ROOT):
 feedback={'id':live['feedback_id'],'video_id':live['video_id'],'analyzed_at':base.stamp(live['analyzed_at']),'clip_id':live['clip_id'],'channel':live['channel'],'detector':live['detector'],'detected_start':live['original_start'],'detected_end':live['original_end']}
 saved=historical.exact_archive(feedback,archive_root)
 if saved is not None:
  f=saved['features'];index=f['index'];expected=context['index']
  actual={'model_revision':index['modelRevision'],'frame_count':index['frameCount'],'interval_seconds':index['intervalSeconds'],'storyboard_generated_at':base.stamp(archived.generation(index['storyboardGeneratedAt'])),'indexed_at':base.stamp(archived.generation(index['indexedAt']))}
  if actual!=expected or saved['source']['fileName']!=context['file_name'] or saved['source']['fileSizeBytes']!=context['source_fingerprint']['size_bytes'] or not close(saved['source']['durationSeconds'],live['duration']):raise labels.FineLabelContractError('Exact archived task index/source receipt differs')
  receipt={'feature_identity':f['identity'],'feature_sha256':f['sha256'],'index':index,'detected_start':feedback['detected_start'],'detected_end':feedback['detected_end']}
  found=historical.archived_frame_inputs(feedback,receipt,archive_root)
  if found is None:raise labels.FineLabelContractError('Archived generation frame coverage missing')
  t,v=found;originals=saved.get('proposals')
  if originals is None:originals=[dict(c,**c.get('detected',{})) for c in saved['clips']]
  origin={'kind':'validated_exact_generation_archive','feature_identity':f['identity'],'feature_sha256':f['sha256']}
 else:
  review=connection.execute('SELECT analyzed_at,prompts_revision,proposals,clips FROM recording_reviews WHERE video_id=%s',(live['video_id'],)).fetchone()
  if review is None or base.stamp(review[0])!=context['analyzed_at'] or review[1]!=context['detector']:raise labels.FineLabelContractError('Live analysis generation differs')
  originals=review[2] if review[2] is not None else [dict(c,**c.get('detected',{})) for c in review[3]]
  frames=connection.execute('SELECT timestamp_seconds,embedding::text FROM video_frame_embeddings WHERE video_id=%s ORDER BY frame_index',(live['video_id'],)).fetchall();t=np.array([r[0] for r in frames],dtype=np.float64);v=np.array([json.loads(r[1]) for r in frames],dtype=np.float32)
  origin={'kind':'live_numeric_exact_frozen_generation','index':context['index'],'source_fingerprint':context['source_fingerprint']}
 if v.shape!=(context['index']['frame_count'],1152) or t.shape!=(len(v),) or not len(v) or not np.isfinite(v).all() or not np.isfinite(t).all() or np.any(np.diff(t)<=0) or t[0]>5.001 or np.any(np.diff(t)>10.001) or t[-1]+10<live['duration']:raise labels.FineLabelContractError('Exact generation full-frame coverage invalid')
 if not np.all(np.abs(np.linalg.norm(v,axis=1)-1)<.02):raise labels.FineLabelContractError('Stored SigLIP frame vectors are not unit/finite')
 proposals=[{'id':p['id'],'start':p['start_seconds'],'end':p['end_seconds'],'score':p['score']} for p in originals if not p['id'].startswith('added-')]
 matches=[p for p in proposals if p['id']==live['clip_id']]
 if len(matches)!=1 or matches[0]['start']!=context['clip'][0] or matches[0]['end']!=context['clip'][1]:raise labels.FineLabelContractError('Exact original proposal universe mismatch')
 identity={'video_id':live['video_id'],'analyzed_at':context['analyzed_at'],'index':context['index'],'source_fingerprint':context['source_fingerprint'],'proposals':proposals,'duration':live['duration'],'origin':origin}
 return t,v,proposals,identity


def domain_features(row,context,live,t,v,proposals,a,b):
 copies=copy.deepcopy(proposals);matching=[i for i,p in enumerate(copies) if p['id']==live['clip_id']]
 if len(matching)!=1 or not context['clip'][0]<=a<b<=context['clip'][1]:raise labels.FineLabelContractError('Domain range outside exact original proposal')
 at=matching[0];copies[at].update(start=a,end=b,score=context['score']);x=recipe.features(copies,float(live['duration']),t,v)[at]
 mask=(t>=a)&(t<=b);visual=recipe.unit(recipe.unit(np.asarray(v[mask],dtype=np.float64)).mean(0)) if mask.any() else None
 if len(x)!=13 or not np.isfinite(x).all():raise labels.FineLabelContractError('Invalid exact domain features')
 return x,None if visual is None else visual.tolist()


def exact_production_audio(row,context,live,a,b,cache_root):
 if not (close(a,context['clip'][0]) and close(b,context['clip'][1])):return None
 fp={k:context['source_fingerprint'][k] for k in ('size_bytes','mtime_ns')};identity={'schema_version':1,'video_id':row['video_id'],'analyzed_at':context['analyzed_at'],'index_model_revision':context['index']['model_revision'],'storyboard_generated_at':context['index']['storyboard_generated_at'],'frame_count':context['index']['frame_count'],'audio_model_revision':audio.PIN,'source_fingerprint':fp};path=cache_root/audio.cache_name(identity)
 if not path.is_file():return None
 if path.stat().st_size>audio.MAX_BYTES:raise labels.FineLabelContractError('Oversize numeric production audio cache')
 payload=json.loads(path.read_text())
 if any(payload.get(k)!=v for k,v in identity.items()):raise labels.FineLabelContractError('Numeric audio generation/source/index mismatch')
 matches=[r for r in payload['proposals'] if r['id']==live['clip_id'] and close(r['start_seconds'],a) and close(r['end_seconds'],b)]
 if len(matches)!=1 or not audio.valid_cached({'id':live['clip_id'],'start_seconds':a,'end_seconds':b},matches[0]):return None
 return {'embedding':matches[0]['embedding'],'model_revision':audio.PIN,'windows_seconds':audio.expected_windows({'start_seconds':a,'end_seconds':b}),'checkpoint_sha256':base.digest(path),'source':'validated_exact_original_equals_domain'}


def ssd_need(row,context,a,b,root=ROOT):
 intervals=audio.expected_windows({'start_seconds':a,'end_seconds':b})
 if intervals is None:return {'status':'shorter_than20s','windows_seconds':[]}
 path=root/'joint-gemma/audio_reuse_manifest.json';possible=[]
 if path.exists():
  for receipt in json.loads(path.read_text())['rows']:
   fp=receipt['source_fingerprint'];expected=context['source_fingerprint'];fp=fp if isinstance(fp,dict) else {'size_bytes':fp[0],'mtime_ns':str(fp[1])}
   if receipt['video_id']!=row['video_id'] or any(str(fp[k])!=str(expected[k]) for k in ('size_bytes','mtime_ns')):continue
   if receipt['alignment']!='aresample_async_first_pts_0' or receipt['rate']!=16000 or receipt['channels']!=1:continue
   source=Path(receipt['cache_path']).resolve()
   if not source.is_relative_to((root/'joint-gemma/audio').resolve()) or not source.is_file() or source.stat().st_dev!=root.stat().st_dev:continue
   info=source.stat()
   if [info.st_size,info.st_mtime_ns]!=receipt['cache_fingerprint'] or a<receipt['audio_start']-.001 or b>receipt['audio_end']+.001:continue
   possible.append({'path':str(source),'cache_fingerprint':receipt['cache_fingerprint'],'cache_sha256_at_staging':receipt['cache_sha256'],'absolute_start':receipt['audio_start'],'absolute_end':receipt['audio_end'],'alignment':receipt['alignment'],'source_fingerprint':fp,'receipt_sha256':base.digest(path)})
 return {'status':'ssd_extraction_ready' if possible else 'missing_validated_ssd_receipt','windows_seconds':intervals,'ssd_receipt':possible[0] if possible else None,'model_revision':audio.PIN,'no_original_or_hdd_fallback':True}


def prepare(root=ROOT,out=OUT):
 import psycopg
 began=time.monotonic();rows,plans,reserved,answer_receipts=training_labels(root);inputs={};output=[];holdout_output=[];needs=[]
 with psycopg.connect(base.pg_config()) as connection:
  connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');connection.execute("SET statement_timeout='45s'")
  # Reserved feature inputs come ONLY from pre-answer metadata, never the answer snapshot.
  targeted=json.loads((root/'targeted-label-round/private_manifest.json').read_text())
  task_ids=dict((position,tid) for tid,position in connection.execute("SELECT id,position FROM recording_label_tasks WHERE kind='versus' AND batch=%s ORDER BY position",(base.BATCH,)).fetchall())
  if set(task_ids)!=set(range(8)):raise labels.FineLabelContractError('Fixed targeted metadata task positions missing')
  held=[]
  for plan in targeted['rows'][4:]:
   for side in ('a','b'):
    ctx=plan['context'][side];key=f"h{task_ids[plan['position']]}{side}";group=base.canon(plan['channel'])
    if group not in reserved or plan['context']['reserved_fine_holdout'] is not True:raise labels.FineLabelContractError('Fixed reserved metadata creator differs')
    value={'row':key,'task_id':task_ids[plan['position']],'position':plan['position'],'side':side,'video_id':ctx['video_id'],'feedback_id':ctx['feedback_id'],'analyzed_at':ctx['analyzed_at'],'source_fingerprint':ctx['source_fingerprint'],'index':ctx['index'],'offered_range':ctx['best'],'original_range':ctx['clip'],'group':group,'channel':plan['channel'],'reserved_fine_holdout':True,'fine_data_role':'holdout','comparison_scope':'same_channel','pair_creators':[group],'cut_gold':None,'no_labels_accessed':True}
    held.append(value);plans[key]=ctx
  fids=sorted({r['feedback_id'] for r in rows+held})
  live={r['feedback_id']:r for r in (dict(zip(connected.COLS,raw)) for raw in connection.execute(connected.QUERY,(fids,)).fetchall())}
  if set(live)!=set(fids) or any(r['is_available'] is not True for r in live.values()):raise labels.FineLabelContractError('Every exact training feedback/source catalog identity required')
  for row in rows+held:
   if time.monotonic()-began>=MAX_SECONDS:raise TimeoutError('Finite numeric feature export deadline')
   ctx=plans[row['row']];source=live[row['feedback_id']];validate_live(row,ctx,source);key=(row['video_id'],ctx['analyzed_at'])
   if key not in inputs:inputs[key]=frame_inputs(source,ctx,connection)
   t,v,proposals,identity=inputs[key];value=copy.deepcopy(row);value['numeric_identity']=identity;domains={}
   for name,bounds in [('offered',row['offered_range']),('confirmed_cut',None if row['cut_gold'] is None else [row['cut_gold']['start_seconds'],row['cut_gold']['end_seconds']])]:
    if bounds is None:continue
    a,b=bounds;fx,visual=domain_features(row,ctx,source,t,v,proposals,a,b);cached=exact_production_audio(row,ctx,source,a,b,base.BACKEND/'data/models/recording-audio-cache');domain={'range':bounds,'features':fx,'visual_mean':visual,'audio':cached}
    if cached is None:
     need=ssd_need(row,ctx,a,b,root);domain['audio_status']=need['status'];needs.append({'row':row['row'],'task_id':row['task_id'],'side':row['side'],'group':row['group'],'video_id':row['video_id'],'feedback_id':row['feedback_id'],'analyzed_at':row['analyzed_at'],'index':row['index'],'source_fingerprint':row['source_fingerprint'],'domain':name,'range':bounds,'reserved_fine_holdout':row['reserved_fine_holdout'],**need})
    else:domain['audio_status']='validated_exact_cached'
    domains[name]=domain
   value['domains']=domains;value['features']=domains['offered']['features'];value['visual_mean']=domains['offered']['visual_mean'];value['duration_seconds']=source['duration'];value['score']=ctx['score']
   (holdout_output if row['reserved_fine_holdout'] else output).append(value)
 # Numeric frame checkpoints are identity-keyed, never a bare video-id cache.
 for (vid,generation),(t,v,proposals,identity) in inputs.items():
  sha=digest(identity);path=out/'frames'/f'{sha}.npz';path.parent.mkdir(parents=True,exist_ok=True,mode=0o700);path.parent.chmod(0o700)
  if not path.exists():
   tmp=path.with_suffix('.partial')
   with tmp.open('wb') as file:np.savez_compressed(file,t=t,v=v.astype(np.float32),identity_sha256=sha)
   tmp.chmod(0o600);tmp.replace(path)
  with np.load(path,allow_pickle=False) as stored:
   if str(stored['identity_sha256'])!=sha or not np.array_equal(stored['t'],t) or not np.array_equal(stored['v'],v.astype(np.float32)):raise labels.FineLabelContractError('Immutable numeric frame checkpoint differs')
  for value in output+holdout_output:
   if value['video_id']==vid and value['analyzed_at']==generation:value['frame_checkpoint']={'file':str(path.relative_to(out)),'sha256':base.digest(path),'identity_sha256':sha};value['frame_cache']=str(path.resolve())
 # Coarse priors must remove every reserved creator before all PCA/scaling/fitting.
 snapshot=json.loads((root/'private_snapshot.json').read_text());coarse_group_channels={}
 coarse=json.loads((root/'cohort.json').read_text());groups_by_video={r['video_id']:r['group'] for r in coarse['rows']}
 for r in snapshot['records']:
  if r['video_id'] in groups_by_video:coarse_group_channels.setdefault(groups_by_video[r['video_id']],set()).add(base.canon(r['channel']))
 excluded_groups=sorted(g for g,channels in coarse_group_channels.items() if channels&reserved)
 if any(len(channels)!=1 for channels in coarse_group_channels.values()):raise labels.FineLabelContractError('Coarse channel/group bijection invalid')
 payload={'schema_version':1,'format':'kura-new-round-training-features','policy':labels.POLICY,'feature_recipe':'recording-v1','feature_names':recipe.FEATURES,'visual_model_revision':historical.VISUAL_PIN,'audio_model_revision':audio.PIN,'source_sha256':base.digest(Path(__file__)),'answers':answer_receipts,'rows':output,'reserved_creators_excluded':sorted(reserved),'coarse_reserved_groups_excluded':excluded_groups,'fold_contract':'Remove all reserved creators globally; hold out whole pair whenever either creator held, BEFORE every coarse/fine PCA, scaler or fit. Offered and confirmed-cut domains cannot substitute for each other.','media_reads':0,'GPU':False,'database_writes':0}
 base.save_frozen(out/'feature_cohort.json',payload);base.save_frozen(out/'holdout_features.json',{'schema_version':1,'format':'kura-preanswer-holdout-features','feature_names':recipe.FEATURES,'rows':holdout_output,'targeted_manifest_sha256':SOURCES[0][3],'label_access':False,'fold_scope':'Reserved evaluation only; no labels read and no fitting/tuning allowed.'});base.save_frozen(out/'private_audio_needs.json',{'schema_version':1,'feature_cohort_sha256':base.digest(out/'feature_cohort.json'),'needs':needs,'no_gpu_started':True,'source_policy':'Only fingerprint-matched existing SSD cache receipts; no bare Opus cache or original/HDD fallback.'})
 summary={'training_sides':len(output),'positive':sum(r['y'] for r in output),'negative':sum(not r['y'] for r in output),'creators':len({r['group'] for r in output}),'strict_pairs':len({r['task_id'] for r in output if r['ranking_y'] is not None}),'confirmed_cuts':sum(r['cut_gold'] is not None for r in output),'numeric_ready_sides':len(output),'offered_audio_ready':sum(r['domains']['offered']['audio'] is not None for r in output),'confirmed_cut_audio_ready':sum(r['domains'].get('confirmed_cut',{}).get('audio') is not None for r in output),'missing_audio_domains':sum(not r['reserved_fine_holdout'] for r in needs),'holdout_feature_sides':len(holdout_output),'ssd_ready_domains':sum(r['status']=='ssd_extraction_ready' and not r['reserved_fine_holdout'] for r in needs),'missing_ssd_receipts':sum(r['status']=='missing_validated_ssd_receipt' and not r['reserved_fine_holdout'] for r in needs),'short_domains':sum(r['status']=='shorter_than20s' and not r['reserved_fine_holdout'] for r in needs),'reserved_creators_excluded':len(reserved),'coarse_reserved_groups_excluded':len(excluded_groups),'feature_cohort_sha256':base.digest(out/'feature_cohort.json'),'fits':0,'GPU':False,'production_writes':0}
 base.save_frozen(out/'summary.json',summary);print(json.dumps(dict(summary,seconds=round(time.monotonic()-began,2))));return payload

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=ROOT);parser.add_argument('--output',type=Path,default=OUT);args=parser.parse_args();prepare(args.root,args.output)
