"""
TODO: Write more tests.
https://docs.python.org/3/library/unittest.html
"""
import unittest


class TestConventions(unittest.TestCase):
  def test_serialize(self):
    from qatools.conventions import serialize_config
    self.assertEqual(serialize_config(['a', 'b', 'c']), 'a:b:c')
    self.assertEqual(serialize_config(['a', {'b': 1}]), 'a:{"b": 1}')
    self.assertEqual(serialize_config(['a', '{"b":1']), 'a:{"b":1')

  def deserialize_config(self):
    from qatools.conventions import deserialize
    self.assertEqual(deserialize_config('a:b:c'), ['a', 'b', 'c'])
    self.assertEqual(deserialize_config('a:{"b":1}'), ['a', {'b': 1}])
    self.assertEqual(deserialize_config('a:{"b":1'), ['a', '{"b":1'])
    self.assertEqual(deserialize_config('a:C://path:b'), ['a', 'C://path', 'b'])


if __name__ == '__main__':
  unittest.main()
