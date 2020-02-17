"""
TODO: Write more tests.
https://docs.python.org/3/library/unittest.html
"""
import unittest


class TestConventions(unittest.TestCase):
  def test_serialize_config(self):
    from qaboard.conventions import serialize_config
    self.assertEqual(serialize_config(['a', 'b', 'c']), 'a:b:c')
    self.assertEqual(serialize_config(['a', {'b': 1}]), 'a:{"b": 1}')
    self.assertEqual(serialize_config(['a', '{"b":1']), 'a:{"b":1')

  def test_deserialize_config(self):
    from qaboard.conventions import deserialize_config
    self.assertEqual(deserialize_config('a:b:c'), ['a', 'b', 'c'])
    self.assertEqual(deserialize_config('a:{"b":1}'), ['a', {'b': 1}])
    self.assertEqual(deserialize_config('a:{"b":1'), ['a', '{"b":1'])
    # we do those adjustments only on windows...
    # self.assertEqual(deserialize_config('a:C://path:b'), ['a', 'C://path', 'b'])
    # self.assertEqual(deserialize_config('C://path:a'), ['C://path', 'a'])


if __name__ == '__main__':
  unittest.main()
