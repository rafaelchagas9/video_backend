"""Synthetic metadata/graph tests; no fitted model or real data/media access."""
import copy,json,tempfile,unittest
from pathlib import Path
import channel_partial_order as cp
import fine_labels as fl
from fine_labels_test import pair


def fixture(answers):
 tasks=[];private=[];records=[];recordings=[];coarse=[]
 for tid,answer in enumerate(answers,1):
  t,m=pair(tid,answer);t['channel']=f'@CH{tid}';t['answered_at']='2026-10-10T02:00:00';tasks.append(t)
  for side,r in zip(('a','b'),m):
   fid=len(records)+1;vid=r['video_id'];generation='2026-10-08T00:00:00';clip=f'c{fid}'
   r['answered_at']=t['answered_at'];t['context'][side]['feedback_id']=fid
   records.append({'id':fid,'video_id':vid,'clip_id':clip,'channel':f'ch{tid}','analyzed_at':generation,'detected_start':0.,'detected_end':100.,'added':False})
   recordings.append({'video_id':vid,'group':f'coarse{tid}','analyzed_at':generation,'original_proposals':[{'id':clip,'start':0.,'end':100.}]})
   coarse.append({'feedback_id':fid,'video_id':vid,'clip_id':clip,'analyzed_at':generation,'group':f'coarse{tid}'})
  private.extend(m)
 return copy.deepcopy(private),private,{'tasks':tasks,'records':records,'indices':{}},{'recordings':recordings,'rows':coarse}


class PartialOrderTests(unittest.TestCase):
 def test_all_independent_targets_preserved(self):
  receipt,mapping=cp.build(*fixture(['a','b']*4+['both']*10+['neither']*2))
  s=receipt['summary'];self.assertEqual((s['sides'],s['current_acceptability_positive'],s['current_acceptability_negative'],s['ranking_pairs'],s['valid_final_cuts']),(40,36,4,8,28))
  self.assertEqual(len(receipt['strict_preferences']),8);self.assertFalse(receipt['model_trained']);self.assertIsNone(receipt['probabilities']);self.assertFalse(receipt['graph']['total_order_inferred'])
  self.assertEqual(receipt['private_binding_sha256'],cp.digest(mapping))
  self.assertNotIn('channel',receipt['nodes'][0]);self.assertNotIn('video_id',receipt['nodes'][0]);self.assertNotIn('task_id',receipt['observations'][0])
  self.assertTrue(all(x['future_replacement_y'] is None and x['permanent_storage_y'] is None for x in receipt['nodes']))

 def test_sparse_public_rows_bind_only_verified_private_identity(self):
  args=list(fixture(['a']));rich,_=cp.build(*args)
  args[0]=[{k:v for k,v in r.items() if k not in ('video_id','task_id','start','end')} for r in args[0]]
  sparse,_=cp.build(*args)
  self.assertEqual(sparse,rich)

 def test_loser_accepted_without_invented_cut(self):
  receipt,_=cp.build(*fixture(['a']));a,b=receipt['observations']
  self.assertEqual((a['current_acceptability_y'],b['current_acceptability_y']),(1,1));self.assertEqual((a['ranking_y'],b['ranking_y']),(1,0));self.assertIsNone(b['cut_gold']);self.assertFalse(a['cut_gold']['accepted_offered_edges'])
  edge=receipt['strict_preferences'][0];self.assertEqual((edge['winner'],edge['loser']),(a['node'],b['node']))

 def test_both_neither_add_no_ordering_edge(self):
  receipt,_=cp.build(*fixture(['both','neither']));self.assertEqual(receipt['strict_preferences'],[])
  self.assertEqual([o['current_acceptability_y'] for o in receipt['observations']],[1,1,0,0]);self.assertTrue(all(o['ranking_y'] is None for o in receipt['observations']))

 def test_exact_generation_answer_offer_channel_fail_closed(self):
  for kind in ('record_generation','answer_generation','public_offer','channel','coarse_group'):
   args=fixture(['a']);public,private,snapshot,cohort=args
   if kind=='record_generation':cohort['recordings'][0]['analyzed_at']='2026-10-09T00:00:00'
   if kind=='answer_generation':private[0]['answered_at']='2026-10-09T00:00:00'
   if kind=='public_offer':public[0]['start']=11.
   if kind=='channel':snapshot['records'][0]['channel']='other'
   if kind=='coarse_group':public[0]['coarse_group']='wrong'
   with self.subTest(kind=kind),self.assertRaises(fl.FineLabelContractError):cp.build(*args)

 def test_unknown_original_is_preserved_without_invention(self):
  args=fixture(['a']);args[2]['records'][1]['detected_start']=None;args[2]['records'][1]['detected_end']=None
  receipt,_=cp.build(*args);self.assertEqual(receipt['nodes'][1]['original'],[None,None]);self.assertIsNone(receipt['observations'][1]['cut_gold'])

 def test_cycles_unknown_and_crosschannel_edges_fail(self):
  nodes=[{'id':k,'group':'g','current_acceptability_y':1} for k in 'abc']
  edges=[{'winner':'a','loser':'b','group':'g'},{'winner':'b','loser':'c','group':'g'},{'winner':'c','loser':'a','group':'g'}]
  with self.assertRaisesRegex(fl.FineLabelContractError,'cycle'):cp.validate_graph(nodes,edges)
  for edge in ({'winner':'a','loser':'a','group':'g'},{'winner':'a','loser':'unknown','group':'g'},{'winner':'a','loser':'b','group':'wrong'}):
   with self.subTest(edge=edge),self.assertRaises(fl.FineLabelContractError):cp.validate_graph(nodes,[edge])

 def test_repeated_identical_current_contradiction_fails(self):
  args=fixture(['a','neither']);public,private,snapshot,cohort=args
  first=private[0];second=private[2];task=snapshot['tasks'][1];record=snapshot['records'][0]
  task['channel']=snapshot['tasks'][0]['channel'];task['context']['a']['video_id']=record['video_id'];task['context']['a']['feedback_id']=record['id']
  second['video_id']=first['video_id'];second['group']=first['group'];public[2].update(video_id=first['video_id'],group=first['group'])
  with self.assertRaisesRegex(fl.FineLabelContractError,'conflicting current'):cp.build(*args)

 def test_immutable_private_permissions_and_conflict(self):
  with tempfile.TemporaryDirectory() as d:
   file=Path(d)/'private.json';cp.immutable_write(file,{'x':1});self.assertEqual(file.stat().st_mode & 0o777,0o600);cp.immutable_write(file,{'x':1})
   with self.assertRaisesRegex(fl.FineLabelContractError,'Historical'):cp.immutable_write(file,{'x':2})
   self.assertEqual(json.loads(file.read_text()),{'x':1});file.chmod(0o644)
   with self.assertRaisesRegex(fl.FineLabelContractError,'permissions'):cp.immutable_write(file,{'x':1})

if __name__=='__main__':unittest.main()
