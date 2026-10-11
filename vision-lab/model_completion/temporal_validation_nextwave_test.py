"""Disposable verdict-neutral nextwave source/semantics/transaction tests only."""
import copy,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
import temporal_validation_nextwave as b
import temporal_validation_nextwave_apply as apply
import temporal_validation_nextwave_intake as intake
from temporal_validation50_test import record
from temporal_validation50_round_test import tasks,PG

def recs(n=7):
 rows=[]
 for i in range(n):
  r=record(i,f'g{i//2}');r.update(original_proposal_id=f'p{i}',comparator_stratum='generic_oldC_without_human_reference',known_debug=False);rows.append(r)
 return rows

def selection(n=7):return {'selected':recs(n),'unavailable':[],'face_provenance':{},'request_sha256':'a'*64,'face_root':'/private/newfaces','actual_count':n,'creators':4}
def manifest(n=7):return b.make_manifest(selection(n),{'reserved'},{'frozen':'holdout'})
def raw():
 s=record(1)['source'];return {'feedback_id':s['feedback_id'],'video_id':s['video_id'],'clip_id':'p1','is_available':True,'channel':'g1','original_start':0.,'original_end':600.,'start':10.,'end':20.,'duration':600.,'score':.8,'file_name':'g1_recording','file_path':'/private/source','saved_at':'now','review_generation':'same','analyzed_at':'same','added':False,'merged_into':None,'label_type':'triage','verdict':'skip','model_revision':b.base.VISUAL_PIN,'interval_seconds':5,'frame_count':121,'actual_frame_count':121,'storyboard_generated_at':'same','storyboard_at':'same','indexed_at':'same','last_frame_timestamp':600.,'vtt_path':'/private/tiles.vtt','detector':{}}
class Tests(unittest.TestCase):
 def test_real_skip_original_not_fake_keep_or_saved_edges(self):
  row=raw();dev=b.v1.ROOT.stat().st_dev
  with patch.object(Path,'is_file',return_value=True),patch.object(Path,'stat',return_value=SimpleNamespace(st_dev=dev)),patch.object(b.base,'source_fingerprint',return_value={'identity':'same'}):
   s=b.original_side(row);self.assertEqual(s['clip'],[0.,600.]);self.assertEqual(s['best'],[0.,600.]);self.assertNotIn('verdict',s)
   for k,v in [('saved_at',None),('added',True),('merged_into','other'),('feedback_id',0),('review_generation','different'),('last_frame_timestamp',550.)]:
    bad=dict(row);bad[k]=v
    with self.assertRaises(ValueError):b.original_side(bad)
 def test_count_aware_independent_balancing_blinding_and_commit(self):
  for n in(1,7,30):
   m=manifest(n);self.assertEqual(m['actual_count'],n);a=sum(p['assignments']['a']=='new_temporal'for p in m['private_assignments']);self.assertLessEqual(abs(a-(n-a)),1);self.assertEqual(m,b.make_manifest(dict(selection(n),selected=list(reversed(recs(n)))),{'reserved'},{'frozen':'holdout'}));self.assertEqual(len(m['policy']['assignment_seed_commit_sha256']),64)
   for hidden in('new_temporal','old_C','known_debug','joint_proxy','face_checkpoint'):self.assertNotIn(hidden,str(m['rows']))
 def test_empty_duplicates_reserved_known_and_creatorcap_fail_closed(self):
  for change in(lambda s:s.update(selected=[]),lambda s:s['selected'].append(copy.deepcopy(s['selected'][0])),lambda s:s['selected'][0]['source'].update(channel_key='reserved'),lambda s:s['selected'][0]['source'].update(video_id=b.temporal.KNOWN_VIDEO),lambda s:[r['source'].update(channel_key='same')for r in s['selected']]):
   s=selection();change(s)
   with self.assertRaises(ValueError):b.make_manifest(s,{'reserved'},{})
 def test_creator99_gate_and_no_pooled_release(self):
  r=[dict(creator=f'g{i}',known_debug=False,outcome='new')for i in range(18)];x=b.metrics(r);self.assertEqual(x['creator_cluster_net_ci99'],[1.,1.]);self.assertFalse(x['release_signal_passed']);self.assertFalse(x['predeclared_gates']['min20_primary_nonabstaining_creators']);self.assertEqual(x['pooled_with_firstwave'],'DESCRIPTIVE_ONLY_NOT_RELEASE_TEST')
  r=[dict(creator='a',known_debug=False,outcome='new')for _ in range(3)]+[dict(creator='b',known_debug=False,outcome='old')];self.assertEqual(b.metrics(r)['creator_macro_net'],0);self.assertEqual(b.metrics(r),b.metrics(list(reversed(r))))
  r.append(dict(creator='a',known_debug=False,outcome='new'))
  with self.assertRaises(ValueError):b.metrics(r)
 def test_actualN_preferences_only_and_partial_no_snapshot(self):
  m=manifest();t=tasks(m);t[0]['answer']='both';t[1]['answer']='neither';x=intake.checked_answers(t,m);self.assertEqual((x['strict_pairs'],x['no_strict_preference'],x['abstained']),(5,1,1))
  for r in x['preference_rows']:self.assertIsNone(r['absolute_y']);self.assertIsNone(r['cut_gold']);self.assertIsNone(r['whole_verdict']);self.assertEqual(r['current_acceptability'],'unknown')
  t[2].update(answer=None,answered_at=None);x=intake.checked_answers(t,m);self.assertEqual(x['pending'],1);self.assertEqual(x['total'],7);self.assertNotIn('preference_rows',x)
  t=tasks(m);t[0]['context']['a']['range']=[1.,181.]
  with self.assertRaises(ValueError):intake.checked_answers(t,m)
 def test_immutable_reanswers_and_no_fifty_assumption(self):
  m=manifest()
  with tempfile.TemporaryDirectory()as root,patch.object(b,'load_contract',return_value=(m,{'reserved'},{})):
   a=intake.intake(root,'a'*64,lambda:tasks(m));same=intake.intake(root,'a'*64,lambda:tasks(m));self.assertEqual(a['answered'],7);self.assertEqual(a['snapshot_sha256'],same['snapshot_sha256']);self.assertFalse(same['created']);changed=intake.intake(root,'a'*64,lambda:tasks(m,'b'));self.assertNotEqual(a['snapshot_sha256'],changed['snapshot_sha256']);self.assertTrue(Path(a['snapshot_path']).exists());self.assertEqual(intake.intake(root,'a'*64,lambda:tasks(m,None))['pending'],7)
 def test_exactN_transaction_preflight_idempotence_preserves_answers(self):
  m=manifest()
  with patch.object(b,'validate_live'),patch.object(b,'history_metadata',return_value=[]),patch.object(b,'load_live',return_value={}):
   self.assertEqual(apply.execute(PG(),m,{'reserved'},{},'a'*64,False)['inserted'],0);pg=PG();self.assertEqual(apply.execute(pg,m,{'reserved'},{},'a'*64,True)['inserted'],7);self.assertEqual(pg.inserted,7);self.assertEqual(apply.execute(PG(m['rows']),m,{'reserved'},{},'a'*64,True)['inserted'],0)
   with self.assertRaises(ValueError):apply.execute(PG(md5=('old','changed')),m,{'reserved'},{},'a'*64,True)
 def test_semantic_pair_ignores_feedback_generation_original_and_order(self):
  m=manifest();a=copy.deepcopy(m['rows'][0]);changed=copy.deepcopy(a)
  for side in('a','b'):
   changed['context'][side].update(feedback_id=999,analyzed_at='newgeneration',clip=[0.,700.]);changed['context'][side]['index']['indexed_at']='newindex'
  changed['context']['a'],changed['context']['b']=changed['context']['b'],changed['context']['a']
  self.assertEqual(b.semantic_pair(a),b.semantic_pair(changed))
  r=recs(2);r[1]['source']=dict(copy.deepcopy(r[0]['source']),feedback_id=999);r[1]['source']['clip']=[0.,700.]
  with self.assertRaises(ValueError):b.make_manifest(dict(selection(2),selected=r),{'reserved'},{})
  live={p['source']['feedback_id']:{'source':p['source'],'proposals':[{'id':q['id'],'start_seconds':q['start'],'end_seconds':q['end'],'score':q['score']}for q in p['numeric_identity']['proposals']]}for p in m['private_assignments']}
  with patch.object(b,'original_side',side_effect=lambda r:r['source']):
   b.validate_live(m,live,[],{'reserved'},{'frozen':'holdout'})
   with self.assertRaises(ValueError):b.validate_live(m,live,[dict(changed,batch='earlier')],{'reserved'},{'frozen':'holdout'})
   wrong=copy.deepcopy(live);next(iter(wrong.values()))['proposals'][0]['end_seconds']=590.
   with self.assertRaisesRegex(ValueError,'universe drift'):b.validate_live(m,wrong,[],{'reserved'},{'frozen':'holdout'})
 def test_complete_other_original_without_detected_is_not_finaltrim(self):
  row=raw();row.update(analyzed_at='2026-10-10T00:00:00Z',proposals=None,clips=[{'id':'p1','start_seconds':0.,'end_seconds':600.,'detected':{'start_seconds':0.,'end_seconds':600.}},{'id':'p2','start_seconds':100.,'end_seconds':200.}])
  common={'video_id':row['video_id'],'analyzed_at':row['analyzed_at'],'channel':row['channel'],'added':False,'score':.8}
  feedback=[dict(common,id=1,clip_id='p1',detected_start=0.,detected_end=600.),dict(common,id=2,clip_id='p2',detected_start=None,detected_end=None)]
  with self.assertRaisesRegex(ValueError,'never use final trims'):b.whole.recover_proposals(row,feedback)
  self.assertRaises(ValueError,b.canonical_originals,None)
  raw_proposals=[{'id':'p1','start_seconds':0.,'end_seconds':600.,'score':.8},{'id':'p2','start_seconds':100.,'end_seconds':200.,'score':.8}]
  actual=b.canonical_originals(raw_proposals);self.assertNotEqual(actual,[{'id':'p1','start':0.,'end':600.,'score':.8}]);self.assertEqual(len(actual),2)
if __name__=='__main__':unittest.main()
