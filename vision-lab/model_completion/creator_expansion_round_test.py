"""Dry graph/audit metadata fixtures; no database, library media, GPU or queue writes."""
import collections,copy,datetime,tempfile,unittest
from pathlib import Path
import connected_label_round_test as fixtures
import creator_expansion_round as s

class Expansion(unittest.TestCase):
 def setUp(self):
  self.fixture=fixtures.Connected();self.fixture.setUp();prototype=self.fixture.rows[100];self.rows={};self.history=[];self.reserved={'held0','held1','held2','held3'};self.training={f'c{i}' for i in range(12)};self.targeted=[f'c{i}' for i in range(4)];self.main={f'c{i}' for i in range(4,12)}
  for channel in range(26):
   for j in range(3):
    fid=channel*3+j+100;row=copy.deepcopy(prototype);row.update(feedback_id=fid,video_id=fid,clip_id=str(fid),channel=f'c{channel}',start=20.,end=60.+channel,verdict='skip' if j==2 else 'keep');self.rows[fid]=row
  def task(a,b,ident):
   ctx={key:s.previous.side(self.rows[fid],[]) for key,fid in [('a',a),('b',b)]};channel=self.rows[a]['channel'] if self.rows[a]['channel']==self.rows[b]['channel'] else None
   return {'id':ident,'kind':'versus','batch':'old','channel':channel,'answer':'both','context':dict(ctx,channel=channel),'detail':{'best':{key:{'start_seconds':v['best'][0],'end_seconds':v['best'][1],'accepted':True} for key,v in ctx.items()}},'answered_at':datetime.datetime(2026,10,10,12)}
  for i in range(4):self.history.append(task(100+i*3,101+i*3,i+1))
  for i in range(8):self.history.append(task(100+(i+4)*3,100+((i+1)%8+4)*3,i+5))
 def tearDown(self):self.fixture.tearDown()
 def value(self,rows=None,history=None):return s.manifest(self.rows if rows is None else rows,self.history if history is None else history,self.reserved,{'fixture':True},self.training,self.targeted,self.main)
 def test_finite_diversity_neutral_audits_complete_connectivity_and_caps(self):
  value=self.value();self.assertEqual(value,self.value());rows=value['rows'];self.assertEqual(len(rows),24);roles=collections.Counter(r['context']['selection_role'] for r in rows);self.assertEqual(roles,{'keep_preference':18,'two_skip_audit':6});self.assertEqual(value['graph']['new_keep_creators'],12);self.assertEqual(value['graph']['existing_plus_new_components'],1)
  pairs=set();auditcreators=set();newcreators=set()
  for row in rows:
   a,b=(row['context'][k] for k in ('a','b'));pair=tuple(sorted((a['feedback_id'],b['feedback_id'])));self.assertNotIn(pair,pairs);pairs.add(pair);self.assertIsNone(row['channel']);self.assertFalse(row['context']['reserved_fine_holdout']);self.assertTrue(row['context']['future_answers_unassigned']);self.assertNotIn('answer',row)
   self.assertFalse({a['channel_key'],b['channel_key']}&self.reserved)
   if row['context']['selection_role']=='two_skip_audit':self.assertEqual({a['initial_triage_verdict'],b['initial_triage_verdict']},{'skip'});auditcreators.update((a['channel_key'],b['channel_key']))
   else:self.assertEqual({a['initial_triage_verdict'],b['initial_triage_verdict']},{'keep'});newcreators.update({a['channel_key'],b['channel_key']}-self.training)
  self.assertEqual(len(newcreators),12);self.assertEqual(len(auditcreators),12);self.assertLessEqual(max(value['total_exposures'].values()),6);self.assertEqual(value['queue_writes'],0)
 def test_novelty_does_not_silently_relax_and_no_keep_skip_pair(self):
  rows={fid:r for fid,r in self.rows.items() if int(r['channel'][1:])<22}
  with self.assertRaisesRegex(ValueError,'Fewer than12'):self.value(rows)
  rows=copy.deepcopy(self.rows)
  for row in rows.values():
   if row['verdict']=='skip':row['verdict']='keep'
  with self.assertRaisesRegex(ValueError,'two-skip'):self.value(rows)
 def test_skipped_source_verdict_is_preserved_and_invalid_source_rejected(self):
  row=self.rows[102];side=s.side(row,self.history);self.assertEqual(side['initial_triage_verdict'],'skip');self.assertEqual(row['verdict'],'skip');self.assertEqual(side['snippet'][1]-side['snippet'][0],15)
  for key,value in [('is_available',False),('model_revision','other'),('review_generation','older')]:
   with self.subTest(key=key),self.assertRaises(Exception):s.side(dict(row,**{key:value}),self.history)
 def test_reserved_and_preexisting_creator_not_new_cycle(self):
  reserved=copy.deepcopy(self.rows);reserved[136]['channel']='held0';value=self.value(reserved);self.assertNotIn('held0',value['graph']['new_cycle_creators'])
  known={'id':999,'kind':'versus','batch':'previous','answer':None,'channel':'c12','context':{'a':{'feedback_id':9991},'b':{'feedback_id':9992}}}
  value=self.value(history=self.history+[known]);self.assertNotIn('c12',value['graph']['new_cycle_creators'])
 def test_prior_asked_pairs_are_never_repeated(self):
  value=self.value();prior={tuple(sorted((t['context']['a']['feedback_id'],t['context']['b']['feedback_id']))) for t in self.history};new={tuple(sorted((r['context']['a']['feedback_id'],r['context']['b']['feedback_id']))) for r in value['rows']};self.assertFalse(prior&new)

if __name__=='__main__':unittest.main()
