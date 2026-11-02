"""
Tests for qaboard/results.py: the runs a web app page shows, as `Run` objects, from Python and `qa runs`.
"""
import io
import json
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
  return mock.patch('requests.get', return_value=r)


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
    url, kwargs = get.call_args[0][0], get.call_args[1]
    self.assertEqual(url, 'https://qaboard/api/v1/commit/7622c337')
    self.assertEqual(kwargs['params'], {'project': 'kitefin/detector', 'batch': 'ci', 'metrics': '{}'})
    self.assertIsInstance(found, Runs)
    # filtered like the web app: outdoor runs only
    self.assertEqual([r.id for r in found], [2, 3])
    self.assertEqual(found.commit, COMMIT)
    run = found[0]
    self.assertEqual(run.input, 'slices/outdoor/night-street.jpg')
    self.assertEqual(run.input_path, Path('/data/slices/outdoor/night-street.jpg'))
    self.assertEqual(run.configurations, ['base', 'night'])
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
    self.assertEqual(get.call_args[0][0], 'https://qaboard/api/v1/commit/def')
    self.assertEqual(get.call_args[1]['params']['batch'], 'nightly')
    self.assertEqual([r.id for r in found], [1, 4])

  def test_without_a_url(self):
    with mock_get(commit_response(batches=('default',))) as get, mock.patch('qaboard.results.default_server', return_value=('http://qaboard:5151', '$QABOARD_URL')):
      found = runs(project='g/repo', branch='main')
    self.assertEqual(get.call_args[0][0], 'http://qaboard:5151/api/v1/commit')
    self.assertEqual(get.call_args[1]['params']['branch'], 'main')
    self.assertEqual(len(found), 4)
    with self.assertRaises(ValueError):
      runs()

  def test_commit_and_branch_replace_the_urls(self):
    with mock_get(commit_response(batches=('default',))) as get:
      runs('https://qaboard/g/repo/commit/abc', branch='dev')
    self.assertEqual(get.call_args[0][0], 'https://qaboard/api/v1/commit')
    self.assertEqual(get.call_args[1]['params']['branch'], 'dev')
    with mock_get(commit_response(batches=('default',))) as get:
      runs('https://qaboard/g/repo/commit?branch=dev', commit='abc')
    self.assertEqual(get.call_args[0][0], 'https://qaboard/api/v1/commit/abc')
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
    with mock_get(commit_response(batches=('nightly',))) as get:
      found = runs('https://qaboard/g/repo/commit/abc?batch=ci&reference=def&batch_ref=nightly&filter_ref=indoor', reference=True)
    self.assertEqual(get.call_args[0][0], 'https://qaboard/api/v1/commit/def')
    self.assertEqual([r.id for r in found], [1])
    with self.assertRaises(ValueError):
      runs('https://qaboard/g/repo/commit/abc', reference=True)

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
  JSON_KEYS = {'project', 'commit', 'batch', 'input', 'database', 'platform', 'configurations', 'extra_parameters', 'params',
               'metrics', 'type', 'id', 'output_dir', 'is_pending', 'is_running', 'is_failed', 'deleted', 'input_metadata', 'data',
               'created_at', 'finished_at', 'server', 'state', 'url'}

  def test_same_object_from_the_server_and_from_code(self):
    from_server = Run.from_api(FIXTURE['outputs']['1'], project='g/repo', commit=COMMIT, batch='ci', server='https://qaboard')
    from_code = Run._new(project='g/repo', input='slices/indoor/kitchen.jpg', configurations=['base', {'gain': 2}], extra_parameters={'lr': 0.1}, batch='exp-1')
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

  def test_nothing_writes_yet(self):
    # no stubs in the public API: methods come when they work
    for name in ('log', 'save_file', 'series', 'finish'):
      self.assertFalse(hasattr(Run, name), name)
    import qaboard
    self.assertFalse(hasattr(qaboard, 'start_run'))


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

  def test_errors(self):
    result = self.invoke()
    self.assertNotEqual(result.exit_code, 0)
    with mock_get({'error': 'nope'}, status=404):
      result = self.invoke('https://qaboard/g/repo/commit/abc')
    self.assertEqual(result.exit_code, 1)
    self.assertIn('nope', result.output + (result.stderr if hasattr(result, 'stderr') else ''))


if __name__ == '__main__':
  unittest.main()
