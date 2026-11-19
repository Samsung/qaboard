"""Tests for qaboard/junit.py: JUnit XML test reports as metrics. The web app reads the same files (webapp/src/viewers/junit/parse.js)."""
import json
import tempfile
import unittest
from pathlib import Path

from qaboard.benchmarks import is_benchmarks
from qaboard.junit import is_junit, junit_metrics, read_junit

from .test_benchmarks import imported_modules

REPORT = """<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="pytest" tests="7">
    <testcase classname="tests.test_codec" name="test_ok" time="0.5"/>
    <testcase classname="tests.test_codec" name="test_failed" time="1,000.25"><failure message="expected 3">trace</failure></testcase>
    <testcase classname="tests.test_codec" name="test_error"><error message="boom"/></testcase>
    <testcase classname="tests.test_codec" name="test_skipped"><skipped message="later"/></testcase>
    <testcase classname="tests.test_codec" name="test_flaky"><flakyFailure message="once"/></testcase>
    <testcase classname="tests.test_codec" name="test_rerun"><rerunFailure message="once"/></testcase>
    <testsuite name="Codec">
      <testcase name="DISABLED_Roundtrip" status="notrun"/>
      <testcase name="Skipped" result="skipped"/>
    </testsuite>
  </testsuite>
</testsuites>
"""


class TestJunit(unittest.TestCase):
  def write(self, content, name='junit.xml'):
    directory = tempfile.TemporaryDirectory()
    self.addCleanup(directory.cleanup)
    path = Path(directory.name) / name
    path.write_text(content)
    return path

  def test_cases_and_their_status(self):
    cases = read_junit(self.write(REPORT))
    self.assertEqual([(case['id'], case['status']) for case in cases], [
      ('tests.test_codec::test_ok', 'passed'), ('tests.test_codec::test_failed', 'failed'), ('tests.test_codec::test_error', 'error'),
      ('tests.test_codec::test_skipped', 'skipped'), ('tests.test_codec::test_flaky', 'flaky'), ('tests.test_codec::test_rerun', 'flaky'),
      # without a classname, the suite's name
      ('Codec::DISABLED_Roundtrip', 'skipped'), ('Codec::Skipped', 'skipped'),
    ])
    self.assertEqual([case['time'] for case in cases[:3]], [0.5, 1000.25, 0.0])

  def test_metrics(self):
    metrics = junit_metrics(self.write(REPORT))
    self.assertEqual({key: float(value) for key, value in metrics.items()},
                     {'tests': 8, 'passed': 1, 'failed': 1, 'errors': 1, 'skipped': 3, 'flaky': 2, 'test_time': 1000.75})
    self.assertEqual(metrics['tests'].definition['smaller_is_better'], False)
    self.assertEqual((metrics['failed'].definition['smaller_is_better'], metrics['failed'].definition['target']), (True, 0))
    self.assertEqual(sorted(junit_metrics(read_junit(self.write(REPORT)), prefix='unit_'))[0], 'unit_errors')

  def test_metrics_are_grouped_and_add_up(self):
    metrics = junit_metrics(self.write(REPORT))
    self.assertEqual({key: metric.definition.get('group') for key, metric in metrics.items()}, dict.fromkeys(metrics, 'Tests'))
    self.assertEqual({key: metric.definition.get('aggregation') for key, metric in metrics.items()}, dict.fromkeys(metrics, 'sum'))
    self.assertEqual({key: (metric.definition.get('part_of'), metric.definition.get('intent')) for key, metric in metrics.items()}, {
      'tests': (None, None), 'passed': ('tests', 'success'), 'failed': ('tests', 'danger'), 'errors': ('tests', 'danger'),
      'skipped': ('tests', 'none'), 'flaky': ('tests', 'warning'), 'test_time': (None, None),
    })
    # parts point at the prefixed total
    unit = junit_metrics(self.write(REPORT), prefix='unit_', group='Tests/unit')
    self.assertEqual((unit['unit_failed'].definition['part_of'], unit['unit_failed'].definition['group']), ('unit_tests', 'Tests/unit'))
    # all valid definitions
    from qaboard.metrics import clean_definition
    for metric in [*metrics.values(), *unit.values()]:
      self.assertEqual(clean_definition(metric.definition)[1], [])

  def test_a_single_suite_and_an_empty_report(self):
    self.assertEqual(float(junit_metrics(self.write('<testsuite name="s"><testcase name="t"/></testsuite>'))['tests']), 1)
    self.assertEqual(read_junit(self.write('<testsuite name="s"><testcase name="t"/></testsuite>'))[0]['id'], 's::t')
    self.assertEqual(float(junit_metrics(self.write('<testsuites/>'))['tests']), 0)

  def test_files_that_are_not_reports(self):
    for content in ('<html><body/></html>', 'not xml', ''):
      with self.assertRaises(ValueError) as e:
        read_junit(self.write(content))
      self.assertIn('is not a JUnit XML report', str(e.exception))

  def test_names_like_the_web_app(self):
    # the same names as webapp/src/viewers/__tests__/fileTypes.test.js
    names = json.loads((Path(__file__).parent / 'fixtures' / 'file-types.json').read_text())
    for is_kind, kind in ((is_junit, 'junit'), (is_benchmarks, 'benchmarks')):
      for name in names[kind]['yes']:
        self.assertTrue(is_kind(name), name)
      for name in names[kind]['no']:
        self.assertFalse(is_kind(name), name)

  def test_imports_only_the_standard_library(self):
    import sys
    path = Path(__file__).resolve().parent.parent / 'qaboard' / 'junit.py'
    allowed = set(sys.stdlib_module_names) | {'.metrics'}
    for name in imported_modules(path):
      self.assertTrue((name if name.startswith('.') else name.split('.')[0]) in allowed, f'junit.py imports {name}')


if __name__ == '__main__':
  unittest.main()
