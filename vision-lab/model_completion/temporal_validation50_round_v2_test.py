"""Disposable synthetic only: no actual outcomes, extraction, fits or database."""
import copy,datetime,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import temporal_validation50_round_v2 as b
import temporal_validation50_apply_v2 as apply
import temporal_validation50_intake_v2 as intake
from temporal_validation50_test import record
from temporal_version_round_test import Result


def manifest():
 rows=[record(i,f'g{i//2}') for i in range(50)]
 selection={'policy':b.generator.POLICY,'metric_policy':b.generator.METRIC_POLICY,'status':'ready50_distinct_for_review','selected':rows,'eligible_distinct':50,'selected_creators':25,'all_inventory_sources':67,'agreement_or_unavailable':[],'suppressed':[]}
 request={'generic_control_counts':{'supported':64,'identical':60,'different':4},'records':[]}
 return b.make_manifest(selection,{'reserved'},{'frozen':'holdout'},request,'c'*64,'/private/faces')
def tasks(m,answer='a'):
 return [dict(copy.deepcopy(row),id=2000+i,answer=answer,reasons=[],detail=None,answered_at=None if answer is None else datetime.datetime(2026,10,10,tzinfo=datetime.timezone.utc)) for i,row in enumerate(m['rows'])]
class PG:
 def __init__(self,existing=None,md5=('same','same')):self.existing=existing or [];self.hashes=iter(md5);self.sql=[];self.inserted=0
 def execute(self,sql,params=None):
  self.sql.append(sql)
  if sql.startswith('SELECT md5'):return Result(one=(next(self.hashes),))
  if sql.startswith('SELECT kind,batch,position'):return Result(rows=[tuple(r[k] for k in b.FIELDS) for r in self.existing])
  if sql.startswith('INSERT INTO'):self.inserted+=1;return Result(rowcount=1)
  return Result()

class Tests(unittest.TestCase):
 def test_manifest_balanced_generic_proof_and_private_method(self):
  m=manifest();self.assertEqual(len(m['rows']),50);self.assertEqual(sum(p['assignments']['a']=='new_temporal' for p in m['private_assignments']),25)
  self.assertEqual(m['generic_control_counts']['identical'],60)
  for hidden in ('new_temporal','old_C','known_debug','joint_proxy','face_checkpoint'):
   self.assertNotIn(hidden,str(m['rows']))
 def test_live_generation_drift_historical_pair_repeat_fail_closed(self):
  m=manifest();live={p['source']['feedback_id']:p['source'] for p in m['private_assignments']}
  with patch.object(b.safe.previous,'side',side_effect=lambda r,h:r):
   b.validate_live(m,live,[],{'reserved'},{'frozen':'holdout'})
   changed=copy.deepcopy(live);next(iter(changed.values()))['analyzed_at']='changed'
   with self.assertRaises(ValueError):b.validate_live(m,changed,[],{'reserved'},{'frozen':'holdout'})
   with self.assertRaises(ValueError):b.validate_live(m,live,[dict(m['rows'][0],batch='old')],{'reserved'},{'frozen':'holdout'})
 def test_preference_target_separate_and_partial_counts_only(self):
  m=manifest();t=tasks(m);t[0]['answer']='both';t[1]['answer']='neither';r=intake.checked_answers(t,m)
  self.assertEqual(r['strict_pairs'],48);self.assertEqual(r['no_strict_preference'],1);self.assertEqual(r['abstained'],1)
  for x in r['preference_rows']:self.assertIsNone(x['absolute_y']);self.assertIsNone(x['cut_gold']);self.assertIsNone(x['whole_verdict']);self.assertEqual(x['current_acceptability'],'unknown')
  t[2].update(answer=None,answered_at=None);r=intake.checked_answers(t,m);self.assertEqual(r['pending'],1);self.assertNotIn('preference_rows',r)
 def test_context_viewing_duplicate_ID_and_reserved_tamper(self):
  m=manifest()
  for change in (lambda t:t[0]['context']['a'].update(range=[1,181]),lambda t:t[0].update(id=t[1]['id']),lambda t:t[0].update(detail={'best':{'accepted':True}}),lambda t:t[0]['context'].update(reserved_fine_holdout=True)):
   t=tasks(m);change(t)
   with self.assertRaises(ValueError):intake.checked_answers(t,m)
 def test_reanswers_immutable_content_address_and_full_cluster_evidence(self):
  m=manifest()
  with tempfile.TemporaryDirectory() as root,patch.object(b,'load_contract',return_value=(m,{'reserved'},{})):
   first=intake.intake(root,'a'*64,lambda:tasks(m));again=intake.intake(root,'a'*64,lambda:tasks(m))
   self.assertEqual(first['snapshot_sha256'],again['snapshot_sha256']);self.assertFalse(again['created']);self.assertEqual(Path(first['snapshot_path']).name,f"answers.{first['snapshot_sha256']}.json")
   changed=intake.intake(root,'a'*64,lambda:tasks(m,'b'));self.assertNotEqual(first['snapshot_sha256'],changed['snapshot_sha256']);self.assertTrue(Path(first['snapshot_path']).exists())
   waiting=intake.intake(root,'a'*64,lambda:tasks(m,None));self.assertEqual(waiting['pending'],50);self.assertEqual(len(list((Path(root)/'answer-snapshots').glob('*.json'))),2)
 def test_mock_atomic_insert_preflight_idempotence_MD5_preservation(self):
  m=manifest()
  with patch.object(b,'validate_live'),patch.object(b,'history_metadata',return_value=[]),patch.object(b.safe.previous,'load_rows',return_value={}):
   dry=PG();r=apply.execute(dry,m,{'reserved'},{},'a'*64,False);self.assertEqual(r['inserted'],0);self.assertIn('READ ONLY',dry.sql[0])
   pg=PG();r=apply.execute(pg,m,{'reserved'},{},'a'*64,True);self.assertEqual(r['inserted'],50);self.assertEqual(pg.inserted,50)
   prior=PG(m['rows']);self.assertEqual(apply.execute(prior,m,{'reserved'},{},'a'*64,True)['inserted'],0)
   with self.assertRaises(ValueError):apply.execute(PG(md5=('old','changed')),m,{'reserved'},{},'a'*64,True)
   changed=copy.deepcopy(m['rows']);changed[0]['context']['a']['range']=[0,180]
   with self.assertRaises(ValueError):apply.execute(PG(changed),m,{'reserved'},{},'a'*64,True)

if __name__=='__main__':unittest.main()
