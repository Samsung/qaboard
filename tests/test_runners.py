"""
Tests for the LSF concurrency limit and the dask runner.
LSF is not available: we check the bsub commands we would send, and execute the job array scripts with bash.
"""
import os
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


try:
  import distributed # noqa: F401
  has_dask = True
except ImportError:
  has_dask = False


class TestCleanOutputDir(unittest.TestCase):
  def test_removes_everything_when_not_redirected(self):
    import sys
    with tempfile.TemporaryDirectory() as tmp:
      output_dir = Path(tmp) / 'output'
      (output_dir / 'a').mkdir(parents=True)
      (output_dir / 'a' / 'b.txt').write_text('b')
      (output_dir / 'log.lsf.txt').write_text('old')
      code = f"from pathlib import Path; from qaboard.utils import clean_output_dir; clean_output_dir(Path('{output_dir}'))"
      subprocess.run([sys.executable, '-c', code], check=True, stdout=subprocess.DEVNULL)
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

  def test_subproject(self):
    """`qa` changes directory to the project root, and commands start with "cd {subproject}".
    job_options['cwd'] is where the user called `qa` from, e.g. the subproject: it must not be used."""
    from qaboard.runners.dask_runner import DaskRunner
    (self.root / 'PSP_2x').mkdir()
    jobs = make_jobs('dask', ['cd PSP_2x && pwd'], self.root, scheduler_address=self.cluster.scheduler_address, cwd=str(self.root / 'PSP_2x'))
    DaskRunner.start_jobs(jobs, jobs[0].run_context.job_options, blocking=True)
    log = (jobs[0].run_context.output_dir / 'log.dask.txt').read_text()
    self.assertEqual(Path(log.strip()).resolve(), (self.root / 'PSP_2x').resolve())

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


if __name__ == '__main__':
  unittest.main()
