"""Finite training-only connected comparison round; dry preparation precedes audited insertion.

Metadata/stat only. No recordings, media/frame decode, model inference or feature-cache writes.
The earlier eight-task generator and its reserved holdout receipt are immutable dependencies.
"""
from __future__ import annotations
import argparse,collections,datetime,itertools,json,math,random
from pathlib import Path
import targeted_label_round as base

BATCH='versus-connected-20261010-1'
SEED=2026101020
OUT=base.LAB/'data/model-completion-20261010/connected-label-round'
HOLDOUT_MANIFEST_SHA='97138b934ec6c586a711c7c99d213c1707e2a36179e1fa1f3c8786be64e79fd3'
COUNT=20
POLICY={'batch':BATCH,'count':COUNT,'seed':SEED,'cross_creator_pairs':12,'same_creator_cross_recording_pairs':8,'graph':'Eight creator anchors: cycle8 plus opposite4; one cross-recording same-creator partner each. Connected; each anchor has four total exposures including history. No unordered pair repeats any earlier task.','role':'Training only. Exclude every previously reserved fine-holdout creator from both sides; existing targeted eight/holdout roles unchanged.','selection':'Confirmed original keeps only; deterministic metadata duration/score coverage, no model outcome or answer winner used for pair selection.','bounds':'Immutable detector original bounds. Initial best exact-generation/source/index validated selected final cut when available, otherwise saved coarse range. No learned cut or four-minute cap.','snippets':'Bounded midpoint15s; no cheap activity receipt accepted without exact provenance, no audio/media content reads.','targets':'Current acceptability plus strict contextual preference, not permanent worth or deletion. Cross-creator task channel is NULL; comparison_scope and both side channels explicit.','safety':'Dry immutable private manifest first; insert only exact reviewed SHA with transactional live generation/source/index/storyboard validation. No new recordings, media reads, cloud, model fits or automatic redraw.'}
COLS=base.COLS+['is_available']
QUERY=base.QUERY.replace('f.label_type FROM','f.label_type,v.is_available FROM')
CANDIDATE_QUERY=QUERY.replace('WHERE f.id=ANY(%s)',"WHERE f.verdict='keep' AND f.label_type='triage' AND f.added=false AND f.merged_into IS NULL AND f.detected_start IS NOT NULL AND r.saved_at IS NOT NULL AND r.analyzed_at=f.analyzed_at AND v.is_available=true")
TASK_COLS=['id','kind','batch','answer','channel','context','detail','answered_at']


def holdout_contract():
 path=base.OUT/'private_manifest.json';receipt=base.OUT/'fine_holdout.json'
 if base.digest(path)!=HOLDOUT_MANIFEST_SHA:raise ValueError('Earlier final manifest checksum changed')
 manifest=json.loads(path.read_text());value=json.loads(receipt.read_text())
 if manifest['source_sha256']!=base.digest(Path(base.__file__)) or value['source_manifest_sha256']!=HOLDOUT_MANIFEST_SHA or value['positions']!=[4,5,6,7] or value['channel_count']!=4 or value['side_count']!=8 or value['channels']!=manifest['holdout_channels']:raise ValueError('Earlier holdout source/receipt changed')
 return {base.canon(x) for x in value['channels']},{'manifest_sha256':HOLDOUT_MANIFEST_SHA,'holdout_receipt_sha256':base.digest(receipt),'generator_sha256':base.digest(Path(base.__file__))}


def load_tasks(connection):
 return [dict(zip(TASK_COLS,row)) for row in connection.execute('SELECT '+','.join(TASK_COLS)+" FROM recording_label_tasks WHERE kind='versus'").fetchall()]


def load_rows(connection,ids=None,lock=False):
 query=CANDIDATE_QUERY if ids is None else QUERY
 if lock:query+=' FOR SHARE OF f,v,r,i,s'
 raw=connection.execute(query,() if ids is None else (ids,)).fetchall()
 return {r['feedback_id']:r for r in (dict(zip(COLS,row)) for row in raw)}


def historical_usage(tasks):
 pairs=set();exposures=collections.Counter()
 for task in tasks:
  context=task.get('context') or {}
  if isinstance(context.get('a'),dict) and isinstance(context.get('b'),dict):
   a,b=context['a'].get('feedback_id'),context['b'].get('feedback_id')
   if isinstance(a,int) and isinstance(b,int):pairs.add(tuple(sorted((a,b))));exposures.update((a,b))
 return pairs,exposures


def side(row,tasks):
 if row.get('is_available') is not True:raise ValueError('Catalog source is unavailable')
 value=base.side(row);channel=base.canon(row['channel'])
 if not channel:raise ValueError('Side creator identity missing')
 value['channel']=row['channel'];value['channel_key']=channel
 refinements=[]
 for task in tasks:
  context=task.get('context') or {};answer=task.get('answer')
  if answer not in ('a','b','both'):continue
  for key in ('a','b'):
   old=context.get(key);cut=(task.get('detail') or {}).get('best',{}).get(key)
   if not isinstance(old,dict) or old.get('feedback_id')!=row['feedback_id'] or answer not in (key,'both') or not isinstance(cut,dict):continue
   # Exact feedback generation/source/index/range, never latest-by-video substitution.
   if any(old.get(k)!=value[k] for k in ('video_id','clip','analyzed_at','source_fingerprint','index')):continue
   prior_channel=old.get('channel_key') or base.canon(old.get('channel') or task.get('channel') or context.get('channel'))
   if prior_channel!=channel:continue
   a,b=cut.get('start_seconds'),cut.get('end_seconds')
   if isinstance(a,bool) or isinstance(b,bool) or not isinstance(cut.get('accepted'),bool):continue
   try:a,b=float(a),float(b)
   except (ValueError,TypeError):continue
   if not math.isfinite(a) or not math.isfinite(b) or not value['clip'][0]<=a<b<=value['clip'][1] or b-a<15:continue
   at=base.stamp(task.get('answered_at'))
   if not at:continue
   try:parsed=datetime.datetime.fromisoformat(at.replace('Z','+00:00'));parsed=parsed.replace(tzinfo=datetime.timezone.utc) if parsed.tzinfo is None else parsed
   except ValueError:continue
   refinements.append((parsed.timestamp(),task['id'],[a,b],at,key,cut['accepted']))
 if refinements:
  _,tid,best,at,key,accepted=max(refinements)
  value['best']=best;value['initial_best_source']='existing_confirmed_final_cut'
  value['final_cut_receipt']={'task_id':tid,'side':key,'answered_at':at,'accepted_offered_edges':accepted}
 a,b=value['best'];mid=(a+b)/2;value['snippet']=[mid-7.5,mid+7.5]
 return value


def candidates(rows,tasks,reserved):
 valid={};rejected=collections.Counter()
 for fid,row in sorted(rows.items()):
  if base.canon(row['channel']) in reserved:rejected['reserved_holdout_creator']+=1;continue
  try:valid[fid]=side(row,tasks)
  except ValueError as error:rejected[str(error)]+=1
 return valid,dict(rejected)


def choose_graph(valid,tasks):
 used,exposure=historical_usage(tasks);by=collections.defaultdict(list)
 for value in valid.values():by[value['channel_key']].append(value)
 options=[]
 for channel,values in sorted(by.items()):
  possible=[]
  for a,b in itertools.product(values,repeat=2):
   pair=tuple(sorted((a['feedback_id'],b['feedback_id'])))
   if a['video_id']==b['video_id'] or exposure[a['feedback_id']] or exposure[b['feedback_id']]>=4 or pair in used:continue
   # Prefer different saved lengths/scores, retaining clip-level rather than creator-only coverage.
   spread=abs(math.log((a['best'][1]-a['best'][0])/(b['best'][1]-b['best'][0])))+abs(a['score']-b['score'])
   possible.append((-spread,exposure[b['feedback_id']],a['feedback_id'],b['feedback_id'],a,b))
  if possible:
   _,_,_,_,a,b=min(possible);options.append((channel,a,b))
 if len(options)<8:raise ValueError('Fewer than eight nonholdout creators with unexposed anchors and playable cross-recording partners')
 # Fixed duration/score strata selection. No observed versus answer used for selection.
 options.sort(key=lambda x:(x[1]['best'][1]-x[1]['best'][0],x[1]['score'],x[0]))
 indices=[round(i*(len(options)-1)/7) for i in range(8)];selected=[options[i] for i in indices]
 # Place two shortest anchors first; graph is cycle plus opposite links regardless of order.
 selected.sort(key=lambda x:(x[1]['best'][1]-x[1]['best'][0],x[0]))
 anchors=[x[1] for x in selected];partners=[x[2] for x in selected]
 cross=[(anchors[i],anchors[(i+1)%8]) for i in range(8)]+[(anchors[i],anchors[i+4]) for i in range(4)]
 same=list(zip(anchors,partners));result=cross[:2]+same[:2]+cross[2:]+same[2:]
 counts=exposure.copy();seen=set()
 for a,b in result:
  pair=tuple(sorted((a['feedback_id'],b['feedback_id'])))
  if pair in seen or pair in used:raise ValueError('Repeated historical/new unordered pair')
  seen.add(pair);counts.update(pair)
 if max(counts[x['feedback_id']] for pair in result for x in pair)>4:raise ValueError('Total clip exposure cap exceeded')
 return result,{'eligible_creator_options':len(options),'creator_count':8,'unique_clips':16,'historical_exposures':{str(x['feedback_id']):exposure[x['feedback_id']] for pair in result for x in pair},'resulting_exposures':{str(x['feedback_id']):counts[x['feedback_id']] for pair in result for x in pair}}


def make_manifest(rows,tasks,reserved,holdout_receipt):
 valid,rejections=candidates(rows,tasks,reserved);pairs,graph=choose_graph(valid,tasks);rng=random.Random(SEED);planned=[]
 for position,(a,b) in enumerate(pairs):
  if rng.random()<.5:a,b=b,a
  scope='same_channel' if a['channel_key']==b['channel_key'] else 'cross_channel';channel=a['channel'] if scope=='same_channel' else None
  context={'a':a,'b':b,'channel':channel,'comparison_scope':scope,'selection':'finite_connected_creator_graph','batch_policy':BATCH,'target_semantics':'current_acceptability_and_strict_preference','cut_target':'final_saved_interval_within_original','reserved_fine_holdout':False,'fine_data_role':'training','randomization_seed':SEED}
  planned.append({'kind':'versus','batch':BATCH,'position':position,'video_id':a['video_id'],'start_seconds':a['best'][0],'end_seconds':a['best'][1],'channel':channel,'stratum':'connected-cross-creator' if scope=='cross_channel' else 'connected-same-creator-cross-recording','context':context})
 return {'schema_version':1,'policy':POLICY,'source_sha256':base.digest(Path(__file__)),'holdout_dependency':holdout_receipt,'excluded_holdout_channels':sorted(reserved),'rows':planned,'graph':graph,'eligibility':{'confirmed_metadata_rows':len(rows),'validated_nonholdout_clips':len(valid),'validated_nonholdout_channels':len({x['channel_key'] for x in valid.values()}),'rejection_counts':rejections},'no_fits_or_new_features':True,'source_reads':'Metadata and stat only; no source/storyboard/audio contents'}


def prepare(out):
 import psycopg
 reserved,receipt=holdout_contract()
 with psycopg.connect(base.pg_config()) as connection:
  connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');connection.execute("SET statement_timeout='15s'")
  manifest=make_manifest(load_rows(connection),load_tasks(connection),reserved,receipt)
 base.save_frozen(out/'private_manifest.json',manifest)
 summary={'status':'prepared_for_review','batch':BATCH,'pairs':20,'cross_creator':12,'same_creator_cross_recording':8,'creators':8,'unique_clips':16,'max_total_exposure':4,'manifest_sha256':base.digest(out/'private_manifest.json'),'eligibility':manifest['eligibility'],'queue_writes':0}
 print(json.dumps(summary))


def validate_live(manifest,rows,tasks,reserved,receipt):
 if manifest['policy']!=POLICY or manifest['source_sha256']!=base.digest(Path(__file__)) or manifest['holdout_dependency']!=receipt or manifest['excluded_holdout_channels']!=sorted(reserved):raise ValueError('Reviewed source/policy/holdout dependency changed')
 current_tasks=[t for t in tasks if t['batch']!=BATCH]
 for row in manifest['rows']:
  for key in ('a','b'):
   wanted=row['context'][key];live=rows.get(wanted['feedback_id'])
   if live is None or base.canon(live['channel']) in reserved or side(live,current_tasks)!=wanted:raise ValueError('Reviewed live source/generation/index/final-cut context changed')
 used,exposure=historical_usage(current_tasks);seen=set()
 for row in manifest['rows']:
  pair=tuple(sorted(row['context'][k]['feedback_id'] for k in ('a','b')))
  if pair in used or pair in seen:raise ValueError('Historical/new unordered pair duplicate')
  seen.add(pair);exposure.update(pair)
 if len(seen)!=20 or any(exposure[fid]>4 for pair in seen for fid in pair):raise ValueError('Finite pair/exposure guard differs')


def insert(out,expected_hash):
 import psycopg
 path=out/'private_manifest.json'
 if base.digest(path)!=expected_hash:raise ValueError('Reviewed connected manifest hash differs')
 manifest=json.loads(path.read_text());reserved,receipt=holdout_contract()
 ids=sorted({row['context'][key]['feedback_id'] for row in manifest['rows'] for key in ('a','b')})
 with psycopg.connect(base.pg_config()) as connection:
  connection.execute("SET statement_timeout='15s'");connection.execute("SET lock_timeout='5s'");connection.execute('LOCK TABLE recording_label_tasks IN SHARE ROW EXCLUSIVE MODE')
  tasks=load_tasks(connection);live=load_rows(connection,ids,lock=True);validate_live(manifest,live,tasks,reserved,receipt)
  columns=['position','video_id','start_seconds','end_seconds','channel','stratum','context']
  existing=[dict(zip(columns,r)) for r in connection.execute('SELECT '+','.join(columns)+" FROM recording_label_tasks WHERE kind='versus' AND batch=%s ORDER BY position",(BATCH,)).fetchall()]
  if existing:
   if len(existing)!=20 or any(any(row[k]!=plan[k] for k in columns) for row,plan in zip(existing,manifest['rows'])):raise ValueError('Existing connected batch differs; preserve answers')
   written=0
  else:
   written=0
   for row in manifest['rows']:
    written+=connection.execute("INSERT INTO recording_label_tasks(kind,batch,video_id,start_seconds,end_seconds,stratum,position,channel,context) VALUES('versus',%s,%s,%s,%s,%s,%s,%s,%s::jsonb)",(BATCH,row['video_id'],row['start_seconds'],row['end_seconds'],row['stratum'],row['position'],row['channel'],json.dumps(row['context'],allow_nan=False))).rowcount
   if written!=20:raise ValueError('Finite connected insertion not exactly20; rollback')
  actual=connection.execute("SELECT count(*),count(*) FILTER(WHERE answer IS NULL) FROM recording_label_tasks WHERE kind='versus' AND batch=%s",(BATCH,)).fetchone()
  if actual[0]!=20:raise ValueError('Connected batch count differs; rollback')
 print(json.dumps({'status':'inserted' if written else 'already_present_preserved','batch':BATCH,'inserted':written,'total':actual[0],'pending':actual[1],'manifest_sha256':expected_hash,'no_new_recordings':True}))

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['prepare','insert']);parser.add_argument('--output',type=Path,default=OUT);parser.add_argument('--manifest-sha256');args=parser.parse_args()
 if args.mode=='prepare':prepare(args.output)
 else:
  if not args.manifest_sha256:parser.error('insert requires exact reviewed --manifest-sha256')
  insert(args.output,args.manifest_sha256)
