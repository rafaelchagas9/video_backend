"""Five blinded same-length temporal challengers; immutable prepare only, no model work."""
from __future__ import annotations
import argparse,copy,json,random
from pathlib import Path
import blind_version_round as versions
import temporal_face_action_diagnostic as diagnostic
base=versions.base;safe=versions.safe;FIELDS=versions.FIELDS
BATCH='temporal-face-action-20261010-1'
OUT=diagnostic.ROOT/'temporal-version-round-v1'
REPORT_SHA='f2c76fe10c29c4983d32fb5143c509fb20069f02303b83cb15601d2609ede687'
REPORT=diagnostic.OUT/f'report.{REPORT_SHA}.json'
SEED=20261010
POLICY={'schema_version':1,'batch':BATCH,'kind':'version-versus','count':5,'seed':SEED,'diagnostic_report_sha256':REPORT_SHA,'selection':'EXACT five distinct challengers from pinned numeric diagnostic; sixth no-eligible source stays unqueued. No preference-outcome selection.','comparison':'Observed temporal face/action challenger vs exact prior frozen crop, SAME duration, SAME immutable source/proposal. Known source is posthoc debug; four other sources are exploratory diagnostics.','blind':'Neutral Version A/B; method, feature, cluster and debugging tags PRIVATE ONLY. Challenger A3/B2 seeded, order seeded before new answers.','previews':'Uniform15s10/50/90-percent previews plus exact optional full range playback. Duration shown; method blind.','semantics':'A/B means preferred version only; both no strict preference; neither abstention. No acceptance, cut gold, whole verdict, outside quality, expiry or permanent worth inferred.','soft_preferred_minutes':[3,15],'promotion_allowed':False,'global_auxiliary_overlap':True,'queue_writes_during_prepare':0,'fits':0,'media_reads':0,'GPU':False}
canonical=versions.canonical;version_key=versions.version_key


def consumers():
 return {str(Path(__file__).with_name(name).resolve()):base.digest(Path(__file__).with_name(name)) for name in ('temporal_version_round_apply.py','temporal_version_round_intake.py')}


def load_inputs():
 if base.digest(REPORT)!=REPORT_SHA or base.digest(diagnostic.MANIFEST)!=diagnostic.MANIFEST_SHA:raise ValueError('Pinned diagnostic/prospective manifest differs')
 report=json.loads(REPORT.read_text());before_path=diagnostic.OUT/'before-run.json';before=json.loads(before_path.read_text());old=json.loads(diagnostic.MANIFEST.read_text())
 if report['spec_sha256']!=base.digest(before_path) or report['policy']!=diagnostic.POLICY or before['policy']!=diagnostic.POLICY or report.get('fits')!=0 or report.get('queue_writes')!=0 or report.get('production_changed') is not False or report.get('reserved_outcomes_opened') is not False:raise ValueError('Exact completed diagnostic contract required')
 for dep in before['dependencies']:
  p=Path(dep['path'])
  if not p.is_absolute() or not p.is_file() or p.stat().st_size>256*1024 or base.digest(p)!=dep['sha256']:raise ValueError('Frozen diagnostic source dependency differs')
 if len(report['results'])!=6 or len({r['source_key'] for r in report['results']})!=6 or {r['source_key'] for r in report['results']}!={r['source_key'] for r in before['selected']}:raise ValueError('Exact six-source diagnostic inventory required')
 selected=[];original={};numeric_bytes=0
 for p in old['private_assignments']:
  if p['pilot_role']=='model_vs_human':original[diagnostic.aux.state.identity_sha256(p['numeric_identity'])]=p
 for result in report['results']:
  key=result['source_key'];p=original.get(key);planned=next(r for r in before['selected'] if r['source_key']==key)
  if p is None or planned['original_range']!=result['original_range'] or planned['control_range']!=result['control_range'] or planned['known_debug']!=result['known_debug'] or key!=result['numeric_identity_sha256'] or p['frame_checkpoint']!=before['numeric_frames'][key] or result['frame_sha256']!=p['frame_checkpoint']['sha256'] or result['face_checkpoint_sha256']!=before['checkpoints'][key]['sha256']:raise ValueError('Exact diagnostic/source/range/checkpoint join differs')
  if result['candidate_range'] is None:
   if result['status']=='distinct_sampled_episode_challenger':raise ValueError('Missing claimed challenger')
   continue
  if result['status']!='distinct_sampled_episode_challenger' or len(result['retained_omitted_joint_points'])<2 or result['automatic_action'] is not False:raise ValueError('Only genuinely distinct observed challenger required')
  frame_path=Path(p['frame_checkpoint']['path'])
  if not frame_path.is_absolute() or not frame_path.is_file() or frame_path.stat().st_dev!=diagnostic.ROOT.stat().st_dev or frame_path.stat().st_size>64*1024**2:raise ValueError('Exact bounded SSD numeric checkpoint required')
  numeric_bytes+=frame_path.stat().st_size
  if numeric_bytes>128*1024**2:raise ValueError('Bounded numeric dependency bytes exceeded BEFORE read')
  if base.digest(frame_path)!=p['frame_checkpoint']['sha256']:raise ValueError('Exact immutable SSD numeric checkpoint differs')
  selected.append({'diagnostic':result,'source':p['source'],'numeric_identity':p['numeric_identity'],'frame_checkpoint':p['frame_checkpoint']})
 if sum(Path(p['frame_checkpoint']['path']).stat().st_size for p in selected)>128*1024**2:raise ValueError('Bounded pinned numeric dependency bytes exceeded')
 if len(selected)!=5 or sum(p['diagnostic']['known_debug'] for p in selected)!=1 or len({p['source']['channel_key'] for p in selected})!=5:raise ValueError('Exactly5 distinct-source creators,1debug+4diagnostic required')
 reserved,receipt=safe.previous.holdout_contract()
 if old['holdout_dependency']!=receipt or old['excluded_holdout_creators']!=sorted(reserved) or any(p['source']['channel_key'] in reserved for p in selected):raise ValueError('Authoritative reserved dependency differs')
 dependencies=[{'path':str(p.resolve()),'sha256':base.digest(p)} for p in (REPORT,before_path,diagnostic.MANIFEST,Path(__file__),Path(versions.__file__))]
 return selected,reserved,receipt,dependencies


def make_manifest(selected,reserved,receipt,dependencies):
 if len(selected)!=5 or len({x['source']['feedback_id'] for x in selected})!=5 or len({x['source']['channel_key'] for x in selected})!=5:raise ValueError('Exact five distinct source creators required')
 rng=random.Random(SEED);a_choices=[True,True,True,False,False];rng.shuffle(a_choices);pairs=[]
 for p,challenger_a in zip(sorted(selected,key=lambda p:p['diagnostic']['source_key']),a_choices):
  d=p['diagnostic'];s=copy.deepcopy(p['source']);identity=p['numeric_identity'];frame=p['frame_checkpoint'];lo,hi=s['clip'];candidate=d['candidate_range'];control=d['control_range']
  if s['channel_key'] in reserved or any(identity[k]!=s[k] for k in ('video_id','analyzed_at','index','source_fingerprint')) or identity['duration']!=s['duration_seconds'] or frame['identity_sha256']!=diagnostic.aux.state.identity_sha256(identity) or d['source_key']!=frame['identity_sha256'] or d['original_range']!=s['clip']:raise ValueError('Frozen generation/source/creator/proposal differs')
  for bounds in (candidate,control):
   if not isinstance(bounds,list) or len(bounds)!=2 or not all(diagnostic.aux.state.finite_number(x) for x in bounds) or not 0<=lo<=bounds[0]<bounds[1]<=hi<=s['duration_seconds'] or bounds[1]-bounds[0]<180:raise ValueError('Legal same-source version range required')
  if abs((candidate[1]-candidate[0])-(control[1]-control[0]))>1e-8 or abs(candidate[0]-control[0])<30 or diagnostic.iou(candidate,control)>.8:raise ValueError('Exact same-length distinct challenger required')
  anchors=d['retained_omitted_joint_points']
  if len(anchors)<2 or len({a['index'] for a in anchors})!=len(anchors) or any(not candidate[0]<=a['timestamp']<=candidate[1] or control[0]<=a['timestamp']<=control[1] for a in anchors):raise ValueError('Observed omitted joint point evidence differs')
  roles=['temporal_observed_challenger','prior_frozen_control'] if challenger_a else ['prior_frozen_control','temporal_observed_challenger'];ranges=[candidate,control] if challenger_a else [control,candidate]
  sides={k:versions.public_side(s,ranges[i],f'Version {k.upper()}') for i,k in enumerate(('a','b'))}
  context=dict(sides,channel=s['channel'],comparison_scope='same_channel',blind_version_comparison=True,target='preferred_version_if_keep_one',soft_preferred_minutes=[3,15],reserved_fine_holdout=False,fine_data_role='training',batch_policy=BATCH,preview_recipe='uniform10_50_90_centres15s',acceptability_target=None,cut_target=None)
  row={'kind':'version-versus','batch':BATCH,'video_id':s['video_id'],'start_seconds':sides['a']['range'][0],'end_seconds':sides['a']['range'][1],'channel':s['channel'],'stratum':'blind-version','context':context}
  private={'source':s,'numeric_identity':identity,'frame_checkpoint':frame,'source_key':d['source_key'],'pilot_role':'posthoc_known_debug' if d['known_debug'] else 'exploratory_temporal_diagnostic','assignments':dict(zip(('a','b'),roles)),'diagnostic':d}
  pairs.append((row,private))
 rng.shuffle(pairs);rows=[];private=[]
 for position,(row,p) in enumerate(pairs):row['position']=position;rows.append(row);private.append(dict(p,position=position))
 if len({tuple(sorted(version_key(r['context'][k]) for k in ('a','b'))) for r in rows})!=5:raise ValueError('Exact new pair duplicate')
 return {'schema_version':1,'policy':POLICY,'source_sha256':base.digest(Path(__file__)),'consumer_sources':consumers(),'dependencies':dependencies,'holdout_dependency':receipt,'excluded_holdout_creators':sorted(reserved),'rows':rows,'private_assignments':private,'queue_writes':0,'model_fits':0,'media_reads':0,'GPU':False}


def validate_live(value,live,history,reserved,receipt):
 selected,r,dep,dependencies=load_inputs()
 if r!=reserved or dep!=receipt or value!=make_manifest(selected,reserved,receipt,dependencies):raise ValueError('Frozen temporal manifest/source/consumer differs')
 prior=[t for t in history if t['batch']!=BATCH];sources={p['source']['feedback_id']:p['source'] for p in value['private_assignments']}
 if set(live)!=set(sources):raise ValueError('Exact five live source IDs required')
 for fid,s in sources.items():
  if safe.previous.side(live[fid],prior)!=s:raise ValueError('Live source/generation/index/review drift')
 used=versions.history_pairs(prior);seen=set()
 for row in value['rows']:
  pair=tuple(sorted(version_key(row['context'][k]) for k in ('a','b')))
  if pair in used or pair in seen:raise ValueError('Historical/new exact version comparison duplicate')
  seen.add(pair)


def load_contract(root,expected):
 path=Path(root)/'private_manifest.json'
 if not isinstance(expected,str) or len(expected)!=64 or any(c not in '0123456789abcdef' for c in expected) or path.stat().st_size>8*1024**2 or base.digest(path)!=expected:raise ValueError('Exact reviewed temporal manifest checksum required')
 value=json.loads(path.read_text());selected,reserved,receipt,dependencies=load_inputs()
 if value!=make_manifest(selected,reserved,receipt,dependencies):raise ValueError('Immutable temporal manifest or source pins differ')
 return value,reserved,receipt


def prepare(out=OUT):
 import psycopg
 selected,reserved,receipt,deps=load_inputs();value=make_manifest(selected,reserved,receipt,deps);ids=sorted(x['source']['feedback_id'] for x in selected)
 with psycopg.connect(base.pg_config()) as pg:
  pg.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');pg.execute("SET statement_timeout='20s'")
  history=safe.load_history(pg,reserved);live=safe.previous.load_rows(pg,ids);validate_live(value,live,history,reserved,receipt)
 diagnostic.frozen(Path(out)/'private_manifest.json',value);summary={'status':'prepared_no_queue_writes','batch':BATCH,'count':5,'known_debug':1,'other_diagnostic_creators':4,'challenger_A':3,'challenger_B':2,'manifest_sha256':base.digest(Path(out)/'private_manifest.json'),'diagnostic_report_sha256':REPORT_SHA,'model_promotion':False,'fits':0,'media_reads':0}
 diagnostic.frozen(Path(out)/'summary.json',summary);return summary

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--out',type=Path,default=OUT);a=p.parse_args();print(json.dumps(prepare(a.out)))
