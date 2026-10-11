"""Dry-only finite creator-diversity comparisons and genuine two-skip audits.

No queue insertion implementation, outcomes assigned, new recordings, media decode or GPU.
Earlier manifests, source generators, answers and reserved evaluation roles remain unchanged.
"""
from __future__ import annotations
import argparse,collections,itertools,json,random
from pathlib import Path
import targeted_label_round as base
import connected_label_round as previous

BATCH='versus-diversity-20261010-1'
SEED=2026101024
OUT=base.LAB/'data/model-completion-20261010/creator-expansion-round'
POLICY={'batch':BATCH,'count':24,'seed':SEED,'keep_preference_pairs':18,'two_skip_audit_pairs':6,'graph':'Twelve fresh creator anchors form a cycle; six links bridge four earlier targeted training creator components and two main connected creators. Prior graph remains part of connectivity receipt.','novelty':'Keep cycle creators absent from all earlier versus creator identities where twelve exist, always exclude the twelve completed new-round training creators and all four reserved creators.','exposures':'New keep anchors at most4 historical+new exposures; six reused bridge anchors at most6. Audit clips at most4. No historical/new unordered pair repeats.','audit':'Every audit starts with TWO genuinely skipped original proposals, never one keep plus one skip. Neutral versus prompt; A/B makes both current candidates, both accepts both, neither rejects both. Answers are never preassigned.','ranges':'Exact generation/source/index/current confirmed review; original detector bounds remain available. Saved final chosen range preferred only when old context source/index/generation matches. No learned cut or arbitrary length cap.','preview':'Bounded midpoint15s, existing sources only; no media reads, activity claims or feature writes.','role':'All24 training only. Reserved four creators excluded globally; no reserved outcomes fetched. Current acceptability/order/selectedcuts remain separate from permanent-storage/whole labels.','stop':'Dry immutable manifest and tests only. No queue implementation or insertion until root reviews current candidate result and exact hash.'}
COLS=previous.COLS
QUERY=previous.QUERY.replace('WHERE f.id=ANY(%s)',"WHERE f.verdict=ANY(%s) AND f.label_type='triage' AND f.added=false AND f.merged_into IS NULL AND f.detected_start IS NOT NULL AND r.saved_at IS NOT NULL AND r.analyzed_at=f.analyzed_at AND v.is_available=true")
TASK_COLS=previous.TASK_COLS


def tasks(connection):
 # Keep pair metadata for dedup/exposure; reserved outcomes never leave PostgreSQL.
 sql="""SELECT id,kind,batch,CASE WHEN context->>'reserved_fine_holdout'='true' THEN NULL ELSE answer END,channel,context,CASE WHEN context->>'reserved_fine_holdout'='true' THEN NULL ELSE detail END,CASE WHEN context->>'reserved_fine_holdout'='true' THEN NULL ELSE answered_at END FROM recording_label_tasks WHERE kind='versus'"""
 return [dict(zip(TASK_COLS,row)) for row in connection.execute(sql).fetchall()]


def creator(task,key):
 ctx=(task.get('context') or {}).get(key) or {}
 return ctx.get('channel_key') or base.canon(ctx.get('channel') or task.get('channel') or (task.get('context') or {}).get('channel'))


def side(row,history):
 if row['verdict'] not in ('keep','skip'):raise ValueError('Only genuine confirmed keep/skip proposals allowed')
 # Frozen helper checks geometry/generation/source/index, not the new task's future answer.
 # Its keep guard is bypassed only for already-skipped audit geometry; explicit provenance stays skip.
 value=previous.side(dict(row,verdict='keep'),history)
 value['initial_triage_verdict']=row['verdict']
 return value


def eligible(rows,history,reserved):
 good={};rejected=collections.Counter()
 for fid,row in sorted(rows.items()):
  if base.canon(row['channel']) in reserved:rejected['reserved_creator']+=1;continue
  try:good[fid]=side(row,history)
  except ValueError as error:rejected[str(error)]+=1
 return good,dict(rejected)


def choose_keep(good,history,training,targeted,main):
 used,exposures=previous.historical_usage(history);known={creator(t,k) for t in history for k in ('a','b')};known.discard('');by=collections.defaultdict(list)
 for value in good.values():
  if value['initial_triage_verdict']=='keep':by[value['channel_key']].append(value)
 fresh=[]
 for channel,values in sorted(by.items()):
  if channel in training or channel in known:continue
  options=[v for v in values if exposures[v['feedback_id']]==0]
  if options:fresh.append(min(options,key=lambda v:(v['best'][1]-v['best'][0],-v['score'],v['feedback_id'])))
 if len(fresh)<12:raise ValueError('Fewer than12 genuinely new playable keep creators; no silent novelty relaxation')
 fresh.sort(key=lambda v:(v['best'][1]-v['best'][0],v['score'],v['channel_key']));selected=[fresh[round(i*(len(fresh)-1)/11)] for i in range(12)]
 selected.sort(key=lambda v:(v['best'][1]-v['best'][0],v['channel_key']))
 old=[]
 for channel in targeted:
  options=[v for v in by[channel] if 0<exposures[v['feedback_id']]<6 and v['initial_best_source']=='existing_confirmed_final_cut']
  if not options:raise ValueError('Earlier targeted training component lacks a playable bridge anchor')
  old.append(min(options,key=lambda v:(v['initial_best_source']!='existing_confirmed_final_cut',exposures[v['feedback_id']],v['best'][1]-v['best'][0],v['feedback_id'])))
 main_options=[]
 for channel in sorted(main):
  options=[v for v in by[channel] if 0<exposures[v['feedback_id']]<6 and v['initial_best_source']=='existing_confirmed_final_cut']
  if options:main_options.append(min(options,key=lambda v:(v['initial_best_source']!='existing_confirmed_final_cut',exposures[v['feedback_id']],v['best'][1]-v['best'][0],v['feedback_id'])))
 if len(main_options)<2:raise ValueError('Main comparison component lacks two playable bridges')
 main_options.sort(key=lambda v:(v['best'][1]-v['best'][0],exposures[v['feedback_id']],v['channel_key']));old+=main_options[:2]
 cycle=[(selected[i],selected[(i+1)%12]) for i in range(12)]
 bridges=[(old[i],selected[i*2]) for i in range(6)]
 result=cycle[:2]+bridges[:2]+cycle[2:]+bridges[2:]
 if any(tuple(sorted((a['feedback_id'],b['feedback_id']))) in used for a,b in result):raise ValueError('Keep pair was already asked')
 return result,{'fresh_keep_creator_candidates':len(fresh),'new_keep_creators':12,'old_bridge_creators':6,'targeted_bridge_creators':list(targeted),'main_bridge_creators':[v['channel_key'] for v in old[4:]],'new_cycle_creators':[v['channel_key'] for v in selected]}


def choose_audits(good,history,used_new,training):
 used,exposures=previous.historical_usage(history);by=collections.defaultdict(list)
 for value in good.values():
  span=value['best'][1]-value['best'][0]
  if value['initial_triage_verdict']=='skip' and exposures[value['feedback_id']]<4 and span>=20:by[value['channel_key']].append(value)
 options=[]
 for channel,values in by.items():options.append(min(values,key=lambda v:(exposures[v['feedback_id']],v['best'][1]-v['best'][0],v['feedback_id'])))
 options.sort(key=lambda v:(v['channel_key'] in training,exposures[v['feedback_id']],v['best'][1]-v['best'][0],v['channel_key']))
 pairs=[];seen_creators=set();seen_clips=set()
 # Distinct creator per audit side where possible; shortest unused candidates first.
 for a,b in itertools.combinations(options,2):
  key=tuple(sorted((a['feedback_id'],b['feedback_id'])))
  if key in used or key in used_new or a['channel_key'] in seen_creators or b['channel_key'] in seen_creators:continue
  pairs.append((a,b));seen_creators.update((a['channel_key'],b['channel_key']));seen_clips.update(key)
  if len(pairs)==6:break
 if len(pairs)!=6:raise ValueError('Six two-skip audits across12 playable creators unavailable; no keep/skip mixing')
 return pairs,{'skip_creator_candidates':len(options),'audit_creator_count':len(seen_creators),'audit_clip_count':len(seen_clips),'maximum_audit_offered_seconds':max(v['best'][1]-v['best'][0] for pair in pairs for v in pair)}


def manifest(rows,history,reserved,dependency,training,targeted,main):
 good,rejected=eligible(rows,history,reserved);preferences,graph=choose_keep(good,history,training,targeted,main)
 used_new={tuple(sorted((a['feedback_id'],b['feedback_id']))) for a,b in preferences};audits,audit_stats=choose_audits(good,history,used_new,training)
 # Two previews first, then interleave each audit after three keep comparisons.
 scheduled=[]
 for i in range(6):scheduled.extend(('keep_preference',pair) for pair in preferences[i*3:(i+1)*3]);scheduled.append(('two_skip_audit',audits[i]))
 used,counts=previous.historical_usage(history);seen=set();rng=random.Random(SEED);planned=[]
 for position,(role,(a,b)) in enumerate(scheduled):
  if rng.random()<.5:a,b=b,a
  pair=tuple(sorted((a['feedback_id'],b['feedback_id'])))
  if pair in seen or pair in used:raise ValueError('Repeated unordered pair')
  seen.add(pair);counts.update(pair)
  for value in (a,b):
   limit=6 if value['channel_key'] in training and role=='keep_preference' else 4
   if counts[value['feedback_id']]>limit:raise ValueError('Declared total exposure cap exceeded')
  if (role=='keep_preference' and {a['initial_triage_verdict'],b['initial_triage_verdict']}!={'keep'}) or (role=='two_skip_audit' and {a['initial_triage_verdict'],b['initial_triage_verdict']}!={'skip'}):raise ValueError('Never mix accepted and skipped candidates')
  scope='same_channel' if a['channel_key']==b['channel_key'] else 'cross_channel';channel=a['channel'] if scope=='same_channel' else None
  context={'a':a,'b':b,'channel':channel,'comparison_scope':scope,'selection_role':role,'selection':'finite_creator_diversity_and_rejection_audit','batch_policy':BATCH,'target_semantics':'current_acceptability_and_strict_preference','cut_target':'final_saved_interval_within_original','reserved_fine_holdout':False,'fine_data_role':'training','randomization_seed':SEED,'future_answers_unassigned':True}
  planned.append({'kind':'versus','batch':BATCH,'position':position,'video_id':a['video_id'],'start_seconds':a['best'][0],'end_seconds':a['best'][1],'channel':channel,'stratum':'creator-diversity' if role=='keep_preference' else 'two-skip-audit','context':context})
 if len(planned)!=24 or any({r['context'][k]['channel_key'] for k in ('a','b')}&reserved for r in planned):raise ValueError('Finite count/reserved guard failed')
 graph['existing_plus_new_components']=connected_components(history,planned,training|set(graph['new_cycle_creators']))
 if graph['existing_plus_new_components']!=1:raise ValueError('Earlier training and new creator graph is disconnected')
 return {'schema_version':1,'policy':POLICY,'source_sha256':base.digest(Path(__file__)),'holdout_dependency':dependency,'excluded_holdout_creators':sorted(reserved),'existing_training_creators':sorted(training),'rows':planned,'graph':graph,'audit':audit_stats,'eligibility':{'metadata_rows':len(rows),'valid_nonreserved_clips':len(good),'valid_nonreserved_creators':len({r['channel_key'] for r in good.values()}),'rejections':rejected},'total_exposures':{str(fid):counts[fid] for pair in seen for fid in pair},'queue_writes':0,'label_assignments':0,'media_reads':0,'GPU':False}


def connected_components(history,planned,creators):
 edges={x:set() for x in creators}
 for task in history+planned:
  a,b=(creator(task,k) for k in ('a','b'))
  if a in edges and b in edges:edges[a].add(b);edges[b].add(a)
 todo=set(edges);count=0
 while todo:
  count+=1;pending=[todo.pop()]
  while pending:
   for value in edges[pending.pop()]&todo:todo.remove(value);pending.append(value)
 return count


def prepare(out):
 import psycopg
 reserved,dependency=previous.holdout_contract();feature_root=base.LAB/'data/model-completion-20261010/new-round-training';training={r['group'] for r in json.loads((feature_root/'feature_cohort.json').read_text())['rows']};targeted=json.loads((base.OUT/'fine_training.json').read_text())['channels'];old=json.loads((previous.OUT/'private_manifest.json').read_text());main={r['context'][k]['channel_key'] for r in old['rows'] for k in ('a','b')}
 if len(training)!=12 or len(targeted)!=4 or len(main)!=8 or set(targeted)&main:raise ValueError('Earlier12 creator split changed')
 with psycopg.connect(base.pg_config()) as connection:
  connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');connection.execute("SET statement_timeout='30s'")
  rows={r['feedback_id']:r for r in (dict(zip(COLS,raw)) for raw in connection.execute(QUERY,(['keep','skip'],)).fetchall())};history=tasks(connection);value=manifest(rows,history,reserved,dependency,training,targeted,main)
 base.save_frozen(out/'private_manifest.json',value)
 summary={'status':'dry_prepared_no_queue_implementation','batch':BATCH,'pairs':24,'keep_preference_pairs':18,'two_skip_audit_pairs':6,'fresh_keep_creator_candidates':value['graph']['fresh_keep_creator_candidates'],'new_keep_creators':12,'old_bridge_creators':6,'audit_creators':value['audit']['audit_creator_count'],'existing_plus_new_components':value['graph']['existing_plus_new_components'],'maximum_audit_offered_seconds':value['audit']['maximum_audit_offered_seconds'],'manifest_sha256':base.digest(out/'private_manifest.json'),'queue_writes':0,'label_assignments':0,'GPU':False};base.save_frozen(out/'summary.json',summary);print(json.dumps(summary))

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,default=OUT);args=parser.parse_args();prepare(args.output)
