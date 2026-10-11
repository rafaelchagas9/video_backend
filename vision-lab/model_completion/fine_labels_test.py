import copy,json,tempfile,unittest
from pathlib import Path
from fine_labels import *
def pair(tid,answer):
 task={'id':tid,'kind':'versus','answer':answer,'context':{s:{'video_id':tid*2+i,'clip':[0,100],'best':[10,90]} for i,s in enumerate(('a','b'))},'detail':{'best':{s:{'start_seconds':20,'end_seconds':80,'accepted':False} for s in ('a','b') if answer in (s,'both')}}}
 meta=[{'row':f'p{tid:03d}{s}','group':f'g{tid}','recording':f'p{tid:03d}','task_id':tid,'video_id':task['context'][s]['video_id'],'start':10,'end':90,'answer':answer,'y':int(answer in (s,'both'))} for s in ('a','b')]
 return task,meta
class FineLabelsTest(unittest.TestCase):
 def test_all_targets_independent(self):
  tasks=[];private=[]
  for i,a in enumerate(['a','b']*4+['both']*10+['neither']*2):
   t,m=pair(i,a);tasks.append(t);private.extend(m)
  rows=annotate_rows(private,private,tasks);s=summary(rows)
  self.assertEqual((s['absolute_sides'],s['absolute_positive'],s['absolute_negative'],s['absolute_unknown']),(40,36,4,0));self.assertEqual((s['ranking_pairs'],s['valid_final_cuts']),(8,28));self.assertEqual(sum(r['y'] for r in rows),36);self.assertEqual(sum(r['legacy_y'] for r in rows),28);self.assertEqual((s['future_replacement_unknown'],s['permanent_storage_unknown']),(40,40))
  self.assertTrue(all(r['cut_gold']['accepted_offered_edges'] is False for r in rows if r['cut_gold']))
 def test_one_sided_loser_is_current_keep_but_never_permanent_or_replacement_label(self):
  t,m=pair(4,'a');rows=annotate_rows(m,m,[t]);winner,loser=rows
  self.assertEqual((winner['absolute_y'],loser['absolute_y']),(1,1))
  self.assertEqual((winner['ranking_y'],loser['ranking_y']),(1,0))
  self.assertEqual(loser['legacy_y'],0);self.assertIsNone(loser['cut_gold'])
  for row in rows:self.assertIsNone(row['future_replacement_y']);self.assertIsNone(row['permanent_storage_y'])
 def test_semantic_freeze_is_immutable_and_policy_specific(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/f'{POLICY}.json';freeze_semantics(p);freeze_semantics(p)
   self.assertEqual(json.loads(p.read_text())['compatibility_absolute_y'],'Compatibility name for current acceptability only.')
   p.write_text('{}')
   with self.assertRaises(FineLabelContractError):freeze_semantics(p)
 def test_public_current_target_and_legacy_provenance_both_verified(self):
  t,m=pair(5,'a');current=absolute_rows(annotate_rows(m,m,[t]));self.assertEqual(len(annotate_rows(current,m,[t])),2)
  current[1]['y']=0
  with self.assertRaises(FineLabelContractError):annotate_rows(current,m,[t])
 def test_fail_closed_provenance(self):
  t,m=pair(1,'a')
  for key,val in [('task_id',99),('video_id',99),('start',11),('side','b'),('answer','both'),('y',0)]:
   bad=copy.deepcopy(m[0]);bad[key]=val
   with self.subTest(key=key),self.assertRaises(FineLabelContractError):contract(bad,t)
  with self.assertRaises(FineLabelContractError):absolute_rows([{'y':0}])
 def test_holdout_and_pair_provenance(self):
  t,m=pair(3,'both')
  for key in ('group','recording'):
   bad=copy.deepcopy(m);bad[0][key]='other'
   with self.subTest(key=key),self.assertRaises(FineLabelContractError):annotate_rows(bad,m,[t])
 def test_one_class_training_and_metrics(self):
  for scope in ('inner training','outer training','absolute metrics'):
   for labels in ([1,1],[0,0],[],[1,None,0]):
    with self.subTest(scope=scope,labels=labels),self.assertRaises(InsufficientAbsoluteLabels):require_binary(labels,scope)
  require_binary([0,1,1])
 def test_saved_false_is_valid_but_outside_is_not(self):
  t,m=pair(2,'a');r=contract(m[0],t);self.assertEqual(r['absolute_y'],1);self.assertEqual(r['ranking_y'],1);self.assertEqual(r['cut_gold']['start_seconds'],20)
  t['detail']['best']['a']['end_seconds']=101
  with self.assertRaises(FineLabelContractError):contract(m[0],t)
if __name__=='__main__':unittest.main()
