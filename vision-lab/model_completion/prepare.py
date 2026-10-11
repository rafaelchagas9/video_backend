"""Freeze all existing decisions and numeric inputs; never reads source media or writes the database."""
from __future__ import annotations
import hashlib,json,math,sys,time
from collections import defaultdict
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import deployed_data as dd
from label_server import PG
ROOT=Path(__file__).resolve().parents[1]/'data'/'model-completion-20261010'
FEATURES=['log_seconds','score','relative_length','relative_score','duration_fraction','position_fraction','cosine_to_recording','cosine_to_rest','dispersion_mean','dispersion_p90','transition_mean','transition_p90','has_frames']

def save(path,value):
 path.parent.mkdir(parents=True,exist_ok=True);path.parent.chmod(0o700)
 tmp=path.with_suffix('.partial');tmp.write_text(json.dumps(value,allow_nan=False,indent=2));tmp.chmod(0o600);tmp.replace(path)

def unit(x):
 norm=np.linalg.norm(x,axis=-1,keepdims=True);return x/np.maximum(norm,1e-12)

def features(proposals,duration,t=None,v=None):
 lengths=np.array([math.log(max(1.,p['end']-p['start'])) for p in proposals]);scores=np.array([p['score'] for p in proposals])
 out=[]
 if v is not None and len(v):
  v=unit(np.asarray(v,dtype=np.float64));total=v.sum(0);centre=unit(v.mean(0))
 for i,p in enumerate(proposals):
  a,b=p['start'],p['end'];x=[float(lengths[i]),float(scores[i]),float(lengths[i]-lengths.mean()),float(scores[i]-scores.mean()),(b-a)/max(1.,duration),(a+b)/2/max(1.,duration)]
  visual=[0.]*7
  if v is not None and len(v):
   mask=(t>=a)&(t<=b);clip=v[mask]
   if len(clip):
    cm=unit(clip.mean(0));rest=v[~mask];rm=unit((total-clip.sum(0))/len(rest)) if len(rest) else centre
    disp=np.clip(1.-clip@cm,0.,2.);change=np.clip(1.-np.sum(clip[:-1]*clip[1:],axis=1),0.,2.) if len(clip)>1 else np.array([0.])
    visual=[float(np.clip(cm@centre,-1.,1.)),float(np.clip(cm@rm,-1.,1.)),float(disp.mean()),float(np.quantile(disp,.9)),float(change.mean()),float(np.quantile(change,.9)),1.]
  out.append(x+visual)
 return out

def union_seconds(ranges,duration):
 end=0.;total=0.
 for a,b in sorted(ranges):
  a=max(0.,float(a));b=min(duration,float(b));total+=max(0.,b-max(a,end));end=max(end,b)
 return total

def main():
 import psycopg
 start=time.monotonic();ROOT.mkdir(parents=True,exist_ok=True);ROOT.chmod(0o700)
 if (ROOT/'cohort.json').exists():print('Immutable cohort already exists; not overwritten.');return
 with psycopg.connect(PG) as c:
  c.execute('SET TRANSACTION READ ONLY')
  c.execute("SET statement_timeout='90s'")
  cols=['id','video_id','analyzed_at','clip_id','channel','detector','verdict','added','reasons','start_seconds','end_seconds','detected_start','detected_end','score','recording_seconds','shown_default','label_type','merged_into','updated_at','rendered']
  records=[dict(zip(cols,r)) for r in c.execute("""SELECT f.id,f.video_id,f.analyzed_at,f.clip_id,f.channel,f.detector,f.verdict,f.added,f.reasons,f.start_seconds,f.end_seconds,f.detected_start,f.detected_end,f.score,f.recording_seconds,f.shown_default,f.label_type,f.merged_into,f.updated_at,f.rendered FROM recording_clip_feedback f JOIN (SELECT video_id,max(analyzed_at) a FROM recording_clip_feedback GROUP BY video_id) l ON l.video_id=f.video_id AND l.a=f.analyzed_at ORDER BY f.video_id,f.start_seconds,f.id""").fetchall()]
  index={r[0]:list(r[1:]) for r in c.execute('SELECT video_id,model_revision,frame_count,interval_seconds,storyboard_generated_at,indexed_at FROM video_visual_index').fetchall()}
  tasks=[dict(zip(['id','kind','answer','channel','context','detail','answered_at'],r)) for r in c.execute("SELECT id,kind,answer,channel,context,detail,answered_at FROM recording_label_tasks WHERE answer IS NOT NULL ORDER BY id").fetchall()]
  # Fine tasks may reference an older feedback generation; keep it separately from latest coarse rows.
  import task_generation_inputs as task_inputs
  task_ids=task_inputs.referenced_feedback_ids(tasks)
  task_records=[dict(zip(cols,r)) for r in c.execute("SELECT id,video_id,analyzed_at,clip_id,channel,detector,verdict,added,reasons,start_seconds,end_seconds,detected_start,detected_end,score,recording_seconds,shown_default,label_type,merged_into,updated_at,rendered FROM recording_clip_feedback WHERE id=ANY(%s) ORDER BY id",(task_ids,)).fetchall()] if task_ids else []
  video_durations=dict(c.execute('SELECT id,duration_seconds FROM videos').fetchall())
  by=defaultdict(list)
  for r in records:by[r['video_id']].append(r)
  groups={};rows=[];recs=[];sources=defaultdict(int);raw_frames=0
  framesdir=ROOT/'frames';framesdir.mkdir(exist_ok=True);framesdir.chmod(0o700)
  for n,(vid,allrows) in enumerate(by.items()):
   chosen=[r for r in allrows if r['merged_into'] is None and r['label_type']=='triage'];
   if not chosen:continue
   channel=dd.channel_key(chosen[0]['channel']) or f'unknown-{vid}'
   groups.setdefault(channel,f'g{len(groups):03d}');group=groups[channel]
   # Refresh live numeric inputs; old id-only caches are never assumed fresh for extant indices.
   if vid in index:
    raw=c.execute('SELECT timestamp_seconds,embedding::text FROM video_frame_embeddings WHERE video_id=%s ORDER BY frame_index',(vid,)).fetchall()
    if raw:
     t=np.array([r[0] for r in raw],np.float64);v=np.array([json.loads(r[1]) for r in raw],np.float32);source='live_numeric'
    else:t=v=None;source='missing'
   else:
    found=dd.frames(vid)
    if found:t,v,source=found
    else:t=v=None;source='missing'
   if v is not None and (v.ndim!=2 or not len(v)):
    t=v=None;source='missing'
   if v is not None:
    assert np.isfinite(v).all() and np.isfinite(t).all() and np.all(np.diff(t)>0)
    assert v.shape[1]==1152
    np.savez(framesdir/f'{vid}.npz',t=t,v=v.astype(np.float16));(framesdir/f'{vid}.npz').chmod(0o600);raw_frames+=len(t)
   sources[source]+=1
   duration=float(video_durations.get(vid) or next((r['recording_seconds'] for r in chosen if r['recording_seconds']),None) or (t[-1]+5 if t is not None else max(r['end_seconds'] for r in chosen)))
   # Original proposals include merged-away ones, matching the review's pre-choice input universe.
   proposals=[{'id':r['clip_id'],'start':float(r['detected_start'] if r['detected_start'] is not None else r['start_seconds']),'end':float(r['detected_end'] if r['detected_end'] is not None else r['end_seconds']),'score':float(r['score']),'feedback':r} for r in allrows if not r['added']]
   fx=features(proposals,duration,t,v)
   featuremap={p['id']:x for p,x in zip(proposals,fx)}
   for r in chosen:
    if r['added']:continue
    try:trained=bool(json.loads(r['detector']).get('model'))
    except (ValueError,AttributeError):trained=False
    if not trained:continue
    a=r['detected_start'];b=r['detected_end'];original=a is not None and b is not None
    a=float(a if a is not None else r['start_seconds']);b=float(b if b is not None else r['end_seconds'])
    rows.append({'row':f'r{len(rows):05d}','video_id':vid,'clip_id':r['clip_id'],'feedback_id':r['id'],'group':group,'analyzed_at':r['analyzed_at'].isoformat(),'updated_at':r['updated_at'].isoformat(),'y':int(r['verdict']=='keep'),'added':False,'keep_whole':'keep_whole' in r['reasons'],'detected_start':a,'detected_end':b,'selected_start':float(r['start_seconds']),'selected_end':float(r['end_seconds']),'score':float(r['score']),'duration':duration,'features':featuremap[r['clip_id']],'has_original_edges':original,'shown_default':r['shown_default'],'frame_source':source})
   kept=[r for r in chosen if r['verdict']=='keep']
   recs.append({'video_id':vid,'group':group,'duration':duration,'explicit_whole':any('keep_whole' in r['reasons'] for r in kept),'kept_coverage':union_seconds([(r['start_seconds'],r['end_seconds']) for r in kept],duration)/max(1.,duration),'any_keep':bool(kept),'analyzed_at':chosen[0]['analyzed_at'].isoformat(),'original_proposals':[{'id':p['id'],'start':p['start'],'end':p['end'],'score':p['score'],'features':x} for p,x in zip(proposals,fx)]})
   if (n+1)%10==0:print(json.dumps({'frozen_recordings':n+1,'numeric_frames':raw_frames}),flush=True)
  # No current index/video-id fallback is used for historical task feature inputs.
  task_sidecar=task_inputs.build_sidecar(tasks,task_records)
  task_sidecar=json.loads(json.dumps(task_sidecar,default=lambda x:x.isoformat()))
  if len(json.dumps(task_sidecar,allow_nan=False,indent=2).encode())>task_inputs.MAX_SIDECAR_BYTES:raise ValueError('Task generation sidecar exceeds 8 MiB limit')
  save(ROOT/'task_generation_inputs.json',task_sidecar)
  private={'version':1,'records':records,'tasks':tasks,'indices':index}
  save(ROOT/'private_snapshot.json',json.loads(json.dumps(private,default=lambda x:x.isoformat())))
  cohort={'version':1,'model_revision':'siglip2/so400m-patch16-256','feature_recipe':'recording-v1','features':FEATURES,'rows':rows,'recordings':recs,'numeric_sources':dict(sources),'frames':raw_frames,'target':'coarse triage and separate saved final preference/cut decisions','production_writes':0,'media_reads':0}
  save(ROOT/'cohort.json',cohort)
  # Pure portable fixture for Python/TypeScript feature/prediction parity.
  ft=np.arange(12,dtype=float)*5;fv=unit(np.array([[math.sin(i+j*.3) for j in range(4)] for i in range(12)]));fp=[{'id':'c1','start':5.,'end':30.,'score':.7},{'id':'c2','start':35.,'end':55.,'score':.9}]
  save(ROOT/'feature_parity.json',{'timestamps':ft.tolist(),'vectors':fv.tolist(),'proposals':[{'id':p['id'],'start_seconds':p['start'],'end_seconds':p['end'],'score':p['score']} for p in fp],'duration':60.,'features':features(fp,60.,ft,fv)})
  print(json.dumps({'status':'frozen','rows':len(rows),'recordings':len(recs),'channels':len(groups),'numeric_sources':dict(sources),'seconds':round(time.monotonic()-start,2)}),flush=True)
if __name__=='__main__':main()
