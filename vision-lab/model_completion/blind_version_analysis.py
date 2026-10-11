"""Deterministic complete-six descriptive analysis; no partial outcomes, fits or promotion.

Counts within the frozen pilot only. Preferences do not label acceptance, cuts, permanent
worth or outside quality. Viewing events describe app events, not human attention.
"""
from __future__ import annotations
import argparse,copy,hashlib,json,re,signal
from pathlib import Path
import blind_version_counterbalanced as batch
import blind_version_counterbalanced_intake as intake
MAX_BYTES=1024*1024
PREREG='analysis-preregistered.json'
POLICY={'target':'preferred_version_if_keep_one','long_pairs':4,'equal_duration_control_pairs':2,'analysis':'Counts of compact/full and human-compact/endpoint choices, no strict preference and abstention. No test, fit, threshold/model selection or population claim.','events':'Preview started/completed and full opened/completed are descriptive app events only; missing metadata stays missing, not zero attention.','labels':'No absolute acceptability, cut gold, permanent worth, outside quality, recording-level positives or future replacement inferred.','next':'Any next evidence uses more existing same-source human compact intervals and frozen blind mappings across additional creators; do not treat this6 as deployment evidence.'}


def analyze_payload(manifest,payload):
 if payload.get('status')!='complete' or payload.get('kind')!='version-versus' or payload.get('target')!=POLICY['target']:raise ValueError('Only complete isolated version preference snapshots may be analyzed')
 rows=payload.get('preference_rows')
 if not isinstance(rows,list) or len(rows)!=6 or {r.get('position') for r in rows}!=set(range(6)) or len({r.get('task_id') for r in rows})!=6:raise ValueError('Complete six unique version rows required')
 by={r['position']:r for r in rows};reconstructed=[]
 for plan in manifest['rows']:
  row=by[plan['position']]
  if row['a']!=plan['context']['a'] or row['b']!=plan['context']['b'] or row.get('a_version_identity')!=batch.version_key(row['a']) or row.get('b_version_identity')!=batch.version_key(row['b']):raise ValueError('Frozen public version/source/range/preview differs')
  reconstructed.append(dict(copy.deepcopy(plan),id=row['task_id'],answer=row['answer'],answered_at=row['answered_at'],reasons=row['reasons'],detail=None if row['viewing'] is None else {'viewing':row['viewing']}))
 # Revalidate pure preference/no-label semantics and optional viewing coverage with the pinned intake.
 if intake.checked_answers(reconstructed,manifest)!=payload:raise ValueError('Complete snapshot semantic/intake reconstruction differs')
 assignments={x['position']:x for x in manifest['private_assignments']};outcomes=[];summary={};events={}
 for role in ('long_vs_compact','equal_duration_control'):
  counters={'pairs':0,'human_compact_preferred':0,'long_original_preferred':0,'fixed_endpoint_control_preferred':0,'no_strict_preference':0,'abstained':0};event={'sides_with_viewing_metadata':0,'sides_without_viewing_metadata':0,'preview_started_events':0,'preview_completed_events':0,'full_opened_events':0,'full_completed_events':0}
  for position,row in sorted(by.items()):
   private=assignments[position]
   if private['pilot_role']!=role:continue
   answer=row['answer'];selected=private['assignments'][answer] if answer in ('a','b') else None
   counters['pairs']+=1
   counters[selected+'_preferred' if selected else 'no_strict_preference' if answer=='both' else 'abstained']+=1
   outcomes.append({'position':position,'pilot_role':role,'choice':selected if selected else 'no_strict_preference' if answer=='both' else 'abstained'})
   viewing=row['viewing']
   for key in ('a','b'):
    seen=None if viewing is None else viewing.get(key)
    if seen is None:event['sides_without_viewing_metadata']+=1;continue
    event['sides_with_viewing_metadata']+=1;event['preview_started_events']+=len(seen['preview_started']);event['preview_completed_events']+=len(seen['preview_completed']);event['full_opened_events']+=int(seen['full_opened']);event['full_completed_events']+=int(seen['full_completed'])
  summary[role]=counters;events[role]=event
 if summary['long_vs_compact']['pairs']!=4 or summary['equal_duration_control']['pairs']!=2:raise ValueError('Frozen4/2 role coverage differs')
 return {'schema_version':1,'status':'descriptive_complete','batch':batch.BATCH,'target':POLICY['target'],'summary':summary,'private_pilot_outcomes':sorted(outcomes,key=lambda r:r['position']),'viewing_event_summary':events,'limits':['Four length comparisons and two content controls describe this selected pilot only; no population conclusion or deployment gate.','Length and content differ in long/compact pairs. Same-length controls help describe content preference, not prove quality or density.','Viewing counters are app events, not attention or full-content understanding.','No whole-recording acceptability/positive labels, saved cut gold, outside negativity, permanent worth or replacement labels are created.'],'possible_next_evidence':['If more evidence is needed, collect additional blind same-source full/human-compact pairs on existing recordings across new creators.','Keep same-length content controls and side balance predeclared; preserve ties/abstentions.','Any future cut proposal needs separate human comparison and validation; these manual candidates do not validate a learned boundary model.'],'model_fits':0,'production_writes':0,'media_reads':0,'GPU':False}


def run(root,snapshot_sha):
 if not re.fullmatch('[0-9a-f]{64}',snapshot_sha):raise ValueError('Exact immutable snapshot SHA required')
 prereg=json.loads((root/PREREG).read_text())
 if prereg['source_sha256']!=batch.base.digest(Path(__file__)) or prereg['policy']!=POLICY or prereg['manifest_sha256']!=intake.FINAL_SHA or prereg['intake_source_sha256']!=batch.base.digest(Path(intake.__file__)):raise ValueError('Frozen analysis/source/manifest/intake contract changed')
 manifest,_,_=intake.load_contract(root);path=root/'answer-snapshots'/f'answers.{snapshot_sha}.json'
 if path.stat().st_size>MAX_BYTES or batch.base.digest(path)!=snapshot_sha:raise ValueError('Bounded complete answer snapshot checksum differs')
 value=json.loads(path.read_text())
 if value['schema_version']!=1 or value['manifest_sha256']!=intake.FINAL_SHA or value['intake_source_sha256']!=prereg['intake_source_sha256']:raise ValueError('Isolated snapshot source/manifest differs')
 report=analyze_payload(manifest,value['answers']);report.update(snapshot_sha256=snapshot_sha,manifest_sha256=intake.FINAL_SHA,analysis_source_sha256=prereg['source_sha256'],preregistered_sha256=batch.base.digest(root/PREREG))
 sha=hashlib.sha256(batch.canonical(report)).hexdigest();batch.base.save_frozen(root/'analysis-reports'/f'report.{sha}.json',report)
 print(json.dumps({'status':report['status'],'summary':report['summary'],'viewing_events':report['viewing_event_summary'],'report_sha256':sha,'model_fits':0,'production_writes':0}))
 return report

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=batch.OUT);parser.add_argument('--snapshot-sha256',required=True);args=parser.parse_args();signal.alarm(10);run(args.root,args.snapshot_sha256)
