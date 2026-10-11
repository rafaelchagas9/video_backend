"""Synthetic/mock-only checks; no actual exports, PCA, logistic fits or media."""
import copy,unittest
from unittest.mock import patch
import numpy as np
import paired_face_action_preference as f
import paired_face_preference_test as fixtures

def graph():
 nodes,pairs,lengths,faces=fixtures.graph();aux={key:np.linspace(.01,.9,10)+i/1000 for i,key in enumerate(nodes)}
 return nodes,pairs,lengths,faces,aux

def auxiliary_fixture():
 rows,_,receipt,_=fixtures.face_fixture();out=[]
 for i,row in enumerate(rows):
  row['task_id']=i//2;row['side']='a' if i%2==0 else 'b';row['score']=.6;identity=row['numeric_identity'];key=f.base.face.source_key(identity);times=np.array(receipt['sources'][key]['full_timestamps']);indices=f.base.face.sample_indices(times,row['offered_range'])
  out.append({'row':row['row'],'task_id':row['task_id'],'side':row['side'],'node_key':f.base.prior.old.node_key(row),'source_key':key,'original_proposal_id':'clip1','original_range':row['original_range'],'offered_range':row['offered_range'],'features':[.1]*10,'sampled_point_indices':indices,'sampled_timestamps':times[indices].tolist(),'availability':True,'action_proxy_is_truth':False,'labels_created':False})
 artifact={'schema_version':1,'policy':f.auxiliary.POLICY,'parent_cohort_sha256':f.base.COHORT_SHA,'face_report_sha256':f.auxiliary.FACE_REPORT_SHA,'probe_sha256':f.auxiliary.state.PROBE_SHA256,'rows':out,'fits':0,'production_changed':False,'reserved_outcomes_opened':False}
 return rows,artifact,receipt

class Tests(unittest.TestCase):
 def patched_models(self):return (patch.object(f.base.prior.old,'PCA',fixtures.FakePCA),patch.object(f.base.prior.old,'StandardScaler',fixtures.FakeScaler),patch.object(f.base.prior.old,'LogisticRegression',fixtures.FakeLogistic))
 def test_trainfold_only37columns_symmetry_fixedC_and_weights(self):
  nodes,pairs,lengths,faces,aux=graph();train=f.base.training_pairs(pairs,{'g0'});fixtures.FakePCA.fits=[];fixtures.FakeScaler.fits=[];fixtures.FakeLogistic.calls=[];a,b,c=self.patched_models()
  with a,b,c:model=f.Fit().fit(nodes,train,lengths,faces,aux)
  self.assertNotIn('g0',model.groups);self.assertNotIn('node00',model.keys);self.assertEqual(fixtures.FakePCA.fits[0].shape,(14,1152));self.assertEqual(fixtures.FakeScaler.fits[0].shape,(14,37));self.assertEqual(len(fixtures.FakeLogistic.calls),3)
  for kwargs,z,y,w in fixtures.FakeLogistic.calls:
   self.assertEqual(kwargs['C'],1);self.assertEqual(kwargs['random_state'],42);self.assertFalse(kwargs['fit_intercept']);np.testing.assert_array_equal(z[:7],-z[7:]);np.testing.assert_array_equal(w[:7]+w[7:],np.ones(7));np.testing.assert_array_equal(y,np.r_[np.ones(7),np.zeros(7)])
 def test_matched_masks_and_export_score_parity(self):
  nodes,pairs,lengths,faces,aux=graph();a,b,c=self.patched_models()
  with a,b,c:model=f.Fit().fit(nodes,pairs,lengths,faces,aux)
  X=np.stack([n[1] for n in nodes.values()]);V=np.stack([n[2] for n in nodes.values()]);H=np.stack([f.base.prior.hinges(x) for x in lengths.values()]);F=np.stack(list(faces.values()));A=np.stack(list(aux.values()));e=model.design(X,V,H,F,A,'joint');d=model.design(X,V,H,F,A,'face');cc=model.design(X,V,H,F,A,'duration')
  np.testing.assert_array_equal(e[:,:27],d[:,:27]);np.testing.assert_array_equal(e[:,:23],cc[:,:23]);self.assertTrue(np.all(d[:,27:]==0));self.assertTrue(np.all(cc[:,23:]==0))
  for kind in f.KINDS:
   h=model.export(kind);direct=model.score(nodes,lengths,faces,aux,kind);got=f.portable(h,nodes,lengths,faces,aux);np.testing.assert_allclose(list(direct.values()),list(got.values()),atol=1e-12,rtol=0);self.assertFalse(h['production_usable']);self.assertFalse(h['promotion_allowed'])
   if kind!='joint':self.assertEqual(h['auxiliary_weights'],[0]*10)
   if kind=='duration':self.assertEqual(h['face_weights'],[0]*4)
 def test_strict_exploratory_scope_even_if_accuracy_perfect(self):
  self.assertFalse(f.SPEC['selection_allowed']);self.assertIsNone(f.SPEC['selected_head']);self.assertFalse(f.SPEC['production_promotion']);self.assertIn('NOT excluded',f.SPEC['supervised_overlap']);self.assertIn('NOT outcome-blind',f.SPEC['timing']);self.assertFalse(f.SPEC['hard_face_or_action_requirement']);self.assertEqual(f.SPEC['counts']['subsets'],[17,5,5,5])
 def test_crosspair_wholecreator_exclusion(self):
  pairs=[{'creators':['a','b']},{'creators':['b','c']},{'creators':['c','d']}];self.assertEqual(f.base.training_pairs(pairs,{'b'}),pairs[2:])
 def test_exact_aux_source_range_point_join_and_legacy_proposal_derivation(self):
  rows,artifact,receipt=auxiliary_fixture()
  with patch.object(f.auxiliary,'FEATURE_NAMES',f.auxiliary.state.FEATURE_NAMES+f.JOINT_NAMES):got=f.join_aux(rows,artifact,receipt)
  self.assertEqual(len(got),2);self.assertNotIn('original_proposal_id',rows[0]);self.assertEqual(f.unique_proposal(rows[0]),'clip1')
 def test_aux_missing_wrongsource_timestamp_nan_or_label_rejected(self):
  for changed in ['missing','source','time','feature','availability','labels','extra','proposal']:
   rows,artifact,receipt=auxiliary_fixture();r=artifact['rows'][0]
   if changed=='missing':artifact['rows'].pop()
   elif changed=='source':r['source_key']='wrong'
   elif changed=='time':r['sampled_timestamps'][0]+=.1
   elif changed=='feature':r['features'][9]=float('nan')
   elif changed=='availability':r['availability']=False
   elif changed=='labels':r['labels_created']=True
   elif changed=='extra':r['acceptability_y']=1
   else:r['original_proposal_id']='changed'
   with patch.object(f.auxiliary,'FEATURE_NAMES',f.auxiliary.state.FEATURE_NAMES+f.JOINT_NAMES):
    with self.assertRaises(ValueError,msg=changed):f.join_aux(rows,artifact,receipt)
 def test_mean_instead_of_max_joint_contract_rejected(self):
  rows,artifact,receipt=auxiliary_fixture()
  with patch.object(f.auxiliary,'FEATURE_NAMES',f.auxiliary.state.FEATURE_NAMES+['sampled_face_detected_x_action_proxy_mean','sampled_face_confidence_x_action_proxy_mean']):
   with self.assertRaises(ValueError):f.join_aux(rows,artifact,receipt)
 def test_unknown_or_duplicate_original_proposal_rejected(self):
  rows,_,_=auxiliary_fixture();row=rows[0];row['original_proposal_id']='changed'
  with self.assertRaises(ValueError):f.unique_proposal(row)
  row.pop('original_proposal_id');row['numeric_identity']['proposals'].append(copy.deepcopy(row['numeric_identity']['proposals'][0]))
  with self.assertRaises(ValueError):f.unique_proposal(row)
 def test_diagnostic_portable_rejects_production_flag_nan_boolean_or_shape(self):
  nodes,pairs,lengths,faces,aux=graph();a,b,c=self.patched_models()
  with a,b,c:model=f.Fit().fit(nodes,pairs,lengths,faces,aux)
  good=model.export('joint')
  for k,v in [('production_usable',True),('promotion_allowed',True),('bias',float('nan')),('auxiliary_weights',[0]*9),('face_weights',[True,0,0,0])]:
   bad=copy.deepcopy(good);bad[k]=v
   with self.assertRaises(ValueError):f.portable(bad,nodes,lengths,faces,aux)
if __name__=='__main__':unittest.main()
