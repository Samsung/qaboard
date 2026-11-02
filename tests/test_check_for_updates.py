"""
Tests for the check for new qaboard versions.
"""
import unittest


class TestVersionKey(unittest.TestCase):
  def test_order(self):
    from qaboard.check_for_updates import version_key
    ordered = ['1.1.1', '1.2.0rc1', '1.2.0.dev3+g1234', '1.2', '1.2.0.post1', '1.2.1', '1.10.0', '2.0.0a1']
    # dev and rc versions of the same release are both before it, in no particular order between them
    keys = [version_key(v) for v in ordered]
    self.assertLess(keys[0], keys[1])
    self.assertEqual(keys[1], keys[2])
    self.assertLess(keys[2], keys[3])
    for a, b in zip(keys[3:], keys[4:]):
      self.assertLess(a, b)
    self.assertEqual(version_key('1.2'), version_key('1.2.0'))
    self.assertEqual(version_key('v1.2.0'), version_key('1.2.0'))

  def test_unknown(self):
    from qaboard.check_for_updates import version_key
    self.assertIsNone(version_key('unknown'))
    self.assertIsNone(version_key(''))


if __name__ == '__main__':
  unittest.main()
