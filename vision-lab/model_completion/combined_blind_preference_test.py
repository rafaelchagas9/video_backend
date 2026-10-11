"""Pure adapter/design tests; no real fits, answer files, DB or media."""
import copy,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import combined_blind_preference as s
import learned_preference_round_test as f

class Combined(unittest.TestCase):
 def data(self):
  rows=f.Preference().fixture();old=[]
  for i in range(24):
   for j,key in enumerate(('a','b')):
    row=copy.deepcopy(rows[(i%12)*2+j]);row.update(task_id=i+1,feedback_id=i*2+j+1,video_id=i+1)
    if i>=17:row.update(answer='both',ranking_y=None)
    old.append(row)
  versions=[];rng=np.random.default_rng(32)
  for i,answer in enumerate(('a','b','a','both','a','b')):
   for j,key in enumerate(('a','b')):
    v=rng.normal(size=1152);v/=np.linalg.norm(v);a,b=([0.,1800.] if j==0 else [100.,500.]);versions.append({'row':f'version{i}{key}','task_id':100+i,'side':key,'kind':'version-versus','target':'preferred_version_if_keep_one','answer':answer,'ranking_y':int(key==answer) if answer in ('a','b') else None,'current_acceptability_y':None,'absolute_y':None,'cut_gold':None,'future_replacement':'unknown','permanent_storage_worth':'unknown','reserved_fine_holdout':False,'fine_data_role':'training','group':f'new{i}','channel':f'new{i}','feedback_id':100+i,'video_id':100+i,'analyzed_at':'g','source_fingerprint':{'fixture':True},'index':{'pin':'fixture'},'original_range':[0.,2000.],'offered_range':[a,b],'start':a,'end':b,'features':rng.normal(size=13).tolist(),'visual_mean':v.tolist(),'pilot_role_private':'long_vs_compact' if i<4 else 'equal_duration_control'})
  return {'old_rows':old,'version_rows':versions,'reserved_creators_excluded':['held0','held1','held2','held3']}
 def validated(self,data):
  with patch.object(s,'verify_provenance',return_value=set(data['reserved_creators_excluded'])):return s.validated(data)
 def test_unknown_newlabels_do_not_pass_through_fine_labels(self):
  original=s.old.validated
  def checked(rows,reserved):self.assertTrue(all(r.get('kind')!='version-versus' for r in rows));return original(rows,reserved)
  with patch.object(s.old,'validated',side_effect=checked),patch.object(s.old.PCA,'fit',side_effect=AssertionError('No fits')):
   nodes,pairs,lengths,reserved=self.validated(self.data());self.assertEqual(len(pairs),22);self.assertEqual(sum(p['cohort_kind']=='blind' for p in pairs),5);self.assertEqual(len(lengths),len(nodes))
 def test_fold_excludes_entire_cross_pair_and_duration_hinges_are_soft(self):
  nodes,pairs,lengths,_=self.validated(self.data());held=pairs[0]['creators'][0];self.assertTrue(all(held not in p['creators'] for p in s.training_pairs(pairs,{held})))
  np.testing.assert_array_equal(s.hinges(600),[0,0]);np.testing.assert_allclose(s.hinges(90),[np.log(2),0]);np.testing.assert_allclose(s.hinges(1800),[0,np.log(2)])
  with self.assertRaises(ValueError):s.hinges(0)
 def test_predetermined_hierarchy_requires_B_gate_first(self):
  self.assertIsNone(s.selected_head({'predecessor_vs_numeric':False,'primary_vs_numeric':True,'primary_vs_predecessor':True}));self.assertEqual(s.selected_head({'predecessor_vs_numeric':True,'primary_vs_numeric':True,'primary_vs_predecessor':False}),'predecessor');self.assertEqual(s.selected_head({'predecessor_vs_numeric':True,'primary_vs_numeric':True,'primary_vs_predecessor':True}),'primary')
 def test_primary_control_diagnostic_exact_design_and_portable(self):
  model=s.Fit()
  class Projection:
   def transform(self,V):return V[:,:8]
  model.pca=Projection();X=np.ones((2,13));V=np.ones((2,1152));H=np.ones((2,2));self.assertEqual(model.design(X,V,H,'primary').shape,(2,23));self.assertTrue(np.all(model.design(X,V,H,'numeric')[:,13:]==0));self.assertTrue(np.all(model.design(X,V,H,'predecessor')[:,21:]==0));self.assertTrue(np.all(model.design(X,V,H,'predecessor')[:,13:21]==1))
  head={'bias':1,'numeric_weights':[1]*13,'visual_weights':[0]*1152,'duration_weights':[2,3]};nodes={'x':('c',np.ones(13),np.r_[1,np.zeros(1151)])};self.assertAlmostEqual(s.portable(head,nodes,{'x':90})['x'],14+2*np.log(2))
 def test_reserved_fakeacceptance_and_halfpair_fail_before_any_fit(self):
  for field in ('reserved','acceptance','half','direction'):
   data=self.data()
   if field=='reserved':data['version_rows'][0]['group']='held0'
   elif field=='acceptance':data['version_rows'][0]['current_acceptability_y']=1
   elif field=='half':data['version_rows'].pop()
   else:data['version_rows'][0]['ranking_y']=0
   with self.subTest(field=field),patch.object(s.Fit,'fit',side_effect=AssertionError('No fits')),self.assertRaises(ValueError):self.validated(data)
 def test_authoritative_header_or_old48_mutation_fails_beforefit(self):
  data=self.data();authoritative={'rows':copy.deepcopy(data['old_rows']),'coarse_reserved_groups_excluded':[]}
  with patch.object(s.features,'inputs',return_value=(authoritative,{}, {},set(data['reserved_creators_excluded']))),patch.object(s.Fit,'fit',side_effect=AssertionError('No fits')),self.assertRaisesRegex(ValueError,'Authoritative'):s.verify_provenance(data)
 def test_spec_prepares_withoutfit_and_declares_labels_already_seen(self):
  import json
  with tempfile.TemporaryDirectory() as root:
   path=Path(root)/'cohort.json';path.write_text(json.dumps(self.data()))
   with patch.object(s.Fit,'fit',side_effect=AssertionError('No fits')),patch.object(s,'verify_provenance',return_value=set(self.data()['reserved_creators_excluded'])):spec=s.prepare(path,Path(root)/'out')
   self.assertTrue(spec['labels_seen_before_design']);self.assertEqual(spec['primary'],'numeric13+training_PCA8+two_soft_duration_hinges');self.assertEqual(spec['gate'],s.old.SPEC['gate']);self.assertFalse(spec['production_promotion'])

if __name__=='__main__':unittest.main()
