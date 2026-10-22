"""
Tests for the LSF concurrency limit and the dask runner.
LSF is not available: we check the bsub commands we would send, and execute the job array scripts with bash.
"""
import os
import sys
import re
import time
import tempfile
import unittest
import subprocess
from pathlib import Path
from unittest import mock


def make_jobs(runner_type, commands, output_root: Path, **job_options):
  from qaboard.run import RunContext
  from qaboard.runners import Job
  jobs = []
  for index, command in enumerate(commands):
    run_context = RunContext(
      type='default',
      input_path=Path(f'input{index}'),
      database=Path(),
      platform='linux',
      configurations=[],
      job_options={"type": runner_type, "command_id": "abcdefgh-1234", **job_options},
      output_dir=output_root / f'output{index}',
      command=command,
    )
    jobs.append(Job(run_context))
  return jobs


class FakeBsub():
  """Records the commands sent to bsub."""
  def __init__(self):
    self.commands = []

  def __call__(self, command, **kwargs):
    self.commands.append(command)
    return subprocess.CompletedProcess(command, 0, stdout='Job <1> is submitted', stderr='')

  def names(self):
    return [re.search(r'-J "([^"]+)"', c).group(1) for c in self.commands]


def has_bsub():
  return mock.patch('qaboard.runners.lsf.shutil.which', return_value='/usr/bin/bsub')


class TestLsfOptions(unittest.TestCase):
  def bsub_command(self, extra_parameters=None, **job_options):
    from qaboard.runners.lsf import LsfRunner
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    job = make_jobs('lsf', ['echo hi'], Path(tmp.name), **job_options)[0]
    job.run_context.extra_parameters = extra_parameters or {}
    bsub = FakeBsub()
    with mock.patch('qaboard.runners.lsf.subprocess.run', bsub), has_bsub():
      LsfRunner(job.run_context).start(blocking=False)
    return bsub.commands[0]

  def test_lsf_defaults(self):
    # Without queue/project, bsub uses LSF's defaults
    command = self.bsub_command()
    self.assertNotIn(' -q ', command)
    self.assertNotIn(' -P ', command)
    self.assertNotIn('None', command)
    self.assertIn('-sp 2000', command)

  def test_options(self):
    command = self.bsub_command(queue='my_queue', project='my/project')
    self.assertIn("-q 'my_queue'", command)
    self.assertIn("-P 'my/project'", command)

  def test_priority(self):
    self.assertIn('-sp 1000', self.bsub_command(extra_parameters={'a': 1}))
    self.assertIn('-sp 3000', self.bsub_command(priority=3000))
    self.assertIn('-sp 3000', self.bsub_command(priority=3000, extra_parameters={'a': 1}))

  def test_no_bsub(self):
    from qaboard.runners.lsf import LsfRunner
    job = make_jobs('lsf', ['echo hi'], Path(), queue='q')[0]
    with mock.patch('qaboard.runners.lsf.shutil.which', return_value=None), mock.patch('qaboard.runners.lsf.subprocess.run') as run:
      with self.assertRaisesRegex(Exception, 'bsub'):
        LsfRunner(job.run_context).start(blocking=False)
    run.assert_not_called()


class TestLsfConcurrency(unittest.TestCase):
  def start(self, nb_jobs, **job_options):
    from qaboard.runners.lsf import LsfRunner
    self.tmp = tempfile.TemporaryDirectory()
    self.addCleanup(self.tmp.cleanup)
    self.output_root = Path(self.tmp.name)
    commands = [f'echo run-{i}' for i in range(nb_jobs)]
    jobs = make_jobs('lsf', commands, self.output_root, queue='q', **job_options)
    bsub = FakeBsub()
    with mock.patch('qaboard.runners.lsf.subprocess.run', bsub), has_bsub():
      LsfRunner.start_jobs(jobs, jobs[0].run_context.job_options, blocking=False)
    return bsub

  def test_unlimited_is_unchanged(self):
    bsub = self.start(5)
    self.assertEqual(len(bsub.commands), 5)
    for command, name in zip(bsub.commands, bsub.names()):
      self.assertRegex(name, r'^abcdefgh_[a-z]{12}$')
      self.assertNotIn(' -w ', command)
      self.assertIn('log.lsf.txt', command)

  def test_concurrency_larger_than_batch_is_unchanged(self):
    bsub = self.start(3, concurrency=5)
    self.assertEqual(len(bsub.commands), 3)

  def test_waves(self):
    bsub = self.start(5, concurrency=2, concurrency_strategy='waves')
    names = bsub.names()
    self.assertEqual([n.rsplit('_', 1)[0] for n in names], ['abcdefgh_W0', 'abcdefgh_W0', 'abcdefgh_W1', 'abcdefgh_W1', 'abcdefgh_W2'])
    self.assertNotIn(' -w ', bsub.commands[0])
    self.assertIn('-w "ended(abcdefgh_W0_*)"', bsub.commands[2])
    self.assertIn('-w "ended(abcdefgh_W1_*)"', bsub.commands[4])

  def test_array(self):
    bsub = self.start(5, concurrency=2)
    self.assertEqual(len(bsub.commands), 1)
    name = bsub.names()[0]
    self.assertRegex(name, r'^abcdefgh_[a-z]{12}\[1-5\]%2$')
    command = bsub.commands[0]
    self.assertIn("-q 'q'", command)
    # LSF writes each element's report via a symlink to the element's output directory
    links_dir = self.output_root.resolve() / 'lsf' / name.split('[')[0]
    self.assertIn(f'-o "{links_dir}/%I/log.lsf.txt"', command)
    # Each array element runs its own command, and logs in its own output directory
    script = command.split('<< "EOF"\n', 1)[1].rsplit('\nEOF', 1)[0]
    for index in range(5):
      out = subprocess.run(['sh', '-c', script], env={**os.environ, 'LSB_JOBINDEX': str(index + 1)})
      self.assertEqual(out.returncode, 0)
      # LSF appends its report when the job ends
      with (links_dir / str(index + 1) / 'log.lsf.txt').open('a') as f:
        f.write('Successfully completed.\n')
      log = (self.output_root / f'output{index}' / 'log.lsf.txt').read_text()
      self.assertEqual(log, f'run-{index}\nSuccessfully completed.\n')

  def test_array_uses_batch_dir(self):
    with tempfile.TemporaryDirectory() as batch_dir:
      bsub = self.start(3, concurrency=2, batch_dir=batch_dir)
      links_dir = Path(batch_dir).resolve() / 'lsf' / bsub.names()[0].split('[')[0]
      self.assertIn(f'-o "{links_dir}/%I/log.lsf.txt"', bsub.commands[0])
      self.assertEqual((links_dir / '2').resolve(), (self.output_root / 'output1').resolve())

  def test_live_log(self):
    # Like job arrays, the output is written live to log.lsf.txt, and LSF appends its report
    bsub = self.start(1)
    command = bsub.commands[0]
    output_dir = (self.output_root / 'output0').resolve()
    self.assertIn(f'-o "{output_dir}/log.lsf.txt"', command)
    script = command.split('<< "EOF"\n', 1)[1].rsplit('\nEOF', 1)[0]
    out = subprocess.run(['sh', '-c', script], stdout=subprocess.PIPE, encoding='utf-8')
    self.assertEqual(out.returncode, 0)
    self.assertEqual(out.stdout, '')
    self.assertEqual((output_dir / 'log.lsf.txt').read_text(), 'run-0\n')

  def test_array_logs_survive_output_cleanup(self):
    # `qa run` cleans its output directory when it starts, after the array element redirected its output there
    import sys
    from qaboard.runners.lsf import LsfRunner
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    output_dir = Path(tmp.name) / 'output0'
    (output_dir / 'previous' / 'nested').mkdir(parents=True)
    (output_dir / 'previous' / 'nested' / 'old.txt').write_text('old')
    (output_dir / 'log.txt').write_text('old')
    qa_run = f"{sys.executable} -c \"from pathlib import Path; from qaboard.utils import clean_output_dir; print('before', flush=True); clean_output_dir(Path('{output_dir}')); print('after')\""
    jobs = make_jobs('lsf', [qa_run, 'echo b', 'echo c'], Path(tmp.name), queue='q', concurrency=2)
    bsub = FakeBsub()
    with mock.patch('qaboard.runners.lsf.subprocess.run', bsub), has_bsub():
      LsfRunner.start_jobs(jobs, jobs[0].run_context.job_options, blocking=False)
    script = bsub.commands[0].split('<< "EOF"\n', 1)[1].rsplit('\nEOF', 1)[0]
    out = subprocess.run(['bash', '-c', script], env={**os.environ, 'LSB_JOBINDEX': '1'})
    self.assertEqual(out.returncode, 0)
    self.assertEqual(sorted(p.name for p in output_dir.iterdir()), ['log.lsf.txt'])
    self.assertTrue((output_dir / 'log.lsf.txt').read_text().endswith('before\nafter\n'))

  def test_array_groups_by_lsf_options(self):
    from qaboard.runners.lsf import LsfRunner
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    jobs = make_jobs('lsf', ['a', 'b', 'c'], Path(tmp.name), queue='q', concurrency=1)
    jobs += make_jobs('lsf', ['d', 'e'], Path(tmp.name) / 'big', queue='q', concurrency=1, max_memory=1000)
    bsub = FakeBsub()
    with mock.patch('qaboard.runners.lsf.subprocess.run', bsub), has_bsub(), mock.patch('qaboard.runners.lsf.secho'):
      LsfRunner.start_jobs(jobs, jobs[0].run_context.job_options, blocking=False)
    self.assertEqual(len(bsub.commands), 2)
    self.assertRegex(bsub.names()[0], r'\[1-3\]%1$')
    self.assertRegex(bsub.names()[1], r'\[1-2\]%1$')
    self.assertIn('rusage[mem=1000]', bsub.commands[1])


class TestJobGroups(unittest.TestCase):
  """Batches can have their own concurrency or timeout: their jobs start with them"""
  def setUp(self):
    self.tmp = tempfile.TemporaryDirectory()
    self.addCleanup(self.tmp.cleanup)
    self.root = Path(self.tmp.name)

  def test_groups(self):
    from qaboard.runners import JobGroup
    command_options = {"type": "local", "command_id": "abcdefgh-1234", "concurrency": 4, "timeout": 0, "cwd": "/here"}
    serial = make_jobs('local', ['a', 'b'], self.root / 'serial', concurrency=1, timeout=0, cwd="/here")
    default = make_jobs('local', ['c'], self.root / 'default', concurrency=4, timeout=0, cwd="/here")
    slow = make_jobs('local', ['d'], self.root / 'slow', concurrency=4, timeout=10, cwd="/here", param='other options are per job')
    group = JobGroup(jobs=[serial[0], default[0], serial[1], *slow], job_options=command_options)
    groups = group.groups()
    self.assertEqual([[job.run_context.command for job in jobs] for _, jobs in groups], [['a', 'b'], ['c'], ['d']])
    self.assertEqual([options for options, _ in groups], [
      {**command_options, "concurrency": 1},
      command_options,
      {**command_options, "timeout": 10},
    ])
    # Runs that QA-Board redoes start together
    group = JobGroup(jobs=[serial[0], default[0]], job_options=command_options, split_by_job_options=False)
    self.assertEqual(group.groups(), [(command_options, [serial[0], default[0]])])
    # Runners that don't have options for groups of jobs start them together
    celery_jobs = make_jobs('celery', ['a', 'b'], self.root / 'celery', concurrency=1)
    celery_jobs += make_jobs('celery', ['c'], self.root / 'celery', concurrency=2)
    group = JobGroup(jobs=celery_jobs, job_options={"type": "celery", "command_id": "abcdefgh-1234"})
    self.assertEqual(len(group.groups()), 1)

  def test_local_concurrency(self):
    """Batches with their own concurrency or timeout run one after the other"""
    from qaboard.runners import JobGroup
    from qaboard.runners.local import LocalRunner
    # Each run records how many runs are in-flight when it starts
    counter = self.root / 'counter'
    def commands(name, nb):
      # runs start where `qa batch` runs
      return [f'mkdir -p "{self.root}/{name}{i}" && cd "{self.root}/{name}{i}" && echo start >> "{counter}"; grep -c start "{counter}" > started; grep -c end "{counter}" > ended; sleep 0.3; echo end >> "{counter}"' for i in range(nb)]
    serial = make_jobs('local', commands('serial', 3), self.root, concurrency=1, cwd=str(self.root))
    parallel = make_jobs('local', commands('parallel', 3), self.root, concurrency=3, cwd=str(self.root))
    group = JobGroup(jobs=[*serial, *parallel], job_options={"type": "local", "command_id": "abcdefgh-1234", "concurrency": 3, "cwd": str(self.root)})
    LocalRunner.start_groups(group.groups())
    def in_flight(name):
      return [int((self.root / f'{name}{i}' / 'started').read_text()) - int((self.root / f'{name}{i}' / 'ended').read_text()) for i in range(3)]
    self.assertEqual(in_flight('serial'), [1, 1, 1])
    self.assertTrue(all(1 <= n <= 3 for n in in_flight('parallel')))

    # joblib gets each group's concurrency, the runs their group's timeout
    from unittest import mock
    with mock.patch('joblib.Parallel') as Parallel:
      slow = make_jobs('local', ['sleep 1'], self.root, concurrency=3, timeout=10, cwd=str(self.root))
      group = JobGroup(jobs=[*serial, *parallel, *slow], job_options={"type": "local", "command_id": "abcdefgh-1234", "concurrency": 3, "cwd": str(self.root)})
      LocalRunner.start_groups(group.groups())
    self.assertEqual([call.kwargs['n_jobs'] for call in Parallel.call_args_list], [1, 3, 3])
    self.assertTrue(all('timeout' not in call.kwargs for call in Parallel.call_args_list))

  @unittest.skipIf(os.name == 'nt', "the shell's children are killed with its process group")
  def test_local_timeout(self):
    """A run over its timeout is killed, with what it started, and the other runs go on"""
    import time
    from qaboard.runners import JobGroup
    from qaboard.runners.local import LocalRunner
    # the shell starts a child that would write its file after the timeout
    late = self.root / 'late'
    done = self.root / 'done'
    slow = make_jobs('local', [f'(sleep 3 && touch "{late}") & wait'], self.root, concurrency=2, timeout=1, cwd=str(self.root))
    fast = make_jobs('local', [f'touch "{done}"'], self.root, concurrency=2, timeout=1, cwd=str(self.root))
    group = JobGroup(jobs=[*slow, *fast], job_options={"type": "local", "command_id": "abcdefgh-1234", "concurrency": 2, "cwd": str(self.root)})
    start = time.time()
    LocalRunner.start_groups(group.groups())
    self.assertLess(time.time() - start, 2.5)
    self.assertTrue(done.exists())
    time.sleep(2.5)
    self.assertFalse(late.exists())

  def test_lsf_groups(self):
    """LSF jobs of all groups are sent, each group with its own concurrency, then we wait for all of them"""
    from qaboard.runners import JobGroup
    from qaboard.runners.lsf import LsfRunner
    serial = make_jobs('lsf', ['a', 'b', 'c'], self.root / 'serial', queue='q', concurrency=1)
    unlimited = make_jobs('lsf', ['d', 'e'], self.root / 'unlimited', queue='q', concurrency=0)
    waves = make_jobs('lsf', ['f', 'g', 'h'], self.root / 'waves', queue='q', concurrency=2, concurrency_strategy='waves')
    group = JobGroup(jobs=[*serial, *unlimited, *waves], job_options={"type": "lsf", "command_id": "abcdefgh-1234", "queue": "q", "concurrency": 0})
    bsub = FakeBsub()
    with mock.patch('qaboard.runners.lsf.subprocess.run', bsub), has_bsub(), mock.patch('signal.signal'):
      LsfRunner.start_groups(group.groups(), blocking=True)
    names = bsub.names()
    self.assertRegex(names[0], r'^abcdefgh_[a-z]{12}\[1-3\]%1$')
    self.assertRegex(names[1], r'^abcdefgh_[a-z]{12}$')
    self.assertRegex(names[2], r'^abcdefgh_[a-z]{12}$')
    # each group has its own waves
    self.assertEqual([n.rsplit('_', 1)[0] for n in names[3:6]], ['abcdefgh_2_W0', 'abcdefgh_2_W0', 'abcdefgh_2_W1'])
    self.assertIn('-w "ended(abcdefgh_2_W0_*)"', bsub.commands[5])
    # a single job waits for all the others
    self.assertEqual(names[6:], ['abcdefgh_WAIT'])
    self.assertIn('-w "ended(abcdefgh_*)"', bsub.commands[6])


class TestBuildPowershellEnv(unittest.TestCase):
  def env_lines(self, **context_env):
    from qaboard.runners.jenkins_windows import build_powershell_env
    return build_powershell_env(context_env)

  def test_plain_env_vars(self):
    self.assertEqual(self.env_lines(FOO='bar'), ["$Env:FOO = 'bar'"])

  def test_single_quotes_are_escaped(self):
    # PowerShell escapes single quotes by doubling them
    self.assertEqual(self.env_lines(MSG="it's here"), ["$Env:MSG = 'it''s here'"])

  def test_prepend_path_string(self):
    # a plain string is a single directory prepended to the inherited PATH
    self.assertEqual(self.env_lines(prepend_path='C:\\tools\\bin'), ["$Env:PATH = 'C:\\tools\\bin;' + $env:PATH"])

  def test_prepend_path_list(self):
    lines = self.env_lines(prepend_path=['C:\\a', 'C:\\b'])
    self.assertEqual(lines, ["$Env:PATH = 'C:\\a;C:\\b;' + $env:PATH"])

  def test_prepend_path_tuple(self):
    lines = self.env_lines(prepend_path=('C:\\a', 'C:\\b'))
    self.assertEqual(lines, ["$Env:PATH = 'C:\\a;C:\\b;' + $env:PATH"])

  def test_prepend_path_with_other_vars(self):
    lines = self.env_lines(prepend_path='C:\\tools', FOO='bar')
    self.assertEqual(lines, ["$Env:PATH = 'C:\\tools;' + $env:PATH", "$Env:FOO = 'bar'"])

  def test_prepend_path_escaped(self):
    self.assertEqual(self.env_lines(prepend_path="C:\\it's"), ["$Env:PATH = 'C:\\it''s;' + $env:PATH"])

  def test_prepend_path_ignores_custom_path(self):
    # a regular PATH key would overwrite the prepended value since it's rendered after
    from qaboard.runners.jenkins_windows import secho
    with mock.patch('qaboard.runners.jenkins_windows.secho') as secho:
      lines = self.env_lines(prepend_path='C:\\tools', PATH='C:\\evil')
    self.assertEqual(lines, ["$Env:PATH = 'C:\\tools;' + $env:PATH"])
    self.assertTrue(any('PATH' in str(call) for call in secho.call_args_list))

  def test_prepend_path_falsy_is_ignored(self):
    self.assertEqual(self.env_lines(prepend_path=None), [])
    self.assertEqual(self.env_lines(prepend_path=''), [])
    self.assertEqual(self.env_lines(prepend_path=[]), [])


class TestJenkinsWindowsRunner(unittest.TestCase):
  def setUp(self):
    self.tmp = tempfile.TemporaryDirectory()
    self.addCleanup(self.tmp.cleanup)
    self.output_root = Path(self.tmp.name)
    # other tests may leave us in a deleted directory
    self.addCleanup(os.chdir, Path(__file__).resolve().parent.parent)
    os.chdir(self.tmp.name)
    # make sure an env var set in another test doesn't leak into the defaults
    os.environ.pop('QA_RUNNER_ERROR_ACTION', None)

  def run_ps1(self, **job_options):
    from qaboard.runners.jenkins_windows import JenkinsWindowsRunner
    job = make_jobs('windows', ['echo hi'], self.output_root, **job_options)[0]
    with mock.patch('qaboard.runners.jenkins_windows.trigger_run', return_value={}):
      JenkinsWindowsRunner(job.run_context).start(blocking=False)
    return (job.run_context.output_dir / 'run.ps1').read_text()

  def test_context_with_custom_env_vars(self):
    # external callers (e.g. the delivery flow) pass custom node env vars via the
    # run context's `env` mapping; start() must write them as $Env:KEY = 'value' lines
    from qaboard.runners.jenkins_windows import JenkinsWindowsRunner

    class EnvRunContext:
      def __init__(self, output_dir):
        self.output_dir = output_dir
        self.command = 'echo hi'
        self.env = {'CI': 'true'}

    output_dir = self.output_root / 'custom-env'
    with mock.patch('qaboard.runners.jenkins_windows.trigger_run', return_value={}):
      JenkinsWindowsRunner(EnvRunContext(output_dir)).start(blocking=False)
    content = (output_dir / 'run.ps1').read_text()
    self.assertIn("$Env:CI = 'true'", content)

  def test_context_with_prepend_path(self):
    # the delivery flow can pass `prepend_path` in the run context's env mapping:
    # start() must prepend the directories to the inherited PATH, before the command
    from qaboard.runners.jenkins_windows import JenkinsWindowsRunner

    class EnvRunContext:
      def __init__(self, output_dir):
        self.output_dir = output_dir
        self.command = 'echo hi'
        self.env = {'prepend_path': 'C:\\tools\\bin', 'CI': 'true'}

    output_dir = self.output_root / 'prepend-path'
    with mock.patch('qaboard.runners.jenkins_windows.trigger_run', return_value={}):
      JenkinsWindowsRunner(EnvRunContext(output_dir)).start(blocking=False)
    content = (output_dir / 'run.ps1').read_text()
    self.assertIn("$Env:PATH = 'C:\\tools\\bin;' + $env:PATH", content)
    self.assertIn("$Env:CI = 'true'", content)
    # the PATH must be prepended before the command runs, and never set to the literal text
    self.assertLess(content.index("$Env:PATH ="), content.index('echo hi'))
    self.assertNotIn("$env:PATH'", content)

  def test_default_error_action(self):
    self.assertIn('$ErrorActionPreference = "Stop"', self.run_ps1())

  def test_env_error_action(self):
    os.environ['QA_RUNNER_ERROR_ACTION'] = 'Continue'
    self.addCleanup(os.environ.pop, 'QA_RUNNER_ERROR_ACTION', None)
    self.assertIn('$ErrorActionPreference = "Continue"', self.run_ps1())

  def test_invalid_env_error_action_falls_back(self):
    os.environ['QA_RUNNER_ERROR_ACTION'] = 'Bogus'
    self.addCleanup(os.environ.pop, 'QA_RUNNER_ERROR_ACTION', None)
    with mock.patch('qaboard.runners.jenkins_windows.secho') as secho:
      content = self.run_ps1()
    self.assertIn('$ErrorActionPreference = "Stop"', content)
    self.assertTrue(any('Bogus' in str(c) for c in secho.call_args_list))

  def test_context_without_job_options_attribute(self):
    # regression: external callers (e.g. CI scripts) may pass a duck-typed
    # context without a job_options attribute; start() must not raise
    from qaboard.runners.jenkins_windows import JenkinsWindowsRunner

    class BareRunContext:
      def __init__(self, output_dir):
        self.output_dir = output_dir
        self.command = 'echo hi'

    output_dir = self.output_root / 'bare'
    with mock.patch('qaboard.runners.jenkins_windows.trigger_run', return_value={}):
      JenkinsWindowsRunner(BareRunContext(output_dir)).start(blocking=False)
    content = (output_dir / 'run.ps1').read_text()
    self.assertIn('$ErrorActionPreference = "Stop"', content)


class TestJenkinsTrigger(unittest.TestCase):
  def test_the_trigger_says_who_and_which_project(self):
    # Without a token, the server only starts the Jenkins jobs of the project's qaboard.yaml
    import requests
    from qaboard.runners import jenkins_windows
    answer = mock.MagicMock(status_code=200)
    answer.json.return_value = {"status": "pending", "url": "http://jenkins/queue/item/7/"}
    with mock.patch.object(requests, 'post', return_value=answer) as post, \
         mock.patch.object(jenkins_windows, 'get_jenkins_config', return_value={"build_url": "http://jenkins/job/windows", "token": None}), \
         mock.patch.object(jenkins_windows, 'api_headers', {"Content-Type": "application/json", "Authorization": "Bearer qab_pat_x"}), \
         mock.patch.object(jenkins_windows, 'project_name', return_value="group/repo"), \
         mock.patch.object(sys.modules['qaboard.config'], 'commit_id', "abc123"):
      jenkins_windows.trigger_run("echo hi")
    self.assertTrue(post.call_args.args[0].endswith("/jenkins/build/trigger/"))
    self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "Bearer qab_pat_x")
    data = post.call_args.kwargs["json"]
    self.assertEqual((data["project"], data["commit"], data["build_url"], data["params"]), ("group/repo", "abc123", "http://jenkins/job/windows", {"task": "echo hi"}))
    self.assertIn("token", data)


class TestJenkinsPolling(unittest.TestCase):
  POLL_ENV_VARS = ('QA_JENKINS_TIMEOUT', 'QA_JENKINS_STATUS_INTERVAL')

  def setUp(self):
    # env vars set in another test or in the environment must not leak into the defaults
    for var in self.POLL_ENV_VARS:
      os.environ.pop(var, None)
      self.addCleanup(os.environ.pop, var, None)

  def resolve(self, **kwargs):
    from qaboard.runners.jenkins_windows import resolve_poll_settings
    return resolve_poll_settings(**kwargs)

  def poll(self, statuses, **kwargs):
    # Monkeypatch build_status to go through `statuses` then stay on the last one,
    # and time.sleep so polling is instant.
    from qaboard.runners.jenkins_windows import poll_jenkins_status
    remaining = iter(statuses)
    with mock.patch('qaboard.runners.jenkins_windows.build_status', side_effect=lambda _: next(remaining, statuses[-1])), \
         mock.patch('qaboard.runners.jenkins_windows.time.sleep') as sleep:
      success = poll_jenkins_status({'url': 'http://jenkins/job/1/'}, **kwargs)
    return success, sleep

  def test_defaults(self):
    self.assertEqual(self.resolve(), (2 * 60 * 60, 30))

  def test_env_overrides_defaults(self):
    with mock.patch.dict(os.environ, {'QA_JENKINS_TIMEOUT': '600', 'QA_JENKINS_STATUS_INTERVAL': '10'}):
      self.assertEqual(self.resolve(), (600, 10))

  def test_params_override_env(self):
    with mock.patch.dict(os.environ, {'QA_JENKINS_TIMEOUT': '600', 'QA_JENKINS_STATUS_INTERVAL': '10'}):
      self.assertEqual(self.resolve(timeout_seconds=100, interval_seconds=5), (100, 5))

  def test_invalid_env_falls_back_to_defaults(self):
    from qaboard.runners.jenkins_windows import secho
    with mock.patch.dict(os.environ, {'QA_JENKINS_TIMEOUT': 'two hours', 'QA_JENKINS_STATUS_INTERVAL': ''}), mock.patch('qaboard.runners.jenkins_windows.secho') as secho:
      self.assertEqual(self.resolve(), (2 * 60 * 60, 30))
    self.assertTrue(any('QA_JENKINS_TIMEOUT' in str(call) for call in secho.call_args_list))

  def test_inf_env_falls_back_to_defaults(self):
    # int(float('inf')) raises OverflowError (not ValueError): it must be caught, falling back with a warning
    from qaboard.runners.jenkins_windows import secho
    with mock.patch.dict(os.environ, {'QA_JENKINS_TIMEOUT': 'inf', 'QA_JENKINS_STATUS_INTERVAL': 'nan'}), mock.patch('qaboard.runners.jenkins_windows.secho') as secho:
      self.assertEqual(self.resolve(), (2 * 60 * 60, 30))
    self.assertTrue(any('QA_JENKINS_TIMEOUT' in str(call) for call in secho.call_args_list))

  def test_inf_param_falls_back_to_defaults(self):
    from qaboard.runners.jenkins_windows import secho
    with mock.patch('qaboard.runners.jenkins_windows.secho') as secho:
      self.assertEqual(self.resolve(timeout_seconds=float('inf')), (2 * 60 * 60, 30))
    self.assertTrue(any('timeout_seconds' in str(call) for call in secho.call_args_list))

  def test_fractional_values_are_truncated_to_ints(self):
    with mock.patch('qaboard.runners.jenkins_windows.secho'):
      self.assertEqual(self.resolve(timeout_seconds=30.9, interval_seconds=10.2), (30, 10))
      # a positive fraction below 1 truncates to 0, which is invalid and falls back to the default
      self.assertEqual(self.resolve(interval_seconds=0.5), (2 * 60 * 60, 30))

  def test_running_then_success(self):
    success, sleep = self.poll(['running', 'success'])
    self.assertTrue(success)
    self.assertEqual(sleep.call_args_list, [mock.call(30)])

  def test_running_until_timeout(self):
    success, sleep = self.poll(['running'], timeout_seconds=90, interval_seconds=30)
    self.assertFalse(success)
    self.assertEqual(sleep.call_count, 3)
    sleep.assert_called_with(30)

  def test_logs_via_secho(self):
    from qaboard.runners.jenkins_windows import poll_jenkins_status
    with mock.patch('qaboard.runners.jenkins_windows.build_status', side_effect=['running', 'BLOCKED', 'success']), \
         mock.patch('qaboard.runners.jenkins_windows.time.sleep'), \
         mock.patch('qaboard.runners.jenkins_windows.secho') as secho:
      self.assertTrue(poll_jenkins_status({'url': 'http://jenkins/job/1/'}))
    secho_messages = [call[0][0] for call in secho.call_args_list]
    self.assertTrue(any('status: BLOCKED' in message for message in secho_messages))
    self.assertTrue(any('finished with status: success' in message for message in secho_messages))

  def wait_for(self, statuses, should_print_log=True):
    # Like self.poll, but through wait_for_build, capturing print_log, secho and any raised exception.
    from qaboard.runners.jenkins_windows import wait_for_build
    remaining = iter(statuses)
    with mock.patch('qaboard.runners.jenkins_windows.build_status', side_effect=lambda _: next(remaining, statuses[-1])) as build_status, \
         mock.patch('qaboard.runners.jenkins_windows.time.sleep'), \
         mock.patch('qaboard.runners.jenkins_windows.print_log') as print_log, \
         mock.patch('qaboard.runners.jenkins_windows.secho') as secho:
      raised = None
      try:
        wait_for_build({'web_url': 'http://jenkins/job/1/', 'url': 'http://jenkins/job/1/'}, should_print_log)
      except Exception as e:
        raised = e
    return build_status, print_log, secho, raised

  def test_wait_for_build_prints_log_when_asked(self):
    build_status, print_log, secho, raised = self.wait_for(['running', 'success'], should_print_log=True)
    self.assertIsNone(raised)
    print_log.assert_called_once_with('http://jenkins/job/1/consoleText')

  def test_wait_for_build_skips_log_when_not_asked(self):
    build_status, print_log, secho, raised = self.wait_for(['success'], should_print_log=False)
    self.assertIsNone(raised)
    print_log.assert_not_called()

  def test_wait_for_build_failure_raises_with_error_messages(self):
    build_status, print_log, secho, raised = self.wait_for(['running', 'failed'])
    self.assertIsNotNone(raised)
    messages = [str(call) for call in secho.call_args_list]
    self.assertTrue(any('[ERROR] There was an issue while waiting for the end of:' in m for m in messages))
    self.assertTrue(any('The job is marked as: failed' in m for m in messages))

  def test_wait_for_build_success_prints_no_error(self):
    build_status, print_log, secho, raised = self.wait_for(['success'])
    self.assertIsNone(raised)
    self.assertFalse(any('[ERROR]' in str(call) for call in secho.call_args_list))

  def test_wait_for_build_does_not_poll_again_after_the_loop(self):
    # regression: wait_for_build used to call build_status once more after the poll loop ended
    build_status, print_log, secho, raised = self.wait_for(['running', 'failed'])
    self.assertEqual(build_status.call_count, 2)

  def test_invalid_interval_env_warns(self):
    from qaboard.runners.jenkins_windows import secho
    with mock.patch.dict(os.environ, {'QA_JENKINS_STATUS_INTERVAL': 'nan'}), mock.patch('qaboard.runners.jenkins_windows.secho') as secho:
      self.assertEqual(self.resolve(), (2 * 60 * 60, 30))
    self.assertTrue(any('QA_JENKINS_STATUS_INTERVAL' in str(call) for call in secho.call_args_list))

  def test_non_positive_env_falls_back(self):
    from qaboard.runners.jenkins_windows import secho
    with mock.patch.dict(os.environ, {'QA_JENKINS_TIMEOUT': '0'}), mock.patch('qaboard.runners.jenkins_windows.secho') as secho:
      self.assertEqual(self.resolve(), (2 * 60 * 60, 30))
    self.assertTrue(any('QA_JENKINS_TIMEOUT' in str(call) for call in secho.call_args_list))

  def test_non_positive_params_fall_back(self):
    from qaboard.runners.jenkins_windows import secho
    with mock.patch('qaboard.runners.jenkins_windows.secho') as secho:
      self.assertEqual(self.resolve(timeout_seconds=0, interval_seconds=-5), (2 * 60 * 60, 30))
    messages = [str(call) for call in secho.call_args_list]
    self.assertTrue(any('timeout_seconds' in m for m in messages))
    self.assertTrue(any('interval_seconds' in m for m in messages))

  def test_non_numeric_params_fall_back(self):
    from qaboard.runners.jenkins_windows import secho
    with mock.patch('qaboard.runners.jenkins_windows.secho') as secho:
      self.assertEqual(self.resolve(timeout_seconds='two hours'), (2 * 60 * 60, 30))
    self.assertTrue(any('timeout_seconds' in str(call) for call in secho.call_args_list))


try:
  import distributed # noqa: F401
  has_dask = True
except ImportError:
  has_dask = False


class TestCelerySettings(unittest.TestCase):
  def test_passwords_come_from_the_environment(self):
    """qaboard.yaml is in git: broker URLs can read the password from the environment"""
    from qaboard.runners.celery_settings import celery_settings
    config = {"runners": {"celery": {
      "broker_url": "pyamqp://camera:${QA_CELERY_PASSWORD}@qaboard:5672/camera",
      "result_backend": "rpc://",
      "timezone": "$TZ_KEPT",
      "worker_concurrency": 4,
    }}}
    with mock.patch.dict(os.environ, {"QA_CELERY_PASSWORD": "secret", "TZ_KEPT": "x"}):
      settings = celery_settings(config)
    self.assertEqual(settings["broker_url"], "pyamqp://camera:secret@qaboard:5672/camera")
    self.assertEqual(settings["result_backend"], "rpc://")
    self.assertEqual(settings["timezone"], "$TZ_KEPT")
    self.assertEqual(settings["worker_concurrency"], 4)
    # the project's configuration isn't changed
    self.assertIn("${QA_CELERY_PASSWORD}", config["runners"]["celery"]["broker_url"])
    self.assertEqual(celery_settings({}), {})


class TestCleanOutputDir(unittest.TestCase):
  def test_removes_everything_when_not_redirected(self):
    import sys
    with tempfile.TemporaryDirectory() as tmp:
      output_dir = Path(tmp) / 'output'
      (output_dir / 'a').mkdir(parents=True)
      (output_dir / 'a' / 'b.txt').write_text('b')
      (output_dir / 'log.lsf.txt').write_text('old')
      code = f"from pathlib import Path; from qaboard.utils import clean_output_dir; clean_output_dir(Path('{output_dir}'))"
      # not redirected: neither stdout nor stderr is a file (they are when the tests' output is)
      subprocess.run([sys.executable, '-c', code], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
      self.assertFalse(output_dir.exists())

  def test_keeps_nested_redirected_logs(self):
    import sys
    with tempfile.TemporaryDirectory() as tmp:
      output_dir = Path(tmp) / 'output'
      (output_dir / 'logs').mkdir(parents=True)
      (output_dir / 'other').mkdir()
      (output_dir / 'other' / 'x.txt').write_text('x')
      (output_dir / 'logs' / 'y.txt').write_text('y')
      code = f"from pathlib import Path; from qaboard.utils import clean_output_dir; clean_output_dir(Path('{output_dir}')); print('ok')"
      with (output_dir / 'logs' / 'log.dask.txt').open('w') as log:
        subprocess.run([sys.executable, '-c', code], check=True, stdout=log, stderr=subprocess.STDOUT)
      self.assertEqual([str(p.relative_to(output_dir)) for p in output_dir.rglob('*')], ['logs', 'logs/log.dask.txt'])
      self.assertTrue((output_dir / 'logs' / 'log.dask.txt').read_text().endswith('ok\n'))


@unittest.skipUnless(has_dask, "requires the dask extra")
class TestDaskRunner(unittest.TestCase):
  def setUp(self):
    from distributed import LocalCluster
    self.cluster = LocalCluster(n_workers=2, threads_per_worker=3, processes=False, dashboard_address=None)
    self.addCleanup(self.cluster.close)
    self.tmp = tempfile.TemporaryDirectory()
    self.addCleanup(self.tmp.cleanup)
    self.root = Path(self.tmp.name)
    # other tests may leave us in a deleted directory
    self.addCleanup(os.chdir, Path(__file__).resolve().parent.parent)
    os.chdir(self.root)

  def test_concurrency(self):
    from qaboard.runners.dask_runner import DaskRunner
    # Each run records how many runs are in-flight when it starts
    counter = self.root / 'counter'
    commands = [
      f'echo start >> "{counter}"; grep -c start "{counter}" > started; grep -c end "{counter}" > ended; sleep 0.5; echo end >> "{counter}"; echo run-{i}'
      for i in range(7)
    ]
    commands = [f'mkdir -p output{i} && cd output{i} && {c}' for i, c in enumerate(commands)]
    jobs = make_jobs('dask', commands, self.root, scheduler_address=self.cluster.scheduler_address, concurrency=2)
    # runs last longer than the poll interval
    with mock.patch('qaboard.runners.dask_runner.poll_interval', 0.1):
      DaskRunner.start_jobs(jobs, jobs[0].run_context.job_options, blocking=True)
    for index, job in enumerate(jobs):
      output_dir = job.run_context.output_dir
      self.assertEqual((output_dir / 'log.dask.txt').read_text(), f'run-{index}\n')
      in_flight = int((output_dir / 'started').read_text()) - int((output_dir / 'ended').read_text())
      self.assertLessEqual(in_flight, 2)

  def test_groups_concurrency(self):
    """Batches can have their own concurrency. The workers are shared, with at most the largest concurrency in flight."""
    from qaboard.runners import JobGroup
    from qaboard.runners.dask_runner import DaskRunner
    total = self.root / 'total'
    def commands(name):
      counter = self.root / f'counter-{name}'
      return [
        f'mkdir -p {name}{i} && cd {name}{i} && echo start >> "{counter}" && echo start >> "{total}"; '
        f'grep -c start "{counter}" > started; grep -c end "{counter}" > ended; grep -c start "{total}" > total_started; grep -c end "{total}" > total_ended; '
        f'sleep 0.5; echo end >> "{counter}"; echo end >> "{total}"'
        for i in range(4)
      ]
    serial = make_jobs('dask', commands('serial'), self.root, scheduler_address=self.cluster.scheduler_address, concurrency=1)
    parallel = make_jobs('dask', commands('parallel'), self.root, scheduler_address=self.cluster.scheduler_address, concurrency=3)
    group = JobGroup(jobs=[*serial, *parallel], job_options=parallel[0].run_context.job_options)
    with mock.patch('qaboard.runners.dask_runner.poll_interval', 0.1):
      DaskRunner.start_groups(group.groups(), blocking=True)
    def in_flight(name, prefix=''):
      return [int((self.root / f'{name}{i}' / f'{prefix}started').read_text()) - int((self.root / f'{name}{i}' / f'{prefix}ended').read_text()) for i in range(4)]
    self.assertEqual(in_flight('serial'), [1, 1, 1, 1])
    self.assertTrue(all(n <= 3 for n in in_flight('parallel')))
    self.assertTrue(all(n <= 3 for n in in_flight('serial', 'total_') + in_flight('parallel', 'total_')))

  def test_subproject(self):
    """`qa` changes directory to the project root, and commands start with "cd {subproject}".
    job_options['cwd'] is where the user called `qa` from, e.g. the subproject: it must not be used."""
    from qaboard.runners.dask_runner import DaskRunner
    (self.root / 'PSP_2x').mkdir()
    jobs = make_jobs('dask', ['cd PSP_2x && pwd'], self.root, scheduler_address=self.cluster.scheduler_address, cwd=str(self.root / 'PSP_2x'))
    DaskRunner.start_jobs(jobs, jobs[0].run_context.job_options, blocking=True)
    log = (jobs[0].run_context.output_dir / 'log.dask.txt').read_text()
    self.assertEqual(Path(log.strip()).resolve(), (self.root / 'PSP_2x').resolve())

  def test_headless(self):
    """Runs don't open windows or X11 connections back to the submitter's display."""
    from qaboard.runners.dask_runner import DaskRunner
    jobs = make_jobs('dask', ['mkdir -p output && cd output && echo "display=${DISPLAY-unset} mpl=$MPLBACKEND"'], self.root, scheduler_address=self.cluster.scheduler_address)
    with mock.patch.dict(os.environ, {'DISPLAY': 'submitter:1', 'MPLBACKEND': 'TkAgg'}):
      DaskRunner.start_jobs(jobs, jobs[0].run_context.job_options, blocking=True)
    self.assertEqual((jobs[0].run_context.output_dir / 'log.dask.txt').read_text(), 'display=unset mpl=agg\n')

  def test_stop(self):
    import threading
    from qaboard.runners.dask_runner import DaskRunner
    jobs = make_jobs('dask', ['sleep 60'] * 4, self.root, scheduler_address=self.cluster.scheduler_address, concurrency=2)
    job_options = jobs[0].run_context.job_options
    exit_codes = []
    def batch():
      try:
        # signal handlers can only be set from the main thread
        with mock.patch('qaboard.runners.dask_runner.signal.signal'):
          DaskRunner.start_jobs(jobs, job_options, blocking=True)
      except SystemExit as e:
        exit_codes.append(e.code)
    thread = threading.Thread(target=batch)
    start = time.time()
    thread.start()
    time.sleep(3)
    DaskRunner.stop_jobs(jobs, job_options)
    thread.join(timeout=45)
    self.assertFalse(thread.is_alive())
    self.assertEqual(exit_codes, [1])
    self.assertLess(time.time() - start, 45)


  def test_no_wait_driver(self):
    """With --no-wait, we bsub a driver job. We run its script for real, against a local cluster."""
    import json
    from distributed import LocalCluster
    from qaboard.runners.dask_runner import DaskRunner
    batch_dir = self.root / 'batch'
    jobs = make_jobs('dask', [f'echo run-{i}' for i in range(3)], self.root, concurrency=2, batch_dir=str(batch_dir),
                     lsf={'queue': 'gpu_q', 'project': 'proj'}, driver={'queue': 'cpu_q', 'max_memory': 1000})
    job_options = jobs[0].run_context.job_options
    bsub = FakeBsub()
    with mock.patch('qaboard.runners.lsf.subprocess.run', bsub), has_bsub():
      DaskRunner.start_jobs(jobs, job_options, blocking=False)
    self.assertEqual(bsub.names(), ['abcdefgh_dask_driver'])
    command = bsub.commands[0]
    self.assertIn("-q 'cpu_q'", command)
    self.assertIn("-P 'proj'", command)
    self.assertIn('rusage[mem=1000]', command)
    logs_dir = batch_dir / 'dask' / 'abcdefgh'
    self.assertIn(f'-o "{logs_dir}/driver.lsf.log"', command)

    # Instead of starting LSF workers, the driver uses a local cluster
    tasks_path = logs_dir / 'tasks.json'
    data = json.loads(tasks_path.read_text())
    self.assertEqual(len(data['tasks']), 3)
    with LocalCluster(n_workers=1, threads_per_worker=2, processes=True, dashboard_address=None) as cluster:
      data['job_options']['scheduler_address'] = cluster.scheduler_address
      tasks_path.write_text(json.dumps(data))
      script = command.split('<< "EOF"\n', 1)[1].rsplit('\nEOF', 1)[0]
      out = subprocess.run(['bash', '-c', script], timeout=120)
    self.assertEqual(out.returncode, 0, (logs_dir / 'driver.log').read_text())
    self.assertIn('3 runs done, 0 failed', (logs_dir / 'driver.log').read_text())
    for index, job in enumerate(jobs):
      self.assertEqual((job.run_context.output_dir / 'log.dask.txt').read_text(), f'run-{index}\n')

  def test_no_wait_existing_cluster(self):
    """With --no-wait and an existing cluster, the driver job connects to it and enforces the concurrency."""
    import json
    from distributed import LocalCluster
    from qaboard.runners.dask_runner import DaskRunner
    counter = self.root / 'counter'
    commands = [
      f'mkdir -p output{i} && cd output{i} && echo start >> "{counter}"; grep -c start "{counter}" > started; grep -c end "{counter}" > ended; sleep 0.5; echo end >> "{counter}"'
      for i in range(5)
    ]
    with LocalCluster(n_workers=1, threads_per_worker=4, processes=True, dashboard_address=None) as cluster:
      batch_dir = self.root / 'batch'
      jobs = make_jobs('dask', commands, self.root, scheduler_address=cluster.scheduler_address, concurrency=2, batch_dir=str(batch_dir))
      bsub = FakeBsub()
      with mock.patch('qaboard.runners.lsf.subprocess.run', bsub), has_bsub(), mock.patch('qaboard.runners.dask_runner.shutil.which', return_value='/usr/bin/bsub'):
        DaskRunner.start_jobs(jobs, jobs[0].run_context.job_options, blocking=False)
      self.assertEqual(bsub.names(), ['abcdefgh_dask_driver'])
      logs_dir = batch_dir / 'dask' / 'abcdefgh'
      self.assertEqual(json.loads((logs_dir / 'tasks.json').read_text())['job_options']['scheduler_address'], cluster.scheduler_address)
      script = bsub.commands[0].split('<< "EOF"\n', 1)[1].rsplit('\nEOF', 1)[0]
      out = subprocess.run(['bash', '-c', script], timeout=120)
    self.assertEqual(out.returncode, 0, (logs_dir / 'driver.log').read_text())
    self.assertIn('5 runs done, 0 failed', (logs_dir / 'driver.log').read_text())
    for job in jobs:
      output_dir = job.run_context.output_dir
      in_flight = int((output_dir / 'started').read_text()) - int((output_dir / 'ended').read_text())
      self.assertLessEqual(in_flight, 2)

  def test_no_wait_existing_cluster_without_lsf(self):
    """Without LSF to send a driver, all runs are sent at once to the existing cluster."""
    from qaboard.runners.dask_runner import DaskRunner
    jobs = make_jobs('dask', [f'echo run-{i}' for i in range(3)], self.root, scheduler_address=self.cluster.scheduler_address, concurrency=1)
    with mock.patch.dict(os.environ, {'QA_RUNNERS_LSF_BRIDGE': ''}), mock.patch('qaboard.runners.dask_runner.shutil.which', return_value=None), \
         mock.patch('qaboard.runners.lsf.subprocess.run') as run, mock.patch('qaboard.runners.dask_runner.secho'):
      DaskRunner.start_jobs(jobs, jobs[0].run_context.job_options, blocking=False)
    run.assert_not_called()
    logs = [job.run_context.output_dir / 'log.dask.txt' for job in jobs]
    deadline = time.time() + 30
    while time.time() < deadline and not all(log.exists() and log.read_text() for log in logs):
      time.sleep(0.1)
    for index, log in enumerate(logs):
      self.assertEqual(log.read_text(), f'run-{index}\n')


if __name__ == '__main__':
  unittest.main()
