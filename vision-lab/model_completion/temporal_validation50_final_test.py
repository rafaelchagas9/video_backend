"""Synthetic final pre-answer cap5 bridge; no real data/model/DB operations."""
import copy,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import temporal_validation50_final as b
import temporal_validation50_final_apply as apply
import temporal_validation50_final_intake as intake
from temporal_validation50_test import record
from temporal_validation50_round_test import tasks,PG


def records():
 rows=[];i=0
 for g,n in enumerate([1]*16+[2]*6+[3]*4+[6,5]):
  for _ in range(n):
   r=record(i,f'g{g:02}');r.update(original_proposal_id=f'p{i}',face_provenance_key='base:'+r['source_key'],comparator_stratum='base_manual_reference_oldC' if i<45 else 'generic_oldC_without_human_reference');rows.append(r);i+=1
 return rows

def parent():
 return dict(base_root='/private/base',base_request_sha256='a'*64,extra_request_sha256='b'*64,extra_pool_sha256='c'*64,base_face_root='/private/base-face',extra_face_root='/private/extra-face',base_face_source_sha256='d'*64,extra_face_source_sha256='e'*64,face_provenance={},agreement_or_unavailable=[{'reason':'same'}])

def manifest():return b.make_manifest(records(),parent(),{'reserved'},{'frozen':'holdout'})

class Tests(unittest.TestCase):
 def test_same51_creator_cap5_fifty_deterministic_reordering(self):
  r=records();chosen,suppressed,counts=b.select_final(r)
  self.assertEqual((len(r),len(chosen),len(counts),len(suppressed)),(51,50,28,1));self.assertEqual(sorted(counts.values()).count(5),2);self.assertEqual(max(counts.values()),5)
  self.assertEqual(chosen,b.select_final(list(reversed(r)))[0]);self.assertEqual(sum(x['known_debug'] for x in chosen),1)
 def test_no_forced_fill_duplicate_or_extra_debug(self):
  for alter in (lambda r:r.pop(),lambda r:r.append(copy.deepcopy(r[0])),lambda r:r[1].update(known_debug=True),lambda r:r[1].update(source=copy.deepcopy(r[0]['source']))):
   r=records();alter(r)
   with self.assertRaises(ValueError):b.select_final(r)
 def test_manifest_balanced_blind_exact_policies(self):
  m=manifest();self.assertEqual(len(m['rows']),50);self.assertEqual(sum(p['assignments']['a']=='new_temporal' for p in m['private_assignments']),25)
  self.assertEqual(m['selection_summary']['primary_creators'],27);self.assertEqual(m['selection_sha256'],b.PARENT_SELECTION_SHA)
  for hidden in ('new_temporal','old_C','known_debug','joint_proxy','face_checkpoint','comparator_stratum'):self.assertNotIn(hidden,str(m['rows']))
  self.assertEqual(m['policy']['max_comparisons_per_creator'],5);self.assertFalse(m['automatic_model_promotion'])
  with self.assertRaises(ValueError):b.make_manifest(records(),parent(),{'g00'}, {})
 def test_cluster_weight_equal_and_six_exposures_rejected(self):
  r=[dict(creator='a',known_debug=False,outcome='new') for _ in range(5)]+[dict(creator='b',known_debug=False,outcome='old'),dict(creator='debug',known_debug=True,outcome='both')]
  out=b.metrics(r);self.assertEqual(out['primary_creator_macro_net'],0);self.assertEqual(out['primary_creator_macro_strict_win'],.5);self.assertFalse(out['release_signal_passed']);self.assertFalse(out['50_independent_sample_claim'])
  r.insert(0,dict(creator='a',known_debug=False,outcome='new'))
  with self.assertRaises(ValueError):b.metrics(r)
 def test_ties_abstentions_ci_and_debug_gates(self):
  for outcome in ('both','neither'):
   r=[dict(creator=f'g{i}',known_debug=False,outcome=outcome) for i in range(27)]+[dict(creator='debug',known_debug=True,outcome='both')];out=b.metrics(r);self.assertFalse(out['release_signal_passed']);self.assertIsNone(out['primary_creator_macro_strict_win'])
  r=[dict(creator=f'g{i}',known_debug=False,outcome='new') for i in range(27)]+[dict(creator='debug',known_debug=True,outcome='new')];out=b.metrics(r);self.assertEqual(out['creator_cluster_net_ci95'],[1.,1.]);self.assertTrue(out['release_signal_passed']);r[-1]['outcome']='old';self.assertFalse(b.metrics(r)['release_signal_passed'])
 def test_preferences_only_strata_pending_and_context_tamper(self):
  m=manifest();t=tasks(m);t[0]['answer']='both';t[1]['answer']='neither';out=intake.checked_answers(t,m)
  self.assertEqual((out['strict_pairs'],out['no_strict_preference'],out['abstained']),(48,1,1))
  for r in out['preference_rows']:
   self.assertIn(r['comparator_stratum'],('base_manual_reference_oldC','generic_oldC_without_human_reference'));self.assertIsNone(r['absolute_y']);self.assertIsNone(r['cut_gold']);self.assertIsNone(r['whole_verdict']);self.assertEqual(r['current_acceptability'],'unknown')
  t[2].update(answer=None,answered_at=None);out=intake.checked_answers(t,m);self.assertEqual(out['pending'],1);self.assertNotIn('preference_rows',out)
  bad=tasks(m);bad[0]['context']['a']['range']=[1.,181.]
  with self.assertRaises(ValueError):intake.checked_answers(bad,m)
 def test_reanswers_immutable_pending_no_snapshot(self):
  m=manifest()
  with tempfile.TemporaryDirectory() as root,patch.object(b,'load_contract',return_value=(m,{'reserved'},{})):
   first=intake.intake(root,'a'*64,lambda:tasks(m));same=intake.intake(root,'a'*64,lambda:tasks(m));self.assertEqual(first['snapshot_sha256'],same['snapshot_sha256']);self.assertFalse(same['created'])
   changed=intake.intake(root,'a'*64,lambda:tasks(m,'b'));self.assertNotEqual(first['snapshot_sha256'],changed['snapshot_sha256']);self.assertTrue(Path(first['snapshot_path']).exists())
   pending=intake.intake(root,'a'*64,lambda:tasks(m,None));self.assertEqual(pending['pending'],50);self.assertEqual(len(list((Path(root)/'answer-snapshots').glob('*.json'))),2)
 def test_mock_transaction_preflight_insert_idempotence_answer_MD5(self):
  m=manifest()
  with patch.object(b,'validate_live'),patch.object(b,'history_metadata',return_value=[]),patch.object(b.safe.previous,'load_rows',return_value={}):
   dry=PG();self.assertEqual(apply.execute(dry,m,{'reserved'},{},'a'*64,False)['inserted'],0);self.assertIn('READ ONLY',dry.sql[0])
   pg=PG();self.assertEqual(apply.execute(pg,m,{'reserved'},{},'a'*64,True)['inserted'],50);self.assertEqual(pg.inserted,50)
   self.assertEqual(apply.execute(PG(m['rows']),m,{'reserved'},{},'a'*64,True)['inserted'],0)
   with self.assertRaises(ValueError):apply.execute(PG(md5=('old','changed')),m,{'reserved'},{},'a'*64,True)
   bad=copy.deepcopy(m['rows']);bad[0]['context']['a']['range']=[0.,180.]
   with self.assertRaises(ValueError):apply.execute(PG(bad),m,{'reserved'},{},'a'*64,True)

if __name__=='__main__':unittest.main()
