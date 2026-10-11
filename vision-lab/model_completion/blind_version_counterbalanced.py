"""Pinned six-task v2 counterbalance; one control side swap, no old globals/artifact changes."""
from __future__ import annotations
import argparse,copy,json
from pathlib import Path
import blind_version_round as previous
base=previous.base
safe=previous.safe
BATCH='blind-version-20261010-2'
OUT=base.LAB/'data/model-completion-20261010/blind-version-counterbalanced'
PREVIOUS_MANIFEST_SHA='f12119225672bc4217a5e37d5185b55805dd64127c6309af37723c517ff22b56'
SWAP_FEEDBACK_ID=331
LONG_IDS=previous.LONG_IDS
CONTROL_IDS=previous.CONTROL_IDS
FIELDS=previous.FIELDS
canonical=previous.canonical
version_key=previous.version_key
POLICY=dict(previous.POLICY,batch=BATCH,counterbalance='Before labels, swap only control331 A/B and neutral labels. Keep other five pair mappings/order/windows. Four long pairs2/2; two controls one human compact A and one B. Pin prior source/manifest; no role disclosure in public context.')


def prior_contract():
 path=previous.OUT/'private_manifest.json'
 if base.digest(path)!=PREVIOUS_MANIFEST_SHA:raise ValueError('Immutable previous blind manifest checksum changed')
 value=json.loads(path.read_text());reserved,receipt=safe.previous.holdout_contract()
 if value['source_sha256']!=base.digest(Path(previous.__file__)) or value['policy']!=previous.POLICY or value['holdout_dependency']!=receipt:raise ValueError('Previous blind source/holdout dependency changed')
 return value,{'manifest_sha256':PREVIOUS_MANIFEST_SHA,'source_sha256':value['source_sha256']}


def make_manifest(sources,reserved,receipt):
 old,dependency=prior_contract()
 if previous.make_manifest(sources,reserved,receipt)!=old:raise ValueError('Six previous blind source generations/ranges/order differ')
 value=copy.deepcopy(old);value.update(source_sha256=base.digest(Path(__file__)),policy=POLICY,previous_blind_dependency=dependency)
 changed=0
 for row,assignment in zip(value['rows'],value['private_assignments']):
  if row['position']!=assignment['position']:raise ValueError('Frozen prior private position differs')
  row['batch']=BATCH;row['context']['batch_policy']=BATCH
  if assignment['feedback_id']==SWAP_FEEDBACK_ID:
   if assignment['pilot_role']!='equal_duration_control':raise ValueError('Only predeclared equal-duration control may swap')
   row['context']['a'],row['context']['b']=row['context']['b'],row['context']['a']
   row['context']['a']['version_label']='Version A';row['context']['b']['version_label']='Version B'
   assignment['assignments']['a'],assignment['assignments']['b']=assignment['assignments']['b'],assignment['assignments']['a']
   row['start_seconds'],row['end_seconds']=row['context']['a']['range'];changed+=1
 if changed!=1:raise ValueError('Exactly one predeclared control swap required')
 controls=[x for x in value['private_assignments'] if x['pilot_role']=='equal_duration_control']
 longs=[x for x in value['private_assignments'] if x['pilot_role']=='long_vs_compact']
 if [sum(x['assignments'][key]=='human_compact' for x in controls) for key in ('a','b')]!=[1,1] or [sum(x['assignments'][key]=='human_compact' for x in longs) for key in ('a','b')]!=[2,2]:raise ValueError('Pre-answer side balance failed')
 return value


def validate_live(value,live,history,reserved,receipt):
 prior=[t for t in history if t['batch']!=BATCH]
 sources={fid:safe.previous.side(live[fid],prior) for fid in LONG_IDS+CONTROL_IDS if fid in live}
 if value!=make_manifest(sources,reserved,receipt):raise ValueError('Counterbalanced source/generation/index/manual range differs')
 used=previous.history_pairs(prior);seen=set()
 for row in value['rows']:
  pair=tuple(sorted(version_key(row['context'][k]) for k in ('a','b')))
  if pair in used or pair in seen:raise ValueError('Historical/new exact version pair duplicate')
  seen.add(pair)


def prepare(out):
 import psycopg
 reserved,receipt=safe.previous.holdout_contract()
 with psycopg.connect(base.pg_config()) as pg:
  pg.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');pg.execute("SET statement_timeout='20s'")
  history=safe.load_history(pg,reserved);live=safe.previous.load_rows(pg,LONG_IDS+CONTROL_IDS);sources={fid:safe.previous.side(r,history) for fid,r in live.items()};value=make_manifest(sources,reserved,receipt);validate_live(value,live,history,reserved,receipt)
 base.save_frozen(out/'private_manifest.json',value);summary=previous.summary(value);summary.update(batch=BATCH,manifest_sha256=base.digest(out/'private_manifest.json'),previous_manifest_sha256=PREVIOUS_MANIFEST_SHA,side_balance={'long_pairs_human_compact_A':2,'long_pairs_human_compact_B':2,'control_pairs_human_compact_A':1,'control_pairs_human_compact_B':1});base.save_frozen(out/'summary.json',summary);print(json.dumps(summary))

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,default=OUT);args=parser.parse_args();prepare(args.output)
