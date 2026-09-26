import unittest

import numpy as np

from vision_service.copy_match import HOP, align_pair, group_by_offset, self_join

rng = np.random.default_rng(7)


def random_fp(n: int) -> np.ndarray:
    return rng.integers(0, 2**32, size=n, dtype=np.uint64).astype(np.uint32)


def noisy(fp: np.ndarray, flip_rate: float) -> np.ndarray:
    bits = rng.random((fp.size, 32)) < flip_rate
    mask = (bits * (1 << np.arange(32, dtype=np.uint64))).sum(axis=1).astype(np.uint32)
    return fp ^ mask


class CopyMatchTests(unittest.TestCase):
    def test_clip_is_retrieved_at_its_offset_with_full_coverage(self):
        source = random_fp(8000)
        fps = {1: source, 2: random_fp(6000), 3: noisy(source[3000:3400], 0.03), 4: random_fp(500)}
        candidates = self_join(fps)
        self.assertEqual(list(candidates), [(1, 3)])
        offset, votes = candidates[(1, 3)][0]
        self.assertEqual(offset, 3000)
        self.assertGreaterEqual(votes, 40)
        segments = align_pair(fps[1], fps[3], candidates[(1, 3)])
        self.assertEqual(len(segments), 1)
        seg = segments[0]
        self.assertEqual(seg.offset, 3000)
        # the smoothing window trims at most a few items at each edge
        self.assertLessEqual(seg.b0, 25)
        self.assertGreaterEqual(seg.b1, 375)
        self.assertLess(seg.ber, 0.1)
        self.assertGreater(seg.contrast, 0.3)

    def test_stationary_audio_matches_at_every_offset_and_is_rejected(self):
        # a repeating 4-item pattern (hum, tone) shared by two unrelated recordings
        hum = np.tile(random_fp(4), 150)
        a = np.concatenate([random_fp(1000), hum, random_fp(1000)])
        b = np.concatenate([random_fp(700), noisy(hum, 0.02), random_fp(700)])
        self.assertEqual(align_pair(a, b, [(300, 200)]), [])

    def test_stop_word_codes_do_not_create_candidates(self):
        silence = np.zeros(400, dtype=np.uint32)
        fps = {
            1: np.concatenate([random_fp(500), silence, random_fp(500)]),
            2: np.concatenate([random_fp(300), silence, random_fp(900)]),
        }
        self.assertEqual(self_join(fps), {})

    def test_audio_gap_yields_two_alignments(self):
        source = random_fp(5000)
        # a recording that dropped 200 items of audio between two parts
        b = np.concatenate([noisy(source[1000:1600], 0.03), noisy(source[1800:2600], 0.03)])
        candidates = self_join({1: source, 2: b})
        segments = align_pair(source, b, candidates[(1, 2)])
        self.assertEqual(sorted(g[0].offset for g in group_by_offset(segments)), [1000, 1200])
        self.assertGreaterEqual(sum(s.b1 - s.b0 for s in segments), 1300)

    def test_focus_limits_pairs_to_new_videos(self):
        source = random_fp(3000)
        fps = {1: source, 2: noisy(source[:1000], 0.02), 3: noisy(source[1000:2000], 0.02)}
        self.assertEqual(set(self_join(fps)), {(1, 2), (1, 3)})
        self.assertEqual(set(self_join(fps, focus={3})), {(1, 3)})

    def test_items_are_spaced_by_the_chromaprint_hop(self):
        self.assertAlmostEqual(HOP, 0.12383, places=4)


if __name__ == "__main__":
    unittest.main()
