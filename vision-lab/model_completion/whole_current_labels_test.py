"""Synthetic whole-review contract checks; no real classifier fitting."""
import copy,unittest
from unittest.mock import patch
import whole_current_labels as w
import fine_labels as fl
import cut_and_whole as cw


def fixture(states):
 records=[];recordings=[]
 for i,(verdicts,whole,coverage) in enumerate(states,1):
  props=[]
  for j,verdict in enumerate(verdicts):
   clip=f'c{j}';records.append({'id':len(records)+1,'video_id':i,'clip_id':clip,'channel':f'@ch{i}','analyzed_at':'2026-10-09T00:00:00','label_type':'triage','merged_into':None,'added':False,'verdict':verdict,'reasons':['keep_whole'] if whole and j==0 else [],'detected_start':j*100.,'detected_end':(j+1)*100.,'start_seconds':j*100.,'end_seconds':(j+1)*100.});props.append({'id':clip,'start':j*100.,'end':(j+1)*100.})
  recordings.append({'video_id':i,'group':f'g{i}','analyzed_at':'2026-10-09T00:00:00','any_keep':'keep' in verdicts,'explicit_whole':whole,'kept_coverage':coverage,'original_proposals':props})
 return {'recordings':recordings},{'records':records}


class WholeLabelsTests(unittest.TestCase):
 def test_only_confirmed_whole_labels(self):
  receipt,_=w.build(*fixture([(['keep'],True,1.),(['skip','skip'],False,0.),(['keep','skip'],False,.99),(['keep'],False,1.),(['keep','skip'],False,.1)]))
  self.assertEqual([r['y'] for r in receipt['rows']],[1,0,None,None,None])
  self.assertEqual(receipt['counts']['near_full_unknown'],2);self.assertEqual(receipt['model_fit_count'],0);self.assertFalse(receipt['enabled'])

 def test_no_empty_all_skip_label(self):
  with self.assertRaisesRegex(fl.FineLabelContractError,'nonempty'):w.build(*fixture([([],False,0.)]))

 def test_nontriage_keep_cannot_be_ignored_as_all_skip(self):
  args=fixture([(['skip','keep'],False,.1)])
  args[1]['records'][1]['label_type']='fine-worth'
  with self.assertRaisesRegex(fl.FineLabelContractError,'Unsupported surviving'):w.build(*args)

 def test_private_identity_separation(self):
  receipt,private=w.build(*fixture([(['skip'],False,0.)]));self.assertNotIn('video_id',receipt['rows'][0]);self.assertNotIn('channel',receipt['rows'][0]);self.assertEqual(receipt['private_binding_sha256'],w.digest(private));self.assertEqual(private['recordings']['w000']['video_id'],1)

 def test_generation_flags_proposal_universe_fail_closed(self):
  for kind in ('generation','keepflag','wholeflag','missingproposal','bounds','channel'):
   args=fixture([(['keep','skip'],False,.2)]);cohort,snapshot=args
   if kind=='generation':snapshot['records'][0]['analyzed_at']='2026-10-08T00:00:00'
   if kind=='keepflag':cohort['recordings'][0]['any_keep']=False
   if kind=='wholeflag':cohort['recordings'][0]['explicit_whole']=True
   if kind=='missingproposal':cohort['recordings'][0]['original_proposals'].pop()
   if kind=='bounds':cohort['recordings'][0]['original_proposals'][0]['start']=1.
   if kind=='channel':snapshot['records'][0]['channel']='other'
   with self.subTest(kind=kind),self.assertRaises(fl.FineLabelContractError):w.build(*args)

 def test_three_positives_fail_existing_five_positive_gate(self):
  states=[(['keep'],True,1.)]*3+[(['skip'],False,0.)]*6
  receipt,_=w.build(*fixture(states));self.assertFalse(receipt['feasibility']['class_count_gate_passed']);self.assertEqual(receipt['feasibility']['minimum_positive_recordings'],5)

 def test_legacy_coverage_proxy_returns_before_any_fit(self):
  rows=[{'kept_coverage':1.,'explicit_whole':False},{'kept_coverage':.1,'explicit_whole':False}]
  with patch.object(cw,'make_pipeline',side_effect=AssertionError('Must never fit invalid target')):
   report,artifact=cw.recording_head(rows,'recording_whole_coverage_proxy')
  self.assertEqual(report['status'],'invalidated_whole_coverage_proxy');self.assertEqual(report['model_fit_count'],0);self.assertTrue(artifact['invalidated']);self.assertFalse(artifact['enabled'])

if __name__=='__main__':unittest.main()
