"""Separate finite offered-span apply. Root alone runs inserts after exact-manifest review."""
from __future__ import annotations
import argparse,hashlib,json
from pathlib import Path
import offered_span_intake as contract
base=contract.base

def existing_match(existing,planned):
 by={contract.key(r):r for r in planned}
 if len(existing)!=len(planned) or len({contract.key(r) for r in existing})!=len(planned) or {contract.key(r) for r in existing}!=set(by) or any(any(row[k]!=by[contract.key(row)][k] for k in contract.FIELDS) for row in existing):raise ValueError('Existing batch differs; preserve all rows and answers')

def validate_live(manifest,live,history,reserved,receipt):
 contract.validate_manifest(manifest,reserved,receipt)
 prior=[t for t in history if t['batch'] not in contract.BATCHES]
 sources={p['source']['feedback_id']:p['source'] for p in manifest['private_assignments']}
 if set(live)!=set(sources):raise ValueError('Exact live source IDs required')
 for fid,source in sources.items():
  if contract.safe.previous.side(live[fid],prior)!=source:raise ValueError('Live source/generation/index/saved review drift')
 used=contract.versions.history_pairs(prior);seen=set()
 for row in manifest['rows']:
  pair=tuple(sorted(contract.versions.version_key(row['context'][k]) for k in ('a','b')))
  if pair in used or pair in seen:raise ValueError('Historical/new exact version comparison repeated')
  seen.add(pair)

def answered_hash(pg):
 # Server-side digest only; reserved answer contents never leave PostgreSQL.
 return pg.execute("SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'[]')) FROM recording_label_tasks t WHERE answer IS NOT NULL").fetchone()[0]

def execute(pg,manifest,reserved,receipt,expected,insert=False):
 pg.execute('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'+('' if insert else ' READ ONLY'));pg.execute("SET statement_timeout='20s'");pg.execute("SET lock_timeout='5s'")
 lock=int.from_bytes(hashlib.sha256(contract.STEM.encode()).digest()[:8],'big',signed=True);pg.execute('SELECT pg_advisory_xact_lock(%s)',(lock,))
 if insert:pg.execute('LOCK TABLE recording_label_tasks IN SHARE ROW EXCLUSIVE MODE')
 before=answered_hash(pg);history=contract.safe.load_history(pg,reserved);ids=sorted({p['source']['feedback_id'] for p in manifest['private_assignments']});live=contract.safe.previous.load_rows(pg,ids,lock=insert)
 validate_live(manifest,live,history,reserved,receipt)
 existing=[dict(zip(contract.FIELDS,r)) for r in pg.execute('SELECT '+','.join(contract.FIELDS)+' FROM recording_label_tasks WHERE batch=ANY(%s) ORDER BY batch,position',(contract.BATCHES,)).fetchall()]
 if existing:existing_match(existing,manifest['rows'])
 written=0
 if insert and not existing:
  for row in manifest['rows']:
   written+=pg.execute('INSERT INTO recording_label_tasks(kind,batch,video_id,start_seconds,end_seconds,stratum,position,channel,context) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)',(row['kind'],row['batch'],row['video_id'],row['start_seconds'],row['end_seconds'],row['stratum'],row['position'],row['channel'],json.dumps(row['context'],allow_nan=False))).rowcount
  if written!=len(manifest['rows']):raise ValueError('Exact finite insert count or rollback')
 after=answered_hash(pg)
 if before!=after:raise ValueError('Existing answered task hash changed; rollback')
 return {'status':'inserted' if written else 'already_present_preserved' if existing else 'preflight_ready_no_queue_writes','batch_stem':contract.STEM,'batches':contract.BATCHES,'count':len(manifest['rows']),'inserted':written,'manifest_sha256':expected,'apply_source_sha256':base.digest(Path(__file__)),'intake_source_sha256':base.digest(Path(contract.__file__)),'existing_answered_sha_md5_before':before,'existing_answered_sha_md5_after':after,'existing_answers_preserved':True,'model_fits':0,'raw_media_reads':0,'GPU':False}

def run(root,expected,insert=False):
 manifest,reserved,receipt=contract.load_contract(root,expected)
 import psycopg
 with psycopg.connect(base.pg_config()) as pg:result=execute(pg,manifest,reserved,receipt,expected,insert)
 sha=contract.digest(result);base.save_frozen(Path(root)/'apply-receipts'/f'receipt.{sha}.json',result);print(json.dumps(dict(result,receipt_sha256=sha)));return result

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['preflight','insert']);p.add_argument('--root',type=Path,default=contract.OUT);p.add_argument('--manifest-sha256',required=True);args=p.parse_args();run(args.root,args.manifest_sha256,args.mode=='insert')
