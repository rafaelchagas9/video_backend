import hashlib,tempfile,unittest
from pathlib import Path
import numpy as np
from PIL import Image
import pixel_temporal_boundaries as p
class PixelContractTest(unittest.TestCase):
 def test_page_fingerprint_hash_device(self):
  with tempfile.TemporaryDirectory() as d:
   f=Path(d)/'neutral.webp';f.write_bytes(b'neutral');fp=p.fingerprint(f);dev=f.stat().st_dev
   self.assertEqual(p.checked_bytes(f,fp,dev,hashlib.sha256(b'neutral').hexdigest())[0],b'neutral')
   for bad in ([fp[0]+1,fp[1]],[fp[0],fp[1]+1]):
    with self.assertRaises(ValueError):p.checked_bytes(f,bad,dev)
   with self.assertRaises(ValueError):p.checked_bytes(f,fp,dev,'wrong')
   with self.assertRaises(ValueError):p.checked_bytes(f,fp,dev+1)
 def test_crop_partial_page_and_resize(self):
  sheet=Image.new('L',(500,180),255);gray=p.tile_gray(sheet,9,100,90)
  self.assertEqual(gray.shape,(86,96));self.assertTrue(np.all(gray==1))
  with self.assertRaises(ValueError):p.tile_gray(sheet,10,100,90)
 def test_window_half_open_and_cadence(self):
  t=np.arange(0,45,5.);np.testing.assert_array_equal(p.window_indices(t,5),[1,2,3,4])
  with self.assertRaises(ValueError):p.window_indices([0,5,11,15],0)
  with self.assertRaises(ValueError):p.window_indices(t,35)
 def test_diagnosed_missing_first_page(self):
  t=np.arange(0,2520,5.)
  np.testing.assert_array_equal(p.window_indices(t,1495,{12,13}),[300,301,302])
  with self.assertRaises(ValueError):p.window_indices(t,1490,{12,13})
 def test_exact_four_features(self):
  np.testing.assert_allclose(p.pixel_features([1,3,2],[.1,.3]),[.2,.3,2,1.5])
  with self.assertRaises(ValueError):p.pixel_features([1,2,3],[.1])
 def test_exact_zero_mass_guard(self):
  d=p.exact_zero_diagnostic([0]*7+[.1]*3);self.assertAlmostEqual(d['exact_probability_all_resampled_channels_zero'],.7**10);self.assertTrue(d['exact_lower_95percent_gain_cannot_be_positive'])
  self.assertFalse(p.exact_zero_diagnostic([-.1,0,.1])['exact_lower_95percent_gain_cannot_be_positive'])
if __name__=='__main__':unittest.main()
