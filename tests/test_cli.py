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

  def test_check_bit_accuracy_reference_platform(self):
    """--reference-platform compares with the reference's runs on another platform"""
    from unittest import mock
    from qaboard.config import ci_env_variables
    # outside CI, so that runs are where the reference's are looked for: in CI, qa writes them in the commit's storage
    not_ci = {k: v for k, v in os.environ.items() if k not in ci_env_variables}
    with mock.patch.dict(os.environ, not_ci, clear=True):
      self._check_bit_accuracy_reference_platform()

  def _check_bit_accuracy_reference_platform(self):
    import sys
    import shutil
    import tempfile
    from unittest import mock
    result = self.qa('--configuration', 'base', 'batch', '--batches-file', 'image.batches.yaml', 'images', '--list')
    runs = json.loads(result.stdout)
    assert len(runs) == 3
    with tempfile.TemporaryDirectory() as tmp:
      # the reference's runs, on the hw platform
      result = self.qa('--configuration', 'base', '--platform', 'hw', 'batch', '--batches-file', 'image.batches.yaml', 'images', '--list')
      reference_runs = json.loads(result.stdout)
      reference_root = Path(tmp) / 'reference'
      output_dirs = [Path(run['output_dir']) for run in runs]
      reference_dirs = [reference_root / Path(run['output_dir']).relative_to(Path().resolve()) for run in reference_runs]
      assert output_dirs != [d.relative_to(reference_root).resolve() for d in reference_dirs] # the platform is part of the output directory
      def write_runs(dirs, md5):
        for d in dirs:
          d.mkdir(parents=True, exist_ok=True)
          for manifest in ['manifest.outputs.json', 'manifest.inputs.json']:
            (d / manifest).write_text(json.dumps({"out.txt": {"md5": md5}}))
      self.addCleanup(lambda: [shutil.rmtree(d, ignore_errors=True) for d in output_dirs])
      write_runs(output_dirs, 'same')
      write_runs(reference_dirs, 'same')
      def check_bit_accuracy():
        config = sys.modules['qaboard.config']
        with mock.patch.object(config, 'is_in_git_repo', True), mock.patch.object(config, 'is_ci', False), \
             mock.patch.object(config, 'outputs_project_root', reference_root), \
             mock.patch('qaboard.git.latest_commit', return_value='a' * 40), \
             mock.patch('qaboard.git_hosts.lastest_successful_ci_commit', side_effect=lambda commit: commit), \
             mock.patch('qaboard.conventions.get_commit_dirs', return_value=Path()):
          return self.qa('--configuration', 'base', 'check-bit-accuracy', '--batches-file', 'image.batches.yaml', '--batch', 'images', '--reference-platform', 'hw', reload_modules=False)
      result = check_bit_accuracy()
      assert result.exit_code == 0, result.output
      assert result.output.count('✔️') == 6 # outputs and inputs of each run
      write_runs(reference_dirs[1:2], 'other')
      result = check_bit_accuracy()
      assert result.exit_code == 1
      assert 'Mismatch' in result.output

  def test_optimize_without_checkpoint(self):
    """--checkpoint is optional"""
    import tempfile
    from unittest import mock
    with tempfile.TemporaryDirectory() as tmp:
      config_file = Path(tmp) / 'optimize.yaml'
      config_file.write_text(yaml.dump({
        "evaluations": 2,
        "objective": {"psnr": {}},
        "search_space": [{"Integer": {"name": "x", "low": 0, "high": 10}}],
      }))
      with mock.patch('qaboard.optimize.batch_objective', return_value=1.0) as batch_objective, \
           mock.patch('qaboard.optimize.notify_qa_database'), \
           mock.patch('qaboard.api.aggregated_metrics', return_value={}):
        result = self.qa('--dryrun', 'optimize', '--batches-file', 'image.batches.yaml', '--batch', 'images', '--config-file', str(config_file))
      assert result.exit_code == 0
      assert batch_objective.call_count == 2
      # with a checkpoint, the optimizer's state is saved
      checkpoint = Path(tmp) / 'checkpoint.pkl'
      with mock.patch('qaboard.optimize.batch_objective', return_value=1.0), \
           mock.patch('qaboard.optimize.notify_qa_database'), \
           mock.patch('qaboard.api.aggregated_metrics', return_value={}):
        result = self.qa('--dryrun', 'optimize', '--batches-file', 'image.batches.yaml', '--batch', 'images', '--config-file', str(config_file), '--checkpoint', str(checkpoint))
      assert result.exit_code == 0
      assert checkpoint.exists()

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
