"""
Tests for the dask runner's clusters (runners.dask.cluster.type): their options, the --no-wait driver, stopping, `qa doctor`.
There is no LSF/Slurm/PBS... or Kubernetes here: we use fake submit/cancel commands on the PATH that record their calls,
run the driver job scripts they get with bash, and mock the Kubernetes API.
`local` clusters run for real.
"""
import os
import re
import sys
import json
import time
import tempfile
import unittest
import subprocess
from pathlib import Path
from unittest import mock

try:
  import distributed # noqa: F401
  import dask_jobqueue # noqa: F401
  has_dask = True
except ImportError:
  has_dask = False

try:
  import dask_kubernetes # noqa: F401
  has_dask_kubernetes = True
except ImportError:
  has_dask_kubernetes = False


def make_jobs(commands, output_root: Path, **job_options):
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
      job_options={"type": "dask", "command_id": "abcdefgh-1234", **job_options},
      output_dir=output_root / f'output{index}',
      command=command,
    )
    jobs.append(Job(run_context))
  return jobs


class FakeCommands():
  """Commands on the PATH that record how they were called, save the script they got, and print `output`."""
  def __init__(self, directory: Path):
    self.bin = directory / 'bin'
    self.bin.mkdir(parents=True)
    self.calls = directory / 'calls.txt'

  def add(self, name: str, output: str = '', exit_code: int = 0, script_from_stdin=False):
    path = self.bin / name
    path.write_text("\n".join([
      "#!/bin/sh",
      f'echo "{name} $*" >> "{self.calls}"',
      'for last; do :; done',
      # the script is a file (sbatch, qsub...), inline (oarsub), or on stdin (bsub)
      f'cat > "{self.bin}/{name}.script"' if script_from_stdin else
      f'if [ -f "$last" ]; then cat "$last" > "{self.bin}/{name}.script"; else printf "%s" "$last" > "{self.bin}/{name}.script"; fi',
      f"echo '{output}'",
      f"exit {exit_code}",
    ]))
    path.chmod(0o755)

  def script(self, name: str) -> str:
    return (self.bin / f'{name}.script').read_text()

  def called(self):
    return self.calls.read_text().splitlines() if self.calls.exists() else []

  def on_path(self):
    """Only our commands, and what python and the shell need"""
    return mock.patch.dict(os.environ, {"PATH": f"{self.bin}:{Path(sys.executable).parent}:/usr/bin:/bin", "QA_RUNNERS_LSF_BRIDGE": ""})


class TempDirTestCase(unittest.TestCase):
  def setUp(self):
    self.tmp = tempfile.TemporaryDirectory()
    self.addCleanup(self.tmp.cleanup)
    self.root = Path(self.tmp.name).resolve()
    # other tests may leave us in a deleted directory
    self.addCleanup(os.chdir, Path(__file__).resolve().parent.parent)
    os.chdir(self.root)
    self.fakes = FakeCommands(self.root)


@unittest.skipUnless(has_dask, "requires the dask extra")
class TestJobqueueClusters(TempDirTestCase):
  def test_lsf_defaults_unchanged(self):
    """The defaults come from runners.lsf, as before cluster.type existed."""
    from qaboard.runners.dask_runner import DaskOptions, jobqueue_kwargs
    options = DaskOptions(lsf={"queue": "gpu_q", "project": "proj", "resources": "select[gpu]", "max_memory": 8000, "options": "-x"})
    self.assertEqual(jobqueue_kwargs(options, 'lsf', 'abcdefgh_dask', self.root), {
      "job_name": "abcdefgh_dask",
      "queue": "gpu_q",
      "project": "proj",
      "cores": 1,
      "processes": 1,
      "memory": "8000MB",
      "job_directives_skip": ["#BSUB -W"],
      "job_extra_directives": ['-R "select[gpu]"', '-x'],
      "log_directory": str(self.root),
    })
    # `cluster` overrides them, and with a walltime we don't skip it
    options = DaskOptions(cluster={"type": "lsf", "cores": 4, "memory": "32GB", "walltime": "24:00"})
    kwargs = jobqueue_kwargs(options, 'lsf', 'abcdefgh_dask', self.root)
    self.assertEqual((kwargs['cores'], kwargs['memory'], kwargs['walltime']), (4, "32GB", "24:00"))
    self.assertNotIn('job_directives_skip', kwargs)
    self.assertNotIn('type', kwargs)

  def test_kwargs_per_scheduler(self):
    from qaboard.runners.dask_runner import DaskOptions, jobqueue_kwargs
    options = DaskOptions(cluster={"type": "slurm", "queue": "gpu", "account": "algo", "cores": 4, "job_name": "mine"}, lsf={"queue": "ignored"})
    self.assertEqual(jobqueue_kwargs(options, 'slurm', 'abcdefgh_dask', self.root), {
      "job_name": "abcdefgh_dask", # always ours, so that we can stop the jobs
      "queue": "gpu",
      "account": "algo",
      "cores": 4,
      "processes": 1,
      "memory": "4GB",
      "log_directory": str(self.root),
      "job_directives_skip": ["#SBATCH -t"],
    })
    kwargs = jobqueue_kwargs(DaskOptions(cluster={"type": "htcondor", "job_extra_directives": {"+Project": '"algo"'}}), 'htcondor', 'abcdefgh_dask', self.root)
    self.assertEqual(kwargs['job_extra_directives'], {"+Project": '"algo"', "batch_name": "abcdefgh_dask"})
    self.assertEqual(kwargs['disk'], "1GB")
    self.assertNotIn('job_name', kwargs)
    self.assertNotIn('job_directives_skip', jobqueue_kwargs(DaskOptions(cluster={"walltime": "01:00:00"}), 'pbs', 'abcdefgh_dask', self.root))

  def test_worker_job_scripts(self):
    """Each scheduler's workers are named "{prefix}_dask", log in the batch logs directory, and get as many jobs as needed."""
    import dask_jobqueue
    from qaboard.runners.dask_runner import DaskOptions, make_cluster, jobqueue_classes
    expected_headers = {
      'lsf': ['#BSUB -J abcdefgh_dask', '#BSUB -e {logs}/'],
      'slurm': ['#SBATCH -J abcdefgh_dask', '#SBATCH -e {logs}/abcdefgh_dask-%J.err'],
      'pbs': ['#PBS -N abcdefgh_dask', '#PBS -e {logs}/'],
      'sge': ['#$ -N abcdefgh_dask', '#$ -e {logs}/'],
      'htcondor': ['batch_name = abcdefgh_dask', 'LogDirectory = {logs}'],
      'oar': ['#OAR -n abcdefgh_dask'],
      'moab': ['#PBS -N abcdefgh_dask', '#PBS -e {logs}/'],
    }
    no_walltime = {'lsf': '#BSUB -W', 'slurm': '#SBATCH -t', 'pbs': 'walltime', 'sge': 'h_rt', 'moab': 'walltime'}
    logs = self.root / 'logs'
    for cluster_type, cluster_class in jobqueue_classes.items():
      with self.subTest(cluster_type):
        options = DaskOptions(concurrency=10, cluster={"type": cluster_type, "cores": 4, "processes": 2, "scheduler_options": {"dashboard_address": None}})
        with mock.patch.object(getattr(dask_jobqueue, cluster_class), 'scale') as scale, mock.patch('qaboard.runners.dask_runner.secho') as secho:
          cluster = make_cluster(options, "abcdefgh-1234", nb_runs=20, log_directory=logs)
        try:
          script = cluster.job_script()
        finally:
          cluster.close()
        for line in expected_headers[cluster_type]:
          self.assertIn(line.format(logs=logs), script)
        if cluster_type in no_walltime:
          self.assertNotIn(no_walltime[cluster_type], script)
        # 10 in flight, each job has 2 workers with 2 threads: 3 jobs
        scale.assert_called_once_with(jobs=3)
        self.assertIn('(4 runs each)', secho.call_args[0][0])

  def test_unknown_type(self):
    from qaboard.runners.dask_runner import DaskOptions, get_cluster_type
    self.assertEqual(get_cluster_type(DaskOptions()), 'lsf')
    self.assertEqual(get_cluster_type(DaskOptions(cluster_type='slurm')), 'slurm')
    self.assertEqual(get_cluster_type(DaskOptions(cluster={'type': 'SLURM'}, cluster_type='lsf')), 'slurm')
    with self.assertRaisesRegex(ValueError, 'Unknown runners.dask.cluster.type'):
      get_cluster_type(DaskOptions(cluster={'type': 'yarn'}))


@unittest.skipUnless(has_dask, "requires the dask extra")
class TestLocalCluster(TempDirTestCase):
  def test_runs(self):
    """3 real runs on a LocalCluster started by `qa batch`, at most 2 at the same time."""
    from qaboard.runners.dask_runner import DaskRunner
    counter = self.root / 'counter'
    commands = [
      f'mkdir -p output{i} && cd output{i} && echo start >> "{counter}"; grep -c start "{counter}" > started; grep -c end "{counter}" > ended; sleep 0.3; echo end >> "{counter}"; echo run-{i}'
      for i in range(3)
    ]
    jobs = make_jobs(commands, self.root, concurrency=2, cluster={"type": "local"}, batch_dir=str(self.root / 'batch'))
    with mock.patch('qaboard.runners.dask_runner.poll_interval', 0.1), mock.patch('qaboard.runners.dask_runner.signal.signal'):
      DaskRunner.start_jobs(jobs, jobs[0].run_context.job_options, blocking=True)
    for index, job in enumerate(jobs):
      output_dir = job.run_context.output_dir
      self.assertEqual((output_dir / 'log.dask.txt').read_text(), f'run-{index}\n')
      in_flight = int((output_dir / 'started').read_text()) - int((output_dir / 'ended').read_text())
      self.assertLessEqual(in_flight, 2)

  def test_worker_sizes(self):
    from qaboard.runners.dask_runner import DaskOptions, make_cluster
    with mock.patch('distributed.LocalCluster') as LocalCluster:
      make_cluster(DaskOptions(concurrency=10, cluster={"type": "local"}), "abcdefgh", nb_runs=4, log_directory=self.root)
      self.assertEqual(LocalCluster.call_args[1], {"n_workers": 1, "threads_per_worker": 4, "processes": False, "dashboard_address": None})
      make_cluster(DaskOptions(concurrency=10, cluster={"type": "local", "threads_per_worker": 3, "processes": True}), "abcdefgh", nb_runs=50, log_directory=self.root)
      self.assertEqual(LocalCluster.call_args[1], {"n_workers": 4, "threads_per_worker": 3, "processes": True, "dashboard_address": None})

  def test_no_wait(self):
    """The driver is a background process."""
    from qaboard.runners.dask_runner import DaskRunner
    batch_dir = self.root / 'batch'
    jobs = make_jobs([f'echo run-{i}' for i in range(3)], self.root, concurrency=2, cluster={"type": "local"}, batch_dir=str(batch_dir))
    with mock.patch.dict(os.environ, {"QA_TEST_FORWARDED": "yes"}):
      info = DaskRunner.start_jobs(jobs, jobs[0].run_context.job_options, blocking=False)
    logs_dir = batch_dir / 'dask' / 'abcdefgh'
    self.assertEqual((logs_dir / 'driver.pid').read_text().strip(), str(info['pid']))
    tasks = json.loads((logs_dir / 'tasks.json').read_text())
    self.assertEqual(tasks['env']['QA_TEST_FORWARDED'], 'yes')
    self.assertEqual(oct((logs_dir / 'tasks.json').stat().st_mode & 0o777), oct(0o600))
    deadline = time.time() + 60
    while time.time() < deadline and '3 runs done' not in (logs_dir / 'driver.log').read_text():
      time.sleep(0.2)
    self.assertIn('3 runs done, 0 failed', (logs_dir / 'driver.log').read_text())
    for index, job in enumerate(jobs):
      self.assertEqual((job.run_context.output_dir / 'log.dask.txt').read_text(), f'run-{index}\n')


@unittest.skipUnless(has_dask, "requires the dask extra")
class TestDriver(TempDirTestCase):
  def run_driver_script(self, script: str, logs_dir: Path, nb_runs: int):
    """Runs the driver job script, with a local cluster instead of the scheduler's workers"""
    tasks_path = logs_dir / 'tasks.json'
    data = json.loads(tasks_path.read_text())
    data['job_options']['cluster'] = {"type": "local"}
    tasks_path.write_text(json.dumps(data))
    out = subprocess.run(['bash', '-c', script], timeout=120)
    self.assertEqual(out.returncode, 0, (logs_dir / 'driver.log').read_text())
    self.assertIn(f'{nb_runs} runs done, 0 failed', (logs_dir / 'driver.log').read_text())

  def test_slurm(self):
    """The driver job script comes from dask-jobqueue, with the workers' kwargs, cores=1, memory=2GB, and `driver`."""
    from qaboard.runners.dask_runner import DaskRunner
    self.fakes.add('sbatch', 'Submitted batch job 42')
    batch_dir = self.root / 'batch'
    jobs = make_jobs([f'echo run-{i}' for i in range(2)], self.root, batch_dir=str(batch_dir),
                     cluster={"type": "slurm", "queue": "gpu", "account": "algo", "cores": 8, "memory": "64GB", "job_extra_directives": ["--gres=gpu:1"]},
                     driver={"queue": "cpu", "job_extra_directives": []})
    with self.fakes.on_path():
      info = DaskRunner.start_jobs(jobs, jobs[0].run_context.job_options, blocking=False)
    self.assertEqual(info, {"job_id": "42"})
    logs_dir = batch_dir / 'dask' / 'abcdefgh'
    script = self.fakes.script('sbatch')
    for line in ['#SBATCH -J abcdefgh_dask_driver', f'#SBATCH -o {logs_dir}/abcdefgh_dask_driver-%J.out', '#SBATCH -p cpu', '#SBATCH -A algo', '#SBATCH --cpus-per-task=1', '#SBATCH --mem=2G']:
      self.assertIn(line, script)
    self.assertNotIn('gres', script)
    self.assertNotIn('#SBATCH -t', script)
    self.assertIn('-m qaboard.runners.dask_runner', script)
    self.run_driver_script(script, logs_dir, nb_runs=2)

  def test_other_schedulers(self):
    from qaboard.runners.dask_runner import DaskRunner
    cases = {
      # type: submit command, its output, the job id we parse, a line of the script
      'pbs': ('qsub', '12.pbs-server', '12', '#PBS -N abcdefgh_dask_driver'),
      'sge': ('qsub', 'Your job 13 ("abcdefgh_dask_driver") has been submitted', '13', '#$ -N abcdefgh_dask_driver'),
      'htcondor': ('condor_submit', '1 job(s) submitted to cluster 14.', '14.0', 'batch_name = abcdefgh_dask_driver'),
      'oar': ('oarsub', 'OAR_JOB_ID=15', '15', 'qaboard.runners.dask_runner'),
      'moab': ('msub', '16', '16', '#PBS -N abcdefgh_dask_driver'),
    }
    for cluster_type, (command, output, job_id, line) in cases.items():
      with self.subTest(cluster_type):
        self.fakes.add(command, output)
        jobs = make_jobs(['echo run'], self.root, batch_dir=str(self.root / cluster_type), cluster={"type": cluster_type})
        with self.fakes.on_path(), mock.patch('qaboard.runners.dask_runner.secho'):
          info = DaskRunner.start_jobs(jobs, jobs[0].run_context.job_options, blocking=False)
        self.assertEqual(info, {"job_id": job_id})
        self.assertIn(line, self.fakes.script(command))

  def test_submit_failure(self):
    from qaboard.runners.dask_runner import DaskRunner
    self.fakes.add('sbatch', 'sbatch: error: invalid partition specified: gpu', exit_code=1)
    jobs = make_jobs(['echo run'], self.root, batch_dir=str(self.root / 'batch'), cluster={"type": "slurm", "queue": "gpu"})
    with self.fakes.on_path(), self.assertRaisesRegex(Exception, 'invalid partition'):
      DaskRunner.start_jobs(jobs, jobs[0].run_context.job_options, blocking=False)

  def test_lsf_submit_detached(self):
    """The LSF driver goes through LsfRunner.submit_detached: its output in driver.lsf.log, the driver's in driver.log."""
    from qaboard.runners.lsf import LsfRunner
    self.fakes.add('bsub', 'Job <1234> is submitted to queue <cpu_q>.', script_from_stdin=True)
    log_file = self.root / 'logs' / 'detached.log'
    with self.fakes.on_path():
      info = LsfRunner.submit_detached('echo hello', 'abcdefgh_x', log_file, {"queue": "cpu_q", "command_id": "abcdefgh-1234"})
    self.assertEqual(info, {"lsf_job_id": "1234"})
    call = self.fakes.called()[0]
    self.assertIn('-J abcdefgh_x', call)
    self.assertIn(f'-o {log_file}', call)
    out = subprocess.run(['bash', '-c', self.fakes.script('bsub')], timeout=30)
    self.assertEqual(out.returncode, 0)
    # (and maybe a warning if the en_US.utf8 locale we ask for isn't installed)
    self.assertTrue(log_file.read_text().endswith('hello\n'), log_file.read_text())

  def test_kubernetes(self):
    """The driver is sent with the kubernetes runner's submit_detached, with runners.kubernetes and `driver` as its options."""
    from qaboard.runners import runners, BaseRunner
    from qaboard.runners.dask_runner import DaskRunner
    submitted = []
    class FakeKubernetesRunner(BaseRunner):
      type = 'kubernetes'
      @classmethod
      def submit_detached(cls, script, name, log_file, job_options):
        submitted.append((script, name, log_file, job_options))
        return {"kubernetes_job": "qa-abcdefgh-dask-driver", "namespace": "algo"}
    batch_dir = self.root / 'batch'
    jobs = make_jobs(['echo run'], self.root, batch_dir=str(batch_dir), cluster={"type": "kubernetes"},
                     kubernetes={"namespace": "algo", "image": "qa:1", "resources": {"cpu": 8}}, driver={"resources": {"cpu": 1}})
    with mock.patch.dict(runners, {'kubernetes': FakeKubernetesRunner}):
      info = DaskRunner.start_jobs(jobs, jobs[0].run_context.job_options, blocking=False)
    self.assertEqual(info['kubernetes_job'], 'qa-abcdefgh-dask-driver')
    script, name, log_file, job_options = submitted[0]
    logs_dir = batch_dir / 'dask' / 'abcdefgh'
    self.assertEqual(name, 'abcdefgh_dask_driver')
    self.assertEqual(log_file, logs_dir / 'driver.k8s.log')
    self.assertEqual(job_options, {"type": "kubernetes", "namespace": "algo", "image": "qa:1", "resources": {"cpu": 1}, "command_id": "abcdefgh-1234"})
    self.assertIn(f'python3 -m qaboard.runners.dask_runner "{logs_dir}/tasks.json"', script)
    self.assertIn(f'cd "{self.root}"', script)
    # pods keep the image's PATH, HOME...
    self.assertNotIn('PATH', json.loads((logs_dir / 'tasks.json').read_text())['env'])

    with mock.patch.dict(runners, clear=True), self.assertRaisesRegex(Exception, 'kubernetes runner is not available'):
      DaskRunner.start_jobs(jobs, jobs[0].run_context.job_options, blocking=False)

  def test_existing_cluster_without_scheduler(self):
    """With a scheduler_address but no sbatch here, all runs are sent at once."""
    from distributed import LocalCluster
    from qaboard.runners.dask_runner import DaskRunner
    with LocalCluster(n_workers=1, threads_per_worker=2, processes=False, dashboard_address=None) as cluster:
      jobs = make_jobs([f'echo run-{i}' for i in range(2)], self.root, cluster={"type": "slurm"}, scheduler_address=cluster.scheduler_address)
      with self.fakes.on_path(), mock.patch('qaboard.runners.dask_runner.secho') as secho:
        DaskRunner.start_jobs(jobs, jobs[0].run_context.job_options, blocking=False)
      self.assertIn('no Slurm to send a driver job', secho.call_args_list[0][0][0])
      logs = [job.run_context.output_dir / 'log.dask.txt' for job in jobs]
      deadline = time.time() + 30
      while time.time() < deadline and not all(log.exists() and log.read_text() for log in logs):
        time.sleep(0.1)
      for index, log in enumerate(logs):
        self.assertEqual(log.read_text(), f'run-{index}\n')


@unittest.skipUnless(has_dask, "requires the dask extra")
class TestStop(TempDirTestCase):
  """The server stops batches with few job options: type, command_id, bridge, cluster_type..."""
  def stop(self, **job_options):
    from qaboard.runners.dask_runner import DaskRunner
    DaskRunner.stop_jobs([], {"type": "dask", "command_id": "abcdefgh-1234", "bridge": "", **job_options})

  def test_jobqueue(self):
    cases = {
      'slurm': ({'scancel': ''}, ['scancel --name abcdefgh_dask', 'scancel --name abcdefgh_dask_driver']),
      'sge': ({'qdel': ''}, ['qdel abcdefgh_dask*']),
      'pbs': ({'qselect': '12.server', 'qdel': ''}, ['qselect -N abcdefgh_dask', 'qselect -N abcdefgh_dask_driver', 'qdel 12.server 12.server']),
      'moab': ({'qselect': '12.server', 'qdel': ''}, ['qselect -N abcdefgh_dask', 'qselect -N abcdefgh_dask_driver', 'qdel 12.server 12.server']),
      'oar': ({'oardel': ''}, ["oardel --sql job_name like 'abcdefgh_dask%'"]),
      'htcondor': ({'condor_rm': ''}, ['condor_rm -constraint JobBatchName =?= "abcdefgh_dask" || JobBatchName =?= "abcdefgh_dask_driver"']),
    }
    for cluster_type, (commands, expected_calls) in cases.items():
      with self.subTest(cluster_type):
        self.fakes.calls.unlink(missing_ok=True)
        for command, output in commands.items():
          self.fakes.add(command, output)
        with self.fakes.on_path(), mock.patch('qaboard.runners.dask_runner.secho'), mock.patch('builtins.print'):
          self.stop(cluster_type=cluster_type)
        self.assertEqual(self.fakes.called(), expected_calls)

  def test_pbs_nothing_to_stop(self):
    self.fakes.add('qselect', '')
    self.fakes.add('qdel', '')
    with self.fakes.on_path(), mock.patch('qaboard.runners.dask_runner.secho'), mock.patch('builtins.print'):
      self.stop(cluster_type='pbs')
    self.assertEqual(self.fakes.called(), ['qselect -N abcdefgh_dask', 'qselect -N abcdefgh_dask_driver'])

  def test_errors(self):
    # already gone: no error
    self.fakes.add('qdel', 'denied: job "abcdefgh_dask*" does not exist', exit_code=1)
    with self.fakes.on_path(), mock.patch('qaboard.runners.dask_runner.secho'), mock.patch('builtins.print'):
      self.stop(cluster_type='sge')
    # other errors are reported
    self.fakes.add('qdel', 'denied: not allowed', exit_code=1)
    with self.fakes.on_path(), mock.patch('qaboard.runners.dask_runner.secho'), mock.patch('builtins.print'), self.assertRaisesRegex(ValueError, 'not allowed'):
      self.stop(cluster_type='sge')
    # missing tools
    with self.fakes.on_path(), self.assertRaisesRegex(ValueError, '`scancel` not found'):
      self.stop(cluster_type='slurm')

  def test_lsf_and_local(self):
    """LSF: bkill by prefix, as before. Local: nothing to do, and we don't fail."""
    with mock.patch('qaboard.runners.lsf.subprocess.run') as run, mock.patch('qaboard.runners.lsf.secho'), mock.patch('builtins.print'):
      run.return_value = subprocess.CompletedProcess('', 0, stdout='Job <1> is being terminated', stderr='')
      self.stop()
    self.assertEqual(run.call_args[0][0], 'bkill -J "abcdefgh*"')
    with mock.patch('qaboard.runners.dask_runner.secho') as secho:
      self.stop(cluster_type='local')
    self.assertIn('driver.pid', secho.call_args[0][0])

  @unittest.skipUnless(has_dask_kubernetes, "requires the dask-kubernetes extra")
  def test_kubernetes(self):
    """Deletes the batch's DaskCluster(s) and Jobs."""
    from kubernetes.client.rest import ApiException # type: ignore
    clusters = {"items": [
      {"metadata": {"name": "qa-abcdefgh-dask", "labels": {"qaboard.io/command-id": "abcdefgh-1234"}}},
      {"metadata": {"name": "qa-12345678-dask", "labels": {"qaboard.io/command-id": "12345678-0000"}}},
      {"metadata": {"name": "someone-else"}},
    ]}
    job = mock.Mock()
    job.metadata.name = 'qa-abcdefgh-dask-driver'
    with mock.patch('qaboard.runners.dask_runner.kubernetes_api_client') as api_client, \
         mock.patch('kubernetes.client.CustomObjectsApi') as CustomObjectsApi, mock.patch('kubernetes.client.BatchV1Api') as BatchV1Api, \
         mock.patch('qaboard.runners.dask_runner.secho'):
      CustomObjectsApi.return_value.list_namespaced_custom_object.return_value = clusters
      BatchV1Api.return_value.list_namespaced_job.return_value.items = [job]
      self.stop(cluster_type='kubernetes', kubernetes={"namespace": "algo", "context": "prod"})
      api_client.assert_called_once_with('prod')
      CustomObjectsApi.return_value.delete_namespaced_custom_object.assert_called_once_with('kubernetes.dask.org', 'v1', 'algo', 'daskclusters', 'qa-abcdefgh-dask')
      BatchV1Api.return_value.list_namespaced_job.assert_called_once_with('algo', label_selector='qaboard.io/command-id=abcdefgh-1234')
      BatchV1Api.return_value.delete_namespaced_job.assert_called_once_with('qa-abcdefgh-dask-driver', 'algo', propagation_policy='Background')

      # Without the operator there is no DaskCluster to delete
      CustomObjectsApi.return_value.list_namespaced_custom_object.side_effect = ApiException(status=404)
      self.stop(cluster_type='kubernetes', kubernetes={"namespace": "algo"})


@unittest.skipUnless(has_dask_kubernetes, "requires the dask-kubernetes extra")
class TestKubernetesCluster(unittest.TestCase):
  def options(self, **kubernetes):
    from qaboard.runners.dask_runner import DaskOptions
    return DaskOptions(
      concurrency=5,
      cluster={"type": "kubernetes", "threads_per_worker": 2, "resource_timeout": 120},
      kubernetes={"image": "registry/qa:1", "namespace": "algo", **kubernetes},
    )

  def test_spec(self):
    from qaboard.runners.dask_runner import kubernetes_cluster_spec
    options = self.options(
      resources={"cpu": 4, "memory": "16Gi", "nvidia.com/gpu": 1},
      run_as={"uid": 1000, "gid": 100},
      mounts=[{"path": "/algo", "pvc": "algo-nfs"}, {"path": "/home", "nfs": {"server": "nas1", "path": "/export/home"}, "read_only": True}],
      env={"OMP_NUM_THREADS": 4},
      image_pull_secrets=["creds"],
      node_selector={"pool": "gpu"},
      tolerations=[{"key": "nvidia.com/gpu", "operator": "Exists"}],
    )
    spec, kwargs, threads, n_workers = kubernetes_cluster_spec(options, "abcdefgh-1234", nb_runs=5)
    self.assertEqual((threads, n_workers), (2, 3))
    self.assertEqual(kwargs, {"resource_timeout": 120, "namespace": "algo"})
    self.assertEqual(spec['metadata']['name'], 'qa-abcdefgh-dask')
    self.assertEqual(spec['metadata']['labels']['qaboard.io/command-id'], 'abcdefgh-1234')
    self.assertEqual(spec['metadata']['labels']['app.kubernetes.io/managed-by'], 'qaboard')
    worker, scheduler = spec['spec']['worker'], spec['spec']['scheduler']['spec']
    self.assertEqual(worker['replicas'], 3)
    container = worker['spec']['containers'][0]
    self.assertEqual(container['image'], 'registry/qa:1')
    self.assertEqual(container['args'][:4], ['dask', 'worker', '--nthreads', '2'])
    self.assertEqual(container['env'], [{"name": "OMP_NUM_THREADS", "value": "4"}])
    self.assertEqual(container['resources'], {
      "requests": {"cpu": "4", "memory": "16Gi", "nvidia.com/gpu": "1"},
      "limits": {"memory": "16Gi", "nvidia.com/gpu": "1"},
    })
    self.assertEqual(container['volumeMounts'], [{"name": "qa-mount-0", "mountPath": "/algo"}, {"name": "qa-mount-1", "mountPath": "/home", "readOnly": True}])
    self.assertEqual(worker['spec']['volumes'], [
      {"name": "qa-mount-0", "persistentVolumeClaim": {"claimName": "algo-nfs"}},
      {"name": "qa-mount-1", "nfs": {"server": "nas1", "path": "/export/home"}},
    ])
    self.assertEqual(worker['spec']['nodeSelector'], {"pool": "gpu"})
    self.assertEqual(worker['spec']['tolerations'], [{"key": "nvidia.com/gpu", "operator": "Exists"}])
    for pod in (worker['spec'], scheduler):
      self.assertEqual(pod['securityContext'], {"runAsUser": 1000, "runAsGroup": 100})
      self.assertEqual(pod['imagePullSecrets'], [{"name": "creds"}])
    # the scheduler doesn't need the workers' GPUs, nodes or files
    self.assertEqual(scheduler['containers'][0]['args'][:2], ['dask', 'scheduler'])
    self.assertEqual(scheduler['containers'][0]['resources'], {"requests": {"cpu": "1", "memory": "2Gi"}, "limits": {"memory": "2Gi"}})
    self.assertNotIn('nodeSelector', scheduler)
    self.assertNotIn('volumes', scheduler)

  def test_run_as(self):
    from qaboard.runners.dask_runner import kubernetes_cluster_spec, DaskOptions
    spec, *_ = kubernetes_cluster_spec(self.options(), "abcdefgh-1234", nb_runs=1)
    self.assertEqual(spec['spec']['worker']['spec']['securityContext']['runAsUser'], os.getuid())
    self.assertEqual(spec['spec']['worker']['spec']['securityContext']['runAsGroup'], os.getgid())
    spec, *_ = kubernetes_cluster_spec(self.options(run_as='image'), "abcdefgh-1234", nb_runs=1)
    self.assertNotIn('securityContext', spec['spec']['worker']['spec'])
    with self.assertRaisesRegex(ValueError, 'image'):
      kubernetes_cluster_spec(DaskOptions(cluster={"type": "kubernetes"}), "abcdefgh-1234", nb_runs=1)

  def test_make_cluster(self):
    from qaboard.runners.dask_runner import make_cluster
    with mock.patch('dask_kubernetes.operator.KubeCluster') as KubeCluster, mock.patch('qaboard.runners.dask_runner.secho'), \
         mock.patch('qaboard.runners.dask_runner.check_kubernetes_context') as check_context:
      make_cluster(self.options(context="prod"), "abcdefgh-1234", nb_runs=10, log_directory=Path())
    check_context.assert_called_once_with("prod")
    kwargs = KubeCluster.call_args[1]
    self.assertEqual(kwargs['namespace'], 'algo')
    self.assertEqual(kwargs['resource_timeout'], 120)
    self.assertTrue(kwargs['quiet'])
    # concurrency 5, 2 runs per worker
    self.assertEqual(kwargs['custom_cluster_spec']['spec']['worker']['replicas'], 3)

  def test_context(self):
    from qaboard.runners.dask_runner import check_kubernetes_context
    with mock.patch('kubernetes.config.list_kube_config_contexts', return_value=([], {"name": "dev"})):
      check_kubernetes_context("dev")
      check_kubernetes_context(None)
      with self.assertRaisesRegex(ValueError, 'use-context prod'):
        check_kubernetes_context("prod")


@unittest.skipUnless(has_dask, "requires the dask extra")
class TestDoctor(TempDirTestCase):
  def doctor(self, test_job=False, **job_options):
    from qaboard.runners.dask_runner import DaskRunner
    return {c.name: c for c in DaskRunner.doctor({"type": "dask", **job_options}, test_job=test_job)}

  def test_existing_cluster(self):
    from distributed import LocalCluster
    with LocalCluster(n_workers=2, threads_per_worker=3, processes=False, dashboard_address=None) as cluster:
      checks = self.doctor(test_job=True, scheduler_address=cluster.scheduler_address)
    check = checks[f'Dask: scheduler {cluster.scheduler_address}']
    self.assertEqual(check.status, 'ok', check)
    self.assertIn('2 worker(s), 6 thread(s)', check.message)
    test = checks['Dask: test job']
    self.assertIn(test.status, ('ok', 'warning'), test) # warning: `qa` may not be on the PATH of the tests
    self.assertIn('uid=', test.message)

  def test_unreachable_scheduler(self):
    checks = self.doctor(scheduler_address='tcp://127.0.0.1:1')
    self.assertEqual(checks['Dask: scheduler tcp://127.0.0.1:1'].status, 'error')
    self.assertIn('dask scheduler', checks['Dask: scheduler tcp://127.0.0.1:1'].fix)

  def test_local_test_job(self):
    checks = self.doctor(test_job=True, cluster={"type": "local"})
    self.assertEqual(checks['Dask: local cluster'].status, 'ok')
    self.assertIn(checks['Dask: test job'].status, ('ok', 'warning'), checks['Dask: test job'])
    self.assertIn(os.uname().nodename, checks['Dask: test job'].message)

  def test_jobqueue(self):
    with self.fakes.on_path():
      checks = self.doctor(cluster={"type": "slurm"})
    self.assertEqual(checks['Dask: dask-jobqueue installed'].status, 'ok')
    self.assertEqual(checks['Dask: `sbatch` available'].status, 'error')
    self.assertIn('login node', checks['Dask: `sbatch` available'].fix)
    self.assertNotIn('Dask: worker job options', checks)

    self.fakes.add('sbatch')
    with self.fakes.on_path():
      checks = self.doctor(cluster={"type": "slurm", "queue": "gpu"})
    self.assertEqual(checks['Dask: `sbatch` available'].status, 'ok')
    self.assertEqual(checks['Dask: worker job options'].status, 'ok')
    self.assertIn('#SBATCH -p gpu', checks['Dask: worker job options'].message)
    with self.fakes.on_path():
      checks = self.doctor(cluster={"type": "slurm", "not_an_option": 1})
    self.assertEqual(checks['Dask: worker job options'].status, 'error')
    self.assertIn('not_an_option', checks['Dask: worker job options'].message)

  def test_lsf_bridge(self):
    with self.fakes.on_path(), mock.patch.dict(os.environ, {"QA_RUNNERS_LSF_BRIDGE": "ssh bridge {bsub_command}"}):
      checks = self.doctor()
    self.assertEqual(checks['Dask: `bsub` available'].status, 'warning')

  def test_never_raises(self):
    checks = self.doctor(cluster={"type": "yarn"})
    self.assertEqual(checks['Dask: cluster type'].status, 'error')
    with mock.patch('qaboard.runners.dask_runner.get_cluster_type', side_effect=RuntimeError('boom')), \
         mock.patch('qaboard.runners.dask_runner.dict_to_DaskOptions', side_effect=RuntimeError('boom')):
      checks = self.doctor()
    self.assertEqual(checks['Dask'].status, 'error')
    self.assertIn('boom', checks['Dask'].message)
    with mock.patch('qaboard.runners.dask_runner.make_cluster', side_effect=RuntimeError('no cluster')):
      checks = self.doctor(test_job=True, cluster={"type": "local"})
    self.assertEqual(checks['Dask: test job'].status, 'error')

  @unittest.skipUnless(has_dask_kubernetes, "requires the dask-kubernetes extra")
  def test_kubernetes(self):
    from kubernetes.client.rest import ApiException # type: ignore
    def doctor(error=None, **kubernetes):
      with mock.patch('qaboard.runners.dask_runner.kubernetes_api_client'), mock.patch('kubernetes.client.CustomObjectsApi') as CustomObjectsApi, \
           mock.patch('qaboard.runners.dask_runner.check_kubernetes_context'):
        CustomObjectsApi.return_value.list_namespaced_custom_object.side_effect = error
        return self.doctor(cluster={"type": "kubernetes"}, kubernetes={"namespace": "algo", **kubernetes})
    name = 'Dask: DaskCluster resources in namespace algo'
    checks = doctor(image='qa:1')
    self.assertEqual(checks[name].status, 'ok')
    self.assertNotIn('Dask: image', checks)
    checks = doctor(ApiException(status=404))
    self.assertEqual(checks['Dask: image'].status, 'error')
    self.assertEqual(checks[name].status, 'error')
    self.assertIn('helm install', checks[name].fix)
    checks = doctor(ApiException(status=403), image='qa:1')
    self.assertIn('daskclusters', checks[name].fix)
    checks = doctor(ConnectionRefusedError('refused'), image='qa:1')
    self.assertEqual(checks[name].status, 'error')
    self.assertIn('kubectl get pods -n algo', checks[name].fix)


if __name__ == '__main__':
  unittest.main()
