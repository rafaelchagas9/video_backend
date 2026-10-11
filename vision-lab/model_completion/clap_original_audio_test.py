"""Pure synthetic contract tests: no pretrained model, media extraction or fits."""
import copy, json, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import clap_original_audio as c

class ClapContracts(unittest.TestCase):
    def row(self):
        return {'row':'fine329a','original_start':100.,'original_end':140.,'dense_offsets':[100.,120.],
                'audio_start':100.,'audio_end':140.,'cache_sha256':'a'*64,'source_fingerprint':[99,123],
                'alignment':'aresample_async_first_pts_0'}
    def fixture(self):
        receipt={'rows':[]}; numeric={'rows':[]}
        for i in range(21):
            n=55 if i<15 else 54; a=float(i*10); r=self.row()
            r.update(row=f'fine{329+i}a',original_start=a,original_end=a+n*20,audio_start=a,audio_end=a+n*20,
                     dense_offsets=list(np.arange(a,a+n*20,20)),rate=16000,channels=1,complete_original_coverage=True,
                     video_id=i,feedback_id=i,clip_id='c1')
            receipt['rows'].append(r)
            numeric['rows'].append(dict(r,detected_start=a,detected_end=a+n*20,offsets=r['dense_offsets'],group=f'g{i%10:03}',selected_start=a+20,selected_end=a+40))
        return receipt,numeric
    def test_dense_sampling_ignores_gold(self):
        r,n=self.fixture(); c.validate_metadata(r,n)
        for row in n['rows']: row['selected_start']=row['detected_start']; row['selected_end']=row['detected_end']
        c.validate_metadata(r,n)
        r['rows'][0]['dense_offsets'][3]+=1
        with self.assertRaises(ValueError): c.validate_metadata(r,n)
    def test_original_and_partial_coverage_fail_closed(self):
        r,n=self.fixture(); n['rows'][0]['detected_start']+=5
        with self.assertRaises(ValueError): c.validate_metadata(r,n)
        r,n=self.fixture(); r['rows'][0]['audio_end']-=1
        with self.assertRaises(ValueError): c.validate_metadata(r,n)
    def test_half_geometry_resample_preserves20s(self):
        x=np.sin(2*np.pi*440*np.arange(320000)/16000).astype(np.float32)*.1
        halves=c.halves(x); self.assertEqual([len(h) for h in halves],[480000,480000])
        self.assertTrue(np.allclose(halves[0][3000:300000:3],x[1000:100000],atol=.001))
        with self.assertRaises(ValueError): c.halves(x[:-1])
        x[0]=np.nan
        with self.assertRaises(ValueError): c.halves(x)
    def test_unit_mean_normalizes_halves_before_pooling(self):
        values=np.zeros((1,2,512),np.float32); values[0,0,0]=2; values[0,1,1]=10
        pooled=c.unit_mean(values); self.assertAlmostEqual(float(pooled[0,0]),2**-.5,places=6)
        self.assertAlmostEqual(float(pooled[0,1]),2**-.5,places=6)
        values[0,1]=0
        with self.assertRaises(ValueError): c.unit_mean(values)
    def test_checkpoint_prefix_cannot_enter_primary_cohort(self):
        r=self.row(); v=np.ones((1,512),np.float32)/np.sqrt(512)
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'fine329a.npz'; c.checkpoint(path,v,r,'b'*64)
            c.validate_checkpoint(path,r,'b'*64,require_complete=False)
            with self.assertRaises(ValueError): c.validate_checkpoint(path,r,'b'*64)
            self.assertEqual(path.stat().st_mode&0o777,0o600)
            self.assertFalse(path.with_suffix('.partial').exists())
            with np.load(path) as z: self.assertNotIn('cache_path',z.files); self.assertNotIn('video_id',z.files)
    def test_complete_checkpoint_provenance_and_samples(self):
        r=self.row(); v=np.ones((2,512),np.float32)/np.sqrt(512)
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'fine329a.npz'; c.checkpoint(p,v,r,'b'*64); c.validate_checkpoint(p,r,'b'*64)
            changed=dict(r,source_fingerprint=[99,124])
            with self.assertRaises(ValueError): c.validate_checkpoint(p,changed,'b'*64)
            with np.load(p) as z: data={k:z[k].copy() for k in z.files}
            data['decoded_samples'][0]-=1
            with p.open('wb') as f: np.savez(f,**data)
            with self.assertRaises(ValueError): c.validate_checkpoint(p,r,'b'*64)
    def test_stored_coverage_and_identity_tampering_rejected(self):
        r=self.row(); v=np.ones((2,512),np.float32)/np.sqrt(512)
        changes={'decoded_samples':np.empty(0,dtype=int),'resampled_samples':np.empty(0,dtype=int),
                 'half_samples':np.empty((0,2),dtype=int),'source_rate':np.array(48000),
                 'input_rate':np.array(16000),'absolute_start':np.array(99.),'duration':np.array(39.),
                 'source_fingerprint':np.array([99,124]),'staged_audio_sha256':np.array('c'*64),
                 'receipt_sha256':np.array('d'*64),'alignment':np.array('unknown'),
                 'duration':np.array([40.]),'source_fingerprint':np.array([[99,123]])}
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'fine329a.npz'
            for key,value in changes.items():
                with self.subTest(key=key):
                    c.checkpoint(p,v,r,'b'*64)
                    with np.load(p) as z: data={k:z[k].copy() for k in z.files}
                    data[key]=value
                    with p.open('wb') as f: np.savez(f,**data)
                    with self.assertRaises(ValueError): c.validate_checkpoint(p,r,'b'*64)
    def test_object_source_fingerprint_fails_before_checkpoint(self):
        r,n=self.fixture(); r['rows'][0]['source_fingerprint']={'size_bytes':99,'mtime_ns':'123'}
        with self.assertRaises(ValueError): c.validate_metadata(r,n)
    def test_stage_outside_allowlist_rejected_before_read(self):
        with tempfile.TemporaryDirectory() as d:
            r=dict(self.row(),cache_path=str(Path(d)/'private-video.mp4'))
            with self.assertRaises(ValueError): c.verify_stage(r,Path(d),float('inf'))
    def test_no_padding_on_truncated_window(self):
        class Handle:
            def seek(self,i): self.position=i
            def read(self,n,dtype): return np.zeros(n-1,np.float32)
        with self.assertRaises(ValueError): c.read_window(Handle(),self.row(),100.)
    def test_measured_budget_requires_safety_margin(self):
        with patch.object(c.time,'monotonic',return_value=100.):
            self.assertTrue(c.budget_viable(1,8,1141,1200.))
            self.assertFalse(c.budget_viable(8,8,1141,1200.))
            self.assertFalse(c.budget_viable(1,0,1141,1200.))

if __name__=='__main__': unittest.main()
