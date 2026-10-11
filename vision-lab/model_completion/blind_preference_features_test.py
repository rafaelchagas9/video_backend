"""Synthetic numeric-domain endpoint/provenance and exact-old-node reuse guards."""
import copy,tempfile,unittest
from pathlib import Path
import numpy as np
import blind_preference_features as s

class Numeric(unittest.TestCase):
 def setUp(self):
  self.context={'feedback_id':1,'video_id':2,'analyzed_at':'g','source_fingerprint':{'fixture':True},'index':{'frame_count':3},'detector':'pin','channel_key':'c','channel':'c','clip':[0.,10.],'score':.7}
  self.live={'clip_id':'x','duration':10.};self.t=np.array([0.,5.,10.]);self.v=np.zeros((3,1152));self.v[0,0]=self.v[1,0]=self.v[2,1]=1
  self.proposals=[{'id':'x','start':0.,'end':10.,'score':.7}];self.frames=(self.t,self.v,self.proposals,{'fixture':True},None)
  side={k:self.context[k] for k in ('feedback_id','video_id','analyzed_at','source_fingerprint','index','detector','channel_key')};side.update(original_range=[0.,10.],range=[0.,10.])
  self.preference={'task_id':1,'position':0,'answer':'a','a':side,'b':copy.deepcopy(side)}
 def test_closed_point_mean_includes_endpoint_and_unknown_acceptance(self):
  row=s.row_features(self.preference,'a',self.context,self.live,self.frames,{})
  self.assertAlmostEqual(row['visual_mean'][0],2/np.sqrt(5));self.assertAlmostEqual(row['visual_mean'][1],1/np.sqrt(5));self.assertAlmostEqual(row['features'][0],np.log(10));self.assertIsNone(row['current_acceptability_y']);self.assertIsNone(row['absolute_y']);self.assertIsNone(row['cut_gold']);self.assertEqual(row['kind'],'version-versus')
 def test_cancelling_unit_frames_do_not_create_complete_zero_mean(self):
  changed=self.v.copy();changed[0,0]=1;changed[1,0]=-1;changed[2]=0;changed[2,1]=1
  preference=copy.deepcopy(self.preference);preference['a']['range']=[0,5]
  with self.assertRaisesRegex(ValueError,'zero'):s.row_features(preference,'a',self.context,self.live,(self.t,changed,self.proposals,{},None),{})
 def test_exact_old_values_reused_only_after_numeric_comparison(self):
  row=s.row_features(self.preference,'a',self.context,self.live,self.frames,{});key=s.oldrank.node_key(row);nodes={key:('c',np.asarray(row['features']),np.asarray(row['visual_mean']))};again=s.row_features(self.preference,'a',self.context,self.live,self.frames,nodes);self.assertTrue(again['old_node_exact_values_reused']);self.assertEqual(again['features'],row['features'])
  nodes[key][1][0]+=1
  with self.assertRaisesRegex(ValueError,'conflict'):s.row_features(self.preference,'a',self.context,self.live,self.frames,nodes)
 def test_atomic_numeric_checkpoint_is_identity_bound_and_immutable(self):
  with tempfile.TemporaryDirectory() as directory:
   path,receipt=s.checkpoint(Path(directory),self.t,self.v,{'fixture':True});self.assertTrue(Path(path).is_file());self.assertEqual(s.checkpoint(Path(directory),self.t,self.v,{'fixture':True}),(path,receipt));self.assertEqual(Path(path).stat().st_mode&0o777,0o600)
   changed=self.v.copy();changed[0]=changed[2]
   with self.assertRaisesRegex(ValueError,'contents'):s.checkpoint(Path(directory),self.t,changed,{'fixture':True})
 def test_source_range_and_missingpoint_frames_fail_closed(self):
  changed=copy.deepcopy(self.preference);changed['a']['source_fingerprint']={'fixture':False}
  with self.assertRaisesRegex(ValueError,'identity'):s.row_features(changed,'a',self.context,self.live,self.frames,{})
  changed=copy.deepcopy(self.preference);changed['a']['range']=[1,2]
  with self.assertRaisesRegex(ValueError,'lacks'):s.row_features(changed,'a',self.context,self.live,self.frames,{})
  changed=copy.deepcopy(self.preference);changed['a']['range']=[0,11]
  with self.assertRaises(ValueError):s.row_features(changed,'a',self.context,self.live,self.frames,{})

if __name__=='__main__':unittest.main()
