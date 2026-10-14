"""
Tests for `qa gate` (qaboard/gate.py).

The numbers the gate checks come from GET /api/v1/commit/<sha>/compare. Here they are those of the fixture shared with
the backend's and the web app's tests (tests/fixtures/metrics-compare.json): the gate decides on the numbers the
Summary and Metrics Diff views show. The server is faked: by mocks, or by a local HTTP server for the CLI itself.
"""
import os
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
      {'metric': 'psnr', 'kind': 'max_regression', 'limit': 0.01},
      {'metric': 'psnr', 'kind': 'per_test_max_regression', 'limit': 0.05},
      {'metric': 'map', 'kind': 'min', 'limit': 0.42},
      {'metric': 'latency_p99', 'kind': 'max', 'limit': 12.0},
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
    local_metrics = {'latency_p99': {'smaller_is_better': False}}
    evaluation = evaluate([{'metric': 'latency_p99', 'max_regression': '4%'}], local_metrics=local_metrics)
    self.assertEqual(self.checks(evaluation), [('max_regression', 'latency_p99', 'fail')])
    self.assertAlmostEqual(evaluation['checks'][0]['regression'], 0.041666666666666664)
    # metrics.yaml says nothing: like the web app, smaller is better
    evaluation = evaluate([{'metric': 'latency_p99', 'max_regression': '4%'}], local_metrics={'latency_p99': None})
    self.assertEqual(evaluation['verdict'], 'pass')

  def test_undeclared_metrics(self):
    g = gate_module()
    comparison = fixture_comparison()
    comparison['metrics']['psnr']['declared'] = False
    with self.assertRaises(g.GateConfigError):
      evaluate([{'metric': 'psnr', 'max_regression': '1%'}], comparison)
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
    with mock.patch('requests.get', return_value=response):
      self.assertEqual(g.fetch_comparison('http://qa/api/v1', 'p', SHA, None, 'default', [], False, {}, True), (None, 'QA-Board has no results for c0ffee0000 in p yet'))
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


# ---------------------------------------------------------------------------- the `qa gate` command

class FakeServer:
  """QA-Board's compare endpoint, and GitHub's statuses API"""
  def __init__(self):
    self.responses = []   # (status code, body) of the next GET requests, the last one repeats
    self.requests = []
    self.statuses = []
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
        server.requests.append((url.path, {k: v[0] for k, v in parse_qs(url.query).items()}))
        code, body = server.responses.pop(0) if len(server.responses) > 1 else server.responses[0]
        self.send(code, body)
      def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        server.statuses.append((self.path, self.headers['Authorization'], body))
        self.send(201, {})
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

  def qa_gate(self, *args, **env):
    clean_env = {k: v for k, v in os.environ.items() if not k.startswith(('QABOARD_', 'QA_', 'GITHUB_', 'CI', 'GITLAB_'))}
    # The fake server is on 127.0.0.1: a web proxy would refuse to reach it
    clean_env = {k: v for k, v in clean_env.items() if k.lower() not in ('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy')}
    environment = {
      **clean_env, 'QA_NO_CHECK_FOR_UPDATES': '1', 'CI': 'true', 'GITHUB_SHA': SHA, 'GITHUB_REF': 'refs/heads/feature',
      'QABOARD_URL': self.server.url, 'GITHUB_STEP_SUMMARY': str(self.summary), **env,
    }
    return subprocess.run([sys.executable, '-m', 'qaboard', 'gate', *args], cwd=self.dir, env=environment, capture_output=True, text=True, timeout=120)

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

  def test_configuration_error(self):
    (self.dir / 'qaboard.yaml').write_text(QABOARD_YAML.format(storage=self.dir / 'storage').replace('max_regression: 1%', 'max_regression: lots'))
    process = self.qa_gate()
    self.assertEqual(process.returncode, 1, process.stderr)
    self.assertIn('gate.rules[0].max_regression: expected a percentage', process.stderr)


if __name__ == '__main__':
  unittest.main()
