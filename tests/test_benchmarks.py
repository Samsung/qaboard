"""
Benchmark files as metrics (qaboard/benchmarks.py): the harnesses' formats, our normalized format, the metrics.
The fixtures' *.expected.benchmarks.json are also checked by the web app's parser (webapp/src/viewers/benchmarks/):
change one, change the other.
"""
import json
import math
import os
import re
import tempfile
import unittest
from pathlib import Path

from qaboard.benchmarks import (
  Benchmark, benchmark_metrics, metric_keys, parse_benchmarks, read_benchmarks, write_benchmarks,
)

fixtures = Path(__file__).parent / 'fixtures' / 'benchmarks'


def expected_path(path: Path) -> Path:
  return fixtures / (re.sub(r'(\.benchmarks)?\.(json|jsonl|txt)$', '', path.name) + '.expected.benchmarks.json')


def harness_files():
  return [p for p in sorted(fixtures.iterdir()) if '.expected.' not in p.name]


class TestBenchmarks(unittest.TestCase):
  maxDiff = None

  def assertClose(self, actual, expected, where=''):
    """Equal, with numbers within a relative 1e-12: the web app computes them too"""
    if isinstance(expected, dict):
      self.assertIsInstance(actual, dict, where)
      self.assertEqual(sorted(actual), sorted(expected), where)
      for key in expected:
        self.assertClose(actual[key], expected[key], f'{where}.{key}')
    elif isinstance(expected, list):
      self.assertEqual(len(actual), len(expected), where)
      for i, (a, e) in enumerate(zip(actual, expected)):
        self.assertClose(a, e, f'{where}[{i}]')
    elif isinstance(expected, float) or (isinstance(expected, int) and not isinstance(expected, bool)):
      self.assertTrue(math.isclose(actual, expected, rel_tol=1e-12), f'{where}: {actual} != {expected}')
    else:
      self.assertEqual(actual, expected, where)

  def test_fixtures(self):
    files = harness_files()
    self.assertEqual(len(files), 9)
    for path in files:
      with self.subTest(path.name):
        expected = json.loads(expected_path(path).read_text())
        self.assertClose(read_benchmarks(path).to_dict(), expected)

  def test_detects_the_format(self):
    sources = {p.name: read_benchmarks(p).source for p in harness_files()}
    self.assertEqual(sources, {
      'cargo-criterion.jsonl': 'criterion',
      'criterion': 'criterion',
      'go-bench.txt': 'go',
      'google-benchmark-repetitions.json': 'google-benchmark',
      'google-benchmark.json': 'google-benchmark',
      'hyperfine.json': 'hyperfine',
      'jmh.json': 'jmh',
      'kitefin.benchmarks.json': 'kitefin-bench 2.3',
      'pytest-benchmark.json': 'pytest-benchmark',
    })

  def test_normalized_files_read_back(self):
    for path in harness_files():
      with self.subTest(path.name):
        benchmarks = read_benchmarks(path)
        with tempfile.TemporaryDirectory() as tmp:
          written = write_benchmarks(Path(tmp) / 'x.benchmarks.json', benchmarks)
          self.assertClose(read_benchmarks(written).to_dict(), benchmarks.to_dict())

  def test_pytest_benchmark(self):
    benchmarks = read_benchmarks(fixtures / 'pytest-benchmark.json')
    encode = benchmarks[0]
    self.assertEqual((encode.name, encode.group, encode.params), ('tests/test_codec.py::test_encode[64]', 'codec', {'size': 64}))
    self.assertEqual((encode.statistic, encode.stats['rounds'], encode.stats['iterations']), ('mean', 52083, 10))
    # without a group, the module
    self.assertEqual(benchmarks[2].group, 'tests/test_frames.py')
    self.assertEqual(benchmarks.context, {
      'machine': 'ci-runner-07', 'cpu': 'AMD EPYC 7763 64-Core Processor', 'cpu_count': 8, 'os': 'Linux 6.8.0-45-generic',
      'arch': 'x86_64', 'date': '2026-11-02T09:15:02.418935+00:00', 'harness': 'pytest-benchmark 5.1.0',
    })

  def test_google_benchmark(self):
    benchmarks = read_benchmarks(fixtures / 'google-benchmark.json')
    # BigO and RMS are not benchmarks, and an error has no time
    self.assertEqual([b.name for b in benchmarks], ['BM_Encode/64', 'BM_Encode/4096', 'BM_RouteLookup/size:1024/threads:4', 'BM_Checksum'])
    self.assertAlmostEqual(benchmarks[0].value, 62.318012412339601e-9, delta=1e-20)
    self.assertAlmostEqual(benchmarks[3].value, 1.2034519910812378e-3, delta=1e-17)
    self.assertEqual(benchmarks[2].params, {'size': '1024', 'threads': '4'})
    self.assertEqual(benchmarks[0].throughput['unit'], 'B/s')
    self.assertEqual(benchmarks[2].throughput['unit'], 'items/s')

    repeated = read_benchmarks(fixtures / 'google-benchmark-repetitions.json')
    plan = repeated[0]
    # the mean, median and stddev aggregates, not the repetitions' rows
    self.assertAlmostEqual(plan.value, 169.886054216614e-6, delta=1e-15)
    self.assertAlmostEqual(plan.stats['stddev'], 1.8721385327416e-6, delta=1e-15)
    self.assertEqual((plan.stats['rounds'], plan.stats['iterations']), (3, 4127))
    # --benchmark_report_aggregates_only: no iterations' rows
    self.assertEqual((repeated[1].name, repeated[1].stats['rounds']), ('BM_PlanRoute/grid:1024', 3))
    self.assertNotIn('iterations', repeated[1].stats)

  def test_criterion(self):
    messages = read_benchmarks(fixtures / 'cargo-criterion.jsonl')
    self.assertEqual([b.name for b in messages], ['varint/encode/64', 'varint/decode/64', 'plan_route'])
    self.assertEqual(messages[0].throughput['unit'], 'B/s')
    self.assertAlmostEqual(messages[0].throughput['value'], 64 / 62.13077e-9)
    directory = read_benchmarks(fixtures / 'criterion')
    # new/, not base/ (the previous results)
    self.assertEqual([b.name for b in directory], ['fib/iterative/20', 'fib/recursive/20', 'plan_route'])
    self.assertAlmostEqual(directory[1].value, 24715.02236e-9)
    with tempfile.TemporaryDirectory() as tmp, self.assertRaisesRegex(ValueError, 'no Criterion results'):
      read_benchmarks(tmp)

  def test_jmh(self):
    benchmarks = read_benchmarks(fixtures / 'jmh.json')
    self.assertEqual(benchmarks[1].name, 'com.kitefin.telemetry.CodecBenchmark.encode[size=4096]')
    self.assertAlmostEqual(benchmarks[1].value, 3.4121053214218703e-6)
    # throughput mode: larger is better, in operations per second
    lookup = benchmarks[2]
    self.assertEqual((lookup.unit, lookup.smaller_is_better), ('ops/s', False))
    self.assertAlmostEqual(lookup.value, 41203812.20517381)
    # a benchmark in two modes
    two_modes = json.loads((fixtures / 'jmh.json').read_text())[:1] * 2
    two_modes[1] = {**two_modes[1], 'mode': 'sample'}
    self.assertEqual([b.name for b in parse_benchmarks(json.dumps(two_modes))], [
      'com.kitefin.telemetry.CodecBenchmark.encode[size=64] (avgt)', 'com.kitefin.telemetry.CodecBenchmark.encode[size=64] (sample)',
    ])

  def test_go(self):
    benchmarks = read_benchmarks(fixtures / 'go-bench.txt')
    encode = benchmarks[0]
    self.assertEqual((encode.name, encode.group), ('example.com/kitefin/telemetry/codec.BenchmarkEncode/size=64', 'example.com/kitefin/telemetry/codec'))
    # -count=3: the mean of the file's 3 lines, and their spread
    self.assertAlmostEqual(encode.value, (65.43 + 64.91 + 66.02) / 3 * 1e-9)
    self.assertEqual(encode.stats['rounds'], 3)
    self.assertEqual(benchmarks.context['cpu_count'], 8)

  def test_unique_names(self):
    text = json.dumps({'results': [{'command': 'sleep 0.1', 'mean': 0.1}, {'command': 'sleep 0.1', 'mean': 0.2}]})
    self.assertEqual([b.name for b in parse_benchmarks(text)], ['sleep 0.1', 'sleep 0.1 #2'])

  def test_errors(self):
    with tempfile.TemporaryDirectory() as tmp:
      for content, message in [('', 'unknown benchmark file'), ('{"a": 1}', 'unknown benchmark file'), ('not json', 'unknown')]:
        with self.subTest(content):
          path = Path(tmp) / 'bench.json'
          path.write_text(content)
          with self.assertRaisesRegex(ValueError, f'bench.json: {message}'):
            read_benchmarks(path)
    with self.assertRaisesRegex(ValueError, 'unknown benchmark format'):
      parse_benchmarks('{}', format='nope')
    with self.assertRaisesRegex(ValueError, 'not a jmh file|not a JMH file'):
      parse_benchmarks('{}', format='jmh')
    with self.assertRaisesRegex(ValueError, r'benchmarks\[0\]'):
      parse_benchmarks('{"qaboard_benchmarks": 1, "benchmarks": [{"name": "a"}]}')
    # forced
    self.assertEqual(parse_benchmarks((fixtures / 'hyperfine.json').read_text(), format='hyperfine').source, 'hyperfine')

  def test_write_benchmarks(self):
    with tempfile.TemporaryDirectory() as tmp:
      path = write_benchmarks(Path(tmp) / 'tiles.benchmarks.json', [
        {'name': 'render/tile_256', 'group': 'render', 'value': 4.2, 'unit': 'ms', 'stats': {'median': 4.2, 'iqr': 0.1}},
        Benchmark(name='startup', value=0.4),
      ], context={'machine': 'ci-runner-07', 'cpu_count': 8}, source='kitefin-bench')
      data = json.loads(path.read_text())
      self.assertEqual(data['source'], 'kitefin-bench')
      self.assertEqual(data['context'], {'machine': 'ci-runner-07', 'cpu_count': 8})
      self.assertEqual(data['benchmarks'][0]['unit'], 's')
      self.assertAlmostEqual(data['benchmarks'][0]['stats']['iqr'], 1e-4)
      self.assertEqual(data['benchmarks'][1], {'name': 'startup', 'value': 0.4, 'unit': 's'})

  def test_metrics(self):
    metrics = benchmark_metrics(fixtures / 'pytest-benchmark.json')
    self.assertEqual(list(metrics), ['tests_test_codec_py_test_encode_64', 'tests_test_codec_py_test_encode_4096', 'tests_test_frames_py_test_parse_frame'])
    encode = metrics['tests_test_codec_py_test_encode_64']
    self.assertAlmostEqual(encode, 1.9787212836584707e-06)
    # in seconds, shown in the suite's typical unit
    self.assertEqual(encode.definition, {
      'label': 'tests/test_codec.py::test_encode[64]', 'short_label': 'test_encode[64]', 'suffix': ' µs', 'scale': 1e6,
      'smaller_is_better': True,
    })
    self.assertEqual(benchmark_metrics(fixtures / 'pytest-benchmark.json', unit='ms')['tests_test_frames_py_test_parse_frame'].definition['suffix'], ' ms')
    with self.assertRaises(ValueError):
      benchmark_metrics(fixtures / 'pytest-benchmark.json', unit='hours')

  def test_metrics_options(self):
    benchmarks = read_benchmarks(fixtures / 'google-benchmark-repetitions.json')
    medians = benchmark_metrics(benchmarks, statistic='median', prefix='planner_')
    self.assertEqual(list(medians), ['planner_bm_planroute_grid_256', 'planner_bm_planroute_grid_1024'])
    self.assertAlmostEqual(medians['planner_bm_planroute_grid_256'], 169.142120934517e-6)
    # benchmarks without the statistic are left out
    self.assertEqual(list(benchmark_metrics(read_benchmarks(fixtures / 'google-benchmark.json'), statistic='median')), [])
    jmh = benchmark_metrics(fixtures / 'jmh.json')
    lookup = jmh['com_kitefin_telemetry_routebenchmark_lookup']
    self.assertEqual((lookup.definition['suffix'], lookup.definition['smaller_is_better']), (' ops/s', False))
    self.assertNotIn('scale', lookup.definition)

  def test_metric_keys(self):
    keys = metric_keys(['encode/64', 'encode.64', 'constructor', 'x' * 300, '[]', 'Decode'])
    self.assertRegex(keys['encode/64'], r'^encode_64_[0-9a-f]{8}$')
    self.assertNotEqual(keys['encode/64'], keys['encode.64'])
    self.assertRegex(keys['constructor'], r'^constructor_[0-9a-f]{8}$')
    self.assertLessEqual(len(keys['x' * 300]), 200)
    self.assertRegex(keys['[]'], r'^_[0-9a-f]{8}$')
    self.assertEqual(keys['Decode'], 'decode')
    # stable
    self.assertEqual(metric_keys(['encode/64', 'encode.64']), metric_keys(['encode.64', 'encode/64']))


def imported_modules(path: Path):
  """The modules a file imports, relative imports as '.name'"""
  import ast
  names = set()
  for node in ast.walk(ast.parse(path.read_text())):
    if isinstance(node, ast.Import):
      names.update(alias.name for alias in node.names)
    elif isinstance(node, ast.ImportFrom):
      names.add('.' * node.level + (node.module or ''))
  return names


def loaded_by_the_cli():
  """The qaboard modules `import qaboard` and the `qa` CLI's module load, in a fresh interpreter"""
  import subprocess
  import sys
  import tempfile
  code = "import sys, qaboard, qaboard.qa; print(' '.join(m for m in sys.modules if m.startswith('qaboard')))"
  with tempfile.TemporaryDirectory() as tmp:
    process = subprocess.run([sys.executable, '-c', code], cwd=tmp, capture_output=True, text=True, check=True,
                             env={**os.environ, 'QA_NO_CHECK_FOR_UPDATES': '1'})
  return set(process.stdout.split())


class TestIsolation(unittest.TestCase):
  """Projects import qaboard.benchmarks from their run(): it doesn't weigh on `import qaboard` or the `qa` CLI, and needs
  only the standard library and qaboard.metrics."""
  def test_imports_only_the_standard_library(self):
    import sys
    path = Path(__file__).resolve().parent.parent / 'qaboard' / 'benchmarks.py'
    allowed = set(sys.stdlib_module_names) | {'.metrics'}
    for name in imported_modules(path):
      self.assertTrue((name if name.startswith('.') else name.split('.')[0]) in allowed, f'benchmarks.py imports {name}')

  def test_not_loaded_by_import_qaboard_or_the_cli(self):
    self.assertNotIn('qaboard.benchmarks', loaded_by_the_cli())


if __name__ == '__main__':
  unittest.main()
