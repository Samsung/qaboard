"""
qaboard/matching.py is a port of the web app's config_distance (webapp/src/configurations/tokens.js):
the CLI and the server must pick the reference runs the web app shows.
"""
import json
import unittest
from pathlib import Path

from qaboard.matching import closest, config_distance, config_tokens, js_number, js_stringify, run_distance, string_change

# made with the web app's config_distance, which is tested against them too (tokens.test.js)
FIXTURE = json.loads((Path(__file__).resolve().parent / 'fixtures' / 'config-distance.json').read_text())


class TestLikeTheWebApp(unittest.TestCase):
  def test_same_distances_as_the_web_app(self):
    self.assertGreater(len(FIXTURE), 50)
    for case in FIXTURE:
      with self.subTest(a=case['a'], b=case['b']):
        self.assertEqual(config_distance(case['a'], case['b']), case['distance'])

  def test_javascript_numbers(self):
    # what String(number) gives in JavaScript
    numbers = {0: '0', 1: '1', 1.0: '1', -2.0: '-2', 0.1: '0.1', 1.5e-5: '0.000015', 1e-7: '1e-7', -2.5e-8: '-2.5e-8',
               1e16: '10000000000000000', 1e21: '1e+21', 1.234e22: '1.234e+22', 12345.678: '12345.678'}
    for number, text in numbers.items():
      self.assertEqual(js_number(number), text)

  def test_javascript_json(self):
    self.assertEqual(js_stringify({'b': 1.0, '10': [True, None], '2': 'é'}), '{"2":"é","10":[true,null],"b":1}')

  def test_string_change(self):
    self.assertEqual(string_change('conf/day.yaml', 'conf/night.yaml'), {'prefix': 'conf/', 'before': 'day', 'after': 'night', 'suffix': '.yaml'})
    self.assertEqual(string_change('a.yaml', 'a.v2.yaml'), {'prefix': 'a.', 'before': '', 'after': 'v2.', 'suffix': 'yaml'})


class TestConfigDistance(unittest.TestCase):
  def test_python_floats_are_javascript_numbers(self):
    # JSON parsed by Python keeps 1.0 a float, JavaScript doesn't know the difference
    self.assertEqual(config_distance([{'gain': 1.0}], [{'gain': 1}]), 0)

  def test_booleans_are_not_numbers(self):
    tokens = config_tokens([{'flag': True}])
    self.assertEqual([t.text for t in tokens], ['true'])
    # true is not 1 (the fixture has the distances)
    self.assertNotEqual(config_distance([{'flag': True}], [{'flag': 1}]), 0)

  def test_viewers_keys_are_not_settings(self):
    self.assertEqual(config_distance([{'badges': ['x'], 'roi': [1], 'gain': 1}], [{'gain': 1}]), 0)


class TestClosestRuns(unittest.TestCase):
  def test_configurations_then_tuning_then_platform(self):
    run = {'platform': 'linux', 'configurations': ['base', {'gain': 3}], 'extra_parameters': {'lr': 0.1}}
    same = dict(run)
    other_platform = {**run, 'platform': 'windows'}
    other_tuning = {**run, 'extra_parameters': {'lr': 0.2}}
    close_config = {**run, 'configurations': ['base', {'gain': 4}]}
    far_config = {**run, 'configurations': ['base', {'gain': 100}]}
    self.assertEqual(run_distance(run, same), (0, 0, 0))
    references = [far_config, close_config, other_tuning, other_platform, same]
    self.assertEqual(closest(run, references), [same, other_platform, other_tuning, close_config, far_config])

  def test_ties_keep_their_order(self):
    run = {'platform': 'linux', 'configurations': ['base'], 'extra_parameters': {}}
    a, b = {**run, 'configurations': ['a']}, {**run, 'configurations': ['b']}
    self.assertEqual(closest(run, [a, b]), [a, b])
    self.assertEqual(closest(run, [b, a]), [b, a])


if __name__ == '__main__':
  unittest.main()
