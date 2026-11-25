"""
Fake test suites, for the development server's data (scripts/dev.py seed): each input names a suite, whose tests and
benchmarks depend on the commit's flags (build/flags.json, written by the seeder): `broken` (test names that fail),
`flaky`, `slowdown` (a factor on the benchmarks' times). Writes a JUnit XML report and a benchmarks file.
"""
import json
import hashlib
from pathlib import Path
from xml.sax.saxutils import quoteattr

from qaboard.junit import junit_metrics
from qaboard.benchmarks import benchmark_metrics, write_benchmarks


def flags() -> dict:
  path = Path('build/flags.json')
  return json.loads(path.read_text()) if path.exists() else {}


def uniform(*parts) -> float:
  return int(hashlib.sha256(':'.join(map(str, parts)).encode()).hexdigest()[:8], 16) / 2**32


TESTS = {
  'unit': ['test_parse_header', 'test_parse_empty', 'test_roundtrip', 'test_checksum', 'test_unicode_names',
           'test_large_payload', 'test_retry_backoff', 'test_timeout'],
  'integration': ['test_upload_resume', 'test_login_flow', 'test_list_runs', 'test_delete_batch', 'test_webhook'],
}


def run(context):
  f = flags()
  suite = context.input_path.stem
  broken, flaky = set(f.get('broken', [])), set(f.get('flaky', []))
  cases, log = [], []
  for name in TESTS.get(suite, []):
    time = round(0.01 + 0.5 * uniform(suite, name), 3)
    if name == 'test_unicode_names' and f.get('skip_unicode'):
      body = '<skipped message="needs ICU"/>'
      status = 'skipped'
    elif name in broken:
      body = f'<failure message="assert 3 == 4">AssertionError: {name}: expected 4, got 3</failure>'
      status = 'failed'
    elif name in flaky:
      body = '<flakyFailure message="connection reset"/>'
      status = 'flaky'
    else:
      body, status = '', 'passed'
    cases.append(f'    <testcase classname={quoteattr(f"tests.{suite}")} name={quoteattr(name)} time="{time}">{body}</testcase>')
    log.append(f"{status.upper():8} tests/{suite}.py::{name} ({time}s)")
  (context.output_dir / 'junit.xml').write_text(
    '<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n'
    f'  <testsuite name={quoteattr(suite)} tests="{len(cases)}">\n' + '\n'.join(cases) + '\n  </testsuite>\n</testsuites>\n')
  (context.output_dir / 'log.txt').write_text('\n'.join(log) + '\n')

  slowdown = float(f.get('slowdown', 1.0))
  benchmarks = []
  for name in ('encode', 'decode', 'checksum'):
    mean = (1e-4 + 1e-3 * uniform(suite, name)) * (slowdown if name == 'decode' else 1.0)
    benchmarks.append({'name': f"{suite}/{name}", 'value': mean, 'unit': 's',
                       'stats': {'mean': mean, 'stddev': mean * 0.05, 'rounds': 50}})
  path = write_benchmarks(context.output_dir / 'suite.benchmarks.json', benchmarks)
  return {**junit_metrics(context.output_dir / 'junit.xml'), **benchmark_metrics(path)}
