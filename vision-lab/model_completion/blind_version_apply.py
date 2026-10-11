"""Separate explicit six-task transaction; metadata preflight allowed, insert needs root review."""
from __future__ import annotations
import argparse,hashlib,json
from pathlib import Path
import blind_version_round as batch
import blind_version_intake as intake


def existing_match(existing,planned):
 if len(existing)!=6 or [r['position'] for r in existing]!=list(range(6)) or any(any(a[k]!=b[k] for k in batch.FIELDS) for a,b in zip(existing,planned)):raise ValueError('Existing blind batch differs; preserve all answers')


def execute(pg,value,reserved,receipt,insert):
 pg.execute('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'+('' if insert else ' READ ONLY'));pg.execute("SET statement_timeout='20s'");pg.execute("SET lock_timeout='5s'")
 lock=int.from_bytes(hashlib.sha256(batch.BATCH.encode()).digest()[:8],'big',signed=True);pg.execute('SELECT pg_advisory_xact_lock(%s)',(lock,))
 history=batch.safe.load_history(pg,reserved);live=batch.safe.previous.load_rows(pg,batch.LONG_IDS+batch.CONTROL_IDS,lock=insert);batch.validate_live(value,live,history,reserved,receipt)
 existing=[dict(zip(batch.FIELDS,r)) for r in pg.execute('SELECT '+','.join(batch.FIELDS)+' FROM recording_label_tasks WHERE batch=%s ORDER BY position',(batch.BATCH,)).fetchall()]
 if existing:existing_match(existing,value['rows'])
 written=0
 if insert and not existing:
  for row in value['rows']:
   written+=pg.execute('INSERT INTO recording_label_tasks(kind,batch,video_id,start_seconds,end_seconds,stratum,position,channel,context) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)',(row['kind'],row['batch'],row['video_id'],row['start_seconds'],row['end_seconds'],row['stratum'],row['position'],row['channel'],json.dumps(row['context'],allow_nan=False))).rowcount
  if written!=6:raise ValueError('Exact six-task insert or rollback')
 return {'status':'inserted' if written else 'already_present_preserved' if existing else 'preflight_ready_no_queue_writes','batch':batch.BATCH,'count':6,'inserted':written,'manifest_sha256':intake.FINAL_SHA,'apply_source_sha256':batch.base.digest(Path(__file__)),'intake_source_sha256':batch.base.digest(Path(intake.__file__)),'optional18_diversity_inserted':0,'raw_media_reads':0,'GPU':False}


def run(root,expected,insert=False):
 value,reserved,receipt=intake.load_contract(root,expected)
 import psycopg
 with psycopg.connect(batch.base.pg_config()) as pg:result=execute(pg,value,reserved,receipt,insert)
 data=batch.canonical(result);sha=hashlib.sha256(data).hexdigest();batch.base.save_frozen(root/'apply-receipts'/f'receipt.{sha}.json',result);print(json.dumps(dict(result,receipt_sha256=sha)))
 return result

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['preflight','insert']);parser.add_argument('--root',type=Path,default=batch.OUT);parser.add_argument('--manifest-sha256',required=True);args=parser.parse_args();run(args.root,args.manifest_sha256,args.mode=='insert')
