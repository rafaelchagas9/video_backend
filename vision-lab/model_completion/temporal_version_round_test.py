"""Synthetic finite batch / preference contract / mocked SQL transaction checks only."""
import copy,datetime,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import temporal_version_round as b
import temporal_version_round_apply as apply
import temporal_version_round_intake as intake


def selected():
 result=[]
 for i in range(5):
  s={'feedback_id':100+i,'video_id':200+i,'channel':f'Creator{i}','channel_key':f'creator{i}','analyzed_at':'2026-10-10T00:00:00Z','source_fingerprint':{'size_bytes':100+i,'mtime_ns':'123','path_identity_sha256':'a'*64},'index':{'model_revision':'siglip2/so400m-patch16-256','frame_count':241,'interval_seconds':5,'storyboard_generated_at':'frozen','indexed_at':'frozen'},'detector':{'pin':'frozen'},'duration_seconds':1200.,'clip':[0.,1200.],'best':[0.,1200.],'score':.8,'file_name':'private_only'}
  identity={k:s[k] for k in ('video_id','analyzed_at','index','source_fingerprint')};identity.update(duration=1200.,proposals=[{'id':f'p{i}','start':0.,'end':1200.,'score':.8}]);key=b.diagnostic.aux.state.identity_sha256(identity)
  d={'source_key':key,'original_range':[0.,1200.],'control_range':[1020.,1200.],'candidate_range':[200.,380.],'known_debug':i==0,'retained_omitted_joint_points':[{'index':44,'timestamp':220.,'joint_proxy':.8},{'index':48,'timestamp':240.,'joint_proxy':.8}]}
  result.append({'source':s,'numeric_identity':identity,'frame_checkpoint':{'path':f'neutral{i}.npz','sha256':'f'*64,'identity_sha256':key},'diagnostic':d})
 return result


def manifest():return b.make_manifest(selected(),{'reserved'},{'frozen':'holdout'},[])
def tasks(value,answers=('a','b','both','neither','a')):
 return [dict(copy.deepcopy(row),id=1000+i,answer=answers[i],reasons=[],detail=None,answered_at=None if answers[i] is None else datetime.datetime(2026,10,10,tzinfo=datetime.timezone.utc)) for i,row in enumerate(value['rows'])]

class Result:
 def __init__(self,rows=None,one=None,rowcount=0):self.rows=rows or [];self.one=one;self.rowcount=rowcount
 def fetchall(self):return self.rows
 def fetchone(self):return self.one
class PG:
 def __init__(self,existing=None,md5=('unchanged','unchanged')):self.existing=existing or [];self.hashes=iter(md5);self.sql=[];self.inserted=0
 def execute(self,sql,params=None):
  self.sql.append(sql)
  if sql.startswith('SELECT md5'):return Result(one=(next(self.hashes),))
  if sql.startswith('SELECT kind,'):return Result(rows=[tuple(x[k] for k in b.FIELDS) for x in self.existing])
  if sql.startswith('INSERT INTO'):self.inserted+=1;return Result(rowcount=1)
  return Result()

class Tests(unittest.TestCase):
 def test_blind_exact_five_balanced_same_duration_and_roles_private(self):
  m=manifest();self.assertEqual(len(m['rows']),5);self.assertEqual(sum(p['pilot_role']=='posthoc_known_debug' for p in m['private_assignments']),1)
  self.assertEqual(sum(p['assignments']['a']=='temporal_observed_challenger' for p in m['private_assignments']),3)
  public=json.dumps(m['rows'])
  for forbidden in ('temporal_observed_challenger','prior_frozen_control','posthoc_known_debug','retained_omitted_joint_points','private_only'):self.assertNotIn(forbidden,public)
  for row in m['rows']:
   a,c=[row['context'][k] for k in ('a','b')];self.assertEqual(a['range'][1]-a['range'][0],c['range'][1]-c['range'][0]);self.assertEqual(a['preview_windows'],b.versions.previews(a['range']));self.assertEqual(row['context']['cut_target'],None)
 def test_deterministic_reorder_source_and_reserved_bounds(self):
  s=selected();m=b.make_manifest(s,{'reserved'},{'frozen':'holdout'},[]);self.assertEqual(m,b.make_manifest(list(reversed(s)),{'reserved'},{'frozen':'holdout'},[]))
  mutations=[lambda s:s[0]['diagnostic'].update(candidate_range=[210.,380.]),lambda s:s[0]['diagnostic'].update(candidate_range=[1020.,1200.]),lambda s:s[0]['diagnostic']['retained_omitted_joint_points'][0].update(timestamp=1100.),lambda s:s[0]['source'].update(channel_key='reserved')]
  for f in mutations:
   bad=copy.deepcopy(s);f(bad)
   with self.assertRaises(ValueError):b.make_manifest(bad,{'reserved'},{'frozen':'holdout'},[])
 def test_live_exact_identity_drift_and_history_duplicate(self):
  s=selected();m=manifest();live={p['source']['feedback_id']:p['source'] for p in s}
  with patch.object(b,'load_inputs',return_value=(s,{'reserved'},{'frozen':'holdout'},[])),patch.object(b.safe.previous,'side',side_effect=lambda r,h:r):
   b.validate_live(m,live,[],{'reserved'},{'frozen':'holdout'})
   bad=copy.deepcopy(live);next(iter(bad.values()))['analyzed_at']='changed'
   with self.assertRaises(ValueError):b.validate_live(m,bad,[],{'reserved'},{'frozen':'holdout'})
   history=[dict(m['rows'][0],batch='historical')]
   with self.assertRaises(ValueError):b.validate_live(m,live,history,{'reserved'},{'frozen':'holdout'})
 def test_preference_not_acceptance_cut_whole_or_tie_edge(self):
  m=manifest();r=intake.checked_answers(tasks(m),m);self.assertEqual(r['strict_pairs'],3);self.assertEqual(r['no_strict_preference'],1);self.assertEqual(r['abstained'],1)
  for x in r['preference_rows']:self.assertIsNone(x['absolute_y']);self.assertIsNone(x['cut_gold']);self.assertIsNone(x['whole_verdict']);self.assertEqual(x['current_acceptability'],'unknown')
  self.assertFalse(r['automatic_model_promotion'])
 def test_partial_has_only_waiting_counts_and_stale_outcome_rejected(self):
  m=manifest();t=tasks(m,('a',None,'both','neither','a'));r=intake.checked_answers(t,m);self.assertEqual(r['pending'],1);self.assertNotIn('preference_rows',r)
  t[1]['detail']={}
  with self.assertRaises(ValueError):intake.checked_answers(t,m)
 def test_outcome_context_viewing_reserved_and_identity_failclosed(self):
  m=manifest();original=tasks(m)
  mutations=[lambda t:t[0]['context']['a'].update(range=[0,180]),lambda t:t[0].update(id=t[1]['id']),lambda t:t[0].update(detail={'best':{'accepted':True}}),lambda t:t[0].update(detail={'viewing':{'a':{'preview_started':[],'preview_completed':[0],'full_opened':False,'full_completed':False}}}),lambda t:t[0]['context'].update(reserved_fine_holdout=True)]
  for mutate in mutations:
   t=copy.deepcopy(original);mutate(t)
   with self.assertRaises(ValueError):intake.checked_answers(t,m)
 def test_snapshot_reanswer_versions_and_no_partial_snapshot(self):
  m=manifest()
  with tempfile.TemporaryDirectory() as root,patch.object(b,'load_contract',return_value=(m,{'reserved'},{'frozen':'holdout'})):
   first=intake.intake(Path(root),'a'*64,lambda:tasks(m));again=intake.intake(Path(root),'a'*64,lambda:tasks(m));self.assertEqual(first['snapshot_sha256'],again['snapshot_sha256']);self.assertFalse(again['created'])
   self.assertEqual(Path(first['snapshot_path']).name,f"answers.{first['snapshot_sha256']}.json")
   changed=intake.intake(Path(root),'a'*64,lambda:tasks(m,('b','b','both','neither','a')));self.assertNotEqual(first['snapshot_sha256'],changed['snapshot_sha256']);self.assertTrue(Path(first['snapshot_path']).exists())
   wait=intake.intake(Path(root),'a'*64,lambda:tasks(m,(None,None,None,None,None)));self.assertEqual(wait['pending'],5);self.assertEqual(len(list((Path(root)/'answer-snapshots').glob('answers.*.json'))),2)
 def test_mock_apply_preflight_insert_idempotence_and_answer_md5(self):
  m=manifest()
  with patch.object(b,'validate_live'),patch.object(b.safe,'load_history',return_value=[]),patch.object(b.safe.previous,'load_rows',return_value={}):
   dry=PG();r=apply.execute(dry,m,{'reserved'},{},'a'*64,False);self.assertEqual(r['inserted'],0);self.assertIn('READ ONLY',dry.sql[0])
   pg=PG();r=apply.execute(pg,m,{'reserved'},{},'a'*64,True);self.assertEqual(r['inserted'],5);self.assertEqual(pg.inserted,5);self.assertTrue(r['existing_answers_preserved'])
   prior=PG(existing=m['rows']);r=apply.execute(prior,m,{'reserved'},{},'a'*64,True);self.assertEqual(r['inserted'],0);self.assertEqual(prior.inserted,0)
   with self.assertRaises(ValueError):apply.execute(PG(md5=('before','changed')),m,{'reserved'},{},'a'*64,True)
   changed=copy.deepcopy(m['rows']);changed[0]['context']['a']['range']=[1,181]
   with self.assertRaises(ValueError):apply.execute(PG(existing=changed),m,{'reserved'},{},'a'*64,True)

if __name__=='__main__':unittest.main()
