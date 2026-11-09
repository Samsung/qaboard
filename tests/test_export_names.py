"""
qaboard/export_names.py names exported files. The web app's port (webapp/src/export/names.js) shows the same names
before exporting: both are tested against tests/fixtures/export-names.json.
"""
import json
import unittest
from pathlib import Path

from qaboard.export_names import ExportNameError, file_name, input_fields, split_extension

FIXTURE = json.loads((Path(__file__).resolve().parent / 'fixtures' / 'export-names.json').read_text())


class TestExportNames(unittest.TestCase):
  def test_like_the_web_app(self):
    self.assertGreater(len(FIXTURE['names']), 30)
    for case in FIXTURE['names']:
      with self.subTest(template=case['template'], file=case['file'], separator=case['separator']):
        if case.get('error'):
          with self.assertRaises(ExportNameError):
            file_name(case['template'], case['fields'], case['file'], case['separator'], windows=case['windows'])
        else:
          self.assertEqual(file_name(case['template'], case['fields'], case['file'], case['separator'], windows=case['windows']), case['name'])

  def test_inputs_and_extensions(self):
    for case in FIXTURE['inputs']:
      self.assertEqual(input_fields(case['path']), {'input': case['input'], 'input_name': case['input_name']})
    for case in FIXTURE['extensions']:
      self.assertEqual(list(split_extension(case['path'])), case['split'])

  def test_empty_fields_take_their_separator_along(self):
    fields = {'input': 'a', 'file': 'out', 'side': 'new'}
    self.assertEqual(file_name('{input}__{settings}__{file}__{side}', fields, 'out.png'), 'a__out__new.png')
    self.assertEqual(file_name('{input}__{settings}__{file}__{side}', {**fields, 'settings': 'gain=4'}, 'out.png'), 'a__gain=4__out__new.png')
    # folders stay
    self.assertEqual(file_name('{side}/{input}__{file}', {**fields, 'side': ''}, 'out.png'), 'a__out.png')

  def test_names_stay_in_the_export(self):
    for template, fields, separator in [('{input}/{file}', {'input': '../..'}, '/'), ('{input}/{file}', {'input': '..'}, '_')]:
      with self.assertRaises(ExportNameError):
        file_name(template, fields, 'x.png', separator)
    self.assertFalse(file_name('{input}/{file}', {'input': '/etc'}, 'passwd', '/').startswith('/'))
