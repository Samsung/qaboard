"""
Tests for `qa gate` (qaboard/gate.py).

The numbers the gate checks come from GET /api/v1/commit/<sha>/compare. Here they are those of the fixture shared with
the backend's and the web app's tests (tests/fixtures/metrics-compare.json): the gate decides on the numbers the
Summary and Metrics Diff views show. The server is faked: by mocks, or by a local HTTP server for the CLI itself.
"""
import os
import re
import sys
import json
import tempfile
import threading
import subprocess
import unittest
from pathlib import Path
from unittest import mock
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs


FIXTURE = json.loads((Path(__file__).resolve().parent / 'fixtures' / 'metrics-compare.json').read_text())
SHA = 'c0ffee0000000000000000000000000000000001'
REF_SHA = 'c0ffee0000000000000000000000000000000002'

# qaboard.config reads qaboard.yaml from the working directory when it's first imported, and test_cli.py needs it
# to happen in the sample project: we import qaboard lazily, in the tests.
def gate_module():
  from qaboard import gate
  return gate


def fixture_comparison(status='complete'):
  """What GET /api/v1/commit/<sha>/compare returns for the fixture (see backend/backend/compare.py)"""
  expected = FIXTURE['expected']
  metrics = {}
  for key, numbers in expected['summary'].items():
    definition = FIXTURE['available_metrics'][key]
    metrics[key] = {
      'label': definition['label'], 'short_label': definition['label'], 'suffix': definition['suffix'], 'scale': 1.0,
      'smaller_is_better': definition['smaller_is_better'], 'target': definition.get('target'), 'declared': True,
      **numbers,
    }
  tests = []
  for id, diff in expected['diff'].items():
    output = FIXTURE['new']['outputs'][id]
    ref = FIXTURE['ref']['outputs'].get(str(diff['reference_id']), {})
    tests.append({
      'id': int(id), 'reference_id': diff['reference_id'], 'reference_mismatch': diff['reference_mismatch'],
      'test_input_path': output['test_input_path'], 'test_input_database': output['test_input_database'],
      'label': output['test_input_metadata'].get('label'), 'platform': output['platform'],
      'configurations': output['configurations'], 'extra_parameters': output['extra_parameters'],
      'is_failed': output['is_failed'], 'bit_accurate': None,
      'metrics': {k: {'new': output['metrics'][k], 'ref': ref['metrics'][k], **cell} for k, cell in diff['metrics'].items()},
    })
  return {
    'project': 'kitefin/camera-isp', 'status': status, 'messages': [] if status == 'complete' else ['Some runs are still running: the numbers may change.'],
    'commit': {'id': SHA, 'branch': 'feature', 'batch': 'default', 'runs': {'total': 8, 'valid': 6, 'failed': 1, 'pending': 0, 'running': 0}},
    'reference': {'requested': 'main', 'type': 'branch', 'milestone': None, 'id': REF_SHA, 'branch': 'main', 'batch': 'default',
                  'runs': {'total': 9, 'valid': 8, 'failed': 0, 'pending': 0, 'running': 0}},
    'metrics': metrics, 'tests': tests, 'bit_accuracy': None,
  }


def evaluate(rules, comparison=None, local_metrics=None, **gate):
  g = gate_module()
  config = g.parse_config({'gate': {'rules': rules, 'max_failed_runs': None, **gate}})
  return g.evaluate_batch(comparison or fixture_comparison(), config, local_metrics or {})


class TestGateConfig(unittest.TestCase):
  def test_defaults(self):
    g = gate_module()
    config = g.parse_config({'project': {'reference_branch': 'main'}})
    self.assertEqual((config.reference, config.batches, config.rules, config.max_failed_runs, config.require_bit_accuracy), ('main', ['default'], [], 0, False))
    self.assertIsNone(g.parse_config({}).reference)

  def test_rules(self):
    g = gate_module()
    config = g.parse_config({'gate': {
      'reference': 'v2.4.0',
      'batches': 'ci',
      'rules': [
        {'metric': 'psnr', 'max_regression': '1%', 'per_test_max_regression': 0.05},
        {'metric': 'map', 'min': 0.42},
        {'metric': 'latency_p99', 'max': '12'},
      ],
      'max_failed_runs': 2,
      'require_bit_accuracy': True,
    }})
    self.assertEqual(config.reference, 'v2.4.0')
    self.assertEqual(config.batches, ['ci'])
    self.assertEqual([r.to_dict() for r in config.rules], [
      {'metric': 'psnr', 'kind': 'max_regression', 'limit': 0.01, 'aggregate': 'median'},
      {'metric': 'psnr', 'kind': 'per_test_max_regression', 'limit': 0.05},
      {'metric': 'map', 'kind': 'min', 'limit': 0.42, 'aggregate': 'median'},
      {'metric': 'latency_p99', 'kind': 'max', 'limit': 12.0, 'aggregate': 'median'},
    ])
    self.assertEqual(config.metrics, ['psnr', 'map', 'latency_p99'])
    self.assertEqual((config.max_failed_runs, config.require_bit_accuracy), (2, True))

  def test_errors(self):
    g = gate_module()
    for gate in [
      'yes',
      {'rule': []},                                         # typo
      {'rules': {'metric': 'psnr'}},
      {'rules': [{'max_regression': '1%'}]},                # no metric
      {'rules': [{'metric': 'psnr'}]},                      # no limit
      {'rules': [{'metric': 'psnr', 'max_regresion': '1%'}]},
      {'rules': [{'metric': 'psnr', 'max_regression': 'a lot'}]},
      {'rules': [{'metric': 'psnr', 'max_regression': '-1%'}]},
      {'rules': [{'metric': 'psnr', 'min': 'high'}]},
      {'rules': [{'metric': 'psnr', 'min': 30, 'aggregate': 'average'}]},
      {'rules': [{'metric': 'psnr', 'per_test_max_regression': '5%', 'aggregate': 'mean'}]},
      {'rules': [{'metric': 'psnr', 'max_regression': '1%', 'per_test_max_regression': '5%', 'aggregate': 'median'}]},
      {'max_failed_runs': -1},
      {'max_failed_runs': True},
      {'require_bit_accuracy': 'yes'},
      {'batches': []},
    ]:
      with self.subTest(gate=gate), self.assertRaises(g.GateConfigError):
        g.parse_config({'gate': gate})


class TestGateRules(unittest.TestCase):
  """On the fixture's numbers: what the Summary and Metrics Diff views show"""

  def checks(self, evaluation):
    return [(c['kind'], c['metric'], c['status']) for c in evaluation['checks']]

  def test_medians(self):
    # PSNR's median improved 2.5% (30.5 vs 29.75 dB), latency's 4.2% (11.5 vs 12 ms)
    evaluation = evaluate([{'metric': 'psnr', 'max_regression': '1%'}, {'metric': 'latency_p99', 'max_regression': '0%'}])
    self.assertEqual(evaluation['verdict'], 'pass')
    psnr, latency = evaluation['checks']
    self.assertAlmostEqual(psnr['regression'], -0.025210084033613446)
    self.assertAlmostEqual(latency['regression'], -0.041666666666666664)
    self.assertEqual((psnr['new'], psnr['ref']), (30.5, 29.75))

  def test_direction_comes_from_the_metrics_definitions(self):
    # if a bigger latency were better, the 4.2% drop of the median would be a regression
    comparison = fixture_comparison()
    comparison['metrics']['latency_p99']['smaller_is_better'] = False
    evaluation = evaluate([{'metric': 'latency_p99', 'max_regression': '4%'}], comparison)
    self.assertEqual(self.checks(evaluation), [('max_regression', 'latency_p99', 'fail')])
    self.assertAlmostEqual(evaluation['checks'][0]['regression'], 0.041666666666666664)
    # what the server knows wins: it has the metrics declared in code, which win over the metrics file
    comparison = fixture_comparison()
    comparison['metrics']['latency_p99']['smaller_is_better'] = False
    evaluation = evaluate([{'metric': 'latency_p99', 'max_regression': '4%'}], comparison, local_metrics={'latency_p99': {'label': 'p99'}})
    self.assertEqual(evaluation['verdict'], 'fail')

  def test_direction_from_the_local_metrics_file(self):
    # when the server doesn't know
    comparison = fixture_comparison()
    comparison['metrics']['latency_p99'].update(declared=False, smaller_is_better=None)
    evaluation = evaluate([{'metric': 'latency_p99', 'max_regression': '4%'}], comparison, local_metrics={'latency_p99': {'smaller_is_better': False}})
    self.assertEqual(evaluation['verdict'], 'fail')
    # the metrics file says nothing: smaller is better
    evaluation = evaluate([{'metric': 'latency_p99', 'max_regression': '4%'}], comparison, local_metrics={'latency_p99': None})
    self.assertEqual(evaluation['verdict'], 'pass')

  def test_undeclared_metrics(self):
    g = gate_module()
    comparison = fixture_comparison()
    comparison['metrics']['psnr']['declared'] = False
    with self.assertRaises(g.GateConfigError):
      evaluate([{'metric': 'psnr', 'max_regression': '1%'}], comparison)
    # declared without a direction, in the metrics file or in code
    comparison = fixture_comparison()
    comparison['metrics']['psnr']['smaller_is_better'] = None
    with self.assertRaises(g.GateConfigError):
      evaluate([{'metric': 'psnr', 'max_regression': '1%'}], comparison)
    with self.assertRaises(g.GateConfigError):
      evaluate([{'metric': 'psnr', 'max_regression': '1%'}], comparison, local_metrics={'psnr': {'smaller_is_better': None}})
    # absolute bounds don't need to know which way is better
    evaluation = evaluate([{'metric': 'psnr', 'min': 30}, {'metric': 'psnr', 'max': 30.4}], comparison)
    self.assertEqual(self.checks(evaluation), [('min', 'psnr', 'pass'), ('max', 'psnr', 'fail')])

  def test_per_test(self):
    # the medians improve, but run 104 (photos/night.jpg) has a PSNR 20% worse than its reference
    evaluation = evaluate([
      {'metric': 'psnr', 'max_regression': '1%', 'per_test_max_regression': '5%'},
      {'metric': 'latency_p99', 'per_test_max_regression': '10%'},
      {'metric': 'runtime', 'per_test_max_regression': '20%'},
    ])
    self.assertEqual(evaluation['verdict'], 'fail')
    self.assertEqual(self.checks(evaluation), [
      ('max_regression', 'psnr', 'pass'),
      ('per_test_max_regression', 'psnr', 'fail'),
      ('per_test_max_regression', 'latency_p99', 'fail'),
      ('per_test_max_regression', 'runtime', 'pass'),
    ])
    psnr, latency, runtime = evaluation['checks'][1:]
    self.assertEqual(psnr['worst']['test'], 'photos/night.jpg')
    self.assertEqual((psnr['tests_compared'], psnr['over_limit']), (6, 1))
    self.assertAlmostEqual(psnr['regression'], 0.199999920000032)
    # 101 and 108 (labelled "Scene 7") are more than 10% slower, 103 9.99999%: the Metrics Diff shows 10%
    self.assertEqual(latency['worst']['test'], 'Scene 7')
    self.assertEqual([t['test'] for t in latency['over_limit_tests']], ['Scene 7', 'charts/edge.png'])
    # the hw-model and linux runs of photos/street.jpg are told apart
    self.assertEqual(gate_module().name_of_test(fixture_comparison()['tests'][4], fixture_comparison()['tests']), 'photos/street.jpg (hw-model, base)')

  def test_missing_values(self):
    comparison = fixture_comparison()
    comparison['metrics']['runtime']['ref'] = {'median': None, 'count': 0, 'pass_rate': None}
    comparison['metrics']['runtime']['delta'] = comparison['metrics']['runtime']['delta_relative'] = None
    evaluation = evaluate([{'metric': 'runtime', 'max_regression': '1%'}, {'metric': 'mtf50', 'min': 0.2}], comparison)
    # a new metric: nothing to compare with. But a metric the new runs don't have fails.
    self.assertEqual(self.checks(evaluation), [('max_regression', 'runtime', 'skip'), ('min', 'mtf50', 'fail')])
    self.assertEqual(evaluation['verdict'], 'fail')

  def test_reference_of_zero(self):
    g = gate_module()
    self.assertEqual(g.regression_of(None, 2.0, True), float('inf'))
    self.assertEqual(g.regression_of(None, 2.0, False), float('-inf'))
    self.assertEqual(g.regression_of(None, 0.0, True), 0)
    self.assertIsNone(g.regression_of(None, None, True))

  def test_failed_runs(self):
    # run 104 failed
    self.assertEqual(self.checks(evaluate([], max_failed_runs=0)), [('max_failed_runs', None, 'fail')])
    self.assertEqual(evaluate([], max_failed_runs=1)['verdict'], 'pass')

  def test_undecidable(self):
    self.assertEqual(evaluate([{'metric': 'psnr', 'max_regression': '1%'}], fixture_comparison(status='running'))['verdict'], 'undecidable')
    self.assertEqual(evaluate([], fixture_comparison(status='missing'))['verdict'], 'undecidable')
    g = gate_module()
    self.assertEqual(g.overall_verdict(['pass', 'undecidable']), 'undecidable')
    self.assertEqual(g.overall_verdict(['undecidable', 'fail']), 'fail')
    self.assertEqual(g.overall_verdict(['pass', 'pass']), 'pass')

  def test_bit_accuracy(self):
    comparison = fixture_comparison()
    comparison['bit_accuracy'] = {'checked': 6, 'mismatched': 0, 'unavailable': 0}
    self.assertEqual(evaluate([], comparison, require_bit_accuracy=True)['verdict'], 'pass')
    comparison['bit_accuracy'] = {'checked': 5, 'mismatched': 0, 'unavailable': 1}
    self.assertEqual(evaluate([], comparison, require_bit_accuracy=True)['verdict'], 'undecidable')
    comparison['bit_accuracy'] = {'checked': 6, 'mismatched': 1, 'unavailable': 0}
    comparison['tests'][0].update(bit_accurate=False, bit_accuracy_mismatch=['out.png'])
    evaluation = evaluate([], comparison, require_bit_accuracy=True)
    self.assertEqual(evaluation['verdict'], 'fail')
    self.assertEqual(evaluation['checks'][0]['differing_tests'], [{'test': 'charts/edge.png', 'files': ['out.png']}])


def comparison_with(metric, values, smaller_is_better=True):
  """The fixture's tests, with a metric whose values are (new, ref) per test. ref None: no reference run has it."""
  import statistics
  comparison = fixture_comparison()
  comparison['tests'] = comparison['tests'][:len(values)]
  for test, (new, ref) in zip(comparison['tests'], values):
    delta = None if ref is None else new - ref
    test['metrics'][metric] = {'new': new, 'ref': ref, 'delta': delta, 'delta_relative': None if ref is None else delta / (abs(ref) + 0.00001)}
  # what the server computes: medians over the runs
  new_values = [n for n, _ in values]
  ref_values = [r for _, r in values if r is not None]
  new_median, ref_median = statistics.median(new_values), statistics.median(ref_values) if ref_values else None
  comparison['metrics'][metric] = {
    'label': metric, 'short_label': metric, 'suffix': '', 'scale': 1.0, 'smaller_is_better': smaller_is_better, 'target': None, 'declared': True,
    'new': {'median': new_median, 'count': len(new_values), 'pass_rate': None},
    'ref': {'median': ref_median, 'count': len(ref_values), 'pass_rate': None},
    'delta': None if ref_median is None else new_median - ref_median,
    'delta_relative': None if not ref_median else (new_median - ref_median) / abs(ref_median),
  }
  return comparison


class TestGateAggregates(unittest.TestCase):
  """`aggregate:` on pass/fail (0/1) metrics, whose median says little"""

  def test_absolute_bounds(self):
    # 2 of 6 tests do something unsafe: the median is 0
    comparison = comparison_with('unsafe_actions', [(0, 0), (1, 0), (0, 0), (0, 0), (1, 0), (0, 0)])
    evaluation = evaluate([
      {'metric': 'unsafe_actions', 'max': 0},
      {'metric': 'unsafe_actions', 'max': 0, 'aggregate': 'max'},
      {'metric': 'unsafe_actions', 'max': 0.25, 'aggregate': 'mean'},
      {'metric': 'unsafe_actions', 'min': 0, 'aggregate': 'min'},
    ], comparison)
    self.assertEqual([(c['aggregate'], c['status']) for c in evaluation['checks']], [('median', 'pass'), ('max', 'fail'), ('mean', 'fail'), ('min', 'pass')])
    self.assertEqual([c['new'] for c in evaluation['checks']], [0, 1, 1 / 3, 0])
    # the same numbers as the server for medians
    self.assertEqual(evaluate([{'metric': 'psnr', 'min': 0, 'aggregate': 'median'}])['checks'][0]['new'], 30.5)

  def test_max_regression(self):
    # 5 of 6 tests passed, 4 now: the pass rate drops 20%
    comparison = comparison_with('passed', [(1, 1), (1, 1), (0, 1), (1, 1), (1, 1), (0, 0)], smaller_is_better=False)
    local_metrics = {'passed': {'smaller_is_better': False}}
    evaluation = evaluate([
      {'metric': 'passed', 'max_regression': '5%'},
      {'metric': 'passed', 'max_regression': '5%', 'aggregate': 'mean'},
      {'metric': 'passed', 'max_regression': '20%', 'aggregate': 'mean'},
    ], comparison, local_metrics)
    median, mean, mean_20 = evaluation['checks']
    self.assertEqual((median['status'], median['regression']), ('pass', 0))
    self.assertEqual((mean['new'], mean['ref']), (4 / 6, 5 / 6))
    self.assertAlmostEqual(mean['change'], -0.2)
    self.assertAlmostEqual(mean['regression'], 0.2)
    self.assertEqual((mean['status'], mean_20['status']), ('fail', 'pass'))

  def test_reference_of_zero(self):
    # no test was unsafe in the reference: any unsafe one is an infinite regression, none is no change
    comparison = comparison_with('unsafe_actions', [(0, 0), (0, 0), (1, 0)])
    check = evaluate([{'metric': 'unsafe_actions', 'max_regression': '50%', 'aggregate': 'mean'}], comparison)['checks'][0]
    self.assertEqual((check['change'], check['regression'], check['status']), (None, float('inf'), 'fail'))
    comparison = comparison_with('unsafe_actions', [(0, 0), (0, 0)])
    check = evaluate([{'metric': 'unsafe_actions', 'max_regression': '0%', 'aggregate': 'max'}], comparison)['checks'][0]
    self.assertEqual((check['change'], check['regression'], check['status']), (0, 0, 'pass'))

  def test_tests_on_one_side(self):
    g = gate_module()
    # the last test has no reference run, the first two the same one
    comparison = comparison_with('score', [(1, 4), (2, 4), (3, 2), (10, None)])
    comparison['tests'][1]['reference_id'] = comparison['tests'][0]['reference_id']
    self.assertEqual(g.tests_values(comparison['tests'], 'score'), ([1, 2, 3, 10], [4, 2]))
    check = evaluate([{'metric': 'score', 'max': 4, 'aggregate': 'mean'}], comparison)['checks'][0]
    self.assertEqual((check['new'], check['ref'], check['status']), (4, 3, 'pass'))
    # no reference run has values: regressions are skipped
    comparison = comparison_with('score', [(1, None), (2, None)])
    comparison['metrics']['score']['ref']['count'] = 1   # e.g. on a reference run that matches none of the new runs
    self.assertEqual(evaluate([{'metric': 'score', 'max_regression': '1%', 'aggregate': 'mean'}], comparison)['checks'][0]['status'], 'skip')

  def test_outputs(self):
    g = gate_module()
    comparison = comparison_with('unsafe_actions', [(0, 0), (1, 0), (0, 0)])
    rules = [{'metric': 'unsafe_actions', 'max': 0, 'aggregate': 'max'}, {'metric': 'unsafe_actions', 'max_regression': '10%', 'aggregate': 'mean'}]
    config = g.parse_config({'project': {'reference_branch': 'main'}, 'gate': {'rules': rules, 'max_failed_runs': None}})
    result = g.run_gate(config, 'kitefin/camera-isp', SHA, lambda label: (comparison, None), {}, 'http://localhost:5151')
    text = g.render(result, 'text')
    self.assertRegex(text, r'unsafe_actions, max +1 +at most 0 +FAIL')
    self.assertRegex(text, r'unsafe_actions, mean +0\.3333 +0 +worse \(reference: 0\) +10% worse +FAIL')
    self.assertIn('| unsafe_actions, max | 1 |  |  | at most 0 | FAIL |', g.render(result, 'markdown'))
    data = json.loads(g.render(result, 'json'))
    self.assertEqual([c['aggregate'] for c in data['batches'][0]['checks']], ['max', 'mean'])
    self.assertEqual(g.status_description(result), 'fail: unsafe_actions, max: 1 vs 0 (limit: at most 0)')

  def test_configuration_errors(self):
    g = gate_module()
    with self.assertRaisesRegex(g.GateConfigError, r'gate\.rules\[0\]\.aggregate: per_test_max_regression checks each test'):
      g.parse_config({'gate': {'rules': [{'metric': 'psnr', 'per_test_max_regression': '5%', 'aggregate': 'max'}]}})
    with self.assertRaisesRegex(g.GateConfigError, r'expected one of median, mean, min, max'):
      g.parse_config({'gate': {'rules': [{'metric': 'psnr', 'min': 1, 'aggregate': 'p90'}]}})


class TestGateRun(unittest.TestCase):
  def run_gate(self, responses, rules, **gate):
    g = gate_module()
    config = g.parse_config({'project': {'reference_branch': 'main'}, 'gate': {'rules': rules, **gate}})
    return g.run_gate(config, 'kitefin/camera-isp', SHA, lambda label: responses[label], {}, 'http://localhost:5151')

  def test_outputs(self):
    g = gate_module()
    result = self.run_gate({'default': (fixture_comparison(), None)}, [{'metric': 'psnr', 'max_regression': '1%', 'per_test_max_regression': '5%'}], max_failed_runs=1)
    self.assertEqual((result['verdict'], result['exit_code'], result['experimental']), ('fail', 1, True))
    url = result['batches'][0]['url']
    self.assertEqual(url, f'http://localhost:5151/kitefin/camera-isp/commit/{SHA}?reference={REF_SHA}&batch=default&batch_ref=default&selected_views=table-compare')

    text = g.render(result, 'text')
    self.assertIn('Quality gate: FAIL', text)
    self.assertIn(f'kitefin/camera-isp {SHA[:10]} vs main ({REF_SHA[:10]}), batch CI: 8 runs, 1 failed', text)
    self.assertRegex(text, r'psnr, median +30\.5 dB +29\.75 dB +2\.5% better +1% worse +pass')
    self.assertRegex(text, r'psnr, each test \(worst: photos/night\.jpg\) +20 dB +25 dB +20\.0% worse +5% worse +FAIL')
    self.assertIn('psnr on photos/night.jpg: 20.0% worse', text)
    self.assertIn(f'Metrics Diff: {url}', text)

    markdown = g.render(result, 'markdown')
    self.assertIn('### Quality gate: fail', markdown)
    self.assertIn('| Check | New | Reference | Change | Limit | Result |', markdown)
    self.assertIn('| psnr, each test (worst: photos/night.jpg) | 20 dB | 25 dB | 20.0% worse | 5% worse | FAIL |', markdown)
    self.assertIn(f'[Metrics Diff]({url})', markdown)
    self.assertIn('experimental', markdown)

    data = json.loads(g.render(result, 'json'))
    self.assertEqual(data['verdict'], 'fail')
    self.assertEqual(data['batches'][0]['checks'][1]['worst']['id'], 104)

    self.assertEqual(g.status_description(result), 'fail: psnr, each test (worst: photos/night.jpg): 20.0% worse (limit: 5% worse)')

  def test_links_and_json(self):
    g = gate_module()
    url = g.metrics_diff_url('http://qa', 'group/my project', SHA, None, 'tune', 'default')
    self.assertEqual(url, f'http://qa/group/my%20project/commit/{SHA}?batch=tune&batch_ref=default&selected_views=table-compare')
    # JSON has no Infinity, e.g. for a regression vs a reference of 0
    self.assertEqual(json.loads(g.render({'regression': float('inf'), 'x': [1.5]}, 'json')), {'regression': None, 'x': [1.5]})

  def test_several_batches(self):
    responses = {'default': (fixture_comparison(), None), 'nightly': (None, 'QA-Board has no results for c0ffee0000 in kitefin/camera-isp yet')}
    result = self.run_gate(responses, [{'metric': 'psnr', 'max_regression': '1%'}], batches=['default', 'nightly'], max_failed_runs=1)
    self.assertEqual([b['verdict'] for b in result['batches']], ['pass', 'undecidable'])
    self.assertEqual((result['verdict'], result['exit_code']), ('undecidable', 2))
    self.assertIn('QA-Board has no results for c0ffee0000', gate_module().render(result, 'text'))
    self.assertTrue(gate_module().status_description(result).startswith('undecidable: QA-Board has no results'))

  def test_ci_and_default_are_checked_once(self):
    asked = []
    responses = {'ci': (fixture_comparison(), None), 'nightly': (fixture_comparison(), None)}
    def fetch(label):
      asked.append(label)
      return responses[label]
    g = gate_module()
    config = g.parse_config({'gate': {'labels': ['ci', 'nightly', 'default', 'CI']}})
    result = g.run_gate(config, 'kitefin/camera-isp', SHA, fetch, {}, 'http://localhost:5151')
    self.assertEqual(asked, ['ci', 'nightly'])
    self.assertEqual(len(result['batches']), 2)


class TestProjectGate(unittest.TestCase):
  """The rules a project's owners set in the web app (docs/rfcs/project-admin.md): checked on top of the commit's"""
  def run_gate(self, comparison, rules, project_gate, reference_gate='unknown', **gate):
    g = gate_module()
    comparison = {**comparison, 'project_gate': project_gate}
    if reference_gate != 'unknown':
      comparison['reference'] = {**comparison['reference'], 'gate': reference_gate}
    config = g.parse_config({'project': {'reference_branch': 'main'}, 'gate': {'rules': rules, **gate}})
    self.asked = []
    def fetch(label):
      self.asked.append((list(config.metrics), config.needs_bit_accuracy))
      return comparison, None
    return g.run_gate(config, 'kitefin/camera-isp', SHA, fetch, {}, 'http://localhost:5151')

  def test_project_rules_are_checked_too(self):
    g = gate_module()
    # the commit's own rule passes, the project's is stricter: PSNR must not get worse on any test
    project_gate = {'rules': [{'metric': 'psnr', 'per_test_max_regression': '5%'}], 'max_failed_runs': 0, 'on_looser_rules': 'warn'}
    result = self.run_gate(fixture_comparison(), [{'metric': 'psnr', 'max_regression': '1%'}], project_gate, max_failed_runs=3)
    checks = result['batches'][0]['checks']
    self.assertEqual([(c['kind'], c.get('source'), c['status']) for c in checks], [
      ('max_regression', None, 'pass'), ('per_test_max_regression', 'project', 'fail'), ('max_failed_runs', 'project', 'fail'),
    ])
    self.assertEqual(result['verdict'], 'fail')
    self.assertEqual(result['project_rules'], [{'metric': 'psnr', 'kind': 'per_test_max_regression', 'limit': 0.05}])
    text = g.render(result, 'text')
    self.assertRegex(text, r'psnr, each test \(worst: photos/night\.jpg\) \[project rule\] +20 dB')
    self.assertRegex(text, r'failed runs \[project rule\] +1 +0 +at most 0 +FAIL')
    self.assertIn('| failed runs [project rule] | 1 | 0 |  | at most 0 | FAIL |', g.render(result, 'markdown'))
    # one request: the project's rules use the metric we asked for
    self.assertEqual(self.asked, [(['psnr'], False)])

  def test_the_stricter_limit_on_failed_runs_applies(self):
    # the commit's own is stricter: not a project rule
    result = self.run_gate(fixture_comparison(), [], {'rules': [], 'max_failed_runs': 5}, max_failed_runs=0)
    check, = result['batches'][0]['checks']
    self.assertEqual((check['limit'], check.get('source'), check['status']), (0, None, 'fail'))
    # the project has no limit, the commit doesn't check
    result = self.run_gate(fixture_comparison(), [], {'rules': []}, max_failed_runs=None)
    self.assertEqual(result['batches'][0]['checks'], [])
    # no settings: as before
    result = self.run_gate(fixture_comparison(), [], None, max_failed_runs=1)
    self.assertNotIn('project_rules', result)
    self.assertEqual(result['verdict'], 'pass')

  def test_asks_again_for_what_the_project_rules_need(self):
    project_gate = {'rules': [{'metric': 'ssim', 'min': 0.5}], 'require_bit_accuracy': True}
    result = self.run_gate(fixture_comparison(), [{'metric': 'psnr', 'max_regression': '1%'}], project_gate)
    self.assertEqual(self.asked, [(['psnr'], False), (['psnr', 'ssim'], True)])
    kinds = [(c['kind'], c.get('source')) for c in result['batches'][0]['checks']]
    self.assertIn(('min', 'project'), kinds)
    self.assertIn(('require_bit_accuracy', 'project'), kinds)
    # without rules of its own, the commit asked for every metric already
    self.run_gate(fixture_comparison(), [], {'rules': [{'metric': 'ssim', 'min': 0.5}]})
    self.assertEqual(len(self.asked), 1)

  def test_commits_that_loosen_their_rules(self):
    g = gate_module()
    rules = [{'metric': 'psnr', 'max_regression': '5%'}]
    stricter_reference = {'rules': [{'metric': 'psnr', 'max_regression': '1%'}], 'max_failed_runs': None}
    # by default the gate says so, and passes
    result = self.run_gate(fixture_comparison(), rules, {'rules': []}, reference_gate=stricter_reference, max_failed_runs=None)
    self.assertEqual((result['verdict'], result['on_looser_rules'], len(result['rules_changes'])), ('pass', 'warn', 1))
    # the project's owners can make it fail
    policy = {'rules': [], 'on_looser_rules': 'fail'}
    result = self.run_gate(fixture_comparison(), rules, policy, reference_gate=stricter_reference, max_failed_runs=None)
    check = result['batches'][0]['checks'][-1]
    self.assertEqual((check['kind'], check['status'], check['source'], check['looser']), ('rules', 'fail', 'project', ['psnr, median, max regression: 1% → 5%']))
    self.assertEqual(result['verdict'], 'fail')
    text = g.render(result, 'text')
    self.assertRegex(text, r"the gate's rules \[project rule\] +1 looser +not looser than the reference's +FAIL")
    self.assertEqual(g.status_description(result), "fail: the gate's rules [project rule]: 1 looser (limit: not looser than the reference's)")
    # the same rules, or stricter ones: fine
    result = self.run_gate(fixture_comparison(), rules, policy, reference_gate={'rules': rules, 'max_failed_runs': None}, max_failed_runs=None)
    self.assertEqual((result['batches'][0]['checks'][-1]['status'], result['verdict']), ('pass', 'pass'))
    # the server doesn't have the reference's qaboard.yaml: we can't tell
    result = self.run_gate(fixture_comparison(), rules, policy, reference_gate=None, max_failed_runs=None)
    self.assertEqual((result['batches'][0]['checks'][-1]['status'], result['verdict']), ('unknown', 'undecidable'))

  def test_settings_this_version_cant_read(self):
    g = gate_module()
    for project_gate, message in [
      ({'rules': [{'metric': 'psnr'}]}, "the project's gate settings, set in the web app: gate.rules[0]"),
      ({'rules': [], 'noise': 'auto'}, "keys this version of qa doesn't know (noise): upgrade qaboard"),
      ({'rules': [], 'on_looser_rules': 'approve'}, "on_looser_rules is 'approve'"),
    ]:
      with self.assertRaises(g.GateConfigError) as error:
        self.run_gate(fixture_comparison(), [], project_gate)
      self.assertIn(message, str(error.exception))


class TestGateServer(unittest.TestCase):
  """Requests to QA-Board, GitHub and GitLab"""

  def test_fetch(self):
    import requests
    g = gate_module()
    response = mock.Mock(status_code=200)
    response.json.return_value = {'status': 'complete'}
    with mock.patch('requests.get', return_value=response) as get:
      data, error = g.fetch_comparison('http://qa/api/v1', 'group/project', SHA, 'main', 'ci', ['psnr', 'ssim'], True, {'Authorization': 'Bearer t'}, True)
    self.assertEqual((data, error), ({'status': 'complete'}, None))
    self.assertEqual(get.call_args.args[0], f'http://qa/api/v1/commit/{SHA}/compare')
    self.assertEqual(get.call_args.kwargs['params'], {'project': 'group/project', 'batch': 'ci', 'reference': 'main', 'metrics': 'psnr,ssim', 'bit_accuracy': 'true'})
    self.assertEqual(get.call_args.kwargs['headers'], {'Authorization': 'Bearer t'})

    response = mock.Mock(status_code=404)
    response.json.return_value = {'error': f'No results for commit {SHA} in project p'}
    with mock.patch('requests.get', return_value=response):
      self.assertEqual(g.fetch_comparison('http://qa/api/v1', 'p', SHA, None, 'default', [], False, {}, True), (None, 'QA-Board has no results for c0ffee0000 in p yet'))
    # servers from before the endpoint: their 404 is a page
    response.json.side_effect = ValueError('not JSON')
    with mock.patch('requests.get', return_value=response):
      data, error = g.fetch_comparison('http://qa/api/v1', 'p', SHA, None, 'default', [], False, {}, True)
    self.assertIn("doesn't have the comparisons qa gate needs: upgrade it", error)
    with mock.patch('requests.get', side_effect=requests.ConnectionError('refused')):
      data, error = g.fetch_comparison('http://qa/api/v1', 'p', SHA, None, 'default', [], False, {}, True)
    self.assertIn('could not reach QA-Board', error)

  def result(self, verdict='fail'):
    return {'verdict': verdict, 'commit': SHA, 'reference': 'main', 'errors': [], 'batches': [{
      'verdict': verdict, 'url': 'http://qa/p/commit/x', 'messages': [],
      'checks': [{'kind': 'max_failed_runs', 'metric': None, 'limit': 0, 'new': 2, 'status': verdict, 'message': ''}],
    }]}

  def test_github_status(self):
    g = gate_module()
    env = {'GITHUB_TOKEN': 'token', 'GITHUB_REPOSITORY': 'kitefin/camera-isp', 'GITHUB_API_URL': 'https://github.example/api/v3'}
    with mock.patch.dict(os.environ, env), mock.patch('requests.post') as post:
      self.assertIsNone(g.post_commit_status('github', self.result(), 'qaboard/gate', 'kitefin/camera-isp'))
    self.assertEqual(post.call_args.args[0], f'https://github.example/api/v3/repos/kitefin/camera-isp/statuses/{SHA}')
    self.assertEqual(post.call_args.kwargs['json'], {
      'state': 'failure', 'target_url': 'http://qa/p/commit/x', 'context': 'qaboard/gate',
      'description': 'fail: failed runs: 2 (limit: at most 0)',
    })
    self.assertEqual(post.call_args.kwargs['headers']['Authorization'], 'Bearer token')
    with mock.patch.dict(os.environ, {}, clear=True):
      self.assertIn('GITHUB_TOKEN', g.post_commit_status('github', self.result(), 'qaboard/gate', 'p'))

  def test_gitlab_status(self):
    g = gate_module()
    env = {'GITLAB_ACCESS_TOKEN': 'token', 'CI_API_V4_URL': 'https://gitlab.example/api/v4', 'CI_PROJECT_ID': '42', 'CI_PIPELINE_ID': '7', 'CI_COMMIT_REF_NAME': 'feature'}
    with mock.patch.dict(os.environ, env), mock.patch('requests.post') as post:
      self.assertIsNone(g.post_commit_status('gitlab', self.result('pass'), 'qaboard/gate', 'kitefin/camera-isp'))
    self.assertEqual(post.call_args.args[0], f'https://gitlab.example/api/v4/projects/42/statuses/{SHA}')
    self.assertEqual(post.call_args.kwargs['json'], {
      'state': 'success', 'name': 'qaboard/gate', 'target_url': 'http://qa/p/commit/x', 'pipeline_id': '7', 'ref': 'feature',
      'description': 'pass: 1 checks vs main',
    })
    self.assertEqual(post.call_args.kwargs['headers'], {'PRIVATE-TOKEN': 'token'})
    # outside of GitLab CI
    env = {'GITLAB_ACCESS_TOKEN': 'token', 'GITLAB_HOST': 'https://gitlab.example'}
    with mock.patch.dict(os.environ, env, clear=True), mock.patch('requests.post') as post:
      g.post_commit_status('gitlab', self.result('undecidable'), 'qaboard/gate', 'kitefin/camera-isp')
    self.assertEqual(post.call_args.args[0], f'https://gitlab.example/api/v4/projects/kitefin%2Fcamera-isp/statuses/{SHA}')
    self.assertEqual(post.call_args.kwargs['json']['state'], 'failed')


class Answers(list):
  """Successive answers to the same request, the last one repeats"""


class Page:
  """An answer with a Link header to the next page"""
  def __init__(self, items, next_url=None):
    self.items, self.next_url = items, next_url


class FakeSession:
  """
  requests.Session, for the forges' comments APIs: `routes` {(method, url): json answer, or an exception, or an int
  for a refusal with this status code, or Answers([...]) for successive answers, or a Page}
  """
  def __init__(self, routes):
    self.routes, self.calls, self.params, self.headers = routes, [], [], {}
  def request(self, method, url, **kwargs):
    import requests
    self.calls.append((method, url, kwargs.get('json')))
    self.params.append(kwargs.get('params'))
    answer = self.routes.get((method, url), [])
    if isinstance(answer, Answers):
      answer = answer.pop(0) if len(answer) > 1 else answer[0]
    if isinstance(answer, Exception):
      raise answer
    links = {}
    if isinstance(answer, Page):
      links = {'next': {'url': answer.next_url, 'rel': 'next'}} if answer.next_url else {}
      answer = answer.items
    # an int is the status code of a refusal
    response = mock.Mock(status_code=answer if isinstance(answer, int) else 200, text='refused', headers={}, links=links)
    response.json.return_value = answer
    if isinstance(answer, int):
      response.raise_for_status.side_effect = requests.HTTPError(f'{answer} Client Error', response=response)
    return response
  def get(self, url, **kwargs): return self.request('GET', url, **kwargs)
  def post(self, url, **kwargs): return self.request('POST', url, **kwargs)
  def put(self, url, **kwargs): return self.request('PUT', url, **kwargs)
  def patch(self, url, **kwargs): return self.request('PATCH', url, **kwargs)


class TestGateComments(unittest.TestCase):
  """The gate's result as a comment on pull requests and merge requests"""
  def result(self):
    return {'verdict': 'pass', 'project': 'kitefin/camera-isp', 'commit': SHA, 'reference': 'main', 'errors': [], 'rules_changes': [], 'batches': [{
      'batch': 'default', 'verdict': 'pass', 'url': 'http://qa/p/commit/x', 'messages': [], 'reruns': None,
      'commit': {'id': SHA, 'runs': {'total': 3, 'failed': 0}}, 'reference': {'id': REF_SHA, 'type': 'commit'},
      'checks': [{'kind': 'max_failed_runs', 'metric': None, 'limit': 0, 'new': 0, 'ref': 0, 'status': 'pass', 'message': ''}],
    }]}

  def test_gitlab_merge_request(self):
    g = gate_module()
    api = 'https://gitlab.example/api/v4/projects/42'
    env = {'GITLAB_ACCESS_TOKEN': 'token', 'CI_API_V4_URL': 'https://gitlab.example/api/v4', 'CI_PROJECT_ID': '42'}
    # outside merge request pipelines, GitLab says which merge requests have the commit
    session = FakeSession({
      ('GET', f'{api}/repository/commits/{SHA}/merge_requests'): [{'iid': 5, 'state': 'opened'}, {'iid': 3, 'state': 'merged'}],
      ('GET', f'{api}/merge_requests/5/notes'): [{'id': 7, 'body': 'nice'}],
    })
    with mock.patch.dict(os.environ, env), mock.patch('requests.Session', return_value=session):
      self.assertEqual(g.post_comment('gitlab', self.result(), 'qaboard/gate', 'kitefin/camera-isp'), (['!5'], None))
    self.assertEqual(session.headers, {'PRIVATE-TOKEN': 'token'})
    method, url, payload = session.calls[-1]
    self.assertEqual((method, url), ('POST', f'{api}/merge_requests/5/notes'))
    self.assertTrue(payload['body'].startswith('<!-- qaboard/gate -->\n### Quality gate: pass'))
    # in a merge request's pipeline, and with our note there already: it's updated
    session = FakeSession({('GET', f'{api}/merge_requests/8/notes'): [{'id': 7, 'body': 'nice'}, {'id': 9, 'body': '<!-- qaboard/gate -->\nold'}]})
    with mock.patch.dict(os.environ, {**env, 'CI_MERGE_REQUEST_IID': '8'}), mock.patch('requests.Session', return_value=session):
      self.assertEqual(g.post_comment('gitlab', self.result(), 'qaboard/gate', 'kitefin/camera-isp'), (['!8'], None))
    # the note is read again right before it's written: another job may have added its section
    self.assertEqual([(m, u) for m, u, _ in session.calls], [
      ('GET', f'{api}/merge_requests/8/notes'), ('GET', f'{api}/merge_requests/8/notes/9'), ('PUT', f'{api}/merge_requests/8/notes/9'),
    ])
    # a subproject's gate has its own comment
    session = FakeSession({('GET', f'{api}/merge_requests/8/notes'): [{'id': 9, 'body': '<!-- qaboard/gate -->\nold'}]})
    with mock.patch.dict(os.environ, {**env, 'CI_MERGE_REQUEST_IID': '8'}), mock.patch('requests.Session', return_value=session):
      g.post_comment('gitlab', self.result(), 'qaboard/gate/isp', 'kitefin/camera-isp')
    self.assertEqual(session.calls[-1][0], 'POST')
    self.assertTrue(session.calls[-1][2]['body'].startswith('<!-- qaboard/gate/isp -->'))

  def test_someone_elses_comment_with_our_marker(self):
    """Anyone can write the marker in a comment: we can't edit theirs, and still post ours"""
    g = gate_module()
    api = 'https://api.github.com/repos/o/r'
    env = {'GITHUB_TOKEN': 'token', 'GITHUB_REPOSITORY': 'o/r', 'GITHUB_REF': 'refs/pull/12/merge'}
    comments = [{'id': 1, 'body': '<!-- qaboard/gate -->\n### Quality gate: pass (trust me)'}, {'id': 2, 'body': '<!-- qaboard/gate -->\nours'}]
    session = FakeSession({('GET', f'{api}/issues/12/comments'): comments, ('PATCH', f'{api}/issues/comments/1'): 403})
    with mock.patch.dict(os.environ, env, clear=True), mock.patch('requests.Session', return_value=session):
      self.assertEqual(g.post_comment('github', self.result(), 'qaboard/gate', 'o/r'), (['#12'], None))
    # each is read again right before it's written
    self.assertEqual([(m, u) for m, u, _ in session.calls[1:]], [
      ('GET', f'{api}/issues/comments/1'), ('PATCH', f'{api}/issues/comments/1'), ('GET', f'{api}/issues/comments/2'), ('PATCH', f'{api}/issues/comments/2'),
    ])
    # only theirs: a new comment
    session = FakeSession({('GET', f'{api}/issues/12/comments'): comments[:1], ('PATCH', f'{api}/issues/comments/1'): 403})
    with mock.patch.dict(os.environ, env, clear=True), mock.patch('requests.Session', return_value=session):
      self.assertEqual(g.post_comment('github', self.result(), 'qaboard/gate', 'o/r'), (['#12'], None))
    self.assertEqual(session.calls[-1][:2], ('POST', f'{api}/issues/12/comments'))

  def test_errors_are_warnings(self):
    import requests
    g = gate_module()
    with mock.patch.dict(os.environ, {}, clear=True):
      self.assertIn('GITHUB_TOKEN', g.post_comment('github', self.result(), 'qaboard/gate', 'p')[1])
      self.assertIn('GITLAB_ACCESS_TOKEN', g.post_comment('gitlab', self.result(), 'qaboard/gate', 'p')[1])
    # e.g. a pull request from a fork: the token can't write
    forbidden = requests.HTTPError('403 Client Error', response=mock.Mock(status_code=403, text='Resource not accessible by integration'))
    session = FakeSession({('GET', 'https://api.github.com/repos/o/r/issues/12/comments'): forbidden})
    env = {'GITHUB_TOKEN': 'token', 'GITHUB_REPOSITORY': 'o/r', 'GITHUB_REF': 'refs/pull/12/merge'}
    with mock.patch.dict(os.environ, env, clear=True), mock.patch('requests.Session', return_value=session):
      commented, error = g.post_comment('github', self.result(), 'qaboard/gate', 'o/r')
    self.assertEqual(commented, [])
    self.assertIn('could not comment on github', error)
    self.assertIn('pull-requests: write', error)

  def test_long_comments_are_cut(self):
    g = gate_module()
    result = self.result()
    result['batches'][0]['messages'] = ['x' * 500] * 200
    body = g.comment_body(result, 'qaboard/gate')
    self.assertLess(len(body), 61_000)
    self.assertIn('the rest is in the Metrics Diff', body)
    self.assertIn(f'For commit {SHA[:10]}', body)


class TestCommentInjection(unittest.TestCase):
  """What users name (tests, metrics, labels, batches) and what servers say end up in a comment many people read"""
  api = 'https://api.github.com/repos/o/r'
  env = {'GITHUB_TOKEN': 'token', 'GITHUB_REPOSITORY': 'o/r', 'GITHUB_REF': 'refs/pull/12/merge'}
  nasty = 'a|b `x` <!-- qaboard/gate end --> @octocat [click](http://evil) ![i](http://evil/i.png) <img src=x> \\ *bold* &#64;team'

  def result(self, label='default'):
    result = gate_result(label, 'fail', failed=1)
    batch = result['batches'][0]
    batch['messages'] = [self.nasty, 'two\nlines']
    batch['checks'].append({'kind': 'per_test_max_regression', 'metric': f'psnr {self.nasty}', 'limit': 0.05, 'status': 'fail', 'message': '',
                            'worst': {'test': self.nasty}, 'regression': 0.5, 'new': 1, 'ref': 2,
                            'over_limit_tests': [{'test': self.nasty, 'regression': 0.5}]})
    return result

  def test_markdown_text(self):
    g = gate_module()
    text = g.markdown_text(self.nasty)
    for raw in ('<!--', '<img', '](', '![', '@octocat', '&#64;', '*bold*'):
      self.assertNotIn(raw, text)
    # nothing left that would end a cell or escape ours
    self.assertNotIn('|', text.replace('\\|', ''))
    self.assertEqual(text, 'a\\|b `x` &lt;!-- qaboard/gate end --&gt; @&#8203;octocat [click]\\(http://evil) !\\[i]\\(http://evil/i.png) &lt;img src=x&gt; \\\\ \\*bold\\* &amp;#64;team')
    # our code spans stay code, and readable
    self.assertEqual(g.markdown_text('no runs from `qa batch perf` yet'), 'no runs from `qa batch perf` yet')
    self.assertEqual(g.markdown_text('my_test_file.py, psnr [perf, project rule]'), 'my_test_file.py, psnr [perf, project rule]')
    # a backtick that pairs with nothing is text
    self.assertEqual(g.markdown_text('a`b'), 'a\\`b')
    self.assertEqual(g.markdown_text('`a|b`'), '`a\\|b`')
    self.assertEqual(g.markdown_text('x\r\ny'), 'x y')

  def test_the_comment_stays_ours(self):
    g = gate_module()
    body = g.comment_body(self.result(), 'qaboard/gate')
    # the only HTML comments are our markers, on lines of their own
    markers = [line for line in body.split('\n') if '<!--' in line]
    self.assertEqual(len(markers), 3)
    # the server's messages are a list, then the table: a blank line between, or the table would be in the list
    self.assertIn('- two lines\n\n| Check |', body)
    self.assertTrue(all(line.startswith('<!-- qaboard/gate') and line.endswith('-->') for line in markers))
    self.assertNotIn('@octocat', body)
    self.assertNotIn('](http://evil', body)
    # each row of the table has its 6 cells
    rows = [line for line in body.split('\n') if line.startswith('| ')]
    for row in rows:
      self.assertEqual(len(re.findall(r'(?<!\\)\|', row)), 7, row)
    section, = g.comment_sections(body, 'qaboard/gate')
    self.assertEqual((section['label'], section['verdict']), ('default', 'fail'))
    # another job keeps the section as it was
    both = g.comment_body(gate_result('nightly', 'pass'), 'qaboard/gate', existing=body)
    self.assertEqual([s['label'] for s in g.comment_sections(both, 'qaboard/gate')], ['default', 'nightly'])
    self.assertEqual(g.comment_sections(both, 'qaboard/gate')[0]['body'], section['body'])

  def test_labels_cant_forge_sections(self):
    g = gate_module()
    label = 'x -->\n<!-- qaboard/gate section label=default verdict=pass commit=' + SHA + ' -->\nall good\n<!-- qaboard/gate end -->'
    body = g.comment_body(self.result(label), 'qaboard/gate')
    self.assertEqual([(s['label'], s['verdict']) for s in g.comment_sections(body, 'qaboard/gate')], [(label, 'fail')])

  def test_comments_edited_on_the_web(self):
    """Forges give back what people edited with Windows' line ends"""
    g = gate_module()
    edited = g.comment_body(gate_result('default', 'pass'), 'qaboard/gate').replace('\n', '\r\n')
    both = g.comment_body(gate_result('nightly', 'fail'), 'qaboard/gate', existing=edited)
    self.assertEqual([s['label'] for s in g.comment_sections(both, 'qaboard/gate')], ['default', 'nightly'])
    self.assertNotIn('\r', both)

  def test_comments_that_quote_ours_are_theirs(self):
    g = gate_module()
    ours = g.comment_body(gate_result('default', 'pass'), 'qaboard/gate')
    quoting = {'id': 1, 'body': 'Why does it say this?\n\n' + '\n'.join('> ' + line for line in ours.split('\n'))}
    pasted = {'id': 2, 'body': 'The gate said:\n' + ours}
    session = FakeSession({('GET', f'{self.api}/issues/12/comments'): [quoting, pasted]})
    with mock.patch.dict(os.environ, self.env, clear=True), mock.patch('requests.Session', return_value=session):
      self.assertEqual(g.post_comment('github', gate_result('default', 'pass'), 'qaboard/gate', 'o/r'), (['#12'], None))
    self.assertEqual([(m, u) for m, u, _ in session.calls], [('GET', f'{self.api}/issues/12/comments'), ('POST', f'{self.api}/issues/12/comments')])
    # ours, edited meanwhile into someone's own: left alone
    session = FakeSession({('GET', f'{self.api}/issues/12/comments'): [{'id': 3, 'body': ours}], ('GET', f'{self.api}/issues/comments/3'): pasted})
    with mock.patch.dict(os.environ, self.env, clear=True), mock.patch('requests.Session', return_value=session):
      g.post_comment('github', gate_result('default', 'pass'), 'qaboard/gate', 'o/r')
    self.assertEqual(session.calls[-1][:2], ('POST', f'{self.api}/issues/12/comments'))

  def test_gitlab_merge_requests_from_forks(self):
    """Their pipelines can run in the fork: the merge request's number is the target project's"""
    g = gate_module()
    env = {'GITLAB_ACCESS_TOKEN': 'token', 'CI_API_V4_URL': 'https://gitlab.example/api/v4', 'CI_PROJECT_ID': '99',
           'CI_MERGE_REQUEST_IID': '8', 'CI_MERGE_REQUEST_PROJECT_ID': '42'}
    session = FakeSession({})
    with mock.patch.dict(os.environ, env, clear=True), mock.patch('requests.Session', return_value=session):
      self.assertEqual(g.post_comment('gitlab', gate_result('default', 'pass'), 'qaboard/gate', 'p'), (['!8'], None))
    self.assertEqual(session.calls[-1][:2], ('POST', 'https://gitlab.example/api/v4/projects/42/merge_requests/8/notes'))

  def test_tokens_are_never_printed(self):
    import requests
    g = gate_module()
    token = 'ghp_s3cr3tt0k3nvalue'
    # secrets often end with a new line: requests refuses the header, and quotes it in its error
    env = {**self.env, 'GITHUB_TOKEN': token + '\n'}
    with mock.patch.dict(os.environ, env, clear=True):
      client, error = g.make_forge('github', 'o/r')
    self.assertEqual(client.session.headers['Authorization'], f'Bearer {token}')
    leak = requests.exceptions.InvalidHeader(f"Invalid return character or leading space in header: Authorization: 'Bearer {token}\\n'")
    session = FakeSession({('GET', f'{self.api}/issues/12/comments'): leak})
    with mock.patch.dict(os.environ, env, clear=True), mock.patch('requests.Session', return_value=session):
      commented, error = g.post_comment('github', gate_result('default', 'pass'), 'qaboard/gate', 'o/r')
    self.assertIn('could not comment on github', error)
    self.assertNotIn(token, error)
    with mock.patch.dict(os.environ, {'GITHUB_TOKEN': token, 'GITHUB_REPOSITORY': 'o/r'}, clear=True), mock.patch('requests.post', side_effect=leak):
      error = g.post_commit_status('github', gate_result('default', 'pass'), 'qaboard/gate', 'o/r')
    self.assertNotIn(token, error)
    with mock.patch('requests.get', side_effect=requests.ConnectionError(f'headers: Bearer {token}')):
      data, error = g.fetch_comparison('http://qa/api/v1', 'p', SHA, None, 'default', [], False, {'Authorization': f'Bearer {token}'}, True)
    self.assertNotIn(token, error)
    # nor in dry runs
    printed = []
    session = FakeSession({})
    with mock.patch.dict(os.environ, env, clear=True), mock.patch('requests.Session', return_value=session):
      g.post_comment('github', gate_result('default', 'pass'), 'qaboard/gate', 'o/r', dryrun=printed.append)
    self.assertNotIn(token, ''.join(printed))


class TestGateLedger(unittest.TestCase):
  """What reviewers should know, that doesn't change the verdict: runs done again, and rules that changed"""
  def test_reruns(self):
    g = gate_module()
    tests = [
      {'id': 1, 'test_input_path': 'a.jpg', 'is_failed': False, 'attempts': {'attempt': 3, 'previous': ['failed', 'unfinished'], 'in_place': False}},
      {'id': 2, 'test_input_path': 'b.jpg', 'is_failed': True, 'attempts': {'attempt': 2, 'previous': ['failed'], 'in_place': False}},
      {'id': 3, 'test_input_path': 'c.jpg', 'is_failed': False, 'attempts': {'attempt': 1, 'previous': ['success'], 'in_place': True}},
      {'id': 4, 'test_input_path': 'd.jpg', 'is_failed': False},
    ]
    data = {'commit': {'reruns': {'runs': 3, 'after_failure': 1, 'after_unfinished': 0}}, 'tests': tests}
    reruns = g.reruns_summary(data)
    self.assertEqual((reruns['runs'], reruns['after_failure']), (3, 1))
    # those that passed after a failure first
    self.assertEqual([t['test'] for t in reruns['tests']], ['a.jpg', 'c.jpg', 'b.jpg'])
    self.assertEqual(g.describe_reruns(reruns), [
      '3 runs were done again: 1 passed after a failed attempt.',
      "a.jpg: attempt 3, earlier: failed, didn't finish",
      'c.jpg: done again in place, earlier: succeeded',
      'b.jpg: attempt 2 (failed), earlier: failed',
    ])
    # older servers don't say, and most batches have none
    self.assertIsNone(g.reruns_summary({'commit': {}, 'tests': tests}))
    self.assertIsNone(g.reruns_summary({'commit': {'reruns': {'runs': 0}}, 'tests': []}))
    self.assertEqual(g.describe_reruns(None), [])
    with mock.patch.object(g, 'MAX_LISTED', 1):
      self.assertEqual(g.describe_reruns(g.reruns_summary(data))[-1], 'and 2 more')

  def test_rules_changes(self):
    g = gate_module()
    def changes(new, old):
      return [(c['text'], c['looser']) for c in g.rules_changes(g.parse_config({'gate': new}), old)]
    rules = [{'metric': 'psnr', 'max_regression': '1%', 'min': 30}, {'metric': 'latency', 'per_test_max_regression': '10%'}, {'metric': 'unsafe', 'max': 0, 'aggregate': 'max'}]
    self.assertEqual(changes({'rules': rules}, {'rules': rules}), [])
    looser = [{'metric': 'psnr', 'max_regression': '5%', 'min': 28}, {'metric': 'unsafe', 'max': 1, 'aggregate': 'max'}, {'metric': 'ssim', 'min': 0.9}]
    self.assertEqual(changes({'rules': looser, 'max_failed_runs': None, 'require_bit_accuracy': False}, {'rules': rules, 'max_failed_runs': 0, 'require_bit_accuracy': True}), [
      ('latency, each test: removed (was 10%)', True),
      ('psnr, median, max regression: 1% → 5%', True),
      ('psnr, median, min: 30 → 28', True),
      ('unsafe, max, max: 0 → 1', True),
      ('ssim, median, min: new (0.9)', False),
      ('failed runs allowed: 0 → any number', True),
      ('bit accuracy required: yes → no', True),
    ])
    # stricter rules are changes too, not flagged as looser
    self.assertEqual(changes({'rules': [{'metric': 'psnr', 'max_regression': '0.5%'}], 'max_failed_runs': 0}, {'rules': [{'metric': 'psnr', 'max_regression': '1%'}], 'max_failed_runs': 2}), [
      ('psnr, median, max regression: 1% → 0.5%', False),
      ('failed runs allowed: 2 → 0', False),
    ])
    self.assertEqual(g.describe_rules_changes([{'text': 'a: 1 → 2', 'looser': False}]), ["This commit changes the gate's rules, compared with the reference's:", 'a: 1 → 2'])
    # the reference had no gate: every rule is new. Unknown: we don't have its configuration, or can't read it
    self.assertEqual(changes({'rules': rules[:1]}, {}), [('psnr, median, max regression: new (1%)', False), ('psnr, median, min: new (30)', False)])
    self.assertEqual(changes({'rules': rules}, None), [])
    self.assertEqual(changes({'rules': rules}, {'rules': 'not a list'}), [])
    # settings a later version added don't hide the rest
    self.assertEqual(changes({'rules': rules}, {'rules': rules, 'noise': 'auto'}), [])


# ---------------------------------------------------------------------------- labels and batches

def with_batches(comparison=None):
  """The fixture's runs, from two `qa batch`: the charts from `qa batch ci`, the photos from `qa batch perf`"""
  comparison = comparison or fixture_comparison()
  for test in comparison['tests']:
    test['batch'] = 'ci' if test['test_input_path'].startswith('charts/') else 'perf'
  return comparison


class TestGateLabels(unittest.TestCase):
  """`labels` (was `batches`), `expect_batches`, and rules' `batch` and `label` (docs/rfcs/gate-scopes-and-comments.md)"""

  def test_labels_and_their_older_name(self):
    g = gate_module()
    self.assertEqual(g.parse_config({'gate': {'labels': ['default', 'nightly']}}).labels, ['default', 'nightly'])
    # `batches` keeps working, with the same meaning
    config = g.parse_config({'gate': {'batches': 'nightly'}})
    self.assertEqual((config.labels, config.batches), (['nightly'], ['nightly']))
    with self.assertRaisesRegex(g.GateConfigError, r'gate: give `labels`, or `batches`, its older name, not both'):
      g.parse_config({'gate': {'labels': ['a'], 'batches': ['b']}})
    with self.assertRaisesRegex(g.GateConfigError, r'gate\.labels: expected a list of labels'):
      g.parse_config({'gate': {'labels': []}})

  def test_scopes_and_expected_batches(self):
    g = gate_module()
    config = g.parse_config({'gate': {
      'expect_batches': ['ci', 'perf'],
      'rules': [
        {'metric': 'latency_p99', 'max_regression': '10%', 'batch': 'perf'},
        {'metric': 'coverage', 'min': 80, 'batch': ['unit', 'integration-*']},
        {'metric': 'accuracy', 'min': 0.9, 'label': 'nightly'},
      ],
    }})
    self.assertEqual([r.to_dict() for r in config.rules], [
      {'metric': 'latency_p99', 'kind': 'max_regression', 'limit': 0.1, 'aggregate': 'median', 'batch': ['perf']},
      {'metric': 'coverage', 'kind': 'min', 'limit': 80, 'aggregate': 'median', 'batch': ['unit', 'integration-*']},
      {'metric': 'accuracy', 'kind': 'min', 'limit': 0.9, 'aggregate': 'median', 'label': ['nightly']},
    ])
    self.assertEqual(config.expect_batches, {'*': ['ci', 'perf']})
    self.assertEqual(config.expected_batches(['nightly']), (['ci', 'perf'], False))
    # per label
    config = g.parse_config({'gate': {'expect_batches': {'default': ['ci', 'perf'], 'nightly': 'all'}}})
    self.assertEqual(config.expect_batches, {'default': ['ci', 'perf'], 'nightly': ['all']})
    self.assertEqual(config.expected_batches(g.names_of_label('ci')), (['ci', 'perf'], False))
    self.assertEqual(config.expected_batches(['nightly']), (['all'], False))
    self.assertEqual(config.expected_batches(['tuning']), ([], False))
    for gate in [
      {'rules': [{'metric': 'psnr', 'min': 1, 'batch': []}]},
      {'rules': [{'metric': 'psnr', 'min': 1, 'label': {'a': 1}}]},
      {'rules': [{'metric': 'psnr', 'min': 1, 'batches': 'perf'}]},   # typo
      {'expect_batches': 'yes please'.split(' ') + [True]},
      {'expect_batches': {'default': [None]}},
    ]:
      with self.subTest(gate=gate), self.assertRaises(g.GateConfigError):
        g.parse_config({'gate': gate})

  def test_rules_on_the_runs_of_a_batch(self):
    g = gate_module()
    # the photos' p99 latency is 10% worse (11 vs 10 ms), while the median of all the runs improves (11.5 vs 12)
    rules = [{'metric': 'latency_p99', 'max_regression': '5%'}, {'metric': 'latency_p99', 'max_regression': '5%', 'batch': 'perf'}]
    evaluation = evaluate(rules, with_batches())
    overall, perf = evaluation['checks']
    self.assertEqual((overall['status'], perf['status'], evaluation['verdict']), ('pass', 'fail', 'fail'))
    # computed over the photos, and the reference runs they're compared with: not the server's medians
    self.assertEqual((perf['new'], perf['ref'], perf['tests_matched']), (11, 10, 4))
    self.assertAlmostEqual(perf['regression'], 0.1)
    self.assertEqual(g.check_label(perf), 'latency_p99, median [perf]')
    # means too, and patterns
    check = evaluate([{'metric': 'psnr', 'min': 0, 'aggregate': 'mean', 'batch': 'c*'}], with_batches())['checks'][0]
    self.assertEqual(check['new'], 30)
    # per test, only those of the batch: the night photo is 20% worse, the charts are fine
    evaluation = evaluate([{'metric': 'psnr', 'per_test_max_regression': '5%', 'batch': 'ci'}, {'metric': 'psnr', 'per_test_max_regression': '5%', 'batch': 'perf'}], with_batches())
    charts, photos = evaluation['checks']
    self.assertEqual((charts['status'], charts['tests_compared']), ('pass', 2))
    self.assertEqual((photos['status'], photos['worst']['test'], photos['tests_compared']), ('fail', 'photos/night.jpg', 4))
    self.assertEqual(g.check_label(photos), 'psnr, each test (worst: photos/night.jpg) [perf]')

  def test_no_runs_from_the_batch_yet(self):
    evaluation = evaluate([{'metric': 'psnr', 'min': 0}, {'metric': 'psnr', 'min': 0, 'batch': ['nightly', 'weekly']}], with_batches())
    self.assertEqual([c['status'] for c in evaluation['checks']], ['pass', 'unknown'])
    self.assertEqual(evaluation['checks'][1]['message'], 'no runs from `qa batch nightly` or `qa batch weekly` yet')
    self.assertEqual(evaluation['verdict'], 'undecidable')
    # a failure elsewhere still fails
    self.assertEqual(evaluate([{'metric': 'psnr', 'max': 0}, {'metric': 'psnr', 'min': 0, 'batch': 'nightly'}], with_batches())['verdict'], 'fail')
    # runs of the batch, without the metric: like for all the runs, it fails
    check = evaluate([{'metric': 'runtime', 'min': 0, 'batch': 'perf'}], with_batches())['checks'][0]
    self.assertEqual((check['status'], check['message']), ('fail', 'no values of runtime in the runs from `qa batch perf`'))

  def test_older_servers_dont_say_which_batch(self):
    # fixture_comparison() is what servers from before November 2026 answer: tests without `batch`
    evaluation = evaluate([{'metric': 'psnr', 'min': 0, 'batch': 'perf'}, {'metric': 'psnr', 'min': 0}], expect_batches=['ci'])
    scoped, unscoped, expected = evaluation['checks']
    self.assertEqual((scoped['status'], unscoped['status'], expected['status'], evaluation['verdict']), ('unknown', 'pass', 'unknown', 'undecidable'))
    self.assertIn("doesn't say which batch each run comes from: upgrade it", scoped['message'])
    self.assertIn("upgrade it to check that `qa batch ci` have runs", expected['message'])

  def test_rules_for_some_labels(self):
    g = gate_module()
    rules = [{'metric': 'psnr', 'min': 0}, {'metric': 'psnr', 'max': 0, 'label': 'nightly'}, {'metric': 'psnr', 'min': 0, 'label': 'ci'}]
    config = g.parse_config({'gate': {'rules': rules, 'max_failed_runs': None}})
    # checking the CI's results: the nightly rule is left out, silently. `ci` names the CI's label, `default`
    evaluation = g.evaluate_batch(with_batches(), config, {}, label='default')
    self.assertEqual([(c['kind'], c['status']) for c in evaluation['checks']], [('min', 'pass'), ('min', 'pass')])
    nightly = {**with_batches(), 'commit': {**with_batches()['commit'], 'batch': 'nightly'}}
    evaluation = g.evaluate_batch(nightly, config, {}, label='nightly')
    self.assertEqual([(c['kind'], c['status'], c.get('scope_label')) for c in evaluation['checks']], [('min', 'pass', None), ('max', 'fail', ['nightly'])])
    self.assertEqual(g.check_label(evaluation['checks'][1]), 'psnr, median')

  def test_expected_batches(self):
    comparison = with_batches()
    self.assertEqual(evaluate([], comparison, expect_batches=['ci', 'perf'])['verdict'], 'pass')
    evaluation = evaluate([], comparison, expect_batches=['ci', 'perf', 'nightly'])
    check, = evaluation['checks']
    self.assertEqual((check['kind'], check['status'], check['missing'], check['message']), ('expect_batches', 'unknown', ['nightly'], 'no runs from `qa batch nightly` yet'))
    self.assertEqual(evaluation['verdict'], 'undecidable')
    g = gate_module()
    self.assertEqual(g.table_rows(evaluation)[0], ['batches with runs', '2 of 3', '', '', 'runs from ci, perf, nightly', 'unknown: no runs from `qa batch nightly` yet'])
    # per label: the nightly results need their own
    self.assertEqual(evaluate([], comparison, expect_batches={'nightly': ['all']})['checks'], [])
    self.assertEqual(evaluate([], comparison, expect_batches={'default': ['ci', 'perf*']})['verdict'], 'pass')
    self.assertEqual(evaluate([], comparison, expect_batches={'default': ['ci', 'unit']})['verdict'], 'undecidable')

  def test_undecidable_says_why(self):
    g = gate_module()
    config = g.parse_config({'project': {'reference_branch': 'main'}, 'gate': {'expect_batches': ['perf', 'nightly'], 'max_failed_runs': None}})
    result = g.run_gate(config, 'kitefin/camera-isp', SHA, lambda label: (with_batches(), None), {}, 'http://localhost:5151')
    self.assertEqual((result['verdict'], result['labels'], result['expect_batches']), ('undecidable', ['default'], {'*': ['perf', 'nightly']}))
    self.assertEqual(result['batches'][0]['label'], 'default')
    self.assertEqual(g.status_description(result), 'undecidable: no runs from `qa batch nightly` yet')

  def test_project_rules_with_scopes(self):
    g = gate_module()
    comparison = {**with_batches(), 'project_gate': {
      'rules': [{'metric': 'latency_p99', 'max_regression': '5%', 'batch': 'perf'}, {'metric': 'psnr', 'max': 0, 'label': 'nightly'}],
      'expect_batches': {'default': ['perf']},
    }}
    config = g.parse_config({'project': {'reference_branch': 'main'}, 'gate': {'expect_batches': ['ci'], 'max_failed_runs': None, 'rules': [{'metric': 'psnr', 'min': 0}]}})
    result = g.run_gate(config, 'kitefin/camera-isp', SHA, lambda label: (comparison, None), {}, 'http://localhost:5151')
    checks = result['batches'][0]['checks']
    self.assertEqual([(c['kind'], c.get('source'), c['status']) for c in checks], [('min', None, 'pass'), ('max_regression', 'project', 'fail'), ('expect_batches', None, 'pass')])
    # the union of the commit's and the project's
    self.assertEqual(checks[2]['limit'], ['ci', 'perf'])
    self.assertEqual(g.check_label(checks[1]), 'latency_p99, median [perf, project rule]')
    self.assertIn('| latency_p99, median [perf, project rule] | 11 ms | 10 ms | 10.0% worse | 5% worse | FAIL |', g.render(result, 'markdown'))
    self.assertEqual(result['project_expect_batches'], {'default': ['perf']})
    # only the project's: marked so
    config = g.parse_config({'project': {'reference_branch': 'main'}, 'gate': {'max_failed_runs': None}})
    result = g.run_gate(config, 'kitefin/camera-isp', SHA, lambda label: ({**comparison, 'project_gate': {'expect_batches': ['nightly']}}, None), {}, 'http://localhost:5151')
    check, = result['batches'][0]['checks']
    self.assertEqual((check['source'], check['status'], g.check_label(check)), ('project', 'unknown', 'batches with runs [project rule]'))

  def test_scopes_in_rules_changes(self):
    g = gate_module()
    def changes(new, old):
      return [(c['text'], c['looser']) for c in g.rules_changes(g.parse_config({'gate': new}), old)]
    everywhere = {'metric': 'latency', 'max_regression': '10%'}
    perf = {**everywhere, 'batch': 'perf'}
    self.assertEqual(changes({'rules': [perf]}, {'rules': [perf]}), [])
    # checking fewer runs is looser
    self.assertEqual(changes({'rules': [perf]}, {'rules': [everywhere]}), [('latency, median, max regression: every run → only `qa batch perf`', True)])
    self.assertEqual(changes({'rules': [everywhere]}, {'rules': [perf]}), [('latency, median, max regression: only `qa batch perf` → every run', False)])
    self.assertEqual(changes({'rules': [{**perf, 'max_regression': '5%', 'batch': ['perf', 'nightly']}]}, {'rules': [perf]}),
                     [('latency, median, max regression: only `qa batch perf` → only `qa batch perf` or `qa batch nightly`, 10% → 5%', False)])
    self.assertEqual(changes({'rules': [{**everywhere, 'label': 'nightly'}]}, {'rules': [everywhere]}), [('latency, median, max regression: every run → only the label nightly', True)])
    # the same metric for another batch, next to the rule for all: a new rule
    self.assertEqual(changes({'rules': [everywhere, {**perf, 'max_regression': '20%'}]}, {'rules': [everywhere]}), [('latency, median, max regression [perf]: new (20%)', False)])
    self.assertEqual(changes({'rules': [everywhere]}, {'rules': [everywhere, perf]}), [('latency, median, max regression [perf]: removed (was 10%)', True)])
    self.assertEqual(changes({'rules': [{**perf, 'max_regression': '20%'}]}, {'rules': [perf]}), [('latency, median, max regression [perf]: 10% → 20%', True)])
    # waiting for fewer batches is looser
    self.assertEqual(changes({'expect_batches': ['ci']}, {'expect_batches': ['ci', 'perf']}), [('batches the gate waits for: ci, perf → ci', True)])
    self.assertEqual(changes({'expect_batches': {'nightly': ['all']}}, {}), [('batches the gate waits for (label nightly): none → all', False)])
    # the reference's qaboard.yaml may say `batches` or `labels`
    self.assertEqual(changes({'labels': ['ci']}, {'batches': ['ci']}), [])


def gate_result(label, verdict, commit=SHA, failed=0):
  """What run_gate returns for one label"""
  return {'verdict': verdict, 'project': 'kitefin/camera-isp', 'commit': commit, 'reference': 'main', 'errors': [], 'rules_changes': [], 'batches': [{
    'batch': label, 'label': label, 'verdict': verdict, 'url': f'http://qa/p/commit/x?batch={label}', 'messages': [], 'reruns': None,
    'commit': {'id': commit, 'runs': {'total': 3, 'failed': failed}}, 'reference': {'id': REF_SHA, 'type': 'commit'},
    'checks': [{'kind': 'max_failed_runs', 'metric': None, 'limit': 0, 'new': failed, 'ref': 0, 'status': 'fail' if failed else 'pass', 'message': ''}],
  }]}


class TestSharedComment(unittest.TestCase):
  """One comment per pull request and gate, with a section per label, shared by each `qa gate` of the commit"""
  api = 'https://api.github.com/repos/o/r'
  env = {'GITHUB_TOKEN': 'token', 'GITHUB_REPOSITORY': 'o/r', 'GITHUB_REF': 'refs/pull/12/merge'}

  def test_sections_per_label(self):
    g = gate_module()
    ci = g.comment_body(gate_result('default', 'pass'), 'qaboard/gate')
    self.assertTrue(ci.startswith('<!-- qaboard/gate -->\n### Quality gate: pass\n'))
    self.assertIn(f'<!-- qaboard/gate section label=default verdict=pass commit={SHA} -->\n**kitefin/camera-isp', ci)
    self.assertEqual([s['label'] for s in g.comment_sections(ci, 'qaboard/gate')], ['default'])
    # one label: no line of verdicts
    self.assertNotIn('**CI**: pass', ci)

    # the nightly job's gate keeps the CI's section
    both = g.comment_body(gate_result('nightly', 'fail', failed=2), 'qaboard/gate', existing=ci)
    self.assertTrue(both.startswith('<!-- qaboard/gate -->\n### Quality gate: fail\n\n**CI**: pass · **nightly**: fail\n'))
    sections = g.comment_sections(both, 'qaboard/gate')
    self.assertEqual([(s['label'], s['verdict'], s['commit']) for s in sections], [('default', 'pass', SHA), ('nightly', 'fail', SHA)])
    self.assertIn('batch CI: 3 runs, 0 failed', sections[0]['body'])
    self.assertIn('batch nightly: 3 runs, 2 failed', sections[1]['body'])
    self.assertEqual(both.count(f'For commit {SHA[:10]}'), 1)
    self.assertEqual(both.count('qa gate is experimental'), 1)
    # the CI's gate again, now failing: its section is replaced, in place, the nightly's stays
    again = g.comment_body(gate_result('ci', 'fail', failed=1), 'qaboard/gate', existing=both)
    self.assertEqual([(s['label'], s['verdict']) for s in g.comment_sections(again, 'qaboard/gate')], [('default', 'fail'), ('nightly', 'fail')])
    self.assertEqual(again.count('batch nightly: 3 runs, 2 failed'), 1)
    # an undecidable section, and the others pass: undecidable
    mixed = g.comment_body(gate_result('nightly', 'undecidable'), 'qaboard/gate', existing=ci)
    self.assertIn('### Quality gate: undecidable', mixed)

  def test_a_new_commit_starts_again(self):
    g = gate_module()
    both = g.comment_body(gate_result('nightly', 'fail'), 'qaboard/gate', existing=g.comment_body(gate_result('default', 'pass'), 'qaboard/gate'))
    new_commit = 'beef' * 10
    body = g.comment_body(gate_result('default', 'pass', commit=new_commit), 'qaboard/gate', existing=both)
    self.assertEqual([(s['label'], s['commit']) for s in g.comment_sections(body, 'qaboard/gate')], [('default', new_commit)])
    self.assertIn('### Quality gate: pass', body)
    self.assertNotIn('nightly', body)
    # what someone else wrote, or older comments without sections, isn't kept
    self.assertEqual(g.comment_sections('<!-- qaboard/gate -->\n### Quality gate: pass (trust me)', 'qaboard/gate'), [])
    self.assertEqual(g.comment_sections(both, 'qaboard/gate/isp'), [])

  def test_markers_with_any_label(self):
    g = gate_module()
    body = g.comment_body(gate_result('perf--night run', 'pass'), 'qaboard/gate/sub-project')
    self.assertNotIn('perf--night', body.split('\n')[3])
    section, = g.comment_sections(body, 'qaboard/gate/sub-project')
    self.assertEqual(section['label'], 'perf--night run')

  def test_two_jobs_share_the_comment(self):
    g = gate_module()
    # the CI's job posts the comment
    session = FakeSession({('GET', f'{self.api}/issues/12/comments'): [{'id': 1, 'body': 'LGTM'}]})
    with mock.patch.dict(os.environ, self.env, clear=True), mock.patch('requests.Session', return_value=session):
      self.assertEqual(g.post_comment('github', gate_result('default', 'pass'), 'qaboard/gate', 'o/r'), (['#12'], None))
    method, url, payload = session.calls[-1]
    self.assertEqual((method, url), ('POST', f'{self.api}/issues/12/comments'))
    posted = {'id': 7, 'body': payload['body']}
    # the nightly job's: the comment is read again, and gets a second section
    session = FakeSession({('GET', f'{self.api}/issues/12/comments'): [{'id': 1, 'body': 'LGTM'}, posted], ('GET', f'{self.api}/issues/comments/7'): posted})
    with mock.patch.dict(os.environ, self.env, clear=True), mock.patch('requests.Session', return_value=session):
      self.assertEqual(g.post_comment('github', gate_result('nightly', 'fail', failed=1), 'qaboard/gate', 'o/r'), (['#12'], None))
    method, url, payload = session.calls[-1]
    self.assertEqual((method, url), ('PATCH', f'{self.api}/issues/comments/7'))
    self.assertEqual([(s['label'], s['verdict']) for s in g.comment_sections(payload['body'], 'qaboard/gate')], [('default', 'pass'), ('nightly', 'fail')])
    # what's kept is the comment as it is right before writing, not as it was listed
    listed = {'id': 7, 'body': g.comment_body(gate_result('weekly', 'pass'), 'qaboard/gate')}
    session = FakeSession({('GET', f'{self.api}/issues/12/comments'): [listed], ('GET', f'{self.api}/issues/comments/7'): posted})
    with mock.patch.dict(os.environ, self.env, clear=True), mock.patch('requests.Session', return_value=session):
      g.post_comment('github', gate_result('nightly', 'fail'), 'qaboard/gate', 'o/r')
    self.assertEqual([s['label'] for s in g.comment_sections(session.calls[-1][2]['body'], 'qaboard/gate')], ['default', 'nightly'])
    # deleted meanwhile: a new one
    session = FakeSession({('GET', f'{self.api}/issues/12/comments'): [posted], ('GET', f'{self.api}/issues/comments/7'): 404})
    with mock.patch.dict(os.environ, self.env, clear=True), mock.patch('requests.Session', return_value=session):
      self.assertEqual(g.post_comment('github', gate_result('nightly', 'fail'), 'qaboard/gate', 'o/r'), (['#12'], None))
    self.assertEqual(session.calls[-1][0], 'POST')

  def test_long_comments_keep_every_section(self):
    g = gate_module()
    ci = gate_result('default', 'pass')
    ci['batches'][0]['messages'] = ['c' * 500] * 200
    nightly = gate_result('nightly', 'fail', failed=1)
    nightly['batches'][0]['checks'].append({'kind': 'per_test_max_regression', 'metric': 'psnr', 'limit': 0.05, 'status': 'fail', 'message': '',
                                            'over_limit_tests': [{'test': 'x' * 100, 'regression': 0.5}] * 600})
    body = g.comment_body(nightly, 'qaboard/gate', existing=g.comment_body(ci, 'qaboard/gate'))
    self.assertLess(len(body), g.MAX_COMMENT_LENGTH)
    self.assertEqual([s['label'] for s in g.comment_sections(body, 'qaboard/gate')], ['default', 'nightly'])
    self.assertIn('batch nightly: 3 runs, 1 failed', body)
    self.assertIn('the rest is in the Metrics Diff', body)
    self.assertIn(f'For commit {SHA[:10]}', body)

  def test_retries_once(self):
    import requests
    g = gate_module()
    # rate limited, each time: each request is tried again once
    session = FakeSession({
      ('GET', f'{self.api}/issues/12/comments'): Answers([429, []]),
      ('POST', f'{self.api}/issues/12/comments'): Answers([429, {}]),
    })
    with mock.patch.dict(os.environ, self.env, clear=True), mock.patch('requests.Session', return_value=session), mock.patch('time.sleep') as sleep:
      self.assertEqual(g.post_comment('github', gate_result('default', 'pass'), 'qaboard/gate', 'o/r'), (['#12'], None))
    self.assertEqual([m for m, _, _ in session.calls], ['GET', 'GET', 'POST', 'POST'])
    self.assertEqual(sleep.call_args_list, [mock.call(g.RETRY_DELAY)] * 2)
    # the forge down for a moment: reads are tried again, not what creates a comment: it may be there anyway
    session = FakeSession({
      ('GET', f'{self.api}/issues/12/comments'): Answers([502, []]),
      ('POST', f'{self.api}/issues/12/comments'): Answers([502, {}]),
    })
    with mock.patch.dict(os.environ, self.env, clear=True), mock.patch('requests.Session', return_value=session), mock.patch('time.sleep'):
      commented, error = g.post_comment('github', gate_result('default', 'pass'), 'qaboard/gate', 'o/r')
    self.assertEqual([m for m, _, _ in session.calls], ['GET', 'GET', 'POST'])
    self.assertIn('could not comment on github: 502', error)
    # only once
    session = FakeSession({('GET', f'{self.api}/issues/12/comments'): 503})
    with mock.patch.dict(os.environ, self.env, clear=True), mock.patch('requests.Session', return_value=session), mock.patch('time.sleep'):
      commented, error = g.post_comment('github', gate_result('default', 'pass'), 'qaboard/gate', 'o/r')
    self.assertEqual((commented, len(session.calls)), ([], 2))
    self.assertIn('could not comment on github: 503', error)
    # not on refusals, and as long as Retry-After says, within reason
    session = FakeSession({('GET', f'{self.api}/issues/12/comments'): 401})
    with mock.patch.dict(os.environ, self.env, clear=True), mock.patch('requests.Session', return_value=session):
      g.post_comment('github', gate_result('default', 'pass'), 'qaboard/gate', 'o/r')
    self.assertEqual(len(session.calls), 1)
    self.assertEqual(g.retry_delay(mock.Mock(headers=requests.structures.CaseInsensitiveDict({'retry-after': '3'}))), 3)
    # longer than we wait: no second try, it would be refused too
    self.assertIsNone(g.retry_delay(mock.Mock(headers={'Retry-After': '3600'})))
    with mock.patch('time.time', return_value=1000):
      self.assertEqual(g.retry_delay(mock.Mock(headers={'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1010'})), 10)
      self.assertIsNone(g.retry_delay(mock.Mock(headers={'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '4600'})))
    limited = mock.Mock(status_code=429, headers={'Retry-After': '3600'})
    with mock.patch('time.sleep') as sleep:
      self.assertIs(g.with_retry(lambda: limited), limited)
    sleep.assert_not_called()
    # GitHub's secondary rate limits can be 403s
    self.assertTrue(g.should_retry(mock.Mock(status_code=403, headers={'Retry-After': '1'})))
    self.assertFalse(g.should_retry(mock.Mock(status_code=403, headers={})))
    # statuses too: posting the same status again replaces it
    first, second = mock.Mock(status_code=500, headers={}), mock.Mock(status_code=201, headers={})
    with mock.patch.dict(os.environ, {'GITHUB_TOKEN': 't', 'GITHUB_REPOSITORY': 'o/r'}, clear=True), mock.patch('requests.post', side_effect=[first, second]) as post, mock.patch('time.sleep'):
      self.assertIsNone(g.post_commit_status('github', gate_result('default', 'pass'), 'qaboard/gate', 'o/r'))
    self.assertEqual(post.call_count, 2)

  def test_pages_of_comments(self):
    g = gate_module()
    ours = {'id': 300, 'body': g.comment_body(gate_result('default', 'pass'), 'qaboard/gate')}
    # GitHub: the Link header's next page
    next_url = f'{self.api}/issues/12/comments?per_page=100&page=2'
    session = FakeSession({
      ('GET', f'{self.api}/issues/12/comments'): Page([{'id': i, 'body': 'hi'} for i in range(100)], next_url),
      ('GET', next_url): Page([ours]),
      ('GET', f'{self.api}/issues/comments/300'): ours,
    })
    with mock.patch.dict(os.environ, self.env, clear=True), mock.patch('requests.Session', return_value=session):
      g.post_comment('github', gate_result('nightly', 'pass'), 'qaboard/gate', 'o/r')
    self.assertEqual(session.calls[-1][:2], ('PATCH', f'{self.api}/issues/comments/300'))
    self.assertEqual(session.params[:2], [{'per_page': 100, 'page': 1}, None])
    # without links, page by page; GitLab's notes oldest first, without its own notes
    api = 'https://gitlab.example/api/v4/projects/42'
    session = FakeSession({('GET', f'{api}/merge_requests/8/notes'): Answers([[{'id': i, 'body': 'hi'} for i in range(100)], [{'id': 5, 'body': ours['body'], 'system': True}]])})
    env = {'GITLAB_ACCESS_TOKEN': 'token', 'CI_API_V4_URL': 'https://gitlab.example/api/v4', 'CI_PROJECT_ID': '42', 'CI_MERGE_REQUEST_IID': '8'}
    with mock.patch.dict(os.environ, env, clear=True), mock.patch('requests.Session', return_value=session):
      self.assertEqual(g.post_comment('gitlab', gate_result('default', 'pass'), 'qaboard/gate', 'p'), (['!8'], None))
    self.assertEqual(session.params[:2], [{'sort': 'asc', 'order_by': 'created_at', 'per_page': 100, 'page': 1}, {'sort': 'asc', 'order_by': 'created_at', 'per_page': 100, 'page': 2}])
    self.assertEqual(session.calls[-1][:2], ('POST', f'{api}/merge_requests/8/notes'))

  def test_which_pull_request(self):
    g = gate_module()
    with tempfile.TemporaryDirectory() as tmp:
      event = Path(tmp) / 'event.json'
      # pull_request_target runs on the base branch: the event says which pull request
      event.write_text(json.dumps({'pull_request': {'number': 34, 'state': 'open', 'head': {'sha': SHA}}}))
      env = {'GITHUB_TOKEN': 'token', 'GITHUB_REPOSITORY': 'o/r', 'GITHUB_REF': 'refs/heads/main', 'GITHUB_EVENT_NAME': 'pull_request_target', 'GITHUB_EVENT_PATH': str(event)}
      session = FakeSession({})
      with mock.patch.dict(os.environ, env, clear=True), mock.patch('requests.Session', return_value=session):
        self.assertEqual(g.post_comment('github', gate_result('default', 'pass'), 'qaboard/gate', 'o/r'), (['#34'], None))
      # a closed pull request: no comment
      event.write_text(json.dumps({'pull_request': {'number': 34, 'state': 'closed'}}))
      with mock.patch.dict(os.environ, env, clear=True), mock.patch('requests.Session', return_value=FakeSession({})):
        self.assertEqual(g.post_comment('github', gate_result('default', 'pass'), 'qaboard/gate', 'o/r')[0], [])
    # pushes: the commit's open pull requests, at most 3 (merged ones are listed too)
    pulls = [{'number': n, 'state': 'open', 'draft': n == 2} for n in range(1, 6)] + [{'number': 9, 'state': 'closed'}]
    session = FakeSession({('GET', f'{self.api}/commits/{SHA}/pulls'): pulls})
    with mock.patch.dict(os.environ, {**self.env, 'GITHUB_REF': 'refs/heads/feature', 'GITHUB_EVENT_NAME': 'push'}, clear=True), mock.patch('requests.Session', return_value=session):
      self.assertEqual(g.post_comment('github', gate_result('default', 'pass'), 'qaboard/gate', 'o/r'), (['#1', '#2', '#3'], None))
    # GitLab branch pipelines: the open merge requests
    api = 'https://gitlab.example/api/v4/projects/42'
    session = FakeSession({('GET', f'{api}/repository/commits/{SHA}/merge_requests'): [{'iid': 5, 'state': 'opened'}]})
    env = {'GITLAB_ACCESS_TOKEN': 'token', 'CI_API_V4_URL': 'https://gitlab.example/api/v4', 'CI_PROJECT_ID': '42'}
    with mock.patch.dict(os.environ, env, clear=True), mock.patch('requests.Session', return_value=session):
      self.assertEqual(g.post_comment('gitlab', gate_result('default', 'pass'), 'qaboard/gate', 'p'), (['!5'], None))
    self.assertEqual(session.params[0], {'state': 'opened', 'per_page': 100})

  def test_dry_run(self):
    g = gate_module()
    existing = {'id': 7, 'body': g.comment_body(gate_result('nightly', 'fail'), 'qaboard/gate')}
    session = FakeSession({('GET', f'{self.api}/issues/12/comments'): [existing], ('GET', f'{self.api}/issues/comments/7'): existing})
    printed = []
    with mock.patch.dict(os.environ, self.env, clear=True), mock.patch('requests.Session', return_value=session):
      self.assertEqual(g.post_comment('github', gate_result('default', 'pass'), 'qaboard/gate', 'o/r', dryrun=printed.append), (['#12'], None))
    # it reads, and writes nothing
    self.assertEqual({m for m, _, _ in session.calls}, {'GET'})
    output, = printed
    self.assertTrue(output.startswith('Dry run: would update the comment 7 on pull request #12'))
    self.assertIn('**CI**: pass · **nightly**: fail', output)
    # a new comment
    session = FakeSession({})
    printed.clear()
    with mock.patch.dict(os.environ, self.env, clear=True), mock.patch('requests.Session', return_value=session):
      g.post_comment('github', gate_result('default', 'pass'), 'qaboard/gate', 'o/r', dryrun=printed.append)
    self.assertTrue(printed[0].startswith('Dry run: would post a new comment on pull request #12:\n<!-- qaboard/gate -->'))
    # without credentials: the body, and why it can't say where
    printed.clear()
    with mock.patch.dict(os.environ, {}, clear=True):
      commented, error = g.post_comment('gitlab', gate_result('default', 'pass'), 'qaboard/gate', 'o/r', dryrun=printed.append)
    self.assertEqual(commented, [])
    self.assertIn('GITLAB_ACCESS_TOKEN, so qa gate could not look the merge request up. It would post:\n<!-- qaboard/gate -->', printed[0])


# ---------------------------------------------------------------------------- the `qa gate` command

class FakeServer:
  """QA-Board's compare endpoint, and GitHub's APIs for statuses and pull requests' comments"""
  def __init__(self):
    self.responses = []   # (status code, body) of the next GET requests, the last one repeats
    self.requests = []
    self.statuses = []
    # GitHub: the open pull requests of the commit, their comments, and what was posted
    self.pulls = []
    self.comments = []
    self.commented = []
    server = self
    class Handler(BaseHTTPRequestHandler):
      def log_message(self, *args):
        pass
      def send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
      def do_GET(self):
        url = urlparse(self.path)
        if url.path.endswith('/pulls'):
          return self.send(200, server.pulls)
        if url.path.endswith('/comments'):
          return self.send(200, server.comments)
        if '/issues/comments/' in url.path:
          comment_id = int(url.path.rsplit('/', 1)[1])
          return self.send(200, next(c for c in server.comments if c['id'] == comment_id))
        server.requests.append((url.path, {k: v[0] for k, v in parse_qs(url.query).items()}))
        code, body = server.responses.pop(0) if len(server.responses) > 1 else server.responses[0]
        self.send(code, body)
      def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.path.endswith('/comments'):
          server.comments.append({'id': 100 + len(server.comments), **body})
          server.commented.append(('POST', self.path, body))
        else:
          server.statuses.append((self.path, self.headers['Authorization'], body))
        self.send(201, {})
      def do_PATCH(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        comment_id = int(self.path.rsplit('/', 1)[1])
        for comment in server.comments:
          if comment['id'] == comment_id:
            comment.update(body)
        server.commented.append(('PATCH', self.path, body))
        self.send(200, {})
    self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    self.url = f'http://127.0.0.1:{self.httpd.server_address[1]}'
    threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

  def close(self):
    self.httpd.shutdown()
    self.httpd.server_close()


QABOARD_YAML = """
project:
  name: kitefin/camera-isp
  url: https://git.kitefin.example/kitefin/camera-isp
  reference_branch: main
outputs:
  metrics: metrics.yaml
storage: {storage}
gate:
  batches: [ci]
  rules:
    - {{metric: psnr, max_regression: 1%}}
    - {{metric: psnr, per_test_max_regression: 25%}}
  max_failed_runs: 1
"""


class TestGateCommand(unittest.TestCase):
  def setUp(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.dir = Path(tmp.name)
    (self.dir / 'qaboard.yaml').write_text(QABOARD_YAML.format(storage=self.dir / 'storage'))
    metrics = {'available_metrics': {k: v for k, v in FIXTURE['available_metrics'].items()}}
    (self.dir / 'metrics.yaml').write_text(json.dumps(metrics))
    self.server = FakeServer()
    self.addCleanup(self.server.close)
    self.summary = self.dir / 'step-summary.md'

  def qa_gate(self, *args, qa_args=(), **env):
    clean_env = {k: v for k, v in os.environ.items() if k == 'QABOARD_IGNORE_SITE' or not k.startswith(('QABOARD_', 'QA_', 'GITHUB_', 'CI', 'GITLAB_'))}
    # The fake server is on 127.0.0.1: a web proxy would refuse to reach it
    clean_env = {k: v for k, v in clean_env.items() if k.lower() not in ('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy')}
    environment = {
      **clean_env, 'QA_NO_CHECK_FOR_UPDATES': '1', 'CI': 'true', 'GITHUB_SHA': SHA, 'GITHUB_REF': 'refs/heads/feature',
      'QABOARD_URL': self.server.url, 'GITHUB_STEP_SUMMARY': str(self.summary), **env,
    }
    return subprocess.run([sys.executable, '-m', 'qaboard', *qa_args, 'gate', *args], cwd=self.dir, env=environment, capture_output=True, text=True, timeout=120)

  def test_pass(self):
    self.server.responses = [(200, fixture_comparison())]
    process = self.qa_gate()
    self.assertEqual(process.returncode, 0, process.stderr)
    self.assertIn('qa gate is experimental', process.stderr)
    self.assertIn('Quality gate: PASS', process.stdout)
    self.assertEqual(self.server.requests, [(f'/api/v1/commit/{SHA}/compare', {'project': 'kitefin/camera-isp', 'batch': 'ci', 'reference': 'main', 'metrics': 'psnr'})])
    # on GitHub Actions, the job's summary
    self.assertIn('| psnr, median | 30.5 dB | 29.75 dB | 2.5% better | 1% worse | pass |', self.summary.read_text())

  def test_fail_and_github_status(self):
    # photos/night.jpg's PSNR is 20% worse than its reference's
    (self.dir / 'qaboard.yaml').write_text(QABOARD_YAML.format(storage=self.dir / 'storage').replace('per_test_max_regression: 25%', 'per_test_max_regression: 5%'))
    self.server.responses = [(200, fixture_comparison())]
    env = {'GITHUB_TOKEN': 'token', 'GITHUB_REPOSITORY': 'kitefin/camera-isp', 'GITHUB_API_URL': self.server.url}
    process = self.qa_gate('--json', '--reference', REF_SHA[:8], '--batch', 'default', '--post-status', 'github', '--server', self.server.url, **env)
    self.assertEqual(process.returncode, 1, process.stderr)
    result = json.loads(process.stdout)
    self.assertEqual(result['verdict'], 'fail')
    self.assertEqual(self.server.requests[0][1]['reference'], REF_SHA[:8])
    self.assertEqual(self.server.requests[0][1]['batch'], 'default')
    self.assertEqual([c['status'] for c in result['batches'][0]['checks']], ['pass', 'fail', 'pass'])
    path, authorization, status = self.server.statuses[0]
    self.assertEqual((path, authorization), (f'/repos/kitefin/camera-isp/statuses/{SHA}', 'Bearer token'))
    self.assertEqual(status['state'], 'failure')
    self.assertEqual(status['target_url'], result['batches'][0]['url'])

  def test_comment_on_the_pull_request(self):
    """The gate's table goes to the commit's pull request, in one comment that later runs update"""
    comparison = fixture_comparison()
    comparison['commit']['reruns'] = {'runs': 1, 'after_failure': 1, 'after_unfinished': 0}
    comparison['tests'][0]['attempts'] = {'attempt': 2, 'previous': ['failed'], 'in_place': False}
    # the reference allowed less: someone loosened the rule
    comparison['reference']['gate'] = {'rules': [{'metric': 'psnr', 'max_regression': '0.5%'}, {'metric': 'psnr', 'per_test_max_regression': '25%'}], 'max_failed_runs': 1}
    self.server.responses = [(200, comparison)]
    self.server.pulls = [{'number': 12, 'state': 'open'}, {'number': 9, 'state': 'closed'}]
    self.server.comments = [{'id': 1, 'body': 'LGTM'}]
    env = {'GITHUB_TOKEN': 'token', 'GITHUB_REPOSITORY': 'kitefin/camera-isp', 'GITHUB_API_URL': self.server.url}
    process = self.qa_gate('--post-comment', 'github', **env)
    self.assertEqual(process.returncode, 0, process.stderr)
    self.assertIn('Commented on #12', process.stderr)
    (method, path, comment), = self.server.commented
    self.assertEqual((method, path), ('POST', '/repos/kitefin/camera-isp/issues/12/comments'))
    body = comment['body']
    self.assertTrue(body.startswith('<!-- qaboard/gate -->\n### Quality gate: pass'))
    self.assertIn('| psnr, median | 30.5 dB | 29.75 dB | 2.5% better | 1% worse | pass |', body)
    self.assertIn('1 run was done again: 1 passed after a failed attempt.', body)
    self.assertIn("This commit loosens the gate's rules, compared with the reference's:", body)
    self.assertIn('psnr, median, max regression: 0.5% → 1% (looser)', body)
    self.assertIn(f'For commit {SHA[:10]}', body)
    # the terminal says it too
    self.assertIn('1 run was done again', process.stdout)
    self.assertIn("loosens the gate's rules", process.stdout)

    # again, e.g. after a push: the same comment is updated
    process = self.qa_gate('--post-comment', 'github', **env)
    self.assertEqual(process.returncode, 0, process.stderr)
    self.assertEqual([(m, p) for m, p, _ in self.server.commented[1:]], [('PATCH', '/repos/kitefin/camera-isp/issues/comments/101')])
    self.assertEqual(len(self.server.comments), 2)

    # on `pull_request` events, GitHub says which pull request it is
    self.server.commented.clear()
    process = self.qa_gate('--post-comment', 'github', GITHUB_REF='refs/pull/34/merge', **env)
    self.assertEqual(self.server.commented[0][1], '/repos/kitefin/camera-isp/issues/comments/101')  # our fake has one list of comments
    self.assertIn('Commented on #34', process.stderr)

    # a push without a pull request: nothing to do, not a warning
    self.server.pulls = []
    self.server.commented.clear()
    process = self.qa_gate('--post-comment', 'github', **env)
    self.assertEqual(process.returncode, 0, process.stderr)
    self.assertEqual(self.server.commented, [])
    self.assertIn('no open pull request has the commit', process.stderr)
    self.assertNotIn('WARNING', process.stderr)

  def test_undecidable_and_wait(self):
    self.server.responses = [(404, {'error': 'unknown commit'})]
    process = self.qa_gate('--format', 'markdown')
    self.assertEqual(process.returncode, 2, process.stderr)
    self.assertIn('### Quality gate: undecidable', process.stdout)
    # --wait: the reference finishes running
    self.server.responses = [(200, fixture_comparison('running')), (200, fixture_comparison())]
    process = self.qa_gate('--wait', '--interval', '0.1', '--timeout', '60')
    self.assertEqual(process.returncode, 0, process.stderr)
    self.assertIn('Waiting 0.1s: Some runs are still running', process.stderr)
    # ... until the timeout
    self.server.responses = [(200, fixture_comparison('running'))]
    process = self.qa_gate('--wait', '--interval', '0.1', '--timeout', '0.5')
    self.assertEqual(process.returncode, 2, process.stderr)

  def test_labels(self):
    self.server.responses = [(200, fixture_comparison())]
    process = self.qa_gate('--label', 'nightly', '-b', 'tuning')
    self.assertEqual(process.returncode, 0, process.stderr)
    self.assertEqual([params['batch'] for _, params in self.server.requests], ['nightly', 'tuning'])
    # like `qa --label nightly batch all`
    self.server.requests.clear()
    self.qa_gate(qa_args=('--label', 'nightly'))
    self.assertEqual([params['batch'] for _, params in self.server.requests], ['nightly'])
    # gate.labels
    (self.dir / 'qaboard.yaml').write_text(QABOARD_YAML.format(storage=self.dir / 'storage').replace('batches: [ci]', 'labels: [ci, weekly]'))
    self.server.requests.clear()
    self.qa_gate()
    self.assertEqual([params['batch'] for _, params in self.server.requests], ['ci', 'weekly'])

  def test_wait_for_the_expected_batches(self):
    (self.dir / 'qaboard.yaml').write_text(QABOARD_YAML.format(storage=self.dir / 'storage').replace('  max_failed_runs: 1', '  max_failed_runs: 1\n  expect_batches: [ci, perf]'))
    # `qa batch perf` hasn't sent runs yet, then it has
    only_ci = with_batches()
    only_ci['tests'] = [t for t in only_ci['tests'] if t['batch'] == 'ci']
    self.server.responses = [(200, only_ci), (200, with_batches())]
    process = self.qa_gate('--wait', '--interval', '0.1', '--timeout', '60')
    self.assertEqual(process.returncode, 0, process.stderr)
    self.assertIn('Waiting 0.1s: no runs from `qa batch perf` yet', process.stderr)
    self.assertRegex(process.stdout, r'batches with runs +2 of 2 +runs from ci, perf +pass')

  def test_dry_run(self):
    """`qa --dryrun gate --post-comment github`: what would be posted, and where, to try the setup from a CI job"""
    self.server.responses = [(200, fixture_comparison())]
    self.server.pulls = [{'number': 12, 'state': 'open'}]
    env = {'GITHUB_TOKEN': 'token', 'GITHUB_REPOSITORY': 'kitefin/camera-isp', 'GITHUB_API_URL': self.server.url}
    process = self.qa_gate('--post-comment', 'github', '--post-status', 'github', qa_args=('--dryrun',), **env)
    self.assertEqual(process.returncode, 0, process.stderr)
    self.assertIn('Dry run: would post a new comment on pull request #12:\n<!-- qaboard/gate -->\n### Quality gate: pass', process.stderr)
    self.assertIn('Dry run: would post the commit status qaboard/gate on github: pass', process.stderr)
    self.assertIn('Would comment on #12', process.stderr)
    self.assertEqual((self.server.commented, self.server.statuses), ([], []))
    # without a token
    process = self.qa_gate('--post-comment', 'github', qa_args=('--dryrun',))
    self.assertIn('Dry run: --post-comment github needs GITHUB_TOKEN', process.stderr)
    self.assertIn('### Quality gate: pass', process.stderr)

  def test_configuration_error(self):
    (self.dir / 'qaboard.yaml').write_text(QABOARD_YAML.format(storage=self.dir / 'storage').replace('max_regression: 1%', 'max_regression: lots'))
    process = self.qa_gate()
    self.assertEqual(process.returncode, 1, process.stderr)
    self.assertIn('gate.rules[0].max_regression: expected a percentage', process.stderr)


if __name__ == '__main__':
  unittest.main()
