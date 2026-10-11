"""Historical two-generation numeric fixtures; no media, PostgreSQL, model or GPU."""
import copy
import json
import hashlib
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import task_generation_inputs as inputs
import archived_audio as archive
import fine_labels as labels


class TaskGenerationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.archives = self.root/'archives'; (self.archives/'7').mkdir(parents=True)
        self.old = dict(id=10, video_id=7, analyzed_at='2026-10-08T01:00:00', clip_id='h0', channel='neutral', detector='probe-old', detected_start=0., detected_end=100.)
        self.new = dict(self.old, id=20, analyzed_at='2026-10-09T01:00:00', detector='probe-new')
        self.task = dict(id=7,kind='versus',answer='a',channel='neutral',context={s:dict(feedback_id=r['id'],video_id=7,clip=[0.,100.],best=[15.,65.],score=.6) for s,r in [('a',self.old),('b',self.new)]}, detail={'best':{'a':dict(start_seconds=20.,end_seconds=60.,accepted=False)}})
        self.old_manifest = self.publish(self.old, np.arange(20)*5.)
        self.new_manifest = self.publish(self.new, np.arange(20)*5., constant=True)
        self.snapshot = dict(records=[self.new],tasks=[self.task])

    def publish(self, feedback, timestamps, constant=False):
        index=dict(modelRevision=inputs.VISUAL_PIN,storyboardGeneratedAt=feedback['analyzed_at']+'Z',indexedAt=feedback['analyzed_at']+'Z',intervalSeconds=5,frameCount=len(timestamps))
        saved=dict(format='kura-recording-training',version=1,source=dict(videoId=7,fileName='neutral.fixture',fileHash=None,fileSizeBytes=100,durationSeconds=100.),analyzedAt=feedback['analyzed_at']+'Z',detectorRevision=feedback['detector'],features=dict(index=index,dimension=1152),proposals=[dict(id='h0',start_seconds=0.,end_seconds=100.,score=.4)],clips=[])
        identity=archive.feature_identity(saved);v=np.zeros((len(timestamps),1152),dtype='<f4')
        for i in range(len(v)):v[i,0 if constant else i%3]=1
        header=json.dumps(dict(version=1,identity=identity,index=index,dimension=1152,timestamps='float64-le',embeddings='float32-le'),separators=(',',':')).encode()
        raw=b'KURAFEAT'+struct.pack('<I',len(header))+header+np.asarray(timestamps,dtype='<f8').tobytes()+v.tobytes();file=f'features-{identity}.bin';(self.archives/'7'/file).write_bytes(raw)
        saved['features'].update(file=file,identity=identity,sha256=hashlib.sha256(raw).hexdigest(),bytes=len(raw))
        self.write_manifest(saved);return saved

    def write_manifest(self,saved):
        name='review-'+saved['analyzedAt'][:10]+'.json';(self.archives/'7'/name).write_text(json.dumps(saved))

    def build(self):
        return inputs.build_sidecar([self.task],[self.old,self.new],self.archives)

    def test_existing_frozen_prepare_never_queries_or_adds_sidecar(self):
        import prepare
        import types
        corpus=self.root/'frozen';corpus.mkdir();(corpus/'cohort.json').write_text('{"immutable":true}');before=(corpus/'cohort.json').read_bytes()
        fake=types.SimpleNamespace(connect=lambda *args: (_ for _ in ()).throw(AssertionError('No DB')))
        with patch.object(prepare,'ROOT',corpus),patch.dict('sys.modules',{'psycopg':fake}),patch.object(inputs,'build_sidecar',side_effect=AssertionError('No sidecar write')):
            prepare.main()
        self.assertEqual((corpus/'cohort.json').read_bytes(),before);self.assertFalse((corpus/'task_generation_inputs.json').exists())

    def test_both_referenced_generations_retained_without_changing_coarse_rows(self):
        coarse=copy.deepcopy(self.snapshot['records']);sidecar=self.build();resolved=inputs.feedback_map(self.snapshot,sidecar)
        self.assertEqual(inputs.referenced_feedback_ids([self.task]),[10,20]);self.assertEqual(set(resolved),{10,20});self.assertEqual(self.snapshot['records'],coarse)
        a,b=sidecar['sides'];self.assertEqual(a['archive']['analyzed_at'],self.old_manifest['analyzedAt']);self.assertEqual(b['archive']['analyzed_at'],self.new_manifest['analyzedAt'])
        self.assertFalse(np.allclose(a['features'],b['features']));self.assertEqual(b['current_acceptability_y'],1);self.assertEqual(b['ranking_y'],0);self.assertIsNone(b['cut_gold'])
        self.assertEqual(a['cut_gold']['accepted_offered_edges'],False)

    def test_missing_old_archive_never_uses_new_generation(self):
        (self.archives/'7'/'review-2026-10-08.json').unlink();row=inputs.side_inputs(self.task,'a',self.old,self.archives)
        self.assertEqual(row['status'],'missing_exact_generation_archive');self.assertIsNone(row['features']);self.assertIsNone(row['archive'])
        self.assertEqual(inputs.side_inputs(self.task,'b',self.new,self.archives)['status'],'numeric_features_available')

    def test_wrong_generation_pin_range_detector_and_source_identity_fail_closed(self):
        self.assertIsNone(inputs.exact_archive(dict(self.old,analyzed_at='2026-10-07T01:00:00'),self.archives))
        self.assertEqual(inputs.side_inputs(self.task,'a',dict(self.old,detected_end=99.),self.archives)['status'],'missing_matching_original_range')
        self.assertEqual(inputs.side_inputs(self.task,'a',dict(self.old,detector='other'),self.archives)['status'],'missing_matching_generation_detector')
        self.old_manifest['features']['index']['modelRevision']='wrong';self.write_manifest(self.old_manifest)
        self.assertEqual(inputs.side_inputs(self.task,'a',self.old,self.archives)['status'],'missing_compatible_generation_index')
        self.old_manifest['features']['index']['modelRevision']=inputs.VISUAL_PIN;self.old_manifest['source']['fileSizeBytes']=101;self.write_manifest(self.old_manifest)
        with self.assertRaisesRegex(labels.FineLabelContractError,'identity'):inputs.side_inputs(self.task,'a',self.old,self.archives)

    def test_leading_or_internal_frame_gaps_are_explicitly_missing(self):
        for t in [np.arange(20,100,5.),np.r_[0.,5.,np.arange(25,100,5.)]]:
            self.publish(self.old,t)
            result=inputs.side_inputs(self.task,'a',self.old,self.archives)
            self.assertEqual(result['status'],'missing_complete_generation_frames');self.assertIsNone(result['features'])

    def test_checksum_and_tampered_frozen_features_rejected(self):
        sidecar=self.build();row=sidecar['sides'][0];row['features'][0]+=1
        with self.assertRaisesRegex(labels.FineLabelContractError,'no longer match'):inputs.sidecar_features(sidecar,self.task,'a',self.old,self.archives)
        path=self.archives/'7'/self.old_manifest['features']['file'];data=path.read_bytes();path.write_bytes(data[:-1]+b'\x02')
        with self.assertRaisesRegex(ValueError,'checksum'):inputs.side_inputs(self.task,'a',self.old,self.archives)

    def test_sidecar_file_load_and_offered_audio_never_use_original_mean(self):
        self.assertIsNone(inputs.load_sidecar(self.root));sidecar=self.build();(self.root/'task_generation_inputs.json').write_text(json.dumps(sidecar))
        loaded=inputs.load_sidecar(self.root);self.assertEqual(loaded,sidecar)
        for row in loaded['sides']:
            self.assertEqual(row['offered_audio']['status'],'missing_exact_offered_audio')
            with self.assertRaisesRegex(labels.FineLabelContractError,'offered-audio'):inputs.require_offered_audio_identity({'generation_input':row})
        bad=copy.deepcopy(loaded);bad['sides'][0]['start']+=1
        with self.assertRaisesRegex(labels.FineLabelContractError,'range/decision'):inputs.sidecar_features(bad,self.task,'a',self.old,self.archives)

    def test_future_offered_consumer_uses_archived_features_not_latest_video_npz(self):
        import fine_audio_match as fine
        corpus=self.root/'corpus';corpus.mkdir();pref=self.root/'pref';pref.mkdir();sidecar=self.build()
        (corpus/'task_generation_inputs.json').write_text(json.dumps(sidecar));(corpus/'private_snapshot.json').write_text(json.dumps(self.snapshot));(corpus/'cohort.json').write_text(json.dumps(dict(rows=[dict(video_id=7,group='g0')],recordings=[])))
        rows=[dict(row='p000'+s,group='g0',recording='p000',y=int(s=='a'),video_id=7,task_id=7,start=15.,end=65.,base=[np.log(50),.6],path=None) for s in ('a','b')]
        (pref/'private_manifest.json').write_text(json.dumps(dict(rows=rows)))
        original=inputs.sidecar_features
        with patch.object(fine,'ROOT',corpus),patch.object(fine,'FINE',pref),patch.object(inputs,'sidecar_features',side_effect=lambda *args:original(*args,root=self.archives)):
            output=fine.cohort()
        self.assertEqual(len(output),2);np.testing.assert_allclose(output[0]['features'],sidecar['sides'][0]['features']);self.assertIsNone(output[0]['source_path'])
        with self.assertRaisesRegex(labels.FineLabelContractError,'offered-audio'):inputs.require_offered_audio_identity(output[0])

    def test_boundary_consumer_keeps_cut_gold_and_reads_exact_frames_without_cheap_audio(self):
        import raw_original_boundaries as raw
        import frame_cuts as cuts
        corpus=self.root/'corpus';corpus.mkdir();sidecar=self.build();(corpus/'task_generation_inputs.json').write_text(json.dumps(sidecar));(corpus/'private_snapshot.json').write_text(json.dumps(self.snapshot));path=corpus/'cohort.json';path.write_text(json.dumps(dict(recordings=[dict(video_id=7,group='g0')])))
        original=inputs.sidecar_features
        with patch.object(inputs,'sidecar_features',side_effect=lambda *args:original(*args,root=self.archives)):
            rows,_=raw.targets(path)
        self.assertEqual(len(rows),1);self.assertEqual(rows[0]['task_generation_input']['feedback']['id'],10);self.assertEqual(rows[0]['analyzed_at'],self.old['analyzed_at']);self.assertEqual(rows[0]['selected_start'],20.)
        loader=inputs.archived_frame_inputs
        second=dict(rows[0],row='new',analyzed_at=self.new['analyzed_at'],task_generation_input=dict(feedback=self.new,archive=sidecar['sides'][1]['archive']))
        with patch.object(inputs,'archived_frame_inputs',side_effect=lambda *args:loader(*args,root=self.archives)),patch.object(cuts.np,'load',side_effect=AssertionError('latest NPZ/audio must not be opened')):
            built=cuts.build([rows[0],second],corpus)
        self.assertEqual(len(built),2);self.assertFalse(built[0]['audio_present']);self.assertFalse(np.array_equal(built[0]['X'][:,:1152],built[1]['X'][:,:1152]))

if __name__=='__main__':unittest.main()
