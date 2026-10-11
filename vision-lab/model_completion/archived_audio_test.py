"""Disposable numeric fixtures: no source media, database, inference or GPU."""
import hashlib
import json
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import archived_audio as archive


class FrozenAudioTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.directory = self.root/'7'; self.directory.mkdir()
        self.row = dict(row='r00000',video_id=7,feedback_id=4,clip_id='h0',analyzed_at='2026-10-10T00:00:00.319000',detected_start=10.,detected_end=60.)
        index = dict(modelRevision='siglip2/so400m-patch16-256',storyboardGeneratedAt='2026-10-09T23:00:00.000Z',indexedAt='2026-10-09T23:01:00.000Z',intervalSeconds=5,frameCount=1)
        self.manifest = dict(format='kura-recording-training',version=1,source=dict(videoId=7,fileName='neutral.fixture',fileHash=None,fileSizeBytes=100,durationSeconds=100.),analyzedAt='2026-10-10T00:00:00.319Z',features=dict(index=index,dimension=1152),proposals=[dict(id='h0',start_seconds=10.,end_seconds=60.)])
        identity = archive.feature_identity(self.manifest)
        header = json.dumps(dict(version=1,identity=identity,index=index,dimension=1152,timestamps='float64-le',embeddings='float32-le'),separators=(',',':')).encode()
        raw=b'KURAFEAT'+struct.pack('<I',len(header))+header+struct.pack('<d',0)+np.zeros(1152,dtype='<f4').tobytes()
        self.framefile=self.directory/f'features-{identity}.bin';self.framefile.write_bytes(raw)
        self.manifest['features'].update(file=self.framefile.name,identity=identity,sha256=hashlib.sha256(raw).hexdigest(),bytes=len(raw))
        self.vector=np.zeros(768);self.vector[0]=1
        self.payload=dict(modelRevision=archive.PIN,proposals=[dict(id='h0',start_seconds=10.,end_seconds=60.,embedding=self.vector.tolist())])
        self.publish()

    def publish(self):
        raw=json.dumps(self.payload,separators=(',',':')).encode();digest=hashlib.sha256(raw).hexdigest()
        self.audiofile=self.directory/f'audio-{digest}.json';self.audiofile.write_bytes(raw)
        self.manifest['audio_features']=dict(file=self.audiofile.name,sha256=digest,bytes=len(raw),modelRevision=archive.PIN,featureIdentity=self.manifest['features']['identity'])
        self.save_manifest()

    def save_manifest(self):
        (self.directory/'review-1791590400319.json').write_text(json.dumps(self.manifest))

    def test_numeric_audio_survives_absent_source_and_catalog(self):
        np.testing.assert_array_equal(archive.embedding(self.row,self.root),self.vector.astype(np.float32))
        self.assertFalse((self.root/'neutral.fixture').exists())

    def test_wrong_generation_range_pin_are_not_reused(self):
        for field,value in [('analyzed_at','2026-10-10T00:00:01.319000'),('detected_start',11.),('clip_id','h1')]:
            self.assertIsNone(archive.embedding(dict(self.row,**{field:value}),self.root))
        self.manifest['audio_features']['modelRevision']='other';self.save_manifest()
        self.assertIsNone(archive.embedding(self.row,self.root))

    def test_checksum_corruption_is_rejected(self):
        raw=self.audiofile.read_bytes();self.audiofile.write_bytes(raw.replace(b'"h0"',b'"h1"'))
        with self.assertRaisesRegex(ValueError,'checksum'):archive.embedding(self.row,self.root)

    def test_frame_and_source_identity_corruption_is_rejected(self):
        self.manifest['source']['fileSizeBytes']+=1;self.save_manifest()
        with self.assertRaisesRegex(ValueError,'identity'):archive.embedding(self.row,self.root)
        self.manifest['source']['fileSizeBytes']-=1;self.save_manifest()
        raw=self.framefile.read_bytes();self.framefile.write_bytes(raw[:-1]+b'\x01')
        with self.assertRaisesRegex(ValueError,'checksum'):archive.embedding(self.row,self.root)

    def test_original_range_and_finite_unit_vector_required(self):
        self.payload['proposals'][0]['end_seconds']=61.;self.publish()
        with self.assertRaisesRegex(ValueError,'range'):archive.embedding(self.row,self.root)
        self.payload['proposals'][0]['end_seconds']=60.;self.payload['proposals'][0]['embedding'][0]=0.;self.publish()
        with self.assertRaisesRegex(ValueError,'vector'):archive.embedding(self.row,self.root)

    def test_audio_complete_existing_snapshot_restores_numeric_checkpoint(self):
        import audio_complete as complete
        output=self.root/'output';output.mkdir();(output/'private_manifest.json').write_text(json.dumps(dict(rows=[self.row])))
        load=archive.embedding
        with patch.object(complete,'OUT',output),patch.object(archive,'embedding',side_effect=lambda row:load(row,self.root)):
            complete.snapshot()
            np.testing.assert_array_equal(complete.validate_checkpoint(self.row),self.vector.astype(np.float32))
            with np.load(complete.rowpath(self.row),allow_pickle=False) as z:
                self.assertEqual(str(z['source_kind']),'validated_frozen_audio_snapshot')

    def test_js_identity_number_spelling(self):
        self.assertEqual(archive.js_json([100.,1e-7,1e-6,1e21]),'[100,1e-7,0.000001,1e+21]')

if __name__=='__main__':unittest.main()
