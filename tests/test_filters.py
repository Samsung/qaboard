"""
qaboard/filters.py is a port of the web app's filter box (filter_batch in webapp/src/utils.js): `qaboard.runs(url)`,
`qa runs` and the server must keep the runs the web app shows.
"""
import json
import unittest
from pathlib import Path

from qaboard.filters import filter_runs, match_query, searched_text, searched_text_of

# tested by the web app too (webapp/src/__tests__/filterBatch.test.js)
FIXTURE = json.loads((Path(__file__).resolve().parent / 'fixtures' / 'filters.json').read_text())


class TestLikeTheWebApp(unittest.TestCase):
  def test_same_runs_as_the_web_app(self):
    outputs = FIXTURE['outputs']
    self.assertGreater(len(FIXTURE['cases']), 20)
    for case in FIXTURE['cases']:
      with self.subTest(filter=case['filter']):
        kept = filter_runs(case['filter'], outputs.values())
        self.assertEqual([str(o['id']) for o in kept], case['matches'])

  def test_searched_text_is_the_web_apps(self):
    # what filter_batch builds in webapp/src/utils.js, for the first run of the fixture
    text = searched_text_of(FIXTURE['outputs']['1'])
    self.assertEqual(text, 'slices/indoor/kitchen.jpg ["base",{"gain":2,"isp":{"awb":"auto"}}] {"scene":"indoor","lux":120} {"gain":2,"isp":{"awb":"auto"}} ci   status:success linux id:1')

  def test_missing_fields_like_javascript(self):
    # the web app prints a missing batch as "undefined", and nothing for empty metadata
    text = searched_text(id=3, test_input_path='a.jpg', platform='linux', configurations=['base'], extra_parameters={}, is_pending=True, is_running=True)
    self.assertEqual(text, 'a.jpg ["base"]  {} undefined  pending running  linux id:3')


class TestMatchQuery(unittest.TestCase):
  def test_regular_expressions_and_literal_fallback(self):
    self.assertTrue(match_query(r'a\.jpg')('a.jpg id:1'))
    self.assertFalse(match_query(r'a\.jpg')('abjpg id:1'))
    # an invalid regular expression matches literally, its non-word characters as wildcards
    self.assertTrue(match_query('drive (a')('videos/drive (a).mp4 id:4'))

  def test_key_value_spellings(self):
    for query in ('gain:2', 'gain=2', 'gain==2', 'gain: 2', '"gain":2'):
      self.assertTrue(match_query(query)('{"gain":2}'), query)

  def test_negative_tokens_are_substrings(self):
    matches = match_query('-crash outdoor')
    self.assertFalse(matches('outdoor fail crash'))
    self.assertTrue(matches('outdoor'))
    # a lone "-" is a word to search, not a negation of nothing
    self.assertTrue(match_query('-')('low-light'))

  def test_run_ids_are_exact(self):
    self.assertTrue(match_query('id:12')('a.jpg id:12'))
    self.assertFalse(match_query('id:12')('a.jpg id:123'))
    self.assertFalse(match_query('id:1')('a.jpg id:123'))
    self.assertTrue(match_query('-id:12')('a.jpg id:123'))
    self.assertFalse(match_query('-id:12')('a.jpg id:12'))


if __name__ == '__main__':
  unittest.main()
