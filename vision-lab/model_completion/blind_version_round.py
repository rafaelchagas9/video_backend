"""Six fixed existing-source blind version preferences; prepare only, no media/model work."""
from __future__ import annotations
import argparse,copy,hashlib,json,math,random
from pathlib import Path
import creator_expansion_v2 as safe
base=safe.base
BATCH='blind-version-20261010-1'
OUT=base.LAB/'data/model-completion-20261010/blind-version-round'
SEED=202610106
LONG_IDS=[452,254,686,732]
CONTROL_IDS=[237,331]
POLICY={'batch':BATCH,'kind':'version-versus','count':6,'seed':SEED,'selection':{'long_vs_existing_compact':LONG_IDS,'equal_duration_endpoint_control':CONTROL_IDS},'target':'preferred_version_if_keep_one','preferred_minutes':[3,15],'blind':'Public context omits original score and human/full/control assignment; neither side is called better, saved or dense. Assignments and full source receipts are private.','control':'Same length as existing human compact; select original-bound endpoint window minimizing overlap, earliest start breaks ties; reject exact duplicate. No quality/negativity label.','previews':'Three15s windows centred at10/50/90 percent of each version, shifted inside version bounds. No activity/quality claim.','semantics':'A/B pure preference only. Both means no strict preference, neither means abstention; no acceptability/cut/permanent worth/outside quality inferred.','safety':'New kind isolated from legacy versus collectors. Six nonreserved source generations validated. Dry immutable private preparation; separately reviewed finite apply only. No new recordings/media/GPU/cloud.'}
FIELDS=['kind','batch','position','video_id','start_seconds','end_seconds','channel','stratum','context']


def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def sha(value):return hashlib.sha256(canonical(value)).hexdigest()
def previews(bounds):
 a,b=map(float,bounds)
 if not math.isfinite(a+b) or not 0<=a<b or b-a<15:raise ValueError('Version cannot cover15s preview')
 return [[max(a,min(a+(b-a)*q-7.5,b-15)),max(a,min(a+(b-a)*q-7.5,b-15))+15] for q in (.1,.5,.9)]


def endpoint_control(original,compact):
 a,b=map(float,original);c,d=map(float,compact);length=d-c
 if not a<=c<d<=b or not 180<=length<=900 or b-a<=900:raise ValueError('Control must be a3–15m interval inside long original')
 options=[[a,a+length],[b-length,b]]
 options=[r for r in options if abs(r[0]-c)>.001 or abs(r[1]-d)>.001]
 if not options:raise ValueError('Control exactly duplicates human compact')
 return min(options,key=lambda r:(max(0,min(r[1],d)-max(r[0],c)),r[0]))


def public_side(source,bounds,label):
 return {'video_id':source['video_id'],'feedback_id':source['feedback_id'],'channel':source['channel'],'channel_key':source['channel_key'],'analyzed_at':source['analyzed_at'],'source_fingerprint':source['source_fingerprint'],'index':source['index'],'detector':source['detector'],'duration_seconds':source['duration_seconds'],'original_range':source['clip'],'range':bounds,'clip':source['clip'],'best':bounds,'preview_windows':previews(bounds),'version_label':label}


def version_key(side):
 return sha({k:side[k] for k in ('feedback_id','video_id','channel_key','analyzed_at','source_fingerprint','index','detector','original_range','range')})


def make_manifest(sources,reserved,dependency):
 if set(sources)!=set(LONG_IDS+CONTROL_IDS):raise ValueError('All six fixed sources required')
 rng=random.Random(SEED);pairs=[]
 for fid in LONG_IDS+CONTROL_IDS:
  s=copy.deepcopy(sources[fid]);compact=s['best'];original=s['clip']
  if s['channel_key'] in reserved or original[1]-original[0]<=900 or not 180<=compact[1]-compact[0]<=900:raise ValueError('Fixed candidate no longer meets long/compact/holdout conditions')
  if fid in LONG_IDS:roles=['long_original','human_compact'];bounds=[original,compact];role='long_vs_compact'
  else:roles=['human_compact','fixed_endpoint_control'];bounds=[compact,endpoint_control(original,compact)];role='equal_duration_control'
  if rng.random()<.5:roles.reverse();bounds.reverse()
  sides={k:public_side(s,bounds[i],f'Version {k.upper()}') for i,k in enumerate(('a','b'))}
  if version_key(sides['a'])==version_key(sides['b']):raise ValueError('Exact version duplicate')
  context=dict(sides,channel=s['channel'],comparison_scope='same_channel',blind_version_comparison=True,target='preferred_version_if_keep_one',soft_preferred_minutes=[3,15],reserved_fine_holdout=False,fine_data_role='training',batch_policy=BATCH,preview_recipe='uniform10_50_90_centres15s',acceptability_target=None,cut_target=None)
  pair={'kind':'version-versus','batch':BATCH,'video_id':s['video_id'],'start_seconds':sides['a']['range'][0],'end_seconds':sides['a']['range'][1],'channel':s['channel'],'stratum':'blind-version','context':context}
  pairs.append((pair,{'feedback_id':fid,'pilot_role':role,'source':s,'assignments':dict(zip(('a','b'),roles))}))
 rng.shuffle(pairs);rows=[];assignments=[]
 for position,(row,private) in enumerate(pairs):row['position']=position;rows.append(row);assignments.append(dict(private,position=position))
 if len({r['context']['a']['channel_key'] for r in rows})!=6:raise ValueError('Pilot requires six distinct nonreserved creators')
 return {'schema_version':1,'policy':POLICY,'source_sha256':base.digest(Path(__file__)),'holdout_dependency':dependency,'excluded_holdout_creators':sorted(reserved),'rows':rows,'private_assignments':assignments,'queue_writes':0,'model_fits':0,'media_reads':0,'GPU':False}


def history_pairs(history):
 used=set()
 for task in history:
  if task['kind']!='version-versus':continue
  c=task.get('context') or {}
  if not all(isinstance(c.get(k),dict) for k in ('a','b')):raise ValueError('Existing version task lacks two exact version identities')
  used.add(tuple(sorted(version_key(c[k]) for k in ('a','b'))))
 return used


def validate_live(value,live,history,reserved,receipt):
 if value['policy']!=POLICY or value['source_sha256']!=base.digest(Path(__file__)) or value['holdout_dependency']!=receipt or value['excluded_holdout_creators']!=sorted(reserved):raise ValueError('Blind source/holdout dependency changed')
 prior=[r for r in history if r['batch']!=BATCH];sources={fid:safe.previous.side(live[fid],prior) for fid in LONG_IDS+CONTROL_IDS if fid in live}
 if value!=make_manifest(sources,reserved,receipt):raise ValueError('Frozen blind generation/source/index/manual range/assignment changed')
 used=history_pairs(prior);seen=set()
 for row in value['rows']:
  pair=tuple(sorted(version_key(row['context'][k]) for k in ('a','b')))
  if pair in used or pair in seen:raise ValueError('Historical/new exact version pair duplicate')
  seen.add(pair)


def summary(value):
 rows={r['position']:r for r in value['rows']};roles={}
 for role in ('long_vs_compact','equal_duration_control'):
  selected=[p for p in value['private_assignments'] if p['pilot_role']==role];durations=[(rows[p['position']]['context'][k]['range'][1]-rows[p['position']]['context'][k]['range'][0])/60 for p in selected for k in ('a','b')]
  roles[role]={'pairs':len(selected),'version_minutes_min':round(min(durations),2),'version_minutes_max':round(max(durations),2),'unique_source_bytes':sum(p['source']['source_fingerprint']['size_bytes'] for p in selected)}
 return {'status':'dry_prepared','batch':BATCH,'count':6,'role_summary':roles,'raw_media_read_bytes':0,'new_media_bytes':0,'GPU':False}


def prepare(out):
 import psycopg
 reserved,receipt=safe.previous.holdout_contract()
 with psycopg.connect(base.pg_config()) as connection:
  connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');connection.execute("SET statement_timeout='20s'")
  history=safe.load_history(connection,reserved);live=safe.previous.load_rows(connection,LONG_IDS+CONTROL_IDS);sources={fid:safe.previous.side(row,history) for fid,row in live.items()};value=make_manifest(sources,reserved,receipt);validate_live(value,live,history,reserved,receipt)
 base.save_frozen(out/'private_manifest.json',value);report=summary(value);report['manifest_sha256']=base.digest(out/'private_manifest.json');base.save_frozen(out/'summary.json',report);print(json.dumps(report))

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,default=OUT);args=parser.parse_args();prepare(args.output)
