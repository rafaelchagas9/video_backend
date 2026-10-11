"""Finite reviewed temporal version task transaction; insert only explicitly run by root."""
from __future__ import annotations
import argparse,hashlib,json
from pathlib import Path
import temporal_validation50_round_v2 as batch


def existing_match(existing,planned):
 if len(existing)!=batch.COUNT or [r['position'] for r in existing]!=list(range(batch.COUNT)) or any(any(a[k]!=b[k] for k in batch.FIELDS) for a,b in zip(existing,planned)):raise ValueError('Existing exact temporal batch differs; preserve every answer')


def answered_hash(pg):
 return pg.execute("SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'[]')) FROM recording_label_tasks t WHERE answer IS NOT NULL").fetchone()[0]


def execute(pg,value,reserved,receipt,expected,insert=False):
 pg.execute('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'+('' if insert else ' READ ONLY'));pg.execute("SET statement_timeout='20s'");pg.execute("SET lock_timeout='5s'")
 lock=int.from_bytes(hashlib.sha256(batch.BATCH.encode()).digest()[:8],'big',signed=True);pg.execute('SELECT pg_advisory_xact_lock(%s)',(lock,))
 if insert:pg.execute('LOCK TABLE recording_label_tasks IN SHARE ROW EXCLUSIVE MODE')
 before=answered_hash(pg);history=batch.history_metadata(pg);ids=sorted(p['source']['feedback_id'] for p in value['private_assignments']);live=batch.safe.previous.load_rows(pg,ids,lock=insert)
 batch.validate_live(value,live,history,reserved,receipt)
 existing=[dict(zip(batch.FIELDS,r)) for r in pg.execute('SELECT '+','.join(batch.FIELDS)+' FROM recording_label_tasks WHERE batch=%s ORDER BY position',(batch.BATCH,)).fetchall()]
 if existing:existing_match(existing,value['rows'])
 written=0
 if insert and not existing:
  for row in value['rows']:
   written+=pg.execute('INSERT INTO recording_label_tasks(kind,batch,video_id,start_seconds,end_seconds,stratum,position,channel,context) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)',(row['kind'],row['batch'],row['video_id'],row['start_seconds'],row['end_seconds'],row['stratum'],row['position'],row['channel'],json.dumps(row['context'],allow_nan=False))).rowcount
  if written!=batch.COUNT:raise ValueError('Exact fifty task insert or rollback')
 after=answered_hash(pg)
 if before!=after:raise ValueError('Existing server-side answered MD5 changed; rollback')
 return {'status':'inserted' if written else 'already_present_preserved' if existing else 'preflight_ready_no_queue_writes','batch':batch.BATCH,'count':batch.COUNT,'inserted':written,'manifest_sha256':expected,'apply_source_sha256':batch.base.digest(Path(__file__)),'existing_answered_sha_md5_before':before,'existing_answered_sha_md5_after':after,'existing_answers_preserved':True,'fits':0,'raw_media_reads':0,'GPU':False}


def run(root,expected,insert=False):
 value,reserved,receipt=batch.load_contract(root,expected)
 import psycopg
 with psycopg.connect(batch.base.pg_config()) as pg:result=execute(pg,value,reserved,receipt,expected,insert)
 digest=batch.temporal.sha(batch.versions.canonical(result)+b'\n');batch.temporal.frozen(Path(root)/'apply-receipts'/f'receipt.{digest}.json',result);return result

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['preflight','insert']);p.add_argument('--root',type=Path,default=batch.OUT);p.add_argument('--manifest-sha256',required=True);a=p.parse_args();print(json.dumps(run(a.root,a.manifest_sha256,a.mode=='insert')))
