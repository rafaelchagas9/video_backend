"""Source-only expanded pipeline guards; no real source reads or operations."""
import copy,datetime,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import temporal_validation50_expanded_pipeline as p
import temporal_validation50_expanded_round as b
import temporal_validation50_expanded_apply as apply
import temporal_validation50_expanded_intake as intake
from temporal_validation50_test import record
from temporal_validation50_round_test import PG,tasks


def selection(n=50):
 rows=[]
 for i in range(n):
  r=record(i,f'g{i//2}');r['original_proposal_id']=f'p{i}';r['comparator_stratum']='generic_oldC_without_human_reference' if i>=32 else 'base_manual_reference_oldC';r['face_provenance_key']=('extra:' if i>=32 else 'base:')+r['source_key'];rows.append(r)
 result=p.combine_candidates(rows[:32],rows[32:],[],[],[])
 result.update(total_original_proposals=99,base_root='/private/base',base_request_sha256='a'*64,extra_request_sha256='b'*64,extra_pool_sha256='c'*64,base_face_root='/private/basefaces',extra_face_root='/private/extrafaces',base_face_source_sha256=b.BASE_FACE_SHA,extra_face_source_sha256='d'*64,face_provenance={},excluded_holdout_creators=['reserved'],holdout_dependency={'frozen':'holdout'})
 return result

def manifest():
 m=b.make_manifest(selection(),{'reserved'},{'frozen':'holdout'});m['selection_sha256']='c'*64;return m
class Tests(unittest.TestCase):
 def test_combined_exact50_strata_blind_balance(self):
  m=manifest();self.assertEqual(len(m['rows']),50);self.assertEqual(sum(p['assignments']['a']=='new_temporal' for p in m['private_assignments']),25);self.assertEqual(m['selection_summary']['comparator_counts']['generic_oldC_without_human_reference'],18)
  for hidden in ('generic_oldC','parent_source','new_temporal','comparator_stratum','face_checkpoint'):self.assertNotIn(hidden,str(m['rows']))
 def test_agreements_cannot_force50_or_duplicate_pair(self):
  s=selection(49);self.assertEqual(s['status'],'insufficient_distinct_pairs_no_forcing')
  with self.assertRaises(ValueError):b.make_manifest(s,{'reserved'},{'frozen':'holdout'})
  rows=[record(i,f'g{i}') for i in range(3)];r=p.combine_candidates(rows,[copy.deepcopy(rows[0])],[{'reason':'no_face_unknown'}],[],[]);self.assertEqual(len(r['selected']),3);self.assertEqual(len(r['suppressed']),1);self.assertEqual(len(r['agreement_or_unavailable']),1)
 def test_historical_duplicates_max3_debug_allsource(self):
  rows=[record(i,'same') for i in range(6)];rows[-1]['known_debug']=True
  r=p.combine_candidates(rows,[],[],[],[]);self.assertEqual(len(r['selected']),3);self.assertTrue(r['selected'][0]['known_debug'])
  pair=tuple(sorted(b.versions.version_key(b.versions.public_side(rows[0]['source'],bounds,'Version')) for bounds in (rows[0]['control_range'],rows[0]['diagnostic']['candidate_range'])))
  r=p.combine_candidates(rows[:1],[],[],[],[pair]);self.assertFalse(r['selected'])
 def test_reserved_and_scope_reconstruction_guard(self):
  s=selection();s['selected'][0]['source']['channel_key']='reserved'
  with self.assertRaises(ValueError):b.make_manifest(s,{'reserved'},{'frozen':'holdout'})
 def test_preferences_only_immutable_reanswers_and_pending(self):
  m=manifest()
  with tempfile.TemporaryDirectory() as root,patch.object(b,'load_contract',return_value=(m,{'reserved'},{})):
   first=intake.intake(root,'a'*64,lambda:tasks(m));changed=intake.intake(root,'a'*64,lambda:tasks(m,'b'));self.assertNotEqual(first['snapshot_sha256'],changed['snapshot_sha256']);self.assertTrue(Path(first['snapshot_path']).exists());self.assertEqual(Path(first['snapshot_path']).name,f"answers.{first['snapshot_sha256']}.json")
   wait=intake.intake(root,'a'*64,lambda:tasks(m,None));self.assertEqual(wait['pending'],50)
  r=intake.checked_answers(tasks(m),m)
  self.assertEqual(sum(row['comparator_stratum']=='generic_oldC_without_human_reference' for row in r['preference_rows']),18)
  for row in r['preference_rows']:self.assertIsNone(row['absolute_y']);self.assertIsNone(row['cut_gold']);self.assertIsNone(row['whole_verdict'])
 def test_serializable_exact50_insert_idempotence_existinganswer_MD5(self):
  m=manifest()
  with patch.object(b,'validate_live'),patch.object(b,'history_metadata',return_value=[]),patch.object(b.safe.previous,'load_rows',return_value={}):
   dry=PG();self.assertEqual(apply.execute(dry,m,{'reserved'},{},'a'*64,False)['inserted'],0)
   pg=PG();self.assertEqual(apply.execute(pg,m,{'reserved'},{},'a'*64,True)['inserted'],50)
   existing=PG(m['rows']);self.assertEqual(apply.execute(existing,m,{'reserved'},{},'a'*64,True)['inserted'],0)
   with self.assertRaises(ValueError):apply.execute(PG(md5=('before','changed')),m,{'reserved'},{},'a'*64,True)

if __name__=='__main__':unittest.main()
