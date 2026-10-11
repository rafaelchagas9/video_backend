"""Synthetic append contracts only: no live DB, media, audio, training or real exports."""
import copy,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import creator_expansion_features as s
import creator_expansion_intake_test as fixtures

class Append(unittest.TestCase):
 def setUp(self):
  self.f=fixtures.Intake();self.f.setUp();self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.batch=self.root/'creator-expansion-v2';self.batch.mkdir();self.oldbase=self.root/'new-round-training';self.oldbase.mkdir()
  self.manifest=self.f.manifest;self.answers=s.intake.checked_answers(self.f.tasks,self.manifest);new=self.answers['current_candidate_rows'];oldrows=[]
  for i in range(48):
   r=copy.deepcopy(new[i%36]);r.update(row=f'old{i}',task_id=100+i//2,frame_cache='/frozen/old/numeric.npz',frame_checkpoint={'file':'frames/old.npz','sha256':'a'*64,'identity_sha256':'b'*64},features=[0.]*13,visual_mean=[0.]*1152);oldrows.append(r)
  self.old={'format':'kura-new-round-training-features','policy':s.labels.POLICY,'rows':oldrows,'answers':[],'reserved_creators_excluded':self.manifest['excluded_holdout_creators']}
  self.spec={'fit_source_sha256':s.FIT_SOURCE_SHA,'old_training_feature_cohort_sha256':s.OLD_SHA,'new_training_manifest_sha256':s.MANIFEST_SHA}
  for path,value in [(self.batch/'private_manifest.json',self.manifest),(self.batch/'preregistered_training.json',self.spec),(self.oldbase/'feature_cohort.json',self.old)]:path.write_text(json.dumps(value))
  self.original_sha=s.sha
 def tearDown(self):self.f.tearDown();self.tmp.cleanup()
 def snapshot(self,answers=None,**header):
  value={'schema_version':1,'manifest_sha256':s.MANIFEST_SHA,'intake_source_sha256':self.original_sha(Path(s.intake.__file__)),'fine_labels_source_sha256':self.original_sha(Path(s.labels.__file__)),'answers':self.answers if answers is None else answers};value.update(header)
  data=s.intake.canonical(value);digest=s.hashlib.sha256(data).hexdigest();path=self.batch/'answer-snapshots'/f'answers.{digest}.json';path.parent.mkdir(exist_ok=True);path.write_bytes(data);return digest,path
 def fake_sha(self,path):
  path=Path(path)
  if path==self.batch/'preregistered_training.json':return s.PREREG_SHA
  if path==self.batch/'private_manifest.json':return s.MANIFEST_SHA
  if path==self.oldbase/'feature_cohort.json':return s.OLD_SHA
  if path.name=='learned_preference_round.py':return s.FIT_SOURCE_SHA
  return self.original_sha(path)
 def load(self,sha):
  with patch.object(s,'sha',side_effect=self.fake_sha),patch.object(s.intake,'load_contract',return_value=self.manifest):return s.load_contract(self.root,sha)
 def test_complete_append_preserves48_and_explicit_frame_roots(self):
  sha,_=self.snapshot();old,new,plans,reserved,receipt=self.load(sha);before=copy.deepcopy(old);out=self.root/'new';payload=s.combine(old,new,receipt,reserved,self.oldbase,out)
  self.assertEqual(len(payload['rows']),84);self.assertEqual(payload['rows'][:48],before['rows']);self.assertEqual(old,before);self.assertEqual(len(plans),36);self.assertEqual(payload['optional_audit_sides'],0)
  for r in old['rows']:self.assertEqual(payload['frame_checkpoint_origins'][r['row']],str(self.oldbase.resolve()));self.assertEqual(r['frame_cache'],'/frozen/old/numeric.npz')
  for r in new:self.assertEqual(payload['frame_checkpoint_origins'][r['row']],str(out.resolve()))
 def test_partial_does_not_export_targets(self):
  partial={'status':'waiting','answered':17,'pending':1};sha,_=self.snapshot(partial)
  with self.assertRaisesRegex(ValueError,'Incomplete'):self.load(sha)
 def test_reanswer_version_is_independent_not_overwritten(self):
  first,path=self.snapshot();bytes_before=path.read_bytes();tasks=copy.deepcopy(self.f.tasks);tasks[0]['detail']['best']['a']['accepted']=False
  answers=s.intake.checked_answers(tasks,self.manifest);second,_=self.snapshot(answers)
  self.assertNotEqual(first,second);self.assertEqual(path.read_bytes(),bytes_before);self.assertNotEqual(self.load(first)[4]['answer_sha256'],self.load(second)[4]['answer_sha256'])
 def test_rows_source_policy_or_task_provenance_tamper_fails(self):
  for field in ('analyzed_at','index','offered_range','group','ranking_y'):
   altered=copy.deepcopy(self.answers);r=altered['current_candidate_rows'][0]
   if field=='index':r[field]['frame_count']+=1
   elif field=='offered_range':r[field][0]+=1
   elif field=='ranking_y':r[field]=1-r[field]
   else:r[field]='tampered'
   digest,_=self.snapshot(altered)
   with self.subTest(field=field),self.assertRaises(ValueError):self.load(digest)
  digest,_=self.snapshot(intake_source_sha256='0'*64)
  with self.assertRaisesRegex(ValueError,'provenance'):self.load(digest)
 def test_reserved_role_creator_and_optional_audit_failclosed(self):
  for field,value in [('reserved_fine_holdout',True),('fine_data_role','holdout'),('group',self.manifest['excluded_holdout_creators'][0])]:
   altered=copy.deepcopy(self.answers);altered['current_candidate_rows'][0][field]=value;digest,_=self.snapshot(altered)
   with self.subTest(field=field),self.assertRaises(ValueError):self.load(digest)
  tasks=copy.deepcopy(self.f.tasks);tasks[0]['kind']='recall-audit'
  with self.assertRaises(ValueError):s.intake.checked_answers(tasks,self.manifest)
 def test_exact_offered_node_versions_include_source_index_generation_range(self):
  r=self.old['rows'][0];base=s.node_identity(r)
  for field in ('analyzed_at','source_fingerprint','index','offered_range'):
   altered=copy.deepcopy(r)
   if field=='index':altered[field]['frame_count']+=1
   elif field=='source_fingerprint':altered[field]['mtime_ns']='999'
   elif field=='offered_range':altered[field][0]+=1
   else:altered[field]='another-generation'
   self.assertNotEqual(base,s.node_identity(altered))
  altered=copy.deepcopy(r);altered['cut_gold']={'start_seconds':1,'end_seconds':2,'accepted_offered_edges':False};self.assertEqual(base,s.node_identity(altered))
 def test_old_snapshot_changed_or_row_collision_rejected(self):
  digest,_=self.snapshot()
  with patch.object(s,'sha',side_effect=lambda p:'0'*64 if Path(p)==self.oldbase/'feature_cohort.json' else self.fake_sha(p)),patch.object(s.intake,'load_contract',return_value=self.manifest),self.assertRaisesRegex(ValueError,'Original48'):s.load_contract(self.root,digest)
  old,new,_,reserved,receipt=self.load(digest);new[0]['row']=old['rows'][0]['row']
  with self.assertRaisesRegex(ValueError,'identities'):s.combine(old,new,receipt,reserved,self.oldbase,self.root/'new')

if __name__=='__main__':unittest.main()
