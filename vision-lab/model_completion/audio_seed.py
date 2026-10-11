"""Prepare bounded private jobs for existing unreviewed analyses; never changes DB rows."""
from __future__ import annotations
import argparse,json,os,sys
from pathlib import Path
from datetime import timezone
LAB=Path(__file__).resolve().parents[1];BACKEND=LAB.parent
sys.path.insert(0,str(LAB));sys.path.insert(0,str(Path(__file__).parent))
from audio_cache_worker import PIN,cache_name,fingerprint

def iso(value):
 if value.tzinfo is None:value=value.replace(tzinfo=timezone.utc)
 return value.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--target',type=int);parser.add_argument('--limit',type=int,default=40);args=parser.parse_args()
 if not 1<=args.limit<=40:raise ValueError('pilot limit must be at most40 proposals')
 import psycopg
 from label_server import PG
 with psycopg.connect(PG) as connection:
  connection.execute('SET TRANSACTION READ ONLY');connection.execute("SET statement_timeout='30s'")
  rows=connection.execute('''SELECT r.video_id,r.analyzed_at,i.model_revision,i.storyboard_generated_at,i.frame_count,v.file_path,v.file_size_bytes,r.proposals
    FROM recording_reviews r JOIN video_visual_index i ON i.video_id=r.video_id JOIN videos v ON v.id=r.video_id
    WHERE r.saved_at IS NULL AND r.status='proposed' AND r.proposals IS NOT NULL
    ORDER BY (r.video_id=%s) DESC,r.analyzed_at DESC LIMIT 100''',(args.target or 0,)).fetchall()
 root=BACKEND/'data/models/recording-audio-jobs';root.mkdir(parents=True,exist_ok=True,mode=0o700);root.chmod(0o700)
 count=0;report=[]
 for vid,analyzed,indexmodel,storyboard,nframes,path,size,proposals in rows:
  selected=[{k:p[k] for k in ('id','start_seconds','end_seconds')} for p in proposals if not p['id'].startswith('added-') and p['end_seconds']-p['start_seconds']>=20]
  if not selected:continue
  selected=selected[:args.limit-count]
  if not selected:break
  try:fp=fingerprint(Path(path))
  except OSError:continue
  if fp['size_bytes']!=size:continue
  identity=dict(schema_version=1,video_id=vid,analyzed_at=iso(analyzed),index_model_revision=indexmodel,storyboard_generated_at=iso(storyboard),frame_count=nframes,audio_model_revision=PIN,source_fingerprint=fp)
  job=root/cache_name(identity);tmp=job.with_suffix('.partial');tmp.write_text(json.dumps(dict(identity=identity,source_path=path,proposals=selected),allow_nan=False,separators=(',',':')));tmp.chmod(0o600);tmp.replace(job)
  count+=len(selected);report.append({'video_id':vid,'proposals':len(selected),'job_name':job.name})
  if count>=args.limit:break
 out=LAB/'data/model-completion-20261010/audio/seed_report.json';out.write_text(json.dumps({'proposal_count':count,'jobs':report,'db_writes':0,'media_reads':0},indent=2));out.chmod(0o600)
 print(json.dumps({'proposal_count':count,'jobs':report,'db_writes':0,'media_reads':0}))
if __name__=='__main__':main()
