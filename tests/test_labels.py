"""Kubernetes label values: the runners and the server must sanitize them the same way"""
import re
import unittest

from qaboard.runners.labels import label_value

valid = re.compile(r'^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$')


class TestLabelValue(unittest.TestCase):
  def test_valid_values_are_kept(self):
    for value in ("", "algo-project", "a", "A_b.c-1", "x" * 63):
      self.assertEqual(label_value(value), value)

  def test_invalid_values(self):
    for value in ("algo/project", "-x-", "x" * 64, "a/" * 40, "/", "été", "x" * 54 + "/", None, 42):
      sanitized = label_value(value)
      self.assertTrue(len(sanitized) <= 63 and valid.match(sanitized), (value, sanitized))
    self.assertEqual(label_value(None), "")
    self.assertEqual(label_value(42), "42")
    self.assertRegex(label_value("algo/project"), r'^algo-project-[0-9a-f]{8}$')

  def test_different_values_stay_different(self):
    values = ["algo/project", "algo-project", "algo.project/", "algo_project/", "x" * 64, "x" * 65]
    self.assertEqual(len({label_value(v) for v in values}), len(values))


if __name__ == '__main__':
  unittest.main()
