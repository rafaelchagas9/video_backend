"""Disposable metadata-only mixed-kind round guards; no library/database writes."""
import copy,unittest
from unittest.mock import patch
import creator_expansion_v2 as s
import creator_expansion_round_test as fixtures

class MixedRound(unittest.TestCase):
 def setUp(self):
  self.f=fixtures.Expansion();self.f.setUp();self.old=self.f.value();self.receipt={'fixture':True};self.value=s.manifest(self.old,self.f.reserved,self.receipt)
 def tearDown(self):self.f.tearDown()
 def test_copies_all18_contexts_and_individual12_skips(self):
  kept=[r for r in self.old['rows'] if r['context']['selection_role']=='keep_preference'];new=self.value['rows'];self.assertEqual(len(new),18);self.assertEqual(len(self.value['optional_dry_audits']),12)
  self.assertEqual([r['context'] for r in new[:18]],[r['context'] for r in kept]);self.assertTrue(all(r['kind']=='versus' for r in new[:18]))
  for row in self.value['optional_dry_audits']:
   self.assertEqual(row['kind'],'recall-audit');self.assertEqual(row['context']['candidate']['initial_triage_verdict'],'skip');self.assertNotIn('a',row['context']);self.assertNotIn('answer',row);self.assertEqual(row['context']['target_semantics'],'interval_triage_potential');self.assertIsNone(row['context']['cut_target'])
 def test_live_mutation_fails_even_on_replay(self):
  with patch.object(s,'load_legacy',return_value=(self.old,self.f.reserved,self.receipt)):
   s.validate_live(self.value,self.f.rows,self.f.history,self.f.reserved,self.receipt)
   rows=copy.deepcopy(self.f.rows);fid=self.value['rows'][0]['context']['a']['feedback_id'];rows[fid]['model_revision']='other'
   with self.assertRaisesRegex(ValueError,'generation'):s.validate_live(self.value,rows,self.f.history,self.f.reserved,self.receipt)
 def test_metadata_first_excludes_any_reserved_marker_role_or_side(self):
  metadata=[(1,'versus','old',None,{'a':{'channel_key':'safe'},'b':{'channel_key':'held0'}}),(2,'versus','old','safe',{'reserved_fine_holdout':True}),(3,'versus','old','safe',{'fine_data_role':'holdout'}),(4,'versus','old','safe',{'a':{'channel_key':'safe'},'b':{'channel_key':'safe2'}}),(5,'recall-audit','old','held1',{})]
  class Cursor:
   def __init__(self,rows):self.rows=rows
   def fetchall(self):return self.rows
  class Connection:
   def __init__(self):self.calls=[]
   def execute(self,sql,args=()):
    self.calls.append((sql,args))
    if len(self.calls)==1:return Cursor(metadata)
    return Cursor([(4,'a',{'secret':'safe'},None)])
  connection=Connection();history=s.load_history(connection,self.f.reserved)
  self.assertNotIn('answer',connection.calls[0][0]);self.assertNotIn('detail',connection.calls[0][0]);self.assertEqual(connection.calls[1][1],([4],));self.assertTrue(all('answer' not in row for row in history if row['id']!=4))
 def test_no_reserved_outcome_escape_and_individual_duplicate_fails(self):
  reserved=copy.deepcopy(self.old);reserved['rows'][0]['context']['a']['channel_key']='held0'
  with self.assertRaisesRegex(ValueError,'Reserved'):s.manifest(reserved,self.f.reserved,self.receipt)
  audit=self.value['optional_dry_audits'][0];history=self.f.history+[{'id':998,'kind':'recall-audit','batch':'old','channel':audit['channel'],'context':audit['context']}]
  with_optional=copy.deepcopy(self.value);with_optional['rows']+=with_optional['optional_dry_audits']
  with patch.object(s,'load_legacy',return_value=(self.old,self.f.reserved,self.receipt)):
   s.validate_live(self.value,self.f.rows,history,self.f.reserved,self.receipt)
   self.assertTrue(all(r['kind']=='versus' for r in self.value['rows']))

if __name__=='__main__':unittest.main()
