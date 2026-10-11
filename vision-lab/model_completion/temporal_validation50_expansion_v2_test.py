"""Pure expansion provenance fixtures only; no actual preparation or score fit."""
import copy,unittest
import temporal_validation50_expansion_v2 as e
from temporal_validation50_test import source


def inputs():
 s=source(0);s.update(file_name='private',initial_best_source='saved',snippet=[],snippet_recipe='preview');s['clip']=[0.,600.];s['best']=[0.,600.];s['duration_seconds']=1200.;s['index']['frame_count']=241
 ps=[{'id':'kept','start':0.,'end':600.,'score':.8},{'id':'other','start':700.,'end':1150.,'score':.3}]
 identity={k:s[k] for k in ('video_id','analyzed_at','source_fingerprint','index')};identity.update(duration=1200.,proposals=ps);key=e.v1.temporal.aux.state.identity_sha256(identity)
 receipts=[{'clip_id':p['id'],'bounds':[p['start'],p['end']],'score':p['score'],'analyzed_at':s['analyzed_at'],'feedback_id':i+1,'origin':'feedback.detected_bounds'} for i,p in enumerate(ps)]
 row={'source':s,'original_proposal_id':'kept','proposals':ps,'proposal_origin':{'kind':'exact_generation_original_detector_receipts','analyzed_at':s['analyzed_at'],'receipts':receipts}}
 inventory={'sources':[s],'rows':[row],'excluded_holdout_creators':['reserved']}
 cp={'source':s,'numeric_identity':identity,'source_key':key,'frame_checkpoint':{'identity_sha256':key,'sha256':'a'*64,'path':'neutral'}}
 return inventory,{'policy':e.v1.POLICY,'records':[cp]}
class Tests(unittest.TestCase):
 def test_review_array_origin_missing_receipt_only_excludes_its_extra(self):
  i,c=inputs();i['rows'][0]['proposal_origin']['kind']='recording_reviews.proposals';i['rows'][0]['proposal_origin']['receipts']=[]
  out=e.build_extensions(i,c,{'reserved'});self.assertFalse(out['extensions']);self.assertEqual(len(out['unavailable']),1);self.assertEqual(out['unavailable'][0]['reason'],'review_array_original_missing_exact_feedback_receipt_UNKNOWN')

 def test_derived_original_not_quality_label_or_fake_human_gold(self):
  inventory,controls=inputs();r=e.build_extensions(inventory,controls,{'reserved'});self.assertEqual(len(r['extensions']),1);x=r['extensions'][0]
  self.assertEqual(x['derived_source']['clip'],[700.,1150.]);self.assertEqual(x['derived_source']['best'],[700.,1150.]);self.assertEqual(x['original_proposal_id'],'other');self.assertEqual(x['current_acceptability'],'UNKNOWN_NOT_INFERRED');self.assertIsNone(x['quality_y']);self.assertIsNone(x['cut_gold'])
 def test_missing_generation_unknown_not_zero_or_bad(self):
  inventory,controls=inputs();controls['records']=[];r=e.build_extensions(inventory,controls,{'reserved'});self.assertFalse(r['extensions']);self.assertEqual(r['unavailable'][0]['reason'],'missing_existing_complete_generation_checkpoint_unknown')
 def test_exact_generation_universe_and_receipts_fail_closed(self):
  inventory,controls=inputs()
  for target,mutate in [('i',lambda x:x['rows'][0]['proposal_origin'].update(analyzed_at='wrong')),('c',lambda x:x['records'][0]['numeric_identity']['proposals'][1].update(end=1190)),('i',lambda x:x['rows'][0]['proposal_origin']['receipts'][1].update(bounds=[701.,1150.])),('i',lambda x:x['sources'][0].update(channel_key='reserved'))]:
   i,c=copy.deepcopy(inventory),copy.deepcopy(controls);mutate(i if target=='i' else c)
   with self.assertRaises(ValueError):e.build_extensions(i,c,{'reserved'})
 def test_parent_live_not_new_feedback_assumption_and_no_mutation(self):
  i,c=inputs();x=e.build_extensions(i,c,{'reserved'})['extensions'][0];live={'video_id':x['parent_source']['video_id'],'clip_id':'kept'}
  result=e.validate_live_parent(x,live,x['parent_source']);self.assertEqual(result['clip_id'],'other');self.assertEqual(live['clip_id'],'kept')
  bad=copy.deepcopy(x);bad['derived_source']['clip']=[701.,1150.]
  with self.assertRaises(ValueError):e.validate_live_parent(bad,live,x['parent_source'])

if __name__=='__main__':unittest.main()
