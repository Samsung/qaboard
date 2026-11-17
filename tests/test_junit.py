"""Tests for qaboard/junit.py: JUnit XML test reports as metrics. The web app reads the same files (webapp/src/viewers/junit/parse.js)."""
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
    # is_junit and is_benchmarks in webapp/src/viewers/OutputViewer.jsx give the same answers
    for name in ('junit.xml', 'JUnit.xml', 'report.junit.xml', 'unit-junit.xml', 'tests_junit.xml', 'reports/TEST-com.example.CodecTest.xml'):
      self.assertTrue(is_junit(name), name)
    for name in ('results.xml', 'junit.xml.gz', 'myjunit.xml', 'junit.json', 'tests.xml'):
      self.assertFalse(is_junit(name), name)
    for name in ('benchmarks.json', 'pytest.benchmarks.json', 'out/codec-bench.jsonl', 'gbench_benchmark.json', 'x.Benchmarks.NDJSON'):
      self.assertTrue(is_benchmarks(name), name)
    for name in ('bench.json', 'benchmarks.txt', 'mybenchmarks.json', 'workbench.json'):
      self.assertFalse(is_benchmarks(name), name)

  def test_imports_only_the_standard_library(self):
    import sys
    path = Path(__file__).resolve().parent.parent / 'qaboard' / 'junit.py'
    allowed = set(sys.stdlib_module_names) | {'.metrics'}
    for name in imported_modules(path):
      self.assertTrue((name if name.startswith('.') else name.split('.')[0]) in allowed, f'junit.py imports {name}')


if __name__ == '__main__':
  unittest.main()
