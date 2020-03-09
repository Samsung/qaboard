"""
TODO: Write more tests.
https://docs.python.org/3/library/unittest.html
"""
import unittest

class TestConventions(unittest.TestCase):
  def test_flatten(self):
    from qaboard.iterators import flatten
    self.assertEqual(list(flatten([])), [])
    self.assertEqual(list(flatten([1])), [1])
    self.assertEqual(list(flatten([1, [2]])), [1, 2])
    self.assertEqual(list(flatten([1, [2], [3, 4, [5], [6, [7]]] ])), [1, 2, 3, 4, 5, 6, 7])
    self.assertEqual(list(flatten([1, {"cde": [2, 3]} ])), [1, {"cde": [2, 3]}])

  def test_resolve_aliases(self):
    from qaboard.iterators import resolve_aliases
    self.assertEqual(
        list(resolve_aliases(["a", "b"], {"c": ["d", "e"], "f": ["g", "h"]})),
        ['a', 'b']
    )
    self.assertEqual(
        list(resolve_aliases(["ci", "xxxxx"], {"ci": ["a", "b"], "b": ["e", "f"]})),
        ['a', 'e', 'f', 'xxxxx']
    )
    self.assertEqual(
        list(resolve_aliases(["branch-specific"],  {'chain': ['remosaic', 'hdr3', 'hdr-2'], 'branch-specific': ['small-group']})),
        ['small-group']
    )
    self.assertEqual(
        list(resolve_aliases(["self-referential"],  {'chain': ['self-referential']})),
        ['self-referential']
    )

  def test_match(self):
    from qaboard.iterators import match
    metadata = {"Sensor": "HM4"}
    # exact match
    self.assertEqual(match(metadata, {"Sensor": "HM4"}), True)
    self.assertEqual(match(metadata, {"Sensor": "HM2"}), False)
    # array of options
    self.assertEqual(match(metadata, {"Sensor": ["HM2", "HM4"]}), True)
    # wildcards
    self.assertEqual(match(metadata, {"Sensor": "HM*"}), True)
    # case insensitive
    self.assertEqual(match(metadata, {"Sensor": "hm4"}), True)
    # multiple filters
    metadata = {"Sensor": "HM4"}
    self.assertEqual(match(metadata, {"Sensor": "HM4", "Binning": "4"}), False)
    metadata = {"Sensor": "HM4", "Binning": "4"}
    self.assertEqual(match(metadata, {"Sensor": "HM4", "Binning": "4"}), True)
    # booleans
    metadata = {"Binning": False}
    self.assertEqual(match(metadata, {"Binning": False}), True)
    # numbers
    metadata = {"Distance": 5}
    self.assertEqual(match(metadata, {"Distance": 3}), False)
    self.assertEqual(match(metadata, {"Distance": 5}), True)
    self.assertEqual(match(metadata, {"Distance": ">=5"}), True)

if __name__ == '__main__':
  unittest.main()
