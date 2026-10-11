"""Separate finite 18-versus preparation and separate optional12 recall-audit draft; no queue writes.

The rejected 24-versus draft remains byte-for-byte immutable. Metadata is read before
outcomes; any reserved marker/role/either creator excludes the entire historical task.
Recall labels mean interval triage potential, never whole-interval final acceptability.
"""
from __future__ import annotations
import argparse,collections,copy,hashlib,json
from pathlib import Path
import creator_expansion_round as legacy
base=legacy.base
previous=legacy.previous
BATCH='diversity-recall-20261010-2'
OUT=base.LAB/'data/model-completion-20261010/creator-expansion-v2'
LEGACY_SHA='3daf13acd2aa14a32c7b042ae1f889fad5f73f0e5aa5c2e13e2e31e2d1a3669e'
META_FIELDS=['id','kind','batch','channel','context']
POLICY={'batch':BATCH,'count':18,'versus_count':18,'individual_recall_count':0,'optional_dry_recall_count':12,'versus_contexts':'Exact eighteen keep preference contexts copied from immutable rejected24 draft; no rerandomization or changed offered edges.','recall':'Twelve formerly paired genuinely skipped candidates asked individually with keep/skip. Keep means something in this exact offered interval deserves keeping (triage potential), not whole-interval final storage acceptability. No A/B forced double acceptance. No cut target invented.','history':'Metadata first. Exclude entire task before ANY answer/detail fetch for reserved_fine_holdout true, fine_data_role holdout, or either reserved creator. Retain all historical identities as metadata-only dedup/exposure.','graph':'Creator connectivity and exact offered-version strict-preference connectivity are separate. Only observed A/B edges establish order; both/neither cannot bridge components. Prospective comparisons are not observed strict edges.','roles':'Training only; four reserved creators excluded. No reserved outcomes, permanent-storage/replacement labels, model fits, raw media reads or new recordings.','safety':'Private immutable preparation only. Separately reviewed apply transaction required; no queue insertion in this source.'}


def creators(task):
 context=task.get('context') or {};values=[]
 for key in ('a','b','candidate'):
  side=context.get(key)
  if isinstance(side,dict):values.append(side.get('channel_key') or base.canon(side.get('channel') or task.get('channel') or context.get('channel')))
 if not values:values.append(base.canon(task.get('channel') or context.get('channel')))
 return {base.canon(x) for x in values if x}


def outcome_eligible(task,reserved):
 context=task.get('context') or {}
 return context.get('reserved_fine_holdout') not in (True,'true') and context.get('fine_data_role')!='holdout' and not creators(task)&reserved


def load_history(connection,reserved):
 # No outcome/answer-status column appears in this first query.
 raw=connection.execute('SELECT '+','.join(META_FIELDS)+' FROM recording_label_tasks ORDER BY id').fetchall()
 metadata=[dict(zip(META_FIELDS,r)) for r in raw]
 ids=[r['id'] for r in metadata if outcome_eligible(r,reserved)]
 outcomes={}
 if ids:
  for ident,answer,detail,at in connection.execute('SELECT id,answer,detail,answered_at FROM recording_label_tasks WHERE id=ANY(%s)',(ids,)).fetchall():
   if ident not in ids:raise ValueError('Unexpected outcome outside explicitly allowed metadata IDs')
   outcomes[ident]={'answer':answer,'detail':detail,'answered_at':at}
 return [dict(r,**outcomes.get(r['id'],{})) for r in metadata]


def load_legacy():
 path=legacy.OUT/'private_manifest.json'
 if base.digest(path)!=LEGACY_SHA:raise ValueError('Frozen rejected draft checksum changed')
 value=json.loads(path.read_text());reserved,receipt=previous.holdout_contract()
 if value['source_sha256']!=base.digest(Path(legacy.__file__)) or value['policy']!=legacy.POLICY or value['holdout_dependency']!=receipt or value['excluded_holdout_creators']!=sorted(reserved):raise ValueError('Frozen rejected draft dependency changed')
 return value,reserved,receipt


def manifest(old,reserved,dependency):
 if len(old['rows'])!=24:raise ValueError('Frozen draft must have24 positions')
 kept=[copy.deepcopy(r) for r in old['rows'] if r['context']['selection_role']=='keep_preference']
 audits=[(r['position'],key,copy.deepcopy(r['context'][key])) for r in old['rows'] if r['context']['selection_role']=='two_skip_audit' for key in ('a','b')]
 if len(kept)!=18 or len(audits)!=12:raise ValueError('Exactly18 keep-versus and12 single audit sides required')
 planned=[]
 for position,row in enumerate(kept):
  # Context is deliberately unchanged, including its original provenance policy identifier.
  row.update(batch=BATCH,position=position);planned.append(row)
 for i,(old_position,key,side) in enumerate(audits):
  if side['initial_triage_verdict']!='skip':raise ValueError('Audit source was not genuinely skipped')
  context={'candidate':side,'feedback_id':side['feedback_id'],'analyzed_at':side['analyzed_at'],'channel':side['channel'],'selection':'individual_skipped_candidate_recall','selection_role':'individual_recall_audit','target_semantics':'interval_triage_potential','cut_target':None,'reserved_fine_holdout':False,'fine_data_role':'training','batch_policy':BATCH,'origin_draft_position':old_position,'origin_draft_side':key,'future_answers_unassigned':True}
  planned.append({'kind':'recall-audit','batch':BATCH,'position':18+i,'video_id':side['video_id'],'start_seconds':side['best'][0],'end_seconds':side['best'][1],'channel':side['channel'],'stratum':'individual-skipped-recall','context':context})
 for row in planned:
  if creators(row)&reserved or not outcome_eligible(row,reserved):raise ValueError('Reserved creator/role in new round')
 if len({(r['kind'],r['video_id'],r['start_seconds']) for r in planned if r['kind']=='recall-audit'})!=12:raise ValueError('Recall identity repeats')
 audit_rows=planned[18:];planned=planned[:18]
 return {'schema_version':2,'policy':POLICY,'source_sha256':base.digest(Path(__file__)),'legacy_manifest_sha256':LEGACY_SHA,'legacy_source_sha256':old['source_sha256'],'holdout_dependency':dependency,'excluded_holdout_creators':sorted(reserved),'existing_training_creators':old['existing_training_creators'],'rows':planned,'optional_dry_audits':audit_rows,'creator_graph':old['graph'],'audit':{'count':12,'target':'interval_triage_potential','current_acceptability':'not_observed','selected_cut_gold':None},'queue_writes':0,'label_assignments':0,'media_reads':0,'GPU':False}


def validate_live(value,live,history,reserved,receipt):
 if value['policy']!=POLICY or value['source_sha256']!=base.digest(Path(__file__)) or value['holdout_dependency']!=receipt or value['excluded_holdout_creators']!=sorted(reserved):raise ValueError('Reviewed v2 dependency changed')
 old,_,_=load_legacy()
 if value!=manifest(old,reserved,receipt):raise ValueError('Copied frozen context or task geometry changed')
 prior=[r for r in history if r['batch']!=BATCH]
 for row in value['rows']:
  sides=[row['context'][k] for k in ('a','b')] if row['kind']=='versus' else [row['context']['candidate']]
  for wanted in sides:
   actual=live.get(wanted['feedback_id'])
   if actual is None or base.canon(actual['channel']) in reserved or legacy.side(actual,prior)!=wanted:raise ValueError('Live source/generation/index/triage/selected cut changed')
 used,exposure=previous.historical_usage(prior);seen=set();audit_seen=set()
 for task in prior:
  if task['kind']=='recall-audit':
   ctx=task.get('context') or {};side=ctx.get('candidate') or {};fid=side.get('feedback_id') or ctx.get('feedback_id')
   if isinstance(fid,int):audit_seen.add(fid);exposure[fid]+=1
 for row in value['rows']:
  if row['kind']=='versus':
   pair=tuple(sorted(row['context'][k]['feedback_id'] for k in ('a','b')))
   if pair in used or pair in seen:raise ValueError('Historical/new pair duplicate')
   seen.add(pair);exposure.update(pair)
  else:
   fid=row['context']['candidate']['feedback_id']
   if fid in audit_seen:raise ValueError('Skipped audit candidate previously asked individually')
   audit_seen.add(fid);exposure[fid]+=1
 training=set(value['existing_training_creators'])
 for row in value['rows']:
  sides=[row['context'][k] for k in ('a','b')] if row['kind']=='versus' else [row['context']['candidate']]
  for side in sides:
   limit=6 if row['kind']=='versus' and side['channel_key'] in training else 4
   if exposure[side['feedback_id']]>limit:raise ValueError('Total historical+new exposure limit exceeded')


def prepare(out):
 import psycopg
 old,reserved,receipt=load_legacy();value=manifest(old,reserved,receipt)
 ids=sorted({s['feedback_id'] for r in value['rows'] for s in ([r['context'][k] for k in ('a','b')] if r['kind']=='versus' else [r['context']['candidate']])})
 with psycopg.connect(base.pg_config()) as connection:
  connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');connection.execute("SET statement_timeout='20s'")
  history=load_history(connection,reserved);live=previous.load_rows(connection,ids);validate_live(value,live,history,reserved,receipt)
 base.save_frozen(out/'private_manifest.json',value)
 base.save_frozen(out/'optional_interval_audits.json',{'source_manifest_sha256':base.digest(out/'private_manifest.json'),'queue_writes':0,'role':'optional_uninserted_interval_triage_only','rows':value['optional_dry_audits']})
 summary={'status':'dry_prepared','batch':BATCH,'total':18,'versus':18,'optional_uninserted_individual_recall':12,'manifest_sha256':base.digest(out/'private_manifest.json'),'queue_writes':0,'media_reads':0,'GPU':False};base.save_frozen(out/'summary.json',summary);print(json.dumps(summary))

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,default=OUT);args=parser.parse_args();prepare(args.output)
