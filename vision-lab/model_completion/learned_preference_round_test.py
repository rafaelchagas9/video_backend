"""Pure synthetic tests; no database, media, answers or holdout files read."""
import copy,unittest
import numpy as np
import learned_preference_round as m
import fine_labels as fl

class Preference(unittest.TestCase):
 def fixture(self):
  rng=np.random.default_rng(12);rows=[]
  for tid in range(12):
   for j,side in enumerate(('a','b')):
    v=rng.normal(size=1152);v/=np.linalg.norm(v);x=rng.normal(size=13);x[0]=1-j
    rows.append({'task_id':tid+1,'side':side,'feedback_id':2*tid+j+1,'video_id':tid+1,'analyzed_at':'generation1','source_fingerprint':{'fixture':True},'index':{'pin':'fixture'},'offered_range':[0.,40.],'original_range':[0.,50.],'start':0.,'end':40.,'group':f'c{tid%6}','features':x.tolist(),'visual_mean':v.tolist(),'answer':'a','ranking_y':1-j,'current_acceptability_y':1,'absolute_y':1,'fine_label_policy':fl.POLICY,'label_target':fl.CURRENT_TARGET,'reserved_fine_holdout':False,'fine_data_role':'training','future_replacement_y':None,'permanent_storage_y':None})
  return rows
 def test_winner_loser_both_accepted_and_portable_parity(self):
  nodes,pairs=m.validated(self.fixture(),set());fit=m.Fit().fit(nodes,pairs)
  for kind in ('visual','numeric'):
   direct=fit.score(nodes,kind);portable=m.portable_score(fit.export(kind),nodes)
   self.assertLess(max(abs(direct[k]-portable[k]) for k in nodes),1e-7)
  self.assertGreater(m.accuracy(list(m.margins(pairs,fit.score(nodes,'numeric')).values())),.8)
 def test_neutral_answers_have_no_ranking_edges(self):
  rows=self.fixture()
  for row in rows[:2]:row.update(answer='both',ranking_y=None)
  for row in rows[2:4]:row.update(answer='neither',ranking_y=None,current_acceptability_y=0,absolute_y=0)
  self.assertEqual(len(m.validated(rows,set())[1]),10)
 def test_reserved_creator_and_marker_rejected_before_fit(self):
  with self.assertRaisesRegex(ValueError,'Reserved creator'):m.validated(self.fixture(),{'c0'})
  rows=self.fixture();rows[0]['reserved_fine_holdout']=True
  with self.assertRaises(fl.ReservedFineHoldoutError):m.validated(rows,set())
 def test_exact_versions_distinct_and_duplicate_side_rejected(self):
  row=self.fixture()[0];changed=copy.deepcopy(row);changed['offered_range']=[1.,40.]
  self.assertNotEqual(m.node_key(row),m.node_key(changed));changed=copy.deepcopy(row);changed['index']['new']=1;self.assertNotEqual(m.node_key(row),m.node_key(changed))
  rows=self.fixture();rows.append(rows[0])
  with self.assertRaisesRegex(ValueError,'Duplicate'):m.validated(rows,set())
 def test_invalid_half_pair_and_nonfinite_visual_rejected(self):
  with self.assertRaisesRegex(ValueError,'Complete'):m.validated(self.fixture()[:-1],set())
  rows=self.fixture();rows[0]['visual_mean'][0]=float('nan')
  with self.assertRaisesRegex(ValueError,'Invalid exact'):m.validated(rows,set())
 def test_cross_fold_excludes_both_participants_before_transform(self):
  rows=self.fixture();rows[1]['group']='held';nodes,pairs=m.validated(rows,set());train=[p for p in pairs if 'held' not in p['creators']];fit=m.Fit().fit(nodes,train)
  self.assertNotIn('held',fit.groups);self.assertNotIn(m.node_key(rows[0]),fit.keys);self.assertNotIn(m.node_key(rows[1]),fit.keys)

 def test_evaluation_guards_answer_direction_and_policy_without_fit_access(self):
  rows=self.fixture();rows[0]['reserved_fine_holdout']=True
  m.validated(rows,{'c0'},for_fit=False)
  rows=self.fixture();rows[0]['ranking_y']=0;rows[1]['ranking_y']=1
  with self.assertRaisesRegex(ValueError,'direction'):m.validated(rows,set(),for_fit=False)
  rows=self.fixture();rows[0]['permanent_storage_y']=1
  with self.assertRaises(fl.FineLabelContractError):m.validated(rows,set(),for_fit=False)

if __name__=='__main__':unittest.main()
