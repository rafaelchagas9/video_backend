"""Reviewed exact finite whole task apply; root alone runs real transactions."""
from __future__ import annotations
import argparse,hashlib,json,math,signal,time
from pathlib import Path
import whole_round_prepare as contract
from channel_partial_order import immutable_write
base=contract.base

def existing_match(existing,planned):
 if len(existing)!=len(planned) or len({contract.task_key(r) for r in existing})!=len(planned):raise ValueError('Existing whole batch incomplete; preserve')
 expected={contract.task_key(r):r for r in planned}
 if set(expected)!={contract.task_key(r) for r in existing} or any(any(r[k]!=expected[contract.task_key(r)][k] for k in contract.FIELDS) for r in existing):raise ValueError('Existing whole task geometry/context differs; preserve all answers')

def validate_live(manifest,live,reserved,holdout):
 contract.validate_manifest(manifest,reserved,holdout)
 if {r['video_id'] for r in live}!={r['video_id'] for r in manifest['rows']}:raise ValueError('Exact whole live source IDs required')
 known,clarified=contract.historical_exclusions()
 contract.choose(live,reserved,known,clarified,set(),len(manifest['rows']))
 by={r['video_id']:r for r in live}
 for p in manifest['private_sources']:
  actual=contract.source(by[p['candidate']['video_id']])
  if any(actual[k]!=p[k] for k in actual):raise ValueError('Whole live source/generation/index/review/numeric frame drift')

def answered_hash(pg):return pg.execute("SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'[]')) FROM recording_label_tasks t WHERE answer IS NOT NULL").fetchone()[0]

def execute(pg,manifest,reserved,holdout,expected,insert=False):
 pg.execute('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'+('' if insert else ' READ ONLY'));pg.execute("SET statement_timeout='20s'");pg.execute("SET lock_timeout='5s'")
 lock=int.from_bytes(hashlib.sha256(contract.BATCH.encode()).digest()[:8],'big',signed=True);pg.execute('SELECT pg_advisory_xact_lock(%s)',(lock,))
 if insert:pg.execute('LOCK TABLE recording_label_tasks IN SHARE ROW EXCLUSIVE MODE')
 before=answered_hash(pg);ids=[r['video_id'] for r in manifest['rows']]
 if insert:pg.execute('SELECT frame_index FROM video_frame_embeddings WHERE video_id=ANY(%s) ORDER BY video_id,frame_index FOR SHARE',(ids,)).fetchall()
 live=contract.attach_reviews(pg,contract.load_metadata(pg,ids,lock=insert),reserved);validate_live(manifest,live,reserved,holdout)
 existing=[dict(zip(contract.FIELDS,r)) for r in pg.execute('SELECT '+','.join(contract.FIELDS)+' FROM recording_label_tasks WHERE batch=%s ORDER BY position',(contract.BATCH,)).fetchall()]
 if existing:existing_match(existing,manifest['rows'])
 else:
  # Exact full-source whole tasks in a different batch cannot be silently repeated.
  prior=pg.execute("SELECT context FROM recording_label_tasks WHERE kind='whole-verdict' AND video_id=ANY(%s) AND batch<>%s",(ids,contract.BATCH)).fetchall()
  asked=contract.task_exclusions([{'kind':'whole-verdict','context':r[0]} for r in prior])
  if asked&{contract.source_key(p['candidate']) for p in manifest['private_sources']}:raise ValueError('Whole source already asked in another batch')
 written=0
 if insert and not existing:
  for row in manifest['rows']:written+=pg.execute('INSERT INTO recording_label_tasks(kind,batch,video_id,start_seconds,end_seconds,stratum,position,channel,context) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)',(row['kind'],row['batch'],row['video_id'],row['start_seconds'],row['end_seconds'],row['stratum'],row['position'],row['channel'],json.dumps(row['context'],allow_nan=False))).rowcount
  if written!=len(manifest['rows']):raise ValueError('Finite whole insert count differs; rollback')
 after=answered_hash(pg)
 if after!=before:raise ValueError('Prior answers changed; rollback')
 return {'status':'inserted' if written else 'already_present_preserved' if existing else 'preflight_ready_no_queue_writes','batch':contract.BATCH,'count':len(manifest['rows']),'inserted':written,'manifest_sha256':expected,'existing_answers_preserved':True,'existing_answered_md5_before':before,'existing_answered_md5_after':after,'model_fits':0,'media_reads':0}

def run(root,expected,insert=False):
 manifest,reserved,holdout=contract.load_contract(root,expected)
 import psycopg
 with psycopg.connect(base.pg_config()) as pg:result=execute(pg,manifest,reserved,holdout,expected,insert)
 immutable_write(Path(root)/'apply-receipts'/f'receipt.{contract.digest(result)}.json',result);print(json.dumps(result));return result

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['preflight','insert']);p.add_argument('--root',type=Path,default=contract.OUT);p.add_argument('--manifest-sha256',required=True);a=p.parse_args();signal.alarm(max(1,math.ceil(contract.MAX_SECONDS-(time.monotonic()-contract.PROCESS_START))));run(a.root,a.manifest_sha256,a.mode=='insert')
