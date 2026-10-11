"""Prospective frozen offered-version preference evaluation; no fitting or live data access."""
from __future__ import annotations
import argparse,copy,hashlib,json,math,os,tempfile
from pathlib import Path
import numpy as np
import offered_span_intake as intake
base=intake.base
ROOT=base.LAB/'data/model-completion-20261010/offered-span-prospective-v2'
MANIFEST_SHA='eec780157b221c592462e3224974c0e8b0e8f30a4f62311a16f81121c1f6be72'
HEAD_SHA='e681be589ec7778c7c09b0273a367012c8ba4278989edde41b576b7fe5495d43'
HEADS=('numeric','predecessor','primary')
ROLES=('model_vs_human','same_duration_location')
COMPARISONS=(('predecessor_vs_numeric','predecessor','numeric'),('primary_vs_numeric','primary','numeric'),('primary_vs_predecessor','primary','predecessor'))
POLICY={'schema_version':1,'target':'preferred_version_if_keep_one','timing':'Metrics policy frozen before first complete-snapshot analysis after at least one user preference/rationale observed; frozen head scores/ranges generated before all new answers. Not outcome-blind preregistration.','user_preference_or_rationale_seen_before_metrics_policy':True,'outcome_blind_preregistration':False,'roles':list(ROLES),'cohorts':'Evaluate roles separately on identical answered comparisons across all three frozen heads. Two roles sharing one creator are not independent creator samples. No pooled performance gate.','prediction':'a if score_a>score_b, b if score_b>score_a, otherwise model tie. Exact score equality only. A model tie on a strict human preference counts as incorrect, never half-credit.','outcomes':'Human a/b strict preference; both tie/no strict preference; neither abstention. Both/neither never become binary acceptability or logistic-loss labels.','denominators':'Report all answered, strict, human ties, abstentions and model ties. Strict accuracy uses strict answers only; strict-correct fraction over all answered is descriptive coverage-adjusted preference support, not total accuracy.','creator_macro':'Average within-creator strict accuracy across creators with at least one strict answer in that role. Report eligible and total creator counts.','paired_bootstrap':{'samples':2000,'seed':42,'unit':'whole creator','quantiles':[.025,.975],'comparisons':[x[0] for x in COMPARISONS],'cohort':'Identical strict comparisons for each head; average per-creator head differences. No strict creator => null gain and interval.'},'selection':'Descriptive prospective result only. No activation threshold, candidate selection, append, refit or reserved-creator outcome access. Report before any future append/refit.','future_training_scope':'Training-role pure preferences only, separately version-versus. No fine_labels/current acceptance/cut/whole/permanent-storage labels.','viewing':'App viewing events are descriptive and do not prove full viewing or attention.','side_roles':'Private assignments identify frozen_primary_best/location versus current_human_approved/endpoint control; public cards remain neutral.','limits':'Eight preselected creators; only one historically fine-unseen. A selected pilot does not establish population generalization or learned cut quality.'}


def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def digest(value):return hashlib.sha256(canonical(value)).hexdigest()
def valid_sha(value):return isinstance(value,str) and len(value)==64 and all(c in '0123456789abcdef' for c in value)

def immutable(path,value):
 data=canonical(value)
 if len(data)>intake.MAX_JSON:raise ValueError('Bounded numerical evaluation artifact required')
 path=Path(path);path.parent.mkdir(parents=True,exist_ok=True,mode=0o700);path.parent.chmod(0o700)
 if path.exists():
  if path.read_bytes()!=data:raise ValueError('Immutable evaluation artifact differs; preserve historical outputs')
  return False
 fd,tmp=tempfile.mkstemp(prefix='.evaluation-',dir=path.parent)
 try:
  with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
  os.chmod(tmp,0o600)
  try:os.link(tmp,path)
  except FileExistsError:
   if path.read_bytes()!=data:raise ValueError('Concurrent immutable evaluation differs')
   return False
  fd=os.open(path.parent,os.O_RDONLY)
  try:os.fsync(fd)
  finally:os.close(fd)
 finally:os.unlink(tmp)
 return True


def contract(root):
 manifest,reserved,holdout=intake.load_contract(root,MANIFEST_SHA)
 heads=[d for d in manifest['dependencies'] if d['role']=='head']
 if len(heads)!=1 or heads[0]['sha256']!=HEAD_SHA or manifest['policy']['head_sha256']!=HEAD_SHA:raise ValueError('Exact frozen head pin required')
 if len(manifest['rows'])!=16 or len(manifest['private_assignments'])!=16 or len({p['source']['channel_key'] for p in manifest['private_assignments']})!=8:raise ValueError('Exact sixteen/eight-creator prospective batch required')
 if any(p['source']['channel_key'] in reserved for p in manifest['private_assignments']):raise ValueError('Reserved creator is not eligible')
 if manifest['policy']['fresh_all_fine_sources']!=1:raise ValueError('Historical-exposure scope changed')
 pins={'manifest_sha256':MANIFEST_SHA,'head_sha256':HEAD_SHA,'evaluator_source_sha256':base.digest(Path(__file__)),'intake_source_sha256':base.digest(Path(intake.__file__)),'generator_source_sha256':manifest['source_sha256'],'consumer_sources':manifest['consumer_sources'],'holdout_dependency':holdout,'dependency_sha256':digest(manifest['dependencies']),'source_policy_sha256':digest(manifest['policy'])}
 return manifest,pins


def prepare(root=ROOT):
 _,pins=contract(root);spec=dict(POLICY,**pins)
 path=Path(root)/'evaluation-policy/before-evaluation.json';immutable(path,spec)
 print(json.dumps({'status':'prepared_before_first_complete_snapshot_analysis','policy_sha256':base.digest(path),'manifest_sha256':MANIFEST_SHA,'fits':0,'DB_queries':0}))
 return spec


def verify_policy(root,pins):
 path=Path(root)/'evaluation-policy/before-evaluation.json'
 if not path.is_file() or path.stat().st_size>intake.MAX_JSON:raise ValueError('Reviewed pre-analysis evaluation policy required')
 actual=json.loads(path.read_text());expected=dict(POLICY,**pins)
 if actual!=expected:raise ValueError('Frozen evaluator/source/policy dependencies changed')
 return actual,base.digest(path)


def checked_snapshot(value,manifest):
 if set(value)!={'schema_version','manifest_sha256','intake_source_sha256','answers'} or value['schema_version']!=1 or value['manifest_sha256']!=MANIFEST_SHA or value['intake_source_sha256']!=base.digest(Path(intake.__file__)):raise ValueError('Exact frozen intake snapshot provenance required')
 payload=value['answers']
 if payload.get('status')!='complete' or not isinstance(payload.get('preference_rows'),list):raise ValueError('Complete snapshot only; no partial outcome analysis')
 plans={intake.key(p):p for p in manifest['rows']};tasks=[]
 for row in payload['preference_rows']:
  key=(row['batch'],row['position'])
  if key not in plans:raise ValueError('Snapshot has an unplanned task')
  task=copy.deepcopy(plans[key]);task.update(id=row['task_id'],answer=row['answer'],answered_at=row['answered_at'],reasons=row['reasons'],detail=None if row['viewing'] is None else {'viewing':row['viewing']});tasks.append(task)
 reconstructed=intake.checked_answers(tasks,manifest)
 if reconstructed!=payload:raise ValueError('Answer/source/range/outcome drift; exact snapshot reconstruction required')
 return payload


def predict(scores):
 if not isinstance(scores,dict) or set(scores)!={'a','b'} or any(isinstance(x,bool) or not isinstance(x,(float,int)) or not math.isfinite(x) for x in scores.values()):raise ValueError('Finite frozen two-side scores required')
 return 'a' if scores['a']>scores['b'] else 'b' if scores['b']>scores['a'] else None


def role_metrics(rows):
 if not rows:raise ValueError('Exact role cohort required')
 if any(not isinstance(r.get('creator'),str) or not r['creator'] or r.get('answer') not in ('a','b','both','neither') or not isinstance(r.get('predictions'),dict) or set(r['predictions'])!=set(HEADS) for r in rows):raise ValueError('Complete pure-preference role rows and three heads required')
 groups=sorted({r['creator'] for r in rows});strict=[r for r in rows if r['answer'] in ('a','b')]
 by={g:[r for r in strict if r['creator']==g] for g in groups};eligible=[g for g in groups if by[g]]
 outcomes={'answered':len(rows),'strict':len(strict),'human_ties':sum(r['answer']=='both' for r in rows),'abstentions':sum(r['answer']=='neither' for r in rows),'creators_total':len(groups),'creators_with_strict':len(eligible)}
 heads={};per_creator={}
 for kind in HEADS:
  predictions=[predict(r['predictions'][kind]) for r in rows];correct=sum(predict(r['predictions'][kind])==r['answer'] for r in strict)
  per_creator[kind]={g:sum(predict(r['predictions'][kind])==r['answer'] for r in by[g])/len(by[g]) for g in eligible}
  heads[kind]={'strict_correct':correct,'strict_accuracy':correct/len(strict) if strict else None,'strict_correct_over_all_answered':correct/len(rows),'creator_macro_strict_accuracy':float(np.mean(list(per_creator[kind].values()))) if eligible else None,'model_ties_all':sum(p is None for p in predictions),'model_ties_strict':sum(predict(r['predictions'][kind]) is None for r in strict)}
 paired={};indices=np.random.default_rng(42).integers(0,len(eligible),size=(2000,len(eligible))) if eligible else None
 for name,a,b in COMPARISONS:
  differences=np.array([per_creator[a][g]-per_creator[b][g] for g in eligible])
  paired[name]={'creator_macro_gain':float(differences.mean()) if eligible else None,'creator_bootstrap_95':np.quantile(differences[indices].mean(1),[.025,.975]).tolist() if eligible else None,'creator_count':len(eligible),'strict_comparisons':len(strict),'identical_head_cohort':True}
 return {'outcomes':outcomes,'heads':heads,'paired':paired}


def analysis(manifest,payload):
 plans={intake.key(p):p for p in manifest['private_assignments']};rows=[]
 for r in payload['preference_rows']:
  p=plans[(r['batch'],r['position'])];group=p['source']['channel_key']
  if group in manifest['excluded_holdout_creators']:raise ValueError('Reserved outcome cannot enter evaluator')
  if r['kind']!='version-versus' or r['current_acceptability']!='unknown' or r['absolute_y'] is not None or r['cut_gold'] is not None or r['permanent_storage_worth']!='unknown':raise ValueError('Pure preference scope required')
  if p['pilot_role'] not in ROLES or set(p['predictions'])!=set(HEADS):raise ValueError('Frozen role/head scope changed')
  if r['a']['channel_key']!=group or r['b']['channel_key']!=group:raise ValueError('Exact shared-source creator required')
  rows.append({'creator':group,'role':p['pilot_role'],'answer':r['answer'],'predictions':p['predictions'],'viewing':r['viewing']})
 roles={role:role_metrics([r for r in rows if r['role']==role]) for role in ROLES}
 if any(v['outcomes']['answered']!=8 or v['outcomes']['creators_total']!=8 for v in roles.values()):raise ValueError('Exact eight-creator role cohorts required')
 role_groups=[{r['creator'] for r in rows if r['role']==role} for role in ROLES]
 telemetry={'metadata_rows':sum(r['viewing'] is not None for r in rows),'preview_starts':0,'preview_completions':0,'full_opened':0,'full_completed':0}
 for row in rows:
  for v in (row['viewing'] or {}).values():
   telemetry['preview_starts']+=len(v['preview_started']);telemetry['preview_completions']+=len(v['preview_completed']);telemetry['full_opened']+=int(v['full_opened']);telemetry['full_completed']+=int(v['full_completed'])
 return {'target':POLICY['target'],'roles':roles,'shared_creators_between_roles':len(role_groups[0]&role_groups[1]),'historically_fine_unseen_creators':manifest['policy']['fresh_all_fine_sources'],'viewing_events_descriptive_only':telemetry,'future_training_role':'pure_version_preference_only','current_acceptability':'not_observed','cut_gold':'not_observed','whole_recording':'not_observed','permanent_storage_worth':'not_observed','fits':0,'reserved_opened':False,'production_changed':False}


def evaluate(root,snapshot_sha):
 if not valid_sha(snapshot_sha):raise ValueError('Exact complete snapshot SHA required')
 manifest,pins=contract(root);spec,policy_sha=verify_policy(root,pins)
 path=Path(root)/'answer-snapshots'/f'answers.{snapshot_sha}.json'
 if not path.is_file() or path.stat().st_size>intake.MAX_JSON or base.digest(path)!=snapshot_sha:raise ValueError('Exact bounded immutable answer snapshot required')
 payload=checked_snapshot(json.loads(path.read_text()),manifest);report=dict(analysis(manifest,payload),schema_version=1,manifest_sha256=MANIFEST_SHA,snapshot_sha256=snapshot_sha,policy_sha256=policy_sha,head_sha256=HEAD_SHA,evaluator_source_sha256=pins['evaluator_source_sha256'],prospective_before_append_or_refit=True)
 report_sha=digest(report);out=Path(root)/'evaluation-reports'/f'report.{snapshot_sha}.{report_sha}.json';immutable(out,report)
 print(json.dumps({'status':'prospective_report_ready','snapshot_sha256':snapshot_sha,'report_sha256':report_sha,'roles':{k:v['outcomes'] for k,v in report['roles'].items()},'fits':0,'production_changed':False}));return report

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['prepare','evaluate']);parser.add_argument('--root',type=Path,default=ROOT);parser.add_argument('--snapshot-sha256');args=parser.parse_args()
 if args.mode=='prepare':prepare(args.root)
 else:evaluate(args.root,args.snapshot_sha256)
