"""What runs use of their machine: qaboard/system_metrics.py"""
import json
import os
import subprocess
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest import mock

from qaboard import system_metrics
from qaboard.system_metrics import Cgroup, GpuSample, Nvml, NvidiaSmi, Stat, SystemMetrics, job_cgroup, visible_gpus

MB = 1024 * 1024


class FakeGpus:
  """Answers like NvidiaSmi and Nvml: (GPUs, {uuid: {pid: bytes}})"""
  def __init__(self, gpus, processes=None, error=None):
    self.gpus, self.processes, self.error = gpus, processes or {}, error
    self.calls = 0

  def sample(self):
    self.calls += 1
    if self.error:
      raise self.error
    return [GpuSample(gpu) for gpu in self.gpus], self.processes


def gpu(index, uuid, utilization=50.0, used=1000, total=24000, power=100.0):
  return {'index': index, 'uuid': uuid, 'name': 'NVIDIA A100', 'utilization': utilization, 'memory_used': used * MB,
          'memory_total': total * MB, 'temperature': 60.0, 'power': power, 'power_limit': 300.0}


class TestSettings(unittest.TestCase):
  def test_enabled(self):
    self.assertTrue(system_metrics.enabled(None, environ={}))
    self.assertTrue(system_metrics.enabled({'outputs': None}, environ={}))
    self.assertFalse(system_metrics.enabled({'outputs': {'system_metrics': False}}, environ={}))
    # the environment wins, e.g. for one CI job
    self.assertTrue(system_metrics.enabled({'outputs': {'system_metrics': False}}, environ={'QA_SYSTEM_METRICS': '1'}))
    self.assertFalse(system_metrics.enabled({}, environ={'QA_SYSTEM_METRICS': 'off'}))

  def test_interval(self):
    self.assertEqual(system_metrics.interval({}), system_metrics.INTERVAL)
    self.assertEqual(system_metrics.interval({'QA_SYSTEM_METRICS_INTERVAL': '0.5'}), 0.5)
    self.assertEqual(system_metrics.interval({'QA_SYSTEM_METRICS_INTERVAL': '0.001'}), system_metrics.MIN_INTERVAL)
    self.assertEqual(system_metrics.interval({'QA_SYSTEM_METRICS_INTERVAL': 'often'}), system_metrics.INTERVAL)
    self.assertEqual(system_metrics.interval({'QA_SYSTEM_METRICS_INTERVAL': '-1'}), system_metrics.INTERVAL)

  def test_stat(self):
    stat = Stat()
    self.assertIsNone(stat.mean)
    for value in (1, None, 3, 2):
      stat.add(value)
    self.assertEqual((stat.peak, stat.mean, stat.last, stat.count), (3, 2, 2, 3))


class TestSampling(unittest.TestCase):
  def setUp(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.dir = Path(tmp.name)

  def test_the_memory_and_cpu_of_the_run_and_its_subprocesses(self):
    metrics = SystemMetrics(self.dir, interval=0.05, write_every=0.1, gpus=None, cgroup=None).start()
    # a subprocess that holds 200MB while it keeps a core busy
    code = "b = b'x' * (200 * 2**20)\nimport time\nt = time.time()\nwhile time.time() - t < 1: pass"
    subprocess.run([sys.executable, '-c', code], check=True)
    summary = metrics.stop()
    self.assertEqual(summary['version'], 1)
    self.assertGreater(summary['samples'], 3)
    self.assertGreaterEqual(summary['memory']['peak_mb'], 200)
    # the exact peak of the biggest process, when the run made it grow: an earlier test's subprocess may have been bigger
    if 'max_process_mb' in summary['memory']:
      self.assertGreaterEqual(summary['memory']['max_process_mb'], 200)
    self.assertGreater(summary['cpu']['peak_cores'], 0.5)
    self.assertGreater(summary['cpu']['time_s'], 0.5)
    self.assertEqual(summary['host']['cpus'], os.cpu_count())
    self.assertNotIn('gpus', summary)
    # the samples, for the web app's plots
    series = json.loads((self.dir / system_metrics.SERIES_FILE).read_text())
    self.assertEqual(series['format'], 'qaboard-series')
    self.assertLessEqual({'memory_mb', 'cpu_cores'}, set(series['series']))
    self.assertGreaterEqual(max(series['series']['memory_mb']['value']), 200)
    # bounded: no history of every point
    self.assertFalse((self.dir / 'system.series.jsonl').exists())
    self.assertEqual([p.name for p in self.dir.iterdir()], [system_metrics.SERIES_FILE])

  def test_the_biggest_process_before_the_run_doesnt_count(self):
    """e.g. a notebook's earlier cell, an earlier start_run() in the same process"""
    with mock.patch.object(system_metrics, 'max_process_rss', side_effect=[30000 * MB, 30000 * MB]):
      self.assertNotIn('max_process_mb', SystemMetrics(None, interval=60, gpus=None, cgroup=None).stop().get('memory', {}))
    with mock.patch.object(system_metrics, 'max_process_rss', side_effect=[300 * MB, 500 * MB]):
      self.assertEqual(SystemMetrics(None, interval=60, gpus=None, cgroup=None).stop()['memory']['max_process_mb'], 500)

  def test_cpu_rates_need_time_between_samples(self):
    """CPU times count in steps of 10ms: two samples a few ms apart would say hundreds of cores"""
    metrics = SystemMetrics(None, interval=5, gpus=None, cgroup=None)
    times = iter([(100.0, 0.0), (100.004, 0.01), (102.5, 2.5), (102.502, 2.52)])
    metrics.processes = mock.Mock()
    with mock.patch.object(system_metrics.time, 'time', side_effect=lambda: clock[0]):
      for now, cpu in times:
        clock = [now]
        metrics.processes.sample.return_value = (MB, cpu, {1})
        metrics.sample()
    summary = metrics.summary()['cpu']
    self.assertEqual(summary['peak_cores'], 1.0)
    # over the whole run: what it used by how long we measured
    self.assertEqual(summary['mean_cores'], round(2.52 / 2.502, 2))

  def test_stop_is_idempotent_and_the_summary_stays(self):
    metrics = SystemMetrics(None, interval=60, gpus=None, cgroup=None).start()
    first = metrics.stop()
    self.assertEqual(metrics.stop()['samples'], first['samples'])
    self.assertEqual(metrics.summary()['samples'], first['samples'])
    # not started again
    thread = metrics._thread
    metrics.start()
    self.assertIs(metrics._thread, thread)
    self.assertFalse(thread.is_alive())

  def test_never_raises(self):
    metrics = SystemMetrics(None, interval=60, gpus=FakeGpus([], error=OSError('no driver')), cgroup=None)
    metrics.processes = None
    metrics.sample()
    summary = metrics.stop()
    self.assertEqual(summary['samples'], 2)
    self.assertNotIn('peak_mb', summary.get('memory', {}))
    # GPUs that fail once aren't asked again
    self.assertIsNone(metrics._gpu_reader)

  def test_the_cgroup_of_the_job(self):
    cgroup = mock.Mock(spec=Cgroup)
    cgroup.current.return_value = 300 * MB
    cgroup.peak.return_value = 400 * MB
    cgroup.limit.return_value = 1024 * MB
    cgroup.working_set.return_value = 250 * MB
    cgroup.oom_kills.return_value = 0
    metrics = SystemMetrics(self.dir, interval=60, gpus=None, cgroup=cgroup)
    summary = metrics.stop()
    self.assertEqual((summary['memory']['cgroup_peak_mb'], summary['memory']['cgroup_limit_mb']), (400, 1024))
    # without the files' cache, like kubelet counts it
    self.assertEqual((summary['memory']['cgroup_working_set_peak_mb'], summary['memory']['oom_kills']), (250, 0))
    self.assertIn('cgroup_memory_mb', json.loads((self.dir / system_metrics.SERIES_FILE).read_text())['series'])
    # kernels before 5.19 don't say the peak: the samples' then
    cgroup.peak.return_value = None
    self.assertEqual(metrics.summary()['memory']['cgroup_peak_mb'], 300)


class TestGpus(unittest.TestCase):
  def sampled(self, reader, environ=None, container=False):
    with mock.patch.dict(os.environ, environ or {}, clear=False), mock.patch.object(system_metrics, 'in_container', return_value=container):
      if 'CUDA_VISIBLE_DEVICES' not in (environ or {}):
        os.environ.pop('CUDA_VISIBLE_DEVICES', None)
      metrics = SystemMetrics(None, interval=60, gpus=reader, cgroup=None)
      metrics.sample()
      metrics.sample()
      return metrics.summary()

  def test_visible_gpus(self):
    self.assertIsNone(visible_gpus({}))
    self.assertEqual(visible_gpus({'CUDA_VISIBLE_DEVICES': ''}), [])
    self.assertEqual(visible_gpus({'CUDA_VISIBLE_DEVICES': '2, 0'}), ['2', '0'])
    self.assertEqual(visible_gpus({'CUDA_VISIBLE_DEVICES': 'GPU-8f3a,1'}), ['GPU-8f3a', '1'])
    # CUDA stops at the first invalid one
    self.assertEqual(visible_gpus({'CUDA_VISIBLE_DEVICES': '1,-1,0'}), ['1'])
    self.assertEqual(visible_gpus({'CUDA_VISIBLE_DEVICES': 'NoDevFiles'}), [])
    # MIG instances: the GPUs the run's processes use
    self.assertIsNone(visible_gpus({'CUDA_VISIBLE_DEVICES': 'MIG-4b0a7f7c-3e2d-5a1b-9c8d-0123456789ab'}))

  def test_the_gpus_of_cuda_visible_devices(self):
    reader = FakeGpus([gpu(0, 'GPU-aaa', utilization=10), gpu(1, 'GPU-bbb', utilization=90)])
    summary = self.sampled(reader, {'CUDA_VISIBLE_DEVICES': '1'})
    self.assertEqual([g['index'] for g in summary['gpus']], [1])
    self.assertEqual(summary['gpus'][0]['utilization_mean'], 90)
    self.assertEqual(summary['gpus'][0]['memory_total_mb'], 24000)
    self.assertEqual(summary['gpus'][0]['power_limit_w'], 300)
    # by UUID, or its beginning
    self.assertEqual([g['uuid'] for g in self.sampled(reader, {'CUDA_VISIBLE_DEVICES': 'GPU-aa'})['gpus']], ['GPU-aaa'])
    # none: we don't even ask
    none = FakeGpus([gpu(0, 'GPU-aaa')])
    with mock.patch.object(system_metrics, 'gpu_reader', return_value=none):
      with mock.patch.dict(os.environ, {'CUDA_VISIBLE_DEVICES': ''}):
        metrics = SystemMetrics(None, interval=60, cgroup=None)
      metrics.sample()
    self.assertIsNone(metrics._gpu_reader)

  def test_a_containers_gpus_are_the_runs(self):
    reader = FakeGpus([gpu(0, 'GPU-aaa'), gpu(1, 'GPU-bbb')])
    self.assertEqual(len(self.sampled(reader, container=True)['gpus']), 2)

  def test_else_the_gpus_its_processes_use(self):
    """e.g. on a shared machine without CUDA_VISIBLE_DEVICES: the other GPUs are other people's"""
    reader = FakeGpus([gpu(0, 'GPU-aaa', used=30000), gpu(1, 'GPU-bbb')], processes={'GPU-aaa': {os.getpid(): 2048 * MB, 1: 9000 * MB}})
    summary = self.sampled(reader)
    self.assertEqual([g['index'] for g in summary['gpus']], [0])
    # the run's own memory on it, and everyone's
    self.assertEqual((summary['gpus'][0]['run_memory_peak_mb'], summary['gpus'][0]['memory_peak_mb']), (2048, 30000))

  def test_the_runs_memory_on_a_gpu_is_unknown_without_its_pids(self):
    """In a container, NVML gives the host's pids: not ours"""
    summary = self.sampled(FakeGpus([gpu(0, 'GPU-aaa', used=30000)], processes={'GPU-aaa': {1: 9000 * MB}}), container=True)
    self.assertNotIn('run_memory_peak_mb', summary['gpus'][0])
    self.assertEqual(summary['gpus'][0]['memory_peak_mb'], 30000)

  def test_the_gpus_in_the_series(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    with mock.patch.object(system_metrics, 'in_container', return_value=True):
      metrics = SystemMetrics(Path(tmp.name), interval=60, gpus=FakeGpus([gpu(0, 'GPU-aaa', used=512)], processes={'GPU-aaa': {os.getpid(): 256 * MB}}), cgroup=None)
      metrics.sample()
      metrics.stop()
    series = json.loads((Path(tmp.name) / system_metrics.SERIES_FILE).read_text())['series']
    self.assertLessEqual({'gpu0/utilization_percent', 'gpu0/memory_mb', 'gpu0/run_memory_mb', 'gpu0/temperature_c', 'gpu0/power_w'}, set(series))
    self.assertEqual(series['gpu0/memory_mb']['value'][0], 512)

  @unittest.skipIf(os.name == 'nt', "a shell script as nvidia-smi")
  def test_nvidia_smi(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    command = Path(tmp.name) / 'nvidia-smi'
    command.write_text('\n'.join([
      '#!/bin/sh',
      'case "$1" in',
      '  --query-gpu=*) echo "0, GPU-aaa, NVIDIA A100-SXM4-40GB, 87, 21000, 40960, 64, 250.5, 400.00"',
      '                 echo "1, GPU-bbb, NVIDIA A100-SXM4-40GB, [N/A], 0, 40960, 30, [Not Supported], 400.00" ;;',
      '  --query-compute-apps=*) echo "GPU-aaa, 1234, 20000" ;;',
      'esac',
    ]))
    command.chmod(0o755)
    gpus, processes = NvidiaSmi(str(command)).sample()
    self.assertEqual(len(gpus), 2)
    self.assertEqual((gpus[0]['index'], gpus[0]['uuid'], gpus[0]['name'], gpus[0]['utilization']), (0, 'GPU-aaa', 'NVIDIA A100-SXM4-40GB', 87))
    self.assertEqual((gpus[0]['memory_used'], gpus[0]['power'], gpus[0]['power_limit']), (21000 * MB, 250.5, 400))
    self.assertEqual((gpus[1]['utilization'], gpus[1]['power']), (None, None))
    self.assertEqual(processes, {'GPU-aaa': {1234: 20000 * MB}})
    command.write_text('#!/bin/sh\necho "NVIDIA-SMI has failed" >&2\nexit 9\n')
    with self.assertRaises(RuntimeError):
      NvidiaSmi(str(command)).sample()

  def test_nvml(self):
    def device(**values):
      return types.SimpleNamespace(**values)
    class Unsupported(Exception):
      pass
    def not_supported(handle):
      raise Unsupported()
    nvml = types.SimpleNamespace(
      NVML_TEMPERATURE_GPU=0,
      nvmlInit=mock.Mock(), nvmlShutdown=mock.Mock(),
      nvmlDeviceGetCount=lambda: 1,
      nvmlDeviceGetHandleByIndex=lambda index: f"handle{index}",
      nvmlDeviceGetUUID=lambda handle: b'GPU-aaa',
      nvmlDeviceGetName=lambda handle: 'NVIDIA H100',
      nvmlDeviceGetMemoryInfo=lambda handle: device(used=10 * MB, total=80 * MB),
      nvmlDeviceGetUtilizationRates=lambda handle: device(gpu=42, memory=10),
      nvmlDeviceGetTemperature=lambda handle, sensor: 55,
      nvmlDeviceGetPowerUsage=lambda handle: 123456,  # mW
      nvmlDeviceGetEnforcedPowerLimit=not_supported,
      nvmlDeviceGetComputeRunningProcesses=lambda handle: [device(pid=7, usedGpuMemory=5 * MB), device(pid=8, usedGpuMemory=None)],
    )
    reader = Nvml(nvml)
    gpus, processes = reader.sample()
    # a GPU we may not read: the others still count
    nvml.nvmlDeviceGetCount = lambda: 2
    def handle(index):
      if index == 1:
        raise Unsupported('NVML_ERROR_NO_PERMISSION')
      return 'handle0'
    nvml.nvmlDeviceGetHandleByIndex = handle
    self.assertEqual([g['uuid'] for g in reader.sample()[0]], ['GPU-aaa'])
    self.assertEqual(dict(gpus[0]), {'index': 0, 'uuid': 'GPU-aaa', 'name': 'NVIDIA H100', 'utilization': 42.0, 'memory_used': 10 * MB,
                                     'memory_total': 80 * MB, 'temperature': 55.0, 'power': 123.456, 'power_limit': None})
    self.assertEqual(processes, {'GPU-aaa': {7: 5 * MB, 8: 0.0}})
    reader.close()
    nvml.nvmlShutdown.assert_called_once()


class TestCgroups(unittest.TestCase):
  def setUp(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.root = Path(tmp.name) / 'cgroup'
    self.proc = Path(tmp.name) / 'proc-self-cgroup'

  def cgroup(self, lines, directory, files, environ, container=False):
    self.proc.write_text('\n'.join(lines) + '\n')
    directory.mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
      (directory / name).write_text(content)
    with mock.patch.object(system_metrics, 'in_container', return_value=container):
      return job_cgroup(self.proc, self.root, environ)

  def test_an_lsf_job_with_cgroups_v2(self):
    path = '/lsf/cluster/job.4242.1.1700000000'
    cgroup = self.cgroup([f'0::{path}'], self.root / path.lstrip('/'),
                         {'memory.current': str(100 * MB), 'memory.peak': str(200 * MB), 'memory.max': str(4096 * MB)}, {'LSB_JOBID': '4242'})
    self.assertEqual((cgroup.current(), cgroup.peak(), cgroup.limit()), (100 * MB, 200 * MB, 4096 * MB))
    # without the files' cache, and the kernel's kills
    directory = self.root / path.lstrip('/')
    (directory / 'memory.stat').write_text(f"anon {60 * MB}\nfile {40 * MB}\ninactive_file {30 * MB}\n")
    (directory / 'memory.events').write_text("low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\n")
    self.assertEqual((cgroup.working_set(100 * MB), cgroup.oom_kills()), (70 * MB, 1))
    # without a limit
    (self.root / path.lstrip('/') / 'memory.max').write_text('max\n')
    self.assertIsNone(cgroup.limit())

  def test_a_slurm_job_with_cgroups_v1(self):
    path = '/slurm/uid_1000/job_77/step_0'
    lines = ['12:pids:/whatever', f'4:memory:{path}', f'3:cpu,cpuacct:{path}']
    cgroup = self.cgroup(lines, self.root / 'memory' / path.lstrip('/'),
                         {'memory.usage_in_bytes': '1000', 'memory.max_usage_in_bytes': '2000', 'memory.limit_in_bytes': str(2 ** 63 - 4096)},
                         {'SLURM_JOB_ID': '77'})
    self.assertEqual((cgroup.version, cgroup.current(), cgroup.peak(), cgroup.limit()), (1, 1000, 2000, None))
    # the limit is on the job, not its step
    (self.root / 'memory' / 'slurm/uid_1000/job_77' / 'memory.limit_in_bytes').write_text(str(8192 * MB))
    self.assertEqual(cgroup.limit(), 8192 * MB)
    (self.root / 'memory' / 'slurm/uid_1000' / 'memory.limit_in_bytes').write_text('1')
    self.assertEqual(cgroup.limit(), 8192 * MB)  # above the job: not its own

  def test_a_slurm_job_with_cgroups_v2(self):
    path = '/system.slice/slurmstepd.scope/job_77/step_0/user/task_0'
    cgroup = self.cgroup([f'0::{path}'], self.root / path.lstrip('/'), {'memory.current': '10', 'memory.max': 'max'}, {'SLURM_JOB_ID': '77'})
    (self.root / 'system.slice/slurmstepd.scope/job_77' / 'memory.max').write_text(str(4096 * MB))
    self.assertEqual(cgroup.limit(), 4096 * MB)

  def test_a_container(self):
    cgroup = self.cgroup(['0::/'], self.root, {'memory.current': '10', 'memory.max': '20'}, {}, container=True)
    self.assertEqual((cgroup.current(), cgroup.limit(), cgroup.peak()), (10, 20, None))
    # in a pod without its own cgroup namespace
    path = '/kubepods.slice/kubepods-burstable.slice/cri-containerd-abc.scope'
    self.assertIsNotNone(self.cgroup([f'0::{path}'], self.root / path.lstrip('/'), {'memory.current': '10'}, {}))

  def test_not_the_jobs_own(self):
    """e.g. a desktop session's: it holds everything its user runs"""
    path = '/user.slice/user-1000.slice/session-2.scope'
    self.assertIsNone(self.cgroup([f'0::{path}'], self.root / path.lstrip('/'), {'memory.current': '10'}, {}))
    # the host's root cgroup, outside a container
    self.assertIsNone(self.cgroup(['0::/'], self.root, {'memory.current': '10'}, {}))
    # another LSF job's id doesn't count, even when it's part of a name
    self.assertIsNone(self.cgroup([f'0::{path}'], self.root / path.lstrip('/'), {'memory.current': '10'}, {'LSB_JOBID': '1000'}))
    self.assertIsNone(self.cgroup([f'0::{path}'], self.root / path.lstrip('/'), {'memory.current': '10'}, {'LSB_JOBID': '2'}))
    self.assertIsNone(self.cgroup(['0::/lsf/cluster/job.42420.1.1'], self.root / 'lsf/cluster/job.42420.1.1', {'memory.current': '10'}, {'LSB_JOBID': '4242'}))
    # no memory files: no memory controller
    path = '/lsf/cluster/job.5.1.1'
    self.assertIsNone(self.cgroup([f'0::{path}'], self.root / path.lstrip('/'), {}, {'LSB_JOBID': '5'}))
    self.assertIsNone(job_cgroup(self.proc.with_name('missing'), self.root, {}))


class TestIsolation(unittest.TestCase):
  def test_imports_nothing_from_qaboard_but_the_series(self):
    import ast
    tree = ast.parse(Path(system_metrics.__file__).read_text())
    imported = {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.level > 0}
    self.assertEqual(imported, {'series'})


class TestQaRun(unittest.TestCase):
  """`qa run` measures its run(), and says what it used with its heartbeats and its end"""
  def setUp(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.dir = Path(tmp.name)
    import qaboard.qa  # noqa: F401 (the module, not the `qa` command the package exports)
    self.qa = sys.modules['qaboard.qa']

  def run_context(self):
    return types.SimpleNamespace(obj={}, id=42, output_dir=self.dir)

  def test_the_end_of_the_run_says_what_it_used(self):
    qa = self.qa
    sent = []
    with mock.patch.object(qa, '_system_metrics', None), mock.patch.object(qa, '_reporter', None), mock.patch.object(qa, 'config', {}), \
         mock.patch.object(system_metrics, 'gpu_reader', return_value=None), mock.patch.object(system_metrics, 'job_cgroup', return_value=None), \
         mock.patch.dict(os.environ, {'QA_SYSTEM_METRICS_INTERVAL': '0.05'}), \
         mock.patch.object(qa, 'notify_qa_database', lambda **kwargs: sent.append(kwargs) or {'id': 42}):
      run_context = self.run_context()
      metrics = qa.start_system_metrics(run_context)
      self.assertIs(qa.start_system_metrics(run_context), metrics)  # one per run
      self.assertEqual(qa.resources_report(), {'resources': metrics.summary()})
      qa.stop_system_metrics()
      qa.notify_run_ended(run_context, metrics={}, data={'storage': 1})
    self.assertEqual(sent[0]['data']['storage'], 1)
    self.assertEqual(sent[0]['data']['resources'], metrics.summary())
    self.assertGreater(sent[0]['data']['resources']['memory']['peak_mb'], 0)
    self.assertTrue((self.dir / system_metrics.SERIES_FILE).exists())

  def test_turned_off(self):
    qa = self.qa
    sent = []
    with mock.patch.object(qa, '_system_metrics', None), mock.patch.object(qa, '_reporter', None), \
         mock.patch.object(qa, 'config', {'outputs': {'system_metrics': False}}), mock.patch.dict(os.environ, {}), \
         mock.patch.object(qa, 'notify_qa_database', lambda **kwargs: sent.append(kwargs) or {'id': 42}):
      os.environ.pop('QA_SYSTEM_METRICS', None)
      self.assertIsNone(qa.start_system_metrics(self.run_context()))
      self.assertEqual(qa.resources_report(), {})
      qa.stop_system_metrics()
      qa.notify_run_ended(self.run_context(), metrics={})
    self.assertNotIn('data', sent[0])
    self.assertEqual(list(self.dir.iterdir()), [])


if __name__ == '__main__':
  unittest.main()
