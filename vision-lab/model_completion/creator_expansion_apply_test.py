"""No live DB/media tests: exact replay, failure-before-write and version connectivity."""
import copy,unittest
from unittest.mock import patch
import creator_expansion_v2_test as fixtures
import creator_expansion_apply as s

class Apply(unittest.TestCase):
 def setUp(self):self.f=fixtures.MixedRound();self.f.setUp();self.value=self.f.value;self.history=self.f.f.history
 def tearDown(self):self.f.tearDown()
 def test_exact_version_not_creator_connectivity_and_no_order(self):
  history=copy.deepcopy(self.history);old=history[0];old['answer']='a';plan=copy.deepcopy(self.value['rows'][:1]);plan[0]['context']['a']=copy.deepcopy(old['context']['a']);plan[0]['context']['b']=copy.deepcopy(old['context']['b'])
  unchanged=s.graph_receipt([old],plan,set());self.assertEqual(len(unchanged['prospective_if_every_new_comparison_is_strict_components']),1)
  plan[0]['context']['a']['best'][0]+=1;changed=s.graph_receipt([old],plan,set());self.assertEqual(len(changed['prospective_if_every_new_comparison_is_strict_components']),1);self.assertEqual(len(changed['nodes']),3);self.assertEqual(len(changed['changed_bridge_versions']),1)
  old['answer']='both';noorder=s.graph_receipt([old],plan,set());self.assertEqual(len(noorder['observed_strict_edges']),0);self.assertEqual(len(noorder['prospective_if_every_new_comparison_is_strict_components']),2);self.assertFalse(noorder['global_order_claim'])
 def test_reserved_or_missing_provenance_cannot_bridge(self):
  history=copy.deepcopy(self.history);history[0]['answer']='a';history[0]['context']['fine_data_role']='holdout';history[1]['context']['a'].pop('index');history[1]['answer']='a'
  out=s.graph_receipt(history,self.value['rows'],self.f.f.reserved);self.assertEqual(out['excluded_reserved_tasks'],1);self.assertEqual(out['missing_full_provenance_historical_pairs'],1);self.assertEqual(len(out['observed_strict_edges']),0)
 def test_existing_exact_answers_preserved_no_updates(self):
  existing=[dict(copy.deepcopy(r),answer='a') for r in self.value['rows']];before=copy.deepcopy(existing);s.existing_match(existing,self.value['rows']);self.assertEqual(existing,before)
  existing[0]['context']['a']['source_fingerprint']['mtime_ns']='changed'
  with self.assertRaisesRegex(ValueError,'differs'):s.existing_match(existing,self.value['rows'])
 def test_wrong_manifest_sha_before_connection(self):
  with self.assertRaisesRegex(ValueError,'checksum'):s.load_contract(self.f.f.fixture.root,'wrong')
 def test_live_drift_fails_before_any_insert(self):
  class Cursor:
   def __init__(self,rows=()):self.rows=rows;self.rowcount=1
   def fetchall(self):return self.rows
  class Connection:
   def __init__(self):self.sql=[]
   def execute(self,sql,args=()):self.sql.append(sql);return Cursor()
  connection=Connection();rows=copy.deepcopy(self.f.f.rows);fid=self.value['rows'][0]['context']['a']['feedback_id'];rows[fid]['verdict']='skip'
  with patch.object(s.batch,'load_history',return_value=self.history),patch.object(s.batch.previous,'load_rows',return_value=rows),patch.object(s.batch,'load_legacy',return_value=(self.f.old,self.f.f.reserved,self.f.receipt)),self.assertRaisesRegex(ValueError,'triage'):
   s.execute_batch(connection,self.value,self.f.f.reserved,self.f.receipt,True)
  self.assertFalse(any('INSERT' in q or 'UPDATE' in q or 'DELETE' in q for q in connection.sql));self.assertTrue(any('pg_advisory_xact_lock' in q for q in connection.sql))

if __name__=='__main__':unittest.main()
