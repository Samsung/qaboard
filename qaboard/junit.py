"""
JUnit XML test reports as QA-Board metrics: the format most test runners write.

    pytest --junitxml=junit.xml               ctest --output-junit junit.xml
    ./tests --gtest_output=xml:junit.xml       cargo nextest (junit in .config/nextest.toml)
    go test -json | go-junit-report            jest --reporters=jest-junit, Gradle, Maven Surefire...

    from qaboard.junit import junit_metrics

    def run(context):
      subprocess.run(["pytest", "tests/", f"--junitxml={context.output_dir}/junit.xml"])
      return junit_metrics(context.output_dir / "junit.xml")

`qa upload junit.xml` does the same without a run(): it saves the report as a run and reads its metrics.
The web app shows the same file against the reference run's (the test viewer, webapp/src/viewers/junit/), and reads
statuses the same way (parse.js): failed and error, skipped (also GoogleTest's disabled tests), and flaky for tests
that failed then passed when run again (<flakyFailure>, as Maven Surefire and Gradle write them).

Like qaboard/benchmarks.py: only the standard library and qaboard.metrics.
Docs: /docs/viewers#test-reports
"""
import re
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path
from typing import Any, Dict, Iterable, List, Union

from .metrics import Metric

STATUSES = ('passed', 'failed', 'error', 'skipped', 'flaky')
# Like the web app (is_junit in webapp/src/viewers/fileTypes.js, both tested on tests/fixtures/file-types.json):
# junit.xml, report.junit.xml, Maven's and Gradle's TEST-*.xml
FILE_PATTERN = re.compile(r'(^|/)(junit|[^/]*[._-]junit|TEST-[^/]*)\.xml$', re.IGNORECASE)


def is_junit(path: Union[str, Path]) -> bool:
  """Whether a file is named like a JUnit XML report, as the web app's test viewer recognizes them"""
  return bool(FILE_PATTERN.search(Path(path).as_posix()))


def _float(value: Any) -> float:
  try:
    return float(str(value).replace(',', ''))
  except (TypeError, ValueError):
    return 0.0


def _status(case: ET.Element) -> str:
  if case.find('failure') is not None:
    return 'failed'
  if case.find('error') is not None:
    return 'error'
  # gtest: DISABLED_ tests are status="notrun", GTEST_SKIP() result="skipped"
  if case.find('skipped') is not None or case.get('status') == 'notrun' or case.get('result') == 'skipped':
    return 'skipped'
  # Maven Surefire and Gradle: failed, then passed when run again
  if any(case.find(tag) is not None for tag in ('flakyFailure', 'flakyError', 'rerunFailure')):
    return 'flaky'
  return 'passed'


def read_junit(path: Union[str, Path]) -> List[Dict[str, Any]]:
  """
  The test cases of a JUnit XML report, in the file's order: {id, classname, name, status, time}.
  `id` is "classname::name", what tests are matched by from a commit to the next; `time` is in seconds.
  Raises ValueError for files that aren't JUnit XML.
  """
  try:
    root = ET.parse(str(path)).getroot()
  except ET.ParseError as e:
    raise ValueError(f"{path} is not a JUnit XML report: {e}") from None
  if root.tag not in ('testsuites', 'testsuite', 'testcase'):
    raise ValueError(f"{path} is not a JUnit XML report: its root is <{root.tag}>, not <testsuites> or <testsuite>")
  cases = []
  for case, suite in _cases(root, ''):
    classname, name = case.get('classname') or suite, case.get('name') or ''
    cases.append({
      'id': f"{classname}::{name}" if classname else name, 'classname': classname, 'name': name,
      'status': _status(case), 'time': _float(case.get('time')),
    })
  return cases


def _cases(element: ET.Element, suite: str) -> Iterable:
  if element.tag == 'testcase':
    yield element, suite
    return
  if element.tag == 'testsuite':
    suite = element.get('name') or suite
  for child in element:
    if child.tag in ('testsuite', 'testcase'):
      yield from _cases(child, suite)


def junit_metrics(path_or_cases: Union[str, Path, Iterable[Dict[str, Any]]], prefix: str = '') -> Dict[str, Metric]:
  """
  Metrics to return from run(), from a JUnit XML report (or the cases of `read_junit`): how many tests it has
  (`tests`), how many `passed`, `failed`, had `errors`, were `skipped` or `flaky`, and their total time (`test_time`).
  - prefix: for the keys, e.g. "unit_" when a run returns several reports.
  A failing test doesn't fail the run: the run measured it. Fewer `tests` than the reference says tests were removed.
  """
  cases = read_junit(path_or_cases) if isinstance(path_or_cases, (str, Path)) else list(path_or_cases)
  counts = Counter(case['status'] for case in cases)
  metrics = {
    'tests': Metric(len(cases), label='Tests', smaller_is_better=False, precision=6),
    'passed': Metric(counts['passed'], label='Passed', smaller_is_better=False, precision=6),
    'failed': Metric(counts['failed'], label='Failed', smaller_is_better=True, target=0, precision=6),
    'errors': Metric(counts['error'], label='Errors', smaller_is_better=True, target=0, precision=6),
    'skipped': Metric(counts['skipped'], label='Skipped', smaller_is_better=True, precision=6),
    'flaky': Metric(counts['flaky'], label='Flaky', smaller_is_better=True, precision=6),
    'test_time': Metric(sum(case['time'] for case in cases), label='Test time', suffix=' s', smaller_is_better=True),
  }
  return {f"{prefix}{key}": metric for key, metric in metrics.items()}
