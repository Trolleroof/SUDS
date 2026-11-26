"""Offline replay of LaWAM-style action chunks at fixed inference delays."""

import unittest
from itertools import pairwise

from lawam_handoff import handoff_weights


class HandoffTests(unittest.TestCase):
    def test_peak_joint_step_under_latency(self):
        # A 24-action prediction arrives 9 ticks after observation step 10.
        # The controller has executed through step 18 and the old plan ends at 24.
        incoming = range(19, 34)
        weights = handoff_weights(set(range(19, 25)), incoming, 6)
        new_targets = [0] + [10 * weights.get(step, 1) for step in incoming]
        legacy_targets = [0] + [7] * 6 + [10] * 9
        peak = max(abs(b - a) for a, b in pairwise(new_targets))
        self.assertAlmostEqual(peak, 2.96)
        self.assertLess(peak, max(abs(b - a) for a, b in pairwise(legacy_targets)))

    def test_tapers_to_new_plan_if_less_overlap_remains(self):
        self.assertEqual(handoff_weights({19, 20, 21}, range(19, 24), 6), {19: 0, 20: 0.5, 21: 1})
        self.assertEqual(handoff_weights({19}, range(19, 24), 6), {19: 0})
        self.assertEqual(handoff_weights({18}, range(19, 24), 6), {})


if __name__ == "__main__":
    unittest.main()
