"""Disposable frozen-answer intake contracts; no real DB, media or fitting."""
import copy,datetime,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import targeted_answer_intake as s
import fine_labels as fl


def fixture():
 rows=[];tasks=[]
 for position in range(8):
  channel=f'channel{position}';context={'reserved_fine_holdout':position>=4,'fine_data_role':'holdout' if position>=4 else 'training'}
  for side,i in [('a',0),('b',1)]:context[side]={'feedback_id':position*2+i+1,'video_id':position*2+i+1,'clip':[0.,100.],'best':[10.,90.],'duration_seconds':100.,'analyzed_at':'2026-10-10T10:00:00.000Z','index':{'model_revision':'fixture'},'source_fingerprint':{'size_bytes':10,'mtime_ns':'123'}}
  row={'kind':'versus','batch':s.batch.BATCH,'position':position,'video_id':context['a']['video_id'],'start_seconds':10.,'end_seconds':90.,'stratum':'targeted-new-channel','channel':channel,'context':context};rows.append(row)
  answer=['a','b','both','neither'][position%4];chosen=('a','b') if answer=='both' else () if answer=='neither' else (answer,)
  detail={'best':{k:{'start_seconds':20.,'end_seconds':80.,'accepted':False} for k in chosen}} if chosen else None
  tasks.append(dict(row,id=position+401,answer=answer,reasons=[],detail=detail,answered_at='2026-10-10T12:00:00.000Z'))
 return {'rows':rows,'training_channels':[f'channel{i}' for i in range(4)],'holdout_channels':[f'channel{i}' for i in range(4,8)]},tasks


class Intake(unittest.TestCase):
 def test_complete_semantics_keeps_loser_without_invented_cut_and_roles(self):
  manifest,tasks=fixture();payload=s.checked_answers(tasks,manifest);self.assertEqual(payload['status'],'complete');self.assertEqual(len(payload['current_candidate_rows']),16);self.assertEqual(payload['label_summary']['absolute_positive'],12);self.assertEqual(payload['label_summary']['absolute_negative'],4);self.assertEqual(payload['label_summary']['ranking_pairs'],4);self.assertEqual(len(payload['confirmed_cut_gold']),8);self.assertEqual(len(payload['training_rows']),8);self.assertEqual(len(payload['holdout_rows']),8)
  loser=payload['current_candidate_rows'][1];self.assertEqual(loser['absolute_y'],1);self.assertEqual(loser['ranking_y'],0);self.assertIsNone(loser['cut_gold']);self.assertTrue(all(r['permanent_storage_y'] is None and r['future_replacement_y'] is None for r in payload['current_candidate_rows']))
  fl.require_fit_scope(payload['training_rows'])
  with self.assertRaises(fl.ReservedFineHoldoutError):fl.absolute_rows(payload['holdout_rows'])
  self.assertEqual(len(fl.absolute_rows(payload['holdout_rows'],for_fit=False)),8)
 def test_partial_returns_counts_only_and_no_output_directory(self):
  manifest,tasks=fixture();tasks[-1].update(answer=None,answered_at=None,detail=None,reasons=[])
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp)
   with patch.object(s,'load_contract',return_value=manifest),patch.object(s,'write_snapshot') as write:result=s.intake(root,lambda:tasks)
   self.assertEqual(result,{'status':'waiting','batch':s.batch.BATCH,'answered':7,'pending':1,'total':8,'training_answered':4,'holdout_answered':3});write.assert_not_called();self.assertEqual(list(root.iterdir()),[])
 def test_each_stored_identity_context_role_must_match(self):
  manifest,tasks=fixture()
  changes=[('batch','other'),('video_id',999),('position',99),('start_seconds',11.),('channel','other')]
  for key,value in changes:
   changed=copy.deepcopy(tasks);changed[0][key]=value
   with self.subTest(key=key),self.assertRaises(fl.FineLabelContractError):s.checked_answers(changed,manifest)
  for path in ('generation','index','role'):
   changed=copy.deepcopy(tasks)
   if path=='generation':changed[0]['context']['a']['analyzed_at']='other'
   if path=='index':changed[0]['context']['a']['index']['model_revision']='other'
   if path=='role':changed[-1]['context']['reserved_fine_holdout']=False
   with self.subTest(path=path),self.assertRaises(fl.FineLabelContractError):s.checked_answers(changed,manifest)
  with self.assertRaises(fl.FineLabelContractError):s.checked_answers(tasks[:7],manifest)
 def test_chosen_cut_required_neither_none_finite_strict_bounds_bool_marker(self):
  manifest,tasks=fixture()
  for name,mutate in [('missing',lambda t:t[0].update(detail=None)),('unexpected_key',lambda t:t[0]['detail']['best']['a'].update(other='invalid')),('extra_loser',lambda t:t[0]['detail']['best'].update(b={'start_seconds':20,'end_seconds':80,'accepted':False})),('neither_cut',lambda t:t[3].update(detail=t[0]['detail'])),('accepted_notbool',lambda t:t[0]['detail']['best']['a'].update(accepted=1)),('nan',lambda t:t[0]['detail']['best']['a'].update(start_seconds=float('nan'))),('outside',lambda t:t[0]['detail']['best']['a'].update(end_seconds=101.)),('empty',lambda t:t[0]['detail']['best']['a'].update(end_seconds=20.)),('missing_both',lambda t:t[2]['detail']['best'].pop('b'))]:
   changed=copy.deepcopy(tasks);mutate(changed)
   with self.subTest(name=name),self.assertRaises(fl.FineLabelContractError):s.checked_answers(changed,manifest)
 def test_immutable_reanswers_versioned_without_overwriting_original(self):
  manifest,tasks=fixture();first=s.checked_answers(tasks,manifest)
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);path,sha,created=s.write_snapshot(root,first);before=path.read_bytes();self.assertTrue(created);self.assertEqual(path.stat().st_mode&511,384)
   same,samesha,created=s.write_snapshot(root,first);self.assertEqual((same,samesha),(path,sha));self.assertFalse(created)
   revised=copy.deepcopy(tasks);revised[0]['detail']['best']['a']['start_seconds']=21.;revised[0]['answered_at']='2026-10-10T12:01:00.000Z';second=s.checked_answers(revised,manifest);new,newsha,created=s.write_snapshot(root,second)
   self.assertTrue(created);self.assertNotEqual(newsha,sha);self.assertEqual(path.read_bytes(),before);self.assertEqual(len(list((root/'answer-snapshots').glob('answers.*.json'))),2)
 def test_invalid_pending_stale_detail_or_answer_timestamp_failclosed(self):
  manifest,tasks=fixture();changed=copy.deepcopy(tasks);changed[0]['answer']=None
  with self.assertRaises(fl.FineLabelContractError):s.checked_answers(changed,manifest)
  changed=copy.deepcopy(tasks);changed[0]['answered_at']='invalid'
  with self.assertRaises(fl.FineLabelContractError):s.checked_answers(changed,manifest)
 def test_contract_checksum_and_role_receipt_validation(self):
  manifest,tasks=fixture();manifest['source_sha256']=s.batch.digest(Path(s.batch.__file__))
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);(root/'private_manifest.json').write_text(json.dumps(manifest));sha=s.batch.digest(root/'private_manifest.json')
   for role,positions in [('training',[0,1,2,3]),('holdout',[4,5,6,7])]:
    (root/f'fine_{role}.json').write_text(json.dumps({'source_manifest_sha256':sha,'batch':s.batch.BATCH,'positions':positions,'channel_count':4,'side_count':8,'channels':manifest[f'{role}_channels']}))
   with patch.object(s,'FINAL_MANIFEST_SHA256',sha):self.assertEqual(s.load_contract(root),manifest)
   with self.assertRaises(fl.FineLabelContractError):s.load_contract(root)
   bad=json.loads((root/'fine_holdout.json').read_text());bad['positions']=[0,1,2,3];(root/'fine_holdout.json').write_text(json.dumps(bad))
   with patch.object(s,'FINAL_MANIFEST_SHA256',sha),self.assertRaises(fl.FineLabelContractError):s.load_contract(root)

if __name__=='__main__':unittest.main()
