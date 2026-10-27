import os
import shutil
import json
from importlib import import_module, reload
from pathlib import Path

import yaml
import unittest
import click
from click.testing import CliRunner

os.environ['QA_TESTING'] = 'true'

# Missing:
# - tests with --share
# - tests with CI=ON CI_COMMIT=XXXXXX


class TestQaCli(unittest.TestCase):
  @classmethod
  def setUpClass(self):
    self.previous_cwd = os.getcwd()
    root_repo = Path(__file__).resolve().parent.parent
    self.project_dir = root_repo / 'qaboard/sample_project'
    os.chdir(self.project_dir)
    database = str(Path())
    images = {'images': {
      "globs": ['*.jpg'],
      "inputs": ['cli_tests'],
      "database": {"linux": database, "windows": database} 
      }
    }
    # TODO: use a temp file?
    with Path('image.batches.yaml').open('w') as f:
      f.write(yaml.dump(images))
    os.environ['QA_DATABASE'] = database
    os.environ['QA_OFFLINE'] = 'true'
    os.environ['QA_STORAGE'] = str(root_repo.resolve())

  @classmethod
  def tearDownClass(self):
    os.chdir(self.previous_cwd)

  def setUp(self):
    # the qa CLI chdirs without restoring the cwd
    os.chdir(self.project_dir)
    def qa_(*argv, reload_modules=True):
      # qaboard.config resolves the project from the cwd, and qa.py binds it at import time.
      # Tests that patch them run a previous command to load them, then keep them: reload_modules=False
      if reload_modules:
        reload(import_module('qaboard.config'))
        reload(import_module('qaboard.qa'))
      import qaboard
      qaboard = reload(qaboard)
      runner = CliRunner()
      result = runner.invoke(qaboard.qa, argv, obj={}, auto_envvar_prefix='QA', color=False)
      if result.exception:
        print("EXCEPTION: ", result.exception)
      if result.exc_info and result.exception:
        import traceback
        exc_type, exc_value, exc_traceback = result.exc_info
        click.secho(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red')
        # traceback.print_exception(exc_type, exc_value, exc_traceback)
        # traceback.print_tb(exc_traceback)
      if result.exit_code:
        print("EXIT CODE:", result.exit_code)
        print('stdout:', result.stdout)
        try:
          print('stderr:', result.stderr)
        except:
          pass
      return result
    self.qa = qa_


  def test_help(self):
    result = self.qa('--help')
    assert result.exit_code == 0
    assert 'Usage:' in result.output

  def test_batch_help(self):
    result = self.qa('batch', '--help')
    assert result.exit_code == 0
    # joblib's n_jobs=-1 uses all CPUs
    assert '-1=one per CPU' in ' '.join(result.output.split())

  def test_run(self):
    result = self.qa('run', '-i', 'cli_tests/a.jpg', 'echo "{input_path} => {output_dir}"')
    assert result.exit_code == 0
    assert 'a.jpg =>' in result.output
    assert "'is_failed': False" in result.output
    result = self.qa('run', '-i', '/dev/null', 'echo "{input_path} => {output_dir}"')
    assert result.exit_code == 0
    assert '/dev/null =>' in result.output
    assert "'is_failed': False" in result.output

  @unittest.skipIf(os.name == 'nt', "no SIGTERM")
  def test_aborted_run_is_failed(self):
    """LSF sends SIGINT then SIGTERM when users bkill the job or it uses too much memory: the run says it failed"""
    import sys
    import time
    import signal
    import tempfile
    import subprocess
    for signo in (signal.SIGINT, signal.SIGTERM):
      with tempfile.TemporaryDirectory() as tmp:
        output_dir = Path(tmp) / 'output'
        command = [sys.executable, '-c', 'from qaboard.qa import main; main()', 'run', '-i', 'cli_tests/a.jpg', '-o', str(output_dir), 'sleep 30']
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding='utf-8')
        try:
          log = output_dir / 'log.txt'
          deadline = time.time() + 30
          while not (log.exists() and 'sleep 30' in log.read_text()) and time.time() < deadline:
            time.sleep(0.1)
          process.send_signal(signo)
          output, _ = process.communicate(timeout=20)
        finally:
          process.kill()
        self.assertEqual(process.returncode, 1, output)
        self.assertIn('The run was aborted', output)
        self.assertEqual(json.loads((output_dir / 'metrics.json').read_text()), {"is_failed": True})

  def test_aborted_run_updates_qaboard(self):
    from unittest import mock
    from qaboard.run import RunContext
    self.qa('--help') # loads the modules
    import tempfile
    qa_module = import_module('qaboard.qa') # qaboard.qa is the click command
    with tempfile.TemporaryDirectory() as tmp_dir:
      tmp = Path(tmp_dir)
      (tmp / 'metrics.json').write_text(json.dumps({"is_failed": False, "partial": 1}))
      run_context = RunContext(type='default', input_path=Path('a.jpg'), database=Path(), output_dir=tmp, configurations=[], platform='linux')
      with mock.patch.object(qa_module, 'notify_qa_database') as notify:
        qa_module.mark_aborted(run_context)
      self.assertEqual(json.loads((tmp / 'metrics.json').read_text()), {"is_failed": True, "partial": 1})
    self.assertEqual(notify.call_count, 1)
    self.assertEqual({k: notify.call_args.kwargs[k] for k in ('is_failed', 'is_pending', 'is_running')}, {'is_failed': True, 'is_pending': False, 'is_running': False})
    self.assertEqual(notify.call_args.kwargs['metrics'], {"is_failed": True, "partial": 1})

  def test_run_in_ci_when_the_server_refuses_results(self):
    from unittest import mock
    from tests.test_auth import response
    self.qa('run', '-i', 'cli_tests/a.jpg', 'echo "{input_path} => {output_dir}"') # loads the modules
    config = import_module('qaboard.config')
    expired = response(401, {"error": "This token expired on 2026-09-01.", "reason": "token_expired"})
    env = {k: v for k, v in os.environ.items() if k not in ('QA_OFFLINE', 'QA_AUTH_WARNING_SHOWN', 'QABOARD_TOKEN', 'QA_TOKEN')}
    with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(config, 'is_ci', True), \
         mock.patch('qaboard.api.results_refused', None), mock.patch('qaboard.auth._warnings_shown', set()), \
         mock.patch('requests.post', return_value=expired) as post:
      result = self.qa('run', '-i', 'cli_tests/a.jpg', 'echo "{input_path} => {output_dir}"', reload_modules=False)
    self.assertEqual(result.exit_code, 1)
    # the results would be lost: it doesn't run
    self.assertEqual(post.call_count, 1)
    self.assertNotIn('a.jpg =>', result.output)
    self.assertIn('WARNING: QA-Board refused the results: This token expired on 2026-09-01.', result.output)
    self.assertEqual(click.unstyle(result.output).strip().splitlines()[-1], 'ERROR: QA-Board refused the results (token_expired): they were not saved. '
                     f'Set QABOARD_TOKEN to a valid token with the ingest scope for {Path(config.project).as_posix()}.')

  def test_batch_in_ci_when_the_server_refuses_results(self):
    from unittest import mock
    from tests.test_auth import response
    self.qa('batch', '--batches-file', 'image.batches.yaml', 'images', '--list') # loads the modules
    config = import_module('qaboard.config')
    refused = response(403, {"error": "This server only accepts results sent with a token.", "reason": "ingest_token_required"})
    env = {k: v for k, v in os.environ.items() if k not in ('QA_OFFLINE', 'QA_AUTH_WARNING_SHOWN', 'QABOARD_TOKEN', 'QA_TOKEN')}
    # qa.py binds is_ci when it's imported
    with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(config, 'is_ci', True), mock.patch.object(import_module('qaboard.qa'), 'is_ci', True), \
         mock.patch('qaboard.api.results_refused', None), mock.patch('qaboard.auth._warnings_shown', set()), \
         mock.patch('requests.get', return_value=response(404, {"error": "Not found"})), \
         mock.patch('requests.post', return_value=refused) as post:
      result = self.qa('batch', '--batches-file', 'image.batches.yaml', 'images', '--runner=local', 'echo "{input_path} => {output_dir}"', reload_modules=False)
    self.assertEqual(result.exit_code, 1, result.output)
    # only the batch was sent, no run started
    self.assertEqual([c.args[0].rstrip('/').rsplit('/', 1)[-1] for c in post.call_args_list], ['batch'], result.output)
    self.assertNotIn('a.jpg =>', result.output)
    output = click.unstyle(result.output)
    self.assertEqual(output.count('This server only accepts results sent with a token.'), 1)
    self.assertEqual(output.strip().splitlines()[-1], 'ERROR: QA-Board refused the results (ingest_token_required): they were not saved. '
                     f'Set QABOARD_TOKEN to a valid token with the ingest scope for {Path(config.project).as_posix()}.')

  def test_get(self):
    result = self.qa('get', 'commit_id')
    assert result.exit_code == 0

  def test_batch(self):
    result = self.qa('--dryrun', 'batch', 'cli_tests')
    assert result.exit_code == 0
    result = self.qa('--dryrun', 'batch', '/dev/null')
    assert result.exit_code == 0

  def test_batch_list(self):
    result = self.qa('--dryrun', 'batch', '--batches-file', 'image.batches.yaml', 'images', '--list')
    tests = json.loads(result.stdout)
    assert len(tests) == 3
    assert result.exit_code == 0

  def test_batch_list_output_dirs(self):
    result = self.qa('--dryrun', 'batch', '--batches-file', 'image.batches.yaml', 'images', '--list-output-dirs')
    output_dirs = result.stdout.splitlines()
    assert len(output_dirs) == 3
    assert result.exit_code == 0

  def test_batch_list_inputs(self):
    result = self.qa('--dryrun', 'batch', '--batches-file', 'image.batches.yaml', 'images', '--list-inputs')
    output_dirs = result.stdout.splitlines()
    assert len(output_dirs) == 3
    assert result.exit_code == 0

  def test_batch_runs_file(self):
    import tempfile
    database = str(Path().resolve())
    runs = {"runs": [
      {"input_path": "cli_tests/a.jpg", "database": database, "configurations": ["base"], "extra_parameters": {"forwarded_args": ["--x"], "p": 1},
       "job_options": {"type": "local", "concurrency": 3, "command_id": "old", "cwd": "/somewhere/else"}},
      {"input_path": "cli_tests/b.jpg", "database": database},
    ]}
    with tempfile.TemporaryDirectory() as tmp:
      runs_file = Path(tmp) / 'runs.json'
      runs_file.write_text(json.dumps(runs))
      result = self.qa('--dryrun', 'batch', '--runs-file', str(runs_file), '--list')
      assert result.exit_code == 0
      first, second = json.loads(result.stdout)
      assert first['input_path'] == f"{database}/cli_tests/a.jpg"
      assert first['configurations'] == ["base"]
      assert first['extra_parameters'] == {"forwarded_args": ["--x"], "p": 1}
      assert first['job_options']['type'] == 'local'
      assert first['job_options']['concurrency'] == 3
      assert first['job_options']['command_id'] != 'old'
      assert first['job_options']['cwd'] != '/somewhere/else'
      assert "--tuning '{\"p\": 1}'" in first['command'] and first['command'].endswith(' --x')
      assert second['input_path'] == f"{database}/cli_tests/b.jpg"
      assert second['extra_parameters'] == {}
      # --runs-file replaces batches
      result = self.qa('--dryrun', 'batch', '--runs-file', str(runs_file), 'images', '--list')
      assert result.exit_code != 0

  def test_batch_runner_settings(self):
    """A batch's runner settings apply to its runs, except the options given on the command line"""
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
      batches_file = Path(tmp) / 'batches.yaml'
      images = yaml.safe_load(Path('image.batches.yaml').read_text())['images']
      batches_file.write_text(yaml.dump({'serial': {**images, 'local': {'concurrency': 1, 'timeout': 60}}}))
      def job_options(*args):
        result = self.qa('--dryrun', 'batch', '--batches-file', str(batches_file), '--runner=local', '--list', *args, 'serial')
        assert result.exit_code == 0
        return [(job['job_options']['concurrency'], job['job_options']['timeout']) for job in json.loads(result.stdout)]
      assert job_options() == [(1, 60)] * 3
      # qaboard.yaml has runners.local.concurrency: -1
      assert job_options('--local-concurrency', '-1') == [(-1, 60)] * 3

  def test_batch_action_on_existing_assert_exists(self):
    """--action-on-existing assert-exists fails if runs are missing, else does nothing with the runs that succeeded"""
    from unittest import mock
    from qaboard.api import dir_to_url
    result = self.qa('--dryrun', 'batch', '--batches-file', 'image.batches.yaml', 'images', '--list')
    runs = json.loads(result.stdout)
    assert len(runs) == 3
    def past_run(index, run, is_failed=False):
      return {
        "id": index, "output_dir_url": dir_to_url(Path(run['output_dir'])), "is_pending": False, "is_failed": is_failed,
        "test_input_path": run['rel_input_path'], "test_input_database": run['database'], "configurations": run['configurations'],
        "extra_parameters": run['extra_parameters'], "platform": run['platform'], "output_type": run['type'],
      }
    def batch(past_runs):
      with mock.patch('qaboard.qa.get_outputs', return_value=dict(enumerate(past_runs))):
        return self.qa('--dryrun', 'batch', '--batches-file', 'image.batches.yaml', 'images', '--action-on-existing', 'assert-exists', '--list', reload_modules=False)
    # a run is missing
    result = batch([past_run(0, runs[0]), past_run(1, runs[1])])
    assert result.exit_code == 1
    # they all exist: only the failed one runs again
    result = batch([past_run(0, runs[0]), past_run(1, runs[1], is_failed=True), past_run(2, runs[2])])
    assert result.exit_code == 0
    jobs = json.loads(result.stdout)
    assert [job['output_dir'] for job in jobs] == [runs[1]['output_dir']]
    assert ' run --input ' in jobs[0]['command']

  def test_batch_when_the_server_wont_read_runs(self):
    """When signing in is required: qa batch says so, and doesn't redo every run when asked to skip the existing ones"""
    from unittest import mock
    from tests.test_auth import response
    self.qa('--dryrun', 'batch', '--batches-file', 'image.batches.yaml', 'images', '--list') # loads the modules
    api = import_module('qaboard.api')
    refused = api.ResultsUnreadable(response(401, {"error": "Sign in to do this.", "reason": "sign_in_required"}))
    def batch(*args):
      with mock.patch('qaboard.qa.get_outputs', side_effect=refused), mock.patch('qaboard.auth._warnings_shown', set()), \
           mock.patch.dict(os.environ, {k: v for k, v in os.environ.items() if k != 'QA_AUTH_WARNING_SHOWN'}, clear=True):
        return self.qa('--dryrun', 'batch', '--batches-file', 'image.batches.yaml', 'images', *args, '--list', reload_modules=False)
    result = batch('--action-on-existing', 'skip')
    assert result.exit_code == 1, result.output
    output = click.unstyle(result.output)
    assert "WARNING: QA-Board refused to read the batch's runs: Sign in to do this." in output
    assert "--action-on-existing=skip needs the batch's runs" in output
    # by default runs are done again anyway: a warning
    result = batch()
    assert result.exit_code == 0, result.output
    assert len(json.loads(result.stdout)) == 3
    assert "can't see which runs are pending" in click.unstyle(result.output)

  # qa check-bit-accuracy: the reference is a CI run in the storage, saved by another user than us
  REFERENCE = 'a' * 40
  CI_USER = 'ci-bot'

  def bit_accuracy_env(self, storage, **env):
    """Outside of CI, as "me", with a {user} in the storage settings"""
    from unittest import mock
    from qaboard.config import ci_env_variables
    not_ci = {k: v for k, v in os.environ.items() if k not in ci_env_variables}
    return mock.patch.dict(os.environ, {**not_ci, 'QA_STORAGE': str(Path(storage) / '{user}'), 'QA_USER': 'me', **env}, clear=True)

  def list_output_dirs(self, *qa_args):
    result = self.qa('--configuration', 'base', *qa_args, 'batch', '--batches-file', 'image.batches.yaml', 'images', '--list')
    output_dirs = [Path(run['output_dir']) for run in json.loads(result.stdout)]
    assert len(output_dirs) == 3
    return output_dirs

  def reference_dirs(self, storage, *qa_args):
    """Where the reference commit's CI saved its runs"""
    commit_dir = Path(storage) / self.CI_USER / 'user/sample_project' / self.REFERENCE[:2] / self.REFERENCE[2:16]
    return [commit_dir / d.relative_to(Path().resolve()) for d in self.list_output_dirs(*qa_args)]

  def write_runs(self, dirs, md5='same'):
    for d in dirs:
      d.mkdir(parents=True, exist_ok=True)
      for manifest in ['manifest.outputs.json', 'manifest.inputs.json']:
        (d / manifest).write_text(json.dumps({"out.txt": {"md5": md5}}))
      self.addCleanup(shutil.rmtree, d, ignore_errors=True)

  def check_bit_accuracy(self, *qa_args, args=(), runs_known_by_qaboard=None, with_batch=True):
    import sys
    from unittest import mock
    reload(import_module('qaboard.config'))
    reload(import_module('qaboard.qa'))
    known_runs = {'return_value': runs_known_by_qaboard} if runs_known_by_qaboard is not None else {'side_effect': AssertionError('QA-Board was asked')}
    with mock.patch.object(sys.modules['qaboard.config'], 'is_in_git_repo', True), \
         mock.patch('qaboard.git.latest_commit', return_value=self.REFERENCE), \
         mock.patch('qaboard.git_hosts.lastest_successful_ci_commit', side_effect=lambda commit: commit), \
         mock.patch('qaboard.bit_accuracy.runs_known_by_qaboard', **known_runs):
      batch = ['--batches-file', 'image.batches.yaml', '--batch', 'images'] if with_batch else []
      result = self.qa('--configuration', 'base', *qa_args, 'check-bit-accuracy', *batch, *args, reload_modules=False)
    result.unstyled_output = click.unstyle(result.output)
    return result

  def test_check_bit_accuracy(self):
    """Local runs versus the reference's runs, saved by its CI in the storage under another {user}"""
    import tempfile
    with tempfile.TemporaryDirectory() as storage, self.bit_accuracy_env(storage):
      output_dirs, reference_dirs = self.list_output_dirs(), self.reference_dirs(storage)
      self.write_runs(output_dirs)
      self.write_runs(reference_dirs)
      result = self.check_bit_accuracy()
      assert result.exit_code == 0, result.output
      assert result.output.count('✔️') == 6 # outputs and inputs of each run
      self.write_runs(reference_dirs[1:2], 'other')
      result = self.check_bit_accuracy()
      assert result.exit_code == 1
      assert 'Mismatch' in result.output
      assert 'cli_tests/b.jpg  ["base"]  @manifest.outputs.json' in result.unstyled_output

  def test_check_bit_accuracy_saved_runs(self):
    """Without --batch, the runs saved with the label are compared"""
    import tempfile
    with tempfile.TemporaryDirectory() as storage, self.bit_accuracy_env(storage):
      # first: qa sets QA_LABEL for the wrapped code, and the next commands in this process would use it
      other_label_dirs = self.list_output_dirs('--label', 'other')
      os.environ.pop('QA_LABEL', None)
      output_dirs, reference_dirs = self.list_output_dirs(), self.reference_dirs(storage)
      self.write_runs(output_dirs + other_label_dirs)
      self.write_runs(reference_dirs)
      for d, input in zip(output_dirs + other_label_dirs, 2 * ['cli_tests/a.jpg', 'cli_tests/b.jpg', 'cli_tests/dir/c.jpg']):
        (d / 'run.json').write_text(json.dumps({"database": ".", "input_path": input, "configurations": ["base"], "extra_parameters": {}, "platform": "linux"}))
      # other tests leave runs in the project's output directory: we only look at ours
      checked = lambda result: [f'✔️  {input}  ["base"]  @{manifest}' in result.unstyled_output for input in ['cli_tests/a.jpg', 'cli_tests/b.jpg', 'cli_tests/dir/c.jpg'] for manifest in ['manifest.outputs.json', 'manifest.inputs.json']]
      result = self.check_bit_accuracy(with_batch=False)
      assert all(checked(result)), result.output
      assert result.unstyled_output.count('✔️  cli_tests/a.jpg  ["base"]  @manifest.outputs.json') == 1 # not the run with the other label
      self.write_runs(reference_dirs[:1], 'other')
      result = self.check_bit_accuracy(with_batch=False)
      assert result.exit_code == 1
      assert checked(result) == [False, False] + 4 * [True] # write_runs changes both manifests
      assert 'Mismatch' in result.output

  def test_check_bit_accuracy_closest_reference(self):
    """--reference-match closest compares with the reference's closest run on each input, like the web app"""
    import tempfile
    with tempfile.TemporaryDirectory() as storage, self.bit_accuracy_env(storage):
      ours = ['--configuration', 'delta-v1']
      output_dirs = self.list_output_dirs(*ours)
      inputs = ['cli_tests/a.jpg', 'cli_tests/b.jpg', 'cli_tests/dir/c.jpg']
      # the reference's CI only ran with other configurations
      references = {configuration: self.reference_dirs(storage, '--configuration', configuration) for configuration in ['delta-v2', 'other']}
      for configuration, dirs in references.items():
        self.write_runs(dirs, md5='same' if configuration == 'delta-v2' else 'other')
        for d, input in zip(dirs, inputs):
          (d / 'run.json').write_text(json.dumps({"database": ".", "input_path": input, "configurations": ["base", configuration], "extra_parameters": {}, "platform": "linux"}))
      self.write_runs(output_dirs)
      result = self.check_bit_accuracy(*ours)
      assert result.exit_code == 1
      assert result.unstyled_output.count('ERROR: No reference for') == 3
      result = self.check_bit_accuracy(*ours, args=['--reference-match', 'closest'])
      assert result.exit_code == 0, result.output
      assert result.output.count('✔️') == 6
      assert '≈  cli_tests/a.jpg  ["base", "delta-v1"]  versus the closest run, with configurations: ["base", "delta-v2"]' in result.unstyled_output
      self.write_runs(references['delta-v2'][:1], md5='other')
      result = self.check_bit_accuracy(*ours, args=['--reference-match', 'closest'])
      assert result.exit_code == 1
      assert 'cli_tests/a.jpg  ["base", "delta-v1"]  @manifest.outputs.json' in result.unstyled_output
      # the same run when there is one
      self.write_runs(self.reference_dirs(storage, *ours)[:1])
      result = self.check_bit_accuracy(*ours, args=['--reference-match', 'closest'])
      assert result.exit_code == 0, result.output
      assert '≈  cli_tests/a.jpg' not in result.unstyled_output

  def test_check_bit_accuracy_reference_platform(self):
    """--reference-platform compares with the reference's runs on another platform"""
    import tempfile
    with tempfile.TemporaryDirectory() as storage, self.bit_accuracy_env(storage):
      output_dirs, reference_dirs = self.list_output_dirs(), self.reference_dirs(storage, '--platform', 'hw')
      # the platform is part of the output directory
      assert [d.relative_to(Path().resolve()) for d in output_dirs] != [d.relative_to(reference_dirs[0].parents[3]) for d in reference_dirs]
      self.write_runs(output_dirs)
      self.write_runs(reference_dirs)
      result = self.check_bit_accuracy()
      assert result.exit_code == 1
      assert result.unstyled_output.count('ERROR: No reference for') == 3
      result = self.check_bit_accuracy(args=['--reference-platform', 'hw'])
      assert result.exit_code == 0, result.output
      assert result.output.count('✔️') == 6
      self.write_runs(reference_dirs[1:2], 'other')
      result = self.check_bit_accuracy(args=['--reference-platform', 'hw'])
      assert result.exit_code == 1
      assert 'Mismatch' in result.output

  def test_check_bit_accuracy_share(self):
    """With --share, our runs are in the storage, in our {user} folder and with our label prefixed by "@me|",
    while the reference's CI runs have the label as-is"""
    import tempfile
    with tempfile.TemporaryDirectory() as storage, self.bit_accuracy_env(storage):
      output_dirs, reference_dirs = self.list_output_dirs('--share'), self.reference_dirs(storage)
      assert all(Path(storage) / 'me' in d.parents for d in output_dirs)
      self.write_runs(output_dirs)
      self.write_runs(reference_dirs)
      result = self.check_bit_accuracy('--share')
      assert result.exit_code == 0, result.output
      assert result.output.count('✔️') == 6
      # --reference-label picks the reference's runs with another label
      result = self.check_bit_accuracy('--share', args=['--reference-label', 'other'])
      assert result.exit_code == 1
      assert result.unstyled_output.count('ERROR: No reference for') == 3
      assert f"nothing at {reference_dirs[0].parents[2] / 'output' / 'other'}" in result.unstyled_output
      self.write_runs(reference_dirs[2:], 'other')
      result = self.check_bit_accuracy('--share')
      assert result.exit_code == 1
      assert 'cli_tests/dir/c.jpg  ["base"]  @manifest.outputs.json' in result.unstyled_output

  def test_check_bit_accuracy_missing_runs(self):
    import tempfile
    with tempfile.TemporaryDirectory() as storage, self.bit_accuracy_env(storage):
      output_dirs, reference_dirs = self.list_output_dirs(), self.reference_dirs(storage)
      self.write_runs(output_dirs[1:])
      result = self.check_bit_accuracy()
      assert result.exit_code == 1
      assert result.unstyled_output.count('ERROR: No reference for') == 3
      # it says where it looked, with {user} for any user
      assert f"nothing at {Path(storage) / '{user}' / 'user/sample_project' / self.REFERENCE[:2]}" in result.unstyled_output
      self.write_runs(reference_dirs)
      result = self.check_bit_accuracy()
      assert result.exit_code == 1
      assert 'ERROR: Missing run for cli_tests/a.jpg  ["base"]' in result.unstyled_output
      assert f'nothing at {output_dirs[0]}' in result.unstyled_output
      assert result.output.count('✔️') == 4

  def test_check_bit_accuracy_asks_qaboard(self):
    """QA-Board knows where the reference's runs are: we don't guess"""
    import tempfile
    from qaboard.api import dir_to_url
    with tempfile.TemporaryDirectory() as storage, self.bit_accuracy_env(storage, QA_OFFLINE=''):
      del os.environ['QA_OFFLINE']
      output_dirs = self.list_output_dirs()
      self.write_runs(output_dirs)
      # anywhere, not where conventions would save them
      reference_dirs = [Path(storage) / 'anywhere' / str(i) for i in range(3)]
      self.write_runs(reference_dirs)
      inputs = ['cli_tests/a.jpg', 'cli_tests/b.jpg', 'cli_tests/dir/c.jpg']
      runs = [{
        'test_input_path': input, 'test_input_database': '.', 'platform': 'linux', 'configurations': ['base'],
        'extra_parameters': {'forwarded_args': ['--verbose']}, # not part of what identifies runs
        'output_dir_url': dir_to_url(d),
      } for input, d in zip(inputs, reference_dirs)]
      result = self.check_bit_accuracy(runs_known_by_qaboard=tuple(runs))
      assert result.exit_code == 0, result.output
      assert result.output.count('✔️') == 6
      self.write_runs(reference_dirs[:1], 'other')
      result = self.check_bit_accuracy(runs_known_by_qaboard=tuple(runs))
      assert result.exit_code == 1
      assert 'cli_tests/a.jpg  ["base"]  @manifest.outputs.json' in result.unstyled_output
      # it doesn't know this run: we look in the storage
      result = self.check_bit_accuracy(runs_known_by_qaboard=tuple(runs[1:]))
      assert result.exit_code == 1
      assert 'ERROR: No reference for cli_tests/a.jpg' in result.unstyled_output
      self.write_runs(self.reference_dirs(storage)[:1])
      result = self.check_bit_accuracy(runs_known_by_qaboard=tuple(runs[1:]))
      assert result.exit_code == 0, result.output
      assert result.output.count('✔️') == 6

  def test_check_bit_accuracy_manifest(self):
    """Versus the manifests saved next to the inputs, which are folders"""
    import tempfile
    with tempfile.TemporaryDirectory() as tmp, self.bit_accuracy_env(Path(tmp) / 'storage'):
      database = Path(tmp) / 'database'
      batches_file = Path(tmp) / 'tvs.batches.yaml'
      batches_file.write_text(yaml.dump({'tvs': {'inputs': ['tv*'], 'globs': [], 'database': {'linux': str(database), 'windows': str(database)}}}))
      for tv in ['tv1', 'tv2']:
        (database / tv).mkdir(parents=True)
      self.write_runs([database / 'tv1', database / 'tv2'])
      qa = lambda *args, **kwargs: self.qa('--configuration', 'base', *args, '--batches-file', str(batches_file), **kwargs)
      result = qa('batch', 'tvs', '--list')
      output_dirs = [Path(run['output_dir']) for run in json.loads(result.stdout)]
      assert len(output_dirs) == 2
      result = qa('check-bit-accuracy-manifest', '--batch', 'tvs')
      assert result.exit_code == 1
      assert 'ERROR: 2 runs are missing!' in click.unstyle(result.output)
      self.write_runs(output_dirs)
      result = qa('check-bit-accuracy-manifest', '--batch', 'tvs')
      assert result.exit_code == 0, result.output
      assert result.output.count('✔️') == 4
      self.write_runs(output_dirs[1:], 'other')
      result = qa('check-bit-accuracy-manifest', '--batch', 'tvs')
      assert result.exit_code == 1
      assert 'tv2  ["base"]  @manifest.outputs.json' in click.unstyle(result.output)

  def test_optimize(self):
    """qa optimize: searches, tells QA-Board what the web app shows, and resumes where it stopped"""
    import tempfile
    from unittest import mock
    with tempfile.TemporaryDirectory() as tmp:
      config_file = Path(tmp) / 'optimize.yaml'
      config_file.write_text(yaml.dump({
        "evaluations": 3,
        "objective": {"is_failed": {}},
        "search_space": [{"Integer": {"name": "x", "low": 0, "high": 10}}],
        "preset_params": {"fixed": 1},
      }))
      def optimize(*args, evaluations=None):
        if evaluations:
          config = yaml.safe_load(config_file.read_text())
          config_file.write_text(yaml.dump({**config, "evaluations": evaluations}))
        # qaboard.optimize binds the metrics when it's first imported, maybe by another test's project
        with mock.patch('qaboard.optimize.available_metrics', {"is_failed": {"smaller_is_better": True}}), \
             mock.patch('qaboard.optimize.batch_objective_components', side_effect=lambda *a: {"is_failed": -1.0}) as objective, \
             mock.patch('qaboard.optimize.notify_qa_database') as notify, \
             mock.patch('qaboard.api.aggregated_metrics', return_value={"is_failed": 0.0}):
          result = self.qa('--dryrun', 'optimize', '--batches-file', 'image.batches.yaml', '--batch', 'images', '--config-file', str(config_file), *args)
        return result, objective, [c.kwargs for c in notify.call_args_list]

      checkpoint = Path(tmp) / 'checkpoint.pkl'
      result, objective, notified = optimize('--checkpoint', str(checkpoint))
      assert result.exit_code == 0, result.output
      assert objective.call_count == 3
      # older servers ask for scikit-optimize's pickle: we save the search next to it
      assert not checkpoint.exists()
      assert (Path(tmp) / 'checkpoint.optuna.log').exists()

      batch_updates = [n['data'] for n in notified if n.get('object_type') == 'batch']
      start, *iterations, end = batch_updates
      assert start['optimization_status'] == 'running'
      assert start['iterations'] == 3
      assert start['optimization_config']['search_space'] == [{'name': 'x', 'type': 'integer', 'low': 0, 'high': 10, 'log': False}]
      assert start['optimization_config']['preset_params'] == {"fixed": 1}
      assert start['optimization_config']['config']['evaluations'] == 3 and start['optimization_config']['batches'] == ['images']
      assert start['optimization_config']['sampler'] in ('gp', 'tpe')
      assert [i['iteration'] for i in iterations] == [1, 2, 3]
      assert iterations[0]['is_best_iter'] and iterations[0]['best_params']['fixed'] == 1
      assert end['optimization_status'] == 'done' and end['evaluations_completed'] == 3
      runs = [n for n in notified if n.get('object_type', 'output') == 'output']
      assert [r['metrics']['iteration'] for r in runs] == [1, 2, 3]
      assert runs[0]['metrics']['objective'] == -1.0 and runs[0]['metrics']['is_failed'] == 0.0

      # the same command with a bigger budget runs only the new evaluations
      result, objective, notified = optimize('--checkpoint', str(checkpoint), evaluations=5)
      assert result.exit_code == 0, result.output
      assert objective.call_count == 2
      assert [n['data']['iteration'] for n in notified if n.get('object_type') == 'batch'][1:-1] == [4, 5]

      # a pickle from scikit-optimize where the search is saved: we say what to do
      old = Path(tmp) / 'old.log'
      old.write_bytes(b'\x80\x04pickle')
      result, _, _ = optimize('--checkpoint', str(old))
      assert result.exit_code != 0
      assert 'older qa optimize' in result.output

  def test_optimize_checks_the_config_first(self):
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
      config_file = Path(tmp) / 'optimize.yaml'
      config_file.write_text(yaml.dump({
        "evaluations": 3,
        "objective": {"is_failed": {}},
        "search_space": [{"Real": {"name": "x", "low": 0, "high": 1}}],
        "solver": {"base_estimator": "GP"},
      }))
      result = self.qa('--dryrun', 'optimize', '--batches-file', 'image.batches.yaml', '--batch', 'images', '--config-file', str(config_file))
      assert result.exit_code != 0
      assert 'scikit-optimize' in result.output and 'sampler' in result.output

  def test_optimize_without_a_metrics_file(self):
    """Which way is better comes from the objective (`psnr: max`), else from the code that computes the metric"""
    import tempfile
    from unittest import mock
    outputs = {'outputs': {1: {'metrics': {'psnr': 30.0}, 'output_dir_url': '/s/run', 'test_input_path': 'a.jpg'}}}
    with tempfile.TemporaryDirectory() as tmp:
      config_file = Path(tmp) / 'optimize.yaml'
      searches = iter(range(100))  # each search saved apart
      def optimize(objective, code_definitions):
        config_file.write_text(yaml.dump({
          "evaluations": 2,
          "objective": objective,
          "search_space": [{"Real": {"name": "x", "low": 0, "high": 1}}],
        }))
        with mock.patch('qaboard.optimize.available_metrics', {}), \
             mock.patch('qaboard.optimize.code_definitions', side_effect=code_definitions) as server, \
             mock.patch('qaboard.optimize.batch_info', return_value=outputs), \
             mock.patch('qaboard.optimize.notify_qa_database') as notify, \
             mock.patch('qaboard.api.aggregated_metrics', return_value={"psnr": 30.0}):
          result = self.qa('--dryrun', 'optimize', '--batches-file', 'image.batches.yaml', '--batch', 'images',
                           '--config-file', str(config_file), '--checkpoint', str(Path(tmp) / f'{next(searches)}.log'))
        batches = [c.kwargs['data'] for c in notify.call_args_list if c.kwargs.get('object_type') == 'batch']
        runs = [c.kwargs for c in notify.call_args_list if c.kwargs.get('object_type', 'output') == 'output']
        return result, server, batches, runs

      # said in the objective: QA-Board isn't asked
      result, server, batches, runs = optimize({"psnr": "max"}, [])
      assert result.exit_code == 0, result.output
      assert server.call_count == 0
      assert [r['metrics']['objective'] for r in runs] == [-30.0, -30.0]
      assert batches[0]['optimization_config']['objective']['psnr'] == {'goal': 'max', 'weight': 1, 'loss': 'identity', 'reduce': 'sum', 'margin': 0.0}

      # declared by the code when it runs (qaboard.Metric): known after the first evaluation, and the web app is told
      result, server, batches, runs = optimize({"psnr": {"weight": 2}}, [{}, {"psnr": {"smaller_is_better": False}}])
      assert result.exit_code == 0, result.output
      assert 'will read which way is better for psnr' in result.output
      assert [r['metrics']['objective'] for r in runs] == [-60.0, -60.0]
      assert batches[0]['optimization_config']['objective']['psnr']['goal'] is None
      assert batches[1]['optimization_config']['objective']['psnr']['goal'] == 'max'

      # nothing says: the search stops after the first evaluation, and says what to write
      result, server, batches, runs = optimize({"psnr": {}}, [{}, {}])
      assert result.exit_code != 0
      assert '`psnr: max`' in result.output
      assert batches[-1]['optimization_status'] == 'failed' and '`psnr: max`' in batches[-1]['optimization_error']

      # the runs returned it without saying: we know before running anything
      result, server, batches, runs = optimize({"psnr": {}}, [{"psnr": {"smaller_is_better": None}}])
      assert result.exit_code != 0
      assert '`psnr: max`' in result.output
      assert not batches

  def test_wait(self):
    """qa wait waits for the run to finish, and fails when the run failed"""
    from unittest import mock
    pending, failed, succeeded = {"is_pending": True, "is_failed": False}, {"is_pending": False, "is_failed": True}, {"is_pending": False, "is_failed": False}
    with mock.patch('qaboard.api.get_output', side_effect=[pending, failed]) as get_output, mock.patch('time.sleep'):
      result = self.qa('wait', '--output-id', '1')
    assert get_output.call_count == 2
    assert result.exit_code == 1
    with mock.patch('qaboard.api.get_output', side_effect=[succeeded]):
      result = self.qa('wait', '--output-id', '1')
    assert result.exit_code == 0

  def test_runner_local(self):
    result = self.qa('batch', '--batches-file', 'image.batches.yaml', 'images', '--runner=local', 'echo "{input_path} => {output_dir}"')
    print('stdout:', result.stdout)
    print('stderr:', result.stderr)
    assert result.exit_code == 0
    # we test with --share, but really being offline is a problem here..
    result = self.qa('--share', 'batch', '--batches-file', 'image.batches.yaml', 'images', '--runner=local', 'echo "{input_path} => {output_dir}"')
    print('stdout:', result.stdout)
    print('stderr:', result.stderr)
    assert result.exit_code == 0


  def test_batch_prints_the_results_url_at_the_start_and_the_end(self):
    from unittest import mock
    import requests
    # other tests run `qa batch` in this process, and leave QA_BATCH set as if we were started by a batch
    env = {k: v for k, v in os.environ.items() if k != 'QA_OFFLINE' and not k.startswith('QA_BATCH')}
    # the runs (subprocesses) can't reach any server, and neither can this process
    env['QABOARD_URL'] = 'http://127.0.0.1:9'
    no_server = requests.ConnectionError('no server in tests')
    # qaboard.api binds the project when imported, maybe by other tests from another directory
    reload(import_module('qaboard.config'))
    reload(import_module('qaboard.api'))
    with mock.patch.dict(os.environ, env, clear=True), \
         mock.patch('requests.post', side_effect=no_server), mock.patch('requests.get', side_effect=no_server):
      result = self.qa('--share', 'batch', '--batches-file', 'image.batches.yaml', 'images', '--runner=local', 'echo "{input_path} => {output_dir}"')
      qa_batch = os.environ.get('QA_BATCH')
    assert result.exit_code == 0
    self.assertEqual(result.stderr.count('Results: '), 2, result.stderr)
    self.assertIsNone(qa_batch) # restored when the batch ends

  @unittest.skipUnless(shutil.which('bsub'), 'needs LSF (bsub)')
  def test_runner_lsf(self):
    result = self.qa('batch', '--batches-file', 'image.batches.yaml', 'images', '--runner=lsf', 'echo "{input_path} => {output_dir}"')
    assert result.exit_code == 0
    # we also test subprojects
    os.chdir('subproject')
    result = self.qa('batch', '--batches-file', 'image.batches.yaml', 'images', '--runner=local', 'echo "{input_path} => {output_dir}"')

  def test_save_artifacts(self):
    result = self.qa('save-artifacts')
    print('stdout:', result.stdout)
    # print('stderr:', result.stderr)
    assert result.exit_code == 0
    # => Gitlab/QA-Board: 404: Project not found

  def test_init(self):
    import tempfile
    prev = os.getcwd()
    with tempfile.TemporaryDirectory() as tmp_dir:
      os.chdir(tmp_dir)
      assert not os.system('git init')
      assert not os.system('echo OK > file')
      assert not os.system('git add file')
      assert not os.system('git commit -m "first commit"')
      assert not os.system('git remote add origin git@gitlab-srv:common-infrastructure/qaboard.git')
      # assert not os.system('git remote add origin git@github.com:Samsung/qaboard.git')
      # assert not os.system('git remote add origin https://github.com/Samsung/qaboard.git')
      assert not os.system('qa init')
      assert not os.system('qa get project')
    os.chdir(prev)


  def test_messages_name_the_qa_cli(self):
    """qa talks about QA-Board, qaboard.yaml and `qa`, not their old name"""
    import sys
    import subprocess
    import tempfile
    qa = Path(sys.executable).parent / 'qa'
    if not qa.exists():
      self.skipTest('needs the qa executable')
    with tempfile.TemporaryDirectory() as tmp:
      # outside a project
      out = subprocess.run([str(qa), 'get', 'commit_id'], cwd=tmp, capture_output=True, encoding='utf-8')
      self.assertIn('run `qa init`', out.stderr)
      out_init = subprocess.run([str(qa), '--dryrun', 'init'], cwd=tmp, capture_output=True, encoding='utf-8')
      self.assertIn('Creating a `qaboard.yaml` configuration', out_init.stdout)
      for output in [out.stdout, out.stderr, out_init.stdout, out_init.stderr]:
        self.assertNotIn('qatools', output)


  @unittest.skip("tendency to fail for no reason")
  def test_batch_lsf_interrupt(self):
      # https://stackoverflow.com/a/59303823/5993501
      from multiprocessing import Queue, Process
      from threading import Timer
      from time import sleep
      from os import kill, getpid
      from signal import SIGINT

      q = Queue()
      # Running out app in SubProcess and after a while using signal sending 
      # SIGINT, results passed back via channel/queue  
      def background():
          Timer(2, lambda: kill(getpid(), SIGINT)).start()
          result = self.qa('batch', '--batches-file', 'image.batches.yaml', 'images', '--runner=lsf', 'echo "{input_path} => {output_dir}"')
          q.put(('exit_code', result.exit_code))
          q.put(('output', result.output))
      p = Process(target=background)
      p.start()
      results = {}
      while p.is_alive():
          sleep(0.1)
      else:
          while not q.empty():
              key, value = q.get()
              results[key] = value
      # print(results['output'])
      assert "Aborted." in results['output']
      # we could also check for "bkill" if we run with QA_BATCH_VERBOSE=1



if __name__ == '__main__':
  unittest.main()
