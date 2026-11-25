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
A run's reports are one set of tests (`merge_reports`, like mergeJunitReports in parse.js): a test in several of them,
like the failed tests a re-run report runs again, counts once, as flaky when it failed in one and passed in another.

Like qaboard/benchmarks.py: only the standard library and qaboard.metrics.
Docs: /docs/viewers#test-reports
"""
import re
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path
from typing import Any
from collections.abc import Iterable

from .metrics import Metric

STATUSES = ('passed', 'failed', 'error', 'skipped', 'flaky')
# Like the web app (is_junit in webapp/src/viewers/fileTypes.js, both tested on tests/fixtures/file-types.json):
# junit.xml, report.junit.xml, Maven's and Gradle's TEST-*.xml
FILE_PATTERN = re.compile(r'(^|/)(junit|[^/]*[._-]junit|TEST-[^/]*)\.xml$', re.IGNORECASE)


def is_junit(path: str | Path) -> bool:
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


def read_junit(path: str | Path) -> list[dict[str, Any]]:
  """
  The test cases of a JUnit XML report, in the file's order: {id, classname, name, status, time}.
  `id` is "classname::name", what tests are matched by from a commit to the next; `time` is in seconds. A test listed
  twice in the report gets a suffix, " #2", like the web app's parser.
  Raises ValueError for files that aren't JUnit XML.
  """
  try:
    root = ET.parse(str(path)).getroot()
  except ET.ParseError as e:
    raise ValueError(f"{path} is not a JUnit XML report: {e}") from None
  if root.tag not in ('testsuites', 'testsuite', 'testcase'):
    raise ValueError(f"{path} is not a JUnit XML report: its root is <{root.tag}>, not <testsuites> or <testsuite>")
  cases = []
  seen: Counter = Counter()
  for case, suite in _cases(root, ''):
    classname, name = case.get('classname') or suite, case.get('name') or ''
    test_id = f"{classname}::{name}" if classname else name
    seen[test_id] += 1
    cases.append({
      'id': test_id if seen[test_id] == 1 else f"{test_id} #{seen[test_id]}", 'classname': classname, 'name': name,
      'status': _status(case), 'time': _float(case.get('time')),
    })
  return cases


FAILING = ('failed', 'error')


def merged_status(statuses: list[str]) -> str:
  """
  The status of a test reported several times in a run's reports (a report, then the report of the tests it ran
  again): flaky when it failed in one and passed in another (as Maven Surefire says of a test that passed when run
  again), else failed if it failed (an assertion says more than an error, e.g. in a fixture), error if it only had
  errors, passed if it ran, skipped if it never did. The order of the reports doesn't matter.
  """
  failing = [status for status in statuses if status in FAILING]
  if 'flaky' in statuses or (failing and 'passed' in statuses):
    return 'flaky'
  if failing:
    return 'failed' if 'failed' in failing else 'error'
  if 'passed' in statuses:
    return 'passed'
  return statuses[0] if statuses else 'skipped'


def merge_reports(reports: Iterable[list[dict[str, Any]]]) -> list[dict[str, Any]]:
  """
  The tests of a run's JUnit reports (the cases of `read_junit` for each), each once: reports of different tests add
  up (Maven and Gradle write a file per class), a test in several reports (a re-run of the failed tests,
  rerun.junit.xml next to junit.xml) is one test, with the status of `merged_status` and the time and place of its
  first report. Reports of different runs (inputs, configurations) aren't merged: each run has its metrics.
  """
  merged: dict[str, dict[str, Any]] = {}
  statuses: dict[str, list[str]] = {}
  for cases in reports:
    for case in cases:
      if case['id'] not in merged:
        merged[case['id']] = dict(case)
        statuses[case['id']] = []
      statuses[case['id']].append(case['status'])
  for test_id, case in merged.items():
    case['status'] = merged_status(statuses[test_id])
  return list(merged.values())


def _cases(element: ET.Element, suite: str) -> Iterable:
  if element.tag == 'testcase':
    yield element, suite
    return
  if element.tag == 'testsuite':
    suite = element.get('name') or suite
  for child in element:
    if child.tag in ('testsuite', 'testcase'):
      yield from _cases(child, suite)


def junit_metrics(path_or_cases: str | Path | Iterable[str | Path | dict[str, Any]], prefix: str = '', group: str | None = None) -> dict[str, Metric]:
  """
  Metrics to return from run(), from a JUnit XML report, several reports of the run (a list of paths, merged by
  `merge_reports`: junit_metrics([out / "junit.xml", out / "rerun.junit.xml"])), or the cases of `read_junit`: how many tests it has
  (`tests`), how many `passed`, `failed`, had `errors`, were `skipped` or `flaky`, and their total time (`test_time`).
  - prefix: for the keys, e.g. "unit_" when a run returns several reports.
  - group: where the web app shows them. By default "Tests", or "Tests/unit" with the prefix "unit_": each report
    of a run gets its own charts.
  The counts add up over a commit's runs (aggregation "sum"), and passed, failed... are parts of `tests`, so that
  the web app charts them over commits without configuration.
  A failing test doesn't fail the run: the run measured it. Fewer `tests` than the reference says tests were removed.
  """
  if isinstance(path_or_cases, (str, Path)):
    cases = read_junit(path_or_cases)
  else:
    items = list(path_or_cases)
    paths = [item for item in items if isinstance(item, (str, Path))]
    cases = merge_reports(read_junit(path) for path in paths) if paths else [item for item in items if isinstance(item, dict)]
  counts = Counter(case['status'] for case in cases)
  if not group:
    name = prefix.strip('_ /')
    group = f"Tests/{name}" if name else 'Tests'
  total = f"{prefix}tests"
  count: dict[str, Any] = dict(group=group, aggregation='sum', precision=6)
  part: dict[str, Any] = dict(count, part_of=total)
  metrics = {
    'tests': Metric(len(cases), label='Tests', smaller_is_better=False, **count),
    'passed': Metric(counts['passed'], label='Passed', smaller_is_better=False, intent='success', **part),
    'failed': Metric(counts['failed'], label='Failed', smaller_is_better=True, target=0, intent='danger', **part),
    'errors': Metric(counts['error'], label='Errors', smaller_is_better=True, target=0, intent='danger', **part),
    'skipped': Metric(counts['skipped'], label='Skipped', smaller_is_better=True, intent='none', **part),
    'flaky': Metric(counts['flaky'], label='Flaky', smaller_is_better=True, intent='warning', **part),
    'test_time': Metric(sum(case['time'] for case in cases), label='Test time', suffix=' s', smaller_is_better=True, group=group, aggregation='sum'),
  }
  return {f"{prefix}{key}": metric for key, metric in metrics.items()}
