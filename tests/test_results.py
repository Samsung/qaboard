"""
Tests for qaboard/results.py: the runs a web app page shows, as `Run` objects, from Python and `qa runs`.
"""
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path, PurePosixPath
from unittest import mock

from qaboard.results import Run, Runs, _Side as Side, parse_url, runs, ResultsError

FIXTURE = json.loads((Path(__file__).resolve().parent / 'fixtures' / 'filters.json').read_text())
COMMIT = '7622c3371234567890abcdef1234567890abcdef'


def commit_response(outputs=None, batches=('ci',)):
  outputs = FIXTURE['outputs'] if outputs is None else outputs
  # the API gives each run its folder as /s<path>
  outputs = {id: {**o, 'output_dir_url': f"/s/mnt/qaboard/kitefin/detector/{COMMIT[:8]}/ci/{id}", 'created_date': '2026-11-01T10:00:00'} for id, o in outputs.items()}
  return {'id': COMMIT, 'batches': {label: {'label': label, 'outputs': outputs} for label in batches}}


def mock_get(response, status=200):
  r = mock.Mock()
  r.status_code = status
  r.json.return_value = response
  r.text = json.dumps(response)
  return mock.patch('requests.request', return_value=r)


class TestParseUrl(unittest.TestCase):
  def test_commit_page(self):
    s = parse_url('https://qaboard.example.com/kitefin/detector/commit/7622c337?batch=ci&filter=night%20-crash&view=summary')
    self.assertEqual(s.server, 'https://qaboard.example.com')
    self.assertEqual(s.new, Side(project='kitefin/detector', commit='7622c337', batch='ci', filter='night -crash'))
    # without ?reference=, the reference is the default one: the server picks it
    self.assertEqual(s.reference, Side(project='kitefin/detector', commit=None, batch='default'))

  def test_defaults(self):
    s = parse_url('http://localhost:5151/group/subgroup/repo/subproject/commit/abc')
    self.assertEqual(s.new.project, 'group/subgroup/repo/subproject')
    self.assertEqual(s.new.batch, 'default')
    self.assertIsNone(s.new.filter)

  def test_latest_commit_and_branches(self):
    self.assertEqual(parse_url('http://qaboard/g/repo/commit').new, Side(project='g/repo', commit=None))
    s = parse_url('http://qaboard/g/repo/commit?branch=release%2F2.0&batch=nightly')
    self.assertEqual(s.new, Side(project='g/repo', commit=None, branch='release/2.0', batch='nightly'))
    # with a commit, ?branch= is only where the user came from
    self.assertIsNone(parse_url('http://qaboard/g/repo/commit/abc?branch=dev').new.branch)
    # tags and branches with slashes
    self.assertEqual(parse_url('http://qaboard/g/repo/commit/release%2F2.0').new.commit, 'release/2.0')
    self.assertEqual(parse_url('http://qaboard/g/repo/commit/release/2.0').new.commit, 'release/2.0')

  def test_like_the_web_app(self):
    # what selection.js reads too: legacy names, lists, other projects
    s = parse_url('http://qaboard/g/repo/commit/abc?batch_new=ci&filter=night&filter=-crash&new_project=g%2Fother')
    self.assertEqual(s.new, Side(project='g/other', commit='abc', batch='ci', filter='night -crash'))
    self.assertEqual(s.reference.project, 'g/repo')

  def test_reference_bar(self):
    s = parse_url('http://qaboard/g/repo/commit/abc?batch=ci&reference=def&batch_ref=nightly&filter_ref=indoor')
    self.assertEqual(s.reference, Side(project='g/repo', commit='def', batch='nightly', filter='indoor'))
    # like in the web app, the reference's batch is "default" when the URL doesn't say, not the new batch
    s = parse_url('http://qaboard/g/repo/commit/abc?batch=ci&reference=def')
    self.assertEqual(s.reference, Side(project='g/repo', commit='def', batch='default'))
    # a reference in another project
    s = parse_url('http://qaboard/g/repo/commit/abc?reference=def&ref_project=g%2Fother')
    self.assertEqual(s.reference.project, 'g/other')

  def test_server_under_a_path_prefix(self):
    s = parse_url('https://tools.example.com/qaboard/g/repo/commit/abc', server='https://tools.example.com/qaboard/')
    self.assertEqual(s.server, 'https://tools.example.com/qaboard')
    self.assertEqual(s.new.project, 'g/repo')
    # whole segments: /qa isn't a prefix of /qaboard
    with self.assertRaises(ValueError):
      parse_url('https://tools.example.com/qaboard/g/repo/commit/abc', server='https://tools.example.com/qa')

  def test_not_a_commit_page(self):
    # lists of commits are not runs: /commits/<branch> shows many commits
    for url in ('https://qaboard/g/repo/history', 'https://qaboard/g/repo', 'https://qaboard/g/repo/commits', 'https://qaboard/g/repo/commits/main',
                'https://qaboard/commit/abc', 'g/repo/commit/abc', ''):
      with self.subTest(url=url), self.assertRaises(ValueError):
        parse_url(url)


class TestRuns(unittest.TestCase):
  def test_runs_of_a_url(self):
    with mock_get(commit_response()) as get:
      found = runs('https://qaboard/kitefin/detector/commit/7622c337?batch=ci&filter=outdoor')
    url, kwargs = get.call_args[0][1], get.call_args[1]
    self.assertEqual(url, 'https://qaboard/api/v1/commit/7622c337')
    self.assertEqual(kwargs['params'], {'project': 'kitefin/detector', 'batch': 'ci', 'metrics': '{}'})
    self.assertIsInstance(found, Runs)
    # filtered like the web app: outdoor runs only
    self.assertEqual([r.id for r in found], [2, 3])
    self.assertEqual(found.commit, COMMIT)
    run = found[0]
    self.assertEqual(run.input, 'slices/outdoor/night-street.jpg')
    self.assertEqual(run.input_path, Path('/data/slices/outdoor/night-street.jpg'))
    self.assertEqual(run.configs, ('base', 'night', {'gain': 8}))
    self.assertEqual(run.extra_parameters, {'gain': 8})
    self.assertEqual(run.params, {'gain': 8})
    self.assertEqual(run.state, 'finished')
    self.assertTrue(run.is_failed)
    self.assertEqual(PurePosixPath(run.output_dir.as_posix()), PurePosixPath(f'/mnt/qaboard/kitefin/detector/{COMMIT[:8]}/ci/2'))
    self.assertEqual(run.commit, COMMIT)
    # id:2 alone would also match id:23
    self.assertEqual(run.url, f'https://qaboard/kitefin/detector/commit/{COMMIT}?batch=ci&filter=id%3A2%24')
    self.assertEqual(found[1].state, 'running')
    # the configurations' objects are parameters too
    self.assertEqual(found[0].params, {'gain': 8})
    with mock_get(commit_response()):
      kitchen, = runs('https://qaboard/g/repo/commit/abc?batch=ci&filter=kitchen')
    self.assertEqual(kitchen.extra_parameters, {})
    self.assertEqual(kitchen.params, {'gain': 2, 'isp': {'awb': 'auto'}})

  def test_effective_parameters_over_tuning_parameters(self):
    with mock_get(commit_response()):
      run, = runs('https://qaboard/g/repo/commit/abc?batch=ci&filter=id:4')
    self.assertEqual(run.extra_parameters, {})
    self.assertEqual(run.params, {'gain': 4})
    self.assertEqual(run.metrics, {})

  def test_keyword_arguments_override_the_url(self):
    with mock_get(commit_response(batches=('nightly',))) as get:
      found = runs('https://qaboard/g/repo/commit/abc?batch=ci', batch='nightly', filter='status:success', commit='def')
    self.assertEqual(get.call_args[0][1], 'https://qaboard/api/v1/commit/def')
    self.assertEqual(get.call_args[1]['params']['batch'], 'nightly')
    self.assertEqual([r.id for r in found], [1, 4])

  def test_without_a_url(self):
    with mock_get(commit_response(batches=('default',))) as get, mock.patch('qaboard.results.default_server', return_value=('http://qaboard:5151', '$QABOARD_URL')):
      found = runs(project='g/repo', branch='main')
    self.assertEqual(get.call_args[0][1], 'http://qaboard:5151/api/v1/commit')
    self.assertEqual(get.call_args[1]['params']['branch'], 'main')
    self.assertEqual(len(found), 4)
    with self.assertRaises(ValueError):
      runs()

  def test_commit_and_branch_replace_the_urls(self):
    with mock_get(commit_response(batches=('default',))) as get:
      runs('https://qaboard/g/repo/commit/abc', branch='dev')
    self.assertEqual(get.call_args[0][1], 'https://qaboard/api/v1/commit')
    self.assertEqual(get.call_args[1]['params']['branch'], 'dev')
    with mock_get(commit_response(batches=('default',))) as get:
      runs('https://qaboard/g/repo/commit?branch=dev', commit='abc')
    self.assertEqual(get.call_args[0][1], 'https://qaboard/api/v1/commit/abc')
    self.assertNotIn('branch', get.call_args[1]['params'])

  def test_hidden_runs(self):
    # qa optimize's iterations are not shown with the batch's runs in the web app
    outputs = {**FIXTURE['outputs'], '1': {**FIXTURE['outputs']['1'], 'output_type': 'optim_iteration'}}
    with mock_get(commit_response(outputs)):
      self.assertEqual([r.id for r in runs('https://qaboard/g/repo/commit/abc?batch=ci')], [2, 3, 4])
      found = runs('https://qaboard/g/repo/commit/abc?batch=ci', include_hidden=True)
    self.assertEqual([r.id for r in found], [1, 2, 3, 4])
    self.assertEqual(found[0].type, 'optim_iteration')

  def test_reference_runs(self):
    url = 'https://qaboard/g/repo/commit/abc?batch=ci&reference=def&batch_ref=nightly&filter_ref=indoor'
    with mock_get(commit_response(batches=('nightly',))) as get:
      found = runs(url, side='reference')
    self.assertEqual(get.call_args[0][1], 'https://qaboard/api/v1/commit/def')
    self.assertEqual([r.id for r in found], [1])
    with mock_get(commit_response(batches=('ci',))) as get:
      runs(url, side='new')
    self.assertEqual(get.call_args[0][1], 'https://qaboard/api/v1/commit/abc')
    # the default reference: the URL doesn't say which, unless the commit is given
    with self.assertRaises(ValueError):
      runs('https://qaboard/g/repo/commit/abc', side='reference')
    with mock_get(commit_response(batches=('default',))) as get:
      runs('https://qaboard/g/repo/commit/abc', side='reference', commit='def')
    self.assertEqual(get.call_args[0][1], 'https://qaboard/api/v1/commit/def')
    with self.assertRaises(ValueError):
      runs(project='g/repo', side='reference')

  def test_unknown_side(self):
    # the web app may compare with several references one day (?compare=): side is not a boolean
    for side in ('ref', 'references', True, None):
      with self.subTest(side=side), self.assertRaises(ValueError) as e:
        runs('https://qaboard/g/repo/commit/abc?reference=def', side=side)
      self.assertIn("'new', 'reference'", str(e.exception))
    with self.assertRaises(TypeError):
      runs('https://qaboard/g/repo/commit/abc?reference=def', reference=True) # the old keyword

  def test_deleted_runs(self):
    outputs = {**FIXTURE['outputs'], '1': {**FIXTURE['outputs']['1'], 'deleted': True}}
    with mock_get(commit_response(outputs)):
      self.assertEqual([r.id for r in runs('https://qaboard/g/repo/commit/abc?batch=ci')], [2, 3, 4])
      self.assertEqual(len(runs('https://qaboard/g/repo/commit/abc?batch=ci', include_deleted=True)), 4)

  def test_sends_the_token(self):
    with mock_get(commit_response()) as get, mock.patch('qaboard.results.resolve_token', return_value=('qab_pat_secret', 'hosts.yaml')) as resolve:
      runs('https://qaboard/g/repo/commit/abc?batch=ci')
    resolve.assert_called_with('https://qaboard')
    self.assertEqual(get.call_args[1]['headers'], {'Authorization': 'Bearer qab_pat_secret'})
    self.assertEqual(get.call_args[1]['timeout'][1], 600)
    with mock_get(commit_response()) as get:
      runs('https://qaboard/g/repo/commit/abc?batch=ci', token='other')
    self.assertEqual(get.call_args[1]['headers'], {'Authorization': 'Bearer other'})

  def test_environment_tokens_only_go_to_the_configured_server(self):
    # a pasted URL can name any server: QABOARD_TOKEN is for the one qa is configured for
    stderr = io.StringIO()
    with mock_get(commit_response()) as get, mock.patch('qaboard.results.resolve_token', return_value=('ci-token', 'QABOARD_TOKEN')), \
         mock.patch('qaboard.results.default_server', return_value=('https://qaboard.example.com', '$QABOARD_URL')), \
         mock.patch('qaboard.results.read_hosts', return_value={}), redirect_stderr(stderr):
      runs('https://evil.example.com/g/repo/commit/abc?batch=ci')
      self.assertEqual(get.call_args[1]['headers'], {})
      runs('https://qaboard.example.com/g/repo/commit/abc?batch=ci')
      self.assertEqual(get.call_args[1]['headers'], {'Authorization': 'Bearer ci-token'})
    self.assertIn('not sending QABOARD_TOKEN to https://evil.example.com', stderr.getvalue())

  def test_errors_say_what_to_do(self):
    with mock_get(commit_response(batches=('default', 'nightly'))), self.assertRaises(ResultsError) as e:
      runs('https://qaboard/g/repo/commit/abc?batch=ci')
    self.assertIn("no batch 'ci'", str(e.exception))
    self.assertIn('default, nightly', str(e.exception))
    with mock_get({'error': 'Sorry, we could not find any data on commit abc'}, status=404), self.assertRaises(ResultsError) as e:
      runs('https://qaboard/g/repo/commit/abc')
    self.assertIn('could not find any data', str(e.exception))
    with mock_get({'error': 'Sign in to see this project.', 'reason': 'login_required'}, status=401), self.assertRaises(ResultsError) as e:
      runs('https://qaboard/g/repo/commit/abc')
    self.assertIn('qa auth login https://qaboard', str(e.exception))


class TestRunContract(unittest.TestCase):
  """
  Runs read from the server and runs created from code (training loops, evals, once the SDK writes) are the same
  object: `Run._new` is what `start_run()` will build. `to_dict()` is the JSON of `qa runs --json`: its keys are a
  contract with scripts, pin them.
  """
  JSON_KEYS = {'project', 'commit', 'batch', 'input', 'database', 'platform', 'configs', 'extra_parameters', 'params',
               'metrics', 'type', 'id', 'output_dir', 'is_pending', 'is_running', 'is_failed', 'deleted', 'input_metadata', 'data',
               'created_at', 'finished_at', 'server', 'state', 'url'}

  def test_same_object_from_the_server_and_from_code(self):
    from_server = Run.from_api(FIXTURE['outputs']['1'], project='g/repo', commit=COMMIT, batch='ci', server='https://qaboard')
    from_code = Run._new(project='g/repo', input='slices/indoor/kitchen.jpg', configs=['base', {'gain': 2}], extra_parameters={'lr': 0.1}, batch='exp-1')
    self.assertIs(type(from_server), type(from_code))
    self.assertEqual(set(from_server.to_dict()), self.JSON_KEYS)
    self.assertEqual(set(from_code.to_dict()), self.JSON_KEYS)
    json.dumps(from_server.to_dict()), json.dumps(from_code.to_dict()) # JSON-friendly
    self.assertEqual(from_code.state, 'pending')
    self.assertEqual(from_server.state, 'finished')
    self.assertIsNone(from_code.id)
    self.assertIsNone(from_code.url)
    # the same meaning of params everywhere: the configurations' objects and the tuning parameters
    self.assertEqual(from_code.params, {'gain': 2, 'lr': 0.1})
    self.assertEqual(from_code.extra_parameters, {'lr': 0.1})
    # like context.configs: the tuning parameters are the last configuration
    self.assertEqual(from_code.configs, ('base', {'gain': 2}, {'lr': 0.1}))
    self.assertEqual(from_code.rel_input_path, Path('slices/indoor/kitchen.jpg'))

  def test_read_only(self):
    # changing a run read from the server would change nothing on the server: it is an error
    run = Run.from_api(FIXTURE['outputs']['2'], project='g/repo', commit=COMMIT, batch='ci', server='https://qaboard')
    from_code = Run._new(project='g/repo', input='a.jpg', configs=['base'], extra_parameters={'lr': 0.1})
    for r in (run, from_code):
      for name in ('metrics', 'extra_parameters', 'params', 'input_metadata', 'data'):
        with self.subTest(name=name), self.assertRaises(TypeError):
          getattr(r, name)['x'] = 1
      self.assertIsInstance(r.configs, tuple)
      with self.assertRaises(AttributeError):
        r.configs.append('other') # type: ignore
    self.assertEqual(run.extra_parameters, {'gain': 8})
    self.assertEqual(run.extra_parameters.get('gain'), 8)
    # runs don't share the dicts they were made from
    extra = {'lr': 0.1}
    made = Run._new(project='g/repo', input='a.jpg', extra_parameters=extra)
    extra['lr'] = 1
    self.assertEqual(made.extra_parameters, {'lr': 0.1})
    # to_dict gives plain data
    d = run.to_dict()
    for name in ('metrics', 'extra_parameters', 'params', 'input_metadata', 'data'):
      self.assertIs(type(d[name]), dict, name)
    self.assertIs(type(d['configs']), list)
    self.assertEqual(d['configs'], ['base', 'night', {'gain': 8}])
    d['metrics']['x'] = 1
    self.assertNotIn('x', run.metrics)
    self.assertEqual(json.loads(json.dumps(d)), d)

  def test_what_writes(self):
    # no stubs in the public API: methods come when they work
    for name in ('log', 'save_file', 'log_params', 'series', 'finish'):
      self.assertFalse(hasattr(Run, name), name)
    self.assertTrue(callable(Run.log_metrics) and callable(Run.log_artifact))
    import qaboard
    self.assertFalse(hasattr(qaboard, 'start_run'))


class TestImport(unittest.TestCase):
  """
  `import qaboard` has no side effects: scripts using `qaboard.runs(url)` don't read the current folder's qaboard.yaml
  or git, and don't ask PyPI for updates.
  """
  def python(self, code, cwd):
    root = Path(__file__).resolve().parent.parent
    env = {k: v for k, v in os.environ.items() if not k.startswith('QA')}
    # no network: the update check would print a warning
    env.update({'PYTHONPATH': str(root), 'HOME': cwd, 'XDG_CONFIG_HOME': cwd, 'QABOARD_LATEST_VERSION_URL': 'http://127.0.0.1:9/nothing-here'})
    return subprocess.run([sys.executable, '-c', code], cwd=cwd, env=env, capture_output=True, text=True, timeout=60)

  def test_import_has_no_side_effects(self):
    with tempfile.TemporaryDirectory() as tmp:
      (Path(tmp) / 'qaboard.yaml').write_text('project: [unclosed\n')
      result = self.python(
        "import sys\n"
        "import qaboard\n"
        "from qaboard import runs, Run, Runs\n"
        "assert qaboard.runs is runs and callable(runs), runs\n"
        "loaded = [m for m in ('qaboard.config', 'qaboard.api', 'qaboard.qa', 'qaboard.check_for_updates', 'requests', 'git') if m in sys.modules]\n"
        "assert not loaded, loaded\n"
        "print(qaboard.__version__)\n",
        cwd=tmp,
      )
      self.assertEqual(result.returncode, 0, result.stderr)
      self.assertEqual(result.stderr, '')
      self.assertTrue(result.stdout.strip())
      self.assertFalse((Path(tmp) / 'qaboard').exists()) # no user config dir: the update check didn't run

  def test_legacy_names(self):
    # what wrapped code imports keeps working, and qaboard.qa / qaboard.config are the command and the configuration
    with tempfile.TemporaryDirectory() as tmp:
      result = self.python(
        "from qaboard import Metric, define_metric, merge, slugify, Context\n"
        "import qaboard, qaboard.config, qaboard.qa\n"
        "import click\n"
        "assert isinstance(qaboard.qa, click.Group), qaboard.qa\n"
        "assert isinstance(qaboard.config, dict), type(qaboard.config)\n"
        "assert callable(qaboard.check_for_updates)\n"
        "from qaboard import qa, config, is_ci, on_windows, on_linux\n"
        "assert qa is qaboard.qa\n"
        "assert merge({'a': 1}, {'b': 2}) == {'a': 1, 'b': 2}\n"
        "try:\n"
        "  qaboard.nope\n"
        "except AttributeError:\n"
        "  pass\n"
        "else:\n"
        "  raise SystemExit('qaboard.nope exists')\n",
        cwd=tmp,
      )
      self.assertEqual(result.returncode, 0, result.stderr)

  def test_the_cli_checks_for_updates(self):
    from importlib import import_module
    qa_module, updates = import_module('qaboard.qa'), import_module('qaboard.check_for_updates')
    with mock.patch.object(updates, 'check_for_updates') as check, mock.patch.object(qa_module, 'qa') as group, \
         mock.patch.object(qa_module, 'init_sentry'), mock.patch.object(qa_module, 'split_dashdash', return_value=[]), \
         mock.patch('qaboard.compat.ensure_cli_backward_compatibility'):
      qa_module.main()
    check.assert_called_once_with()
    group.assert_called_once()


class TestLog(unittest.TestCase):
  """run.log_metrics({...}): metrics added to a run by a script, merged by the server with their provenance"""
  URL = 'https://qaboard/g/repo/commit/abc?batch=ci&filter=kitchen'

  def run_and_patch(self, answer=None, **kwargs):
    with mock_get(commit_response()):
      run, = runs(self.URL, **kwargs)
    patched = mock.Mock(status_code=200)
    patched.json.return_value = answer if answer is not None else {
      'metrics': {**run.metrics, 'sharpness': 0.4}, 'data': {**run.data, 'added_metrics': {'sharpness': {'value': 0.4, 'at': 'now', 'script': 's.py'}}},
      'added': {'sharpness': {'value': 0.4, 'at': 'now', 'script': 's.py'}},
    }
    return run, patched

  def test_log_sends_a_patch_and_updates_the_run(self):
    from qaboard import Metric
    run, patched = self.run_and_patch()
    with mock.patch('requests.request', return_value=patched) as request, mock.patch('qaboard.results.resolve_token', return_value=('tok', 'hosts.yaml')):
      added = run.log_metrics({'sharpness': Metric(0.4, smaller_is_better=False, suffix=''), 'blur': 2})
    method, url = request.call_args[0]
    self.assertEqual((method, url), ('PATCH', 'https://qaboard/api/v1/output/1/metrics'))
    body = request.call_args[1]['json']
    self.assertEqual(body['metrics'], {'sharpness': 0.4, 'blur': 2})
    self.assertEqual(body['metrics_definitions'], {'sharpness': {'smaller_is_better': False, 'suffix': ''}})
    self.assertEqual(body['source']['qaboard_version'], __import__('qaboard').__version__)
    self.assertIn('script', body['source'])
    # who added them is the token's user: the script doesn't say
    self.assertNotIn('user', body['source'])
    self.assertNotIn('overwrite', body)
    self.assertEqual(request.call_args[1]['headers'], {'Authorization': 'Bearer tok'})
    # the run reflects the server's answer, read-only still
    self.assertEqual(run.metrics['sharpness'], 0.4)
    self.assertEqual(run.data['added_metrics']['sharpness']['script'], 's.py')
    self.assertEqual(added['sharpness']['value'], 0.4)
    with self.assertRaises(TypeError):
      run.metrics['x'] = 1

  def test_log_uses_the_token_given_to_runs(self):
    run, patched = self.run_and_patch(token='given')
    with mock.patch('requests.request', return_value=patched) as request:
      run.log_metrics({'sharpness': 0.4})
    self.assertEqual(request.call_args[1]['headers'], {'Authorization': 'Bearer given'})

  def test_dry_run_sends_nothing(self):
    run, patched = self.run_and_patch(dry_run=True)
    stderr = io.StringIO()
    with mock.patch('requests.request', return_value=patched) as request, redirect_stderr(stderr):
      added = run.log_metrics({'sharpness': 0.4})
      # per call too
      run.log_metrics({'blur': 1}, dry_run=True)
    request.assert_not_called()
    self.assertIn('would add', stderr.getvalue())
    self.assertEqual(added['sharpness']['value'], 0.4)
    self.assertTrue(added['sharpness']['dry_run'])
    self.assertIn('script', added['sharpness'])
    self.assertNotIn('sharpness', run.metrics)
    with mock.patch('requests.request', return_value=patched) as request:
      run.log_metrics({'sharpness': 0.4}, dry_run=False, overwrite=True)
    self.assertTrue(request.call_args[1]['json']['overwrite'])

  def test_numpy_values(self):
    try:
      import numpy as np
    except ImportError:
      self.skipTest('numpy')
    run, patched = self.run_and_patch()
    with mock.patch('requests.request', return_value=patched) as request:
      run.log_metrics({'a': np.float32(0.5), 'b': np.int64(3), 'c': np.array(2.0), 'd': np.bool_(True)})
    body = request.call_args[1]['json']['metrics']
    self.assertEqual(body, {'a': 0.5, 'b': 3, 'c': 2.0, 'd': True})
    self.assertEqual([type(v) for v in body.values()], [float, int, float, bool])

  def test_log_refuses_bad_values(self):
    run, patched = self.run_and_patch()
    with self.assertRaises(ValueError):
      run.log_metrics({})
    stderr = io.StringIO()
    with mock.patch('requests.request', return_value=patched) as request, redirect_stderr(stderr):
      self.assertEqual(run.log_metrics({'x': float('nan'), 'y': float('inf')}), {})
    request.assert_not_called()
    self.assertIn('NaN', stderr.getvalue())
    # nested values and other types can't be metrics
    for bad in ({'x': {'nested': 1}}, {'x': [1, 2]}, {'': 1}, {3: 1}):
      with self.assertRaises(ValueError):
        run.log_metrics(bad)
    # a run the server doesn't know
    with self.assertRaises(ResultsError):
      Run._new(project='g/repo', input='a.jpg').log_metrics({'x': 1})

  def test_log_errors_name_the_ingest_scope(self):
    run, _ = self.run_and_patch()
    refused = mock.Mock(status_code=403)
    refused.json.return_value = {'error': "This token can't send results", 'reason': 'missing_scope'}
    with mock.patch('requests.request', return_value=refused), self.assertRaises(ResultsError) as e:
      run.log_metrics({'x': 1})
    self.assertIn('ingest scope', str(e.exception))


class TestLogArtifact(unittest.TestCase):
  """run.log_artifact(name, file): a file added to the run's folder, never overwriting, then the manifest refreshed"""
  URL = 'https://qaboard/g/repo/commit/abc?batch=ci&filter=kitchen'

  def run_in(self, folder, **kwargs):
    import tempfile
    outputs = {'1': {**FIXTURE['outputs']['1']}}
    with mock_get({'id': COMMIT, 'batches': {'ci': {'outputs': {k: {**o, 'output_dir_url': f"/s{folder}"} for k, o in outputs.items()}}}}):
      run, = runs(self.URL, **kwargs)
    return run

  def test_copies_a_file_and_refreshes_the_manifest(self):
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
      folder = Path(tmp) / 'run'
      folder.mkdir()
      source = Path(tmp) / 'map.png'
      source.write_bytes(b'PNG')
      run = self.run_in(folder, token='tok')
      refreshed = mock.Mock(status_code=200)
      refreshed.json.return_value = {}
      with mock.patch('requests.request', return_value=refreshed) as request:
        target = run.log_artifact('sharpness/map.png', source)
      self.assertEqual(target, folder / 'sharpness' / 'map.png')
      self.assertEqual(target.read_bytes(), b'PNG')
      method, url = request.call_args[0]
      self.assertEqual((method, url), ('GET', 'https://qaboard/api/v1/output/1/manifest'))
      self.assertEqual(request.call_args[1]['params'], {'refresh': '1'})
      self.assertEqual(request.call_args[1]['headers'], {'Authorization': 'Bearer tok'})
      # bytes are written; nothing is overwritten unless asked
      with mock.patch('requests.request', return_value=refreshed):
        run.log_artifact('notes.txt', b'hello')
        self.assertEqual((folder / 'notes.txt').read_bytes(), b'hello')
        with self.assertRaises(ResultsError):
          run.log_artifact('notes.txt', b'again')
        run.log_artifact('notes.txt', b'again', overwrite=True)
        self.assertEqual((folder / 'notes.txt').read_bytes(), b'again')

  def test_stays_in_the_runs_folder(self):
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
      run = self.run_in(Path(tmp))
      for bad in ('../escape.txt', '/etc/passwd', 'a/../../b', ''):
        with self.assertRaises(ValueError):
          run.log_artifact(bad, b'x')
      with self.assertRaises(ValueError):
        run.log_artifact('x.txt', Path(tmp) / 'missing.png')
      self.assertEqual(sorted(p.name for p in Path(tmp).iterdir()), [])

  def test_dry_run_writes_nothing(self):
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
      run = self.run_in(Path(tmp), dry_run=True)
      stderr = io.StringIO()
      with mock.patch('requests.request') as request, redirect_stderr(stderr):
        self.assertIsNone(run.log_artifact('x.txt', b'x'))
      request.assert_not_called()
      self.assertIn('would write 1 bytes', stderr.getvalue())
      self.assertEqual(list(Path(tmp).iterdir()), [])

  def test_a_run_without_a_folder(self):
    run = Run._new(project='g/repo', input='a.jpg')
    with self.assertRaises(ResultsError):
      run.log_artifact('x.txt', b'x')


class TestCli(unittest.TestCase):
  def invoke(self, *args):
    from click.testing import CliRunner
    from qaboard.qa import qa
    return CliRunner(mix_stderr=False).invoke(qa, ['runs', *args]) if 'mix_stderr' in CliRunner.__init__.__code__.co_varnames else CliRunner().invoke(qa, ['runs', *args])

  def test_lists_output_dirs(self):
    with mock_get(commit_response()):
      result = self.invoke('https://qaboard/g/repo/commit/abc?batch=ci&filter=outdoor')
    self.assertEqual(result.exit_code, 0, result.output)
    self.assertEqual(result.stdout.splitlines(), [str(Path(f'/mnt/qaboard/kitefin/detector/{COMMIT[:8]}/ci/{id}')) for id in (2, 3)])

  def test_json(self):
    with mock_get(commit_response()):
      result = self.invoke('https://qaboard/g/repo/commit/abc?batch=ci', '--filter', 'id:4', '--json')
    self.assertEqual(result.exit_code, 0, result.output)
    run, = json.loads(result.stdout)
    self.assertEqual(run['input'], 'videos/Drive (A).mp4')
    self.assertEqual(run['params'], {'gain': 4})
    self.assertEqual(run['extra_parameters'], {})
    self.assertEqual(run['state'], 'finished')
    self.assertTrue(run['output_dir'].endswith('4'))

  def test_reference_side(self):
    with mock_get(commit_response(batches=('nightly',))) as get:
      result = self.invoke('https://qaboard/g/repo/commit/abc?batch=ci&reference=def&batch_ref=nightly', '--side', 'reference')
    self.assertEqual(result.exit_code, 0, result.output)
    self.assertEqual(get.call_args[0][1], 'https://qaboard/api/v1/commit/def')
    result = self.invoke('https://qaboard/g/repo/commit/abc', '--side', 'ref')
    self.assertEqual(result.exit_code, 2)

  def test_errors(self):
    result = self.invoke()
    self.assertNotEqual(result.exit_code, 0)
    with mock_get({'error': 'nope'}, status=404):
      result = self.invoke('https://qaboard/g/repo/commit/abc')
    self.assertEqual(result.exit_code, 1)
    self.assertIn('nope', result.output + (result.stderr if hasattr(result, 'stderr') else ''))


if __name__ == '__main__':
  unittest.main()
