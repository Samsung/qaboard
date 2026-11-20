"""
What a run uses of its machine while it runs: memory, CPU and GPUs, sampled every few seconds by a thread of `qa run`
or `qaboard.start_run()`.

- The server gets a summary, small whatever the length of the run: peaks, means, the last values (`summary()`). It
  goes with every heartbeat (qaboard/heartbeat.py) and with the run's end, and the server keeps it as data.resources.
  A run its scheduler killed (e.g. for using too much memory) said what it used until its last heartbeat.
- The samples go to the run's folder, as series the web app plots: system.series.json, at most ~1000 points per
  series (qaboard/series.py). Nothing more in the database.

What we measure:
- memory: the resident memory (RSS) of the run's processes, its own and its subprocesses', summed: what schedulers
  like LSF count. Samples miss spikes shorter than the interval: at the end we also have the exact peak of the
  biggest process (getrusage). When the run has its own cgroup (a Kubernetes pod, an LSF or Slurm job with cgroups)
  we read the cgroup's peak and limit too: what the kernel kills the job for. Its usage counts the files' cache.
- cpu: how many cores the run's processes used, on average between samples (1.0 = one core busy).
- gpus: those the run may use: its container's, those in $CUDA_VISIBLE_DEVICES, else those its processes use.
  Their utilization, memory, temperature and power, and the GPU memory of the run's own processes. With NVML
  (`pip install nvidia-ml-py`), else nvidia-smi. Other runs may share a GPU: its utilization is everyone's.

Turned off with `outputs: {system_metrics: false}` in qaboard.yaml, or QA_SYSTEM_METRICS=0.
QA_SYSTEM_METRICS_INTERVAL sets how often we sample, in seconds (default 5).

Nothing here talks to the server, or imports from qaboard but the series' writer.
"""
import datetime
import os
import platform
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

SERIES_NAME = 'system'
# what the web app plots (qaboard/series.py)
SERIES_FILE = f"{SERIES_NAME}.series.json"
INTERVAL = 5.0  # seconds
# how often system.series.json is written: the storage is often shared over the network
WRITE_EVERY = 30.0  # seconds
# GPU queries that take longer stop GPU sampling: nvidia-smi can hang on a broken driver
GPU_TIMEOUT = 10.0  # seconds
VERSION = 1
MB = 1024 * 1024
OFF = ('0', 'false', 'no', 'off', 'none')


def enabled(config: Optional[dict] = None, environ=os.environ) -> bool:
  """`outputs.system_metrics` in qaboard.yaml (default: true), or $QA_SYSTEM_METRICS"""
  value = environ.get('QA_SYSTEM_METRICS')
  if value is None:
    value = ((config or {}).get('outputs') or {}).get('system_metrics', True)
  return str(value).strip().lower() not in OFF


def interval(environ=os.environ) -> float:
  try:
    value = float(environ.get('QA_SYSTEM_METRICS_INTERVAL') or INTERVAL)
  except ValueError:
    return INTERVAL
  return value if value > 0 else INTERVAL


def _iso(timestamp: float) -> str:
  return datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _mb(value: Optional[float]) -> Optional[float]:
  return None if value is None else round(value / MB, 1)


class Stat:
  """A value's peak, mean and last value, without keeping its samples"""
  __slots__ = ('peak', 'total', 'count', 'last')

  def __init__(self) -> None:
    self.peak: Optional[float] = None
    self.total = 0.0
    self.count = 0
    self.last: Optional[float] = None

  def add(self, value: Optional[float]) -> None:
    if value is None:
      return
    self.peak = value if self.peak is None else max(self.peak, value)
    self.total += value
    self.count += 1
    self.last = value

  @property
  def mean(self) -> Optional[float]:
    return self.total / self.count if self.count else None


def _round(value: Optional[float], digits: int = 1) -> Optional[float]:
  return None if value is None else round(value, digits)


def _compact(values: Dict[str, Any]) -> Dict[str, Any]:
  return {k: v for k, v in values.items() if v is not None}


# --- processes ---------------------------------------------------------------------------------------------------------
class ProcessTree:
  """The run's processes: its own and their subprocesses, found again at each sample"""
  def __init__(self, pid: int):
    import psutil
    self.psutil = psutil
    self.root = psutil.Process(pid)
    self.pid = pid

  def processes(self) -> List[Any]:
    try:
      return [self.root, *self.root.children(recursive=True)]
    except self.psutil.Error:
      return []

  def sample(self) -> Tuple[Optional[float], Optional[float], Set[int]]:
    """(RSS of all the processes in bytes, CPU time they used so far in seconds, their pids)"""
    rss, cpu, pids = 0.0, 0.0, set()
    for process in self.processes():
      try:
        with process.oneshot():
          rss += process.memory_info().rss
          times = process.cpu_times()
      except self.psutil.Error:  # it ended, or isn't ours
        continue
      pids.add(process.pid)
      # with the subprocesses that ended and that it waited for
      cpu += times.user + times.system + getattr(times, 'children_user', 0.0) + getattr(times, 'children_system', 0.0)
    if not pids:
      return None, None, pids
    return rss, cpu, pids


def max_process_rss() -> Optional[float]:
  """The peak RSS of the biggest of our processes, exact, in bytes: ours, or of a subprocess that ended (POSIX)"""
  try:
    import resource
  except ImportError:
    return None
  peak = max(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)
  # kilobytes on Linux, bytes on macOS
  return float(peak) if platform.system() == 'Darwin' else peak * 1024.0


# --- cgroups -----------------------------------------------------------------------------------------------------------
def _read_int(path: Path) -> Optional[int]:
  try:
    text = path.read_text().strip()
  except (OSError, ValueError):
    return None
  try:
    return int(text)
  except ValueError:  # "max": no limit
    return None


def in_container() -> bool:
  return Path('/.dockerenv').exists() or Path('/run/.containerenv').exists() or 'KUBERNETES_SERVICE_HOST' in os.environ


class Cgroup:
  """The memory of the run's cgroup, when the scheduler gave it its own: what the kernel kills the run for"""
  def __init__(self, directory: Path, version: int):
    self.directory = directory
    self.version = version

  def _file(self, v2: str, v1: str) -> Path:
    return self.directory / (v2 if self.version == 2 else v1)

  def current(self) -> Optional[int]:
    return _read_int(self._file('memory.current', 'memory.usage_in_bytes'))

  def peak(self) -> Optional[int]:
    """Since the cgroup was created. Linux 5.19+ with cgroups v2"""
    return _read_int(self._file('memory.peak', 'memory.max_usage_in_bytes'))

  def limit(self) -> Optional[int]:
    limit = _read_int(self._file('memory.max', 'memory.limit_in_bytes'))
    # cgroups v1 say "no limit" with a huge number
    return limit if limit is not None and limit < 2 ** 60 else None


def job_cgroup(proc_cgroup: Path = Path('/proc/self/cgroup'), root: Path = Path('/sys/fs/cgroup'), environ=os.environ) -> Optional[Cgroup]:
  """
  The run's cgroup, if it's the job's own: a container's (its cgroup is "/" in its namespace, or under kubepods),
  an LSF job's (its path has the job's id), a Slurm job's (job_<id>). Else None: e.g. a desktop session's cgroup
  holds everything its user runs.
  """
  try:
    lines = proc_cgroup.read_text().splitlines()
  except OSError:
    return None
  found: Optional[Tuple[str, int]] = None
  for line in lines:
    parts = line.split(':', 2)
    if len(parts) != 3:
      continue
    hierarchy, controllers, path = parts
    if hierarchy == '0' and controllers == '':
      found = found or (path, 2)
    elif 'memory' in controllers.split(','):
      found = (path, 1)  # cgroups v1 has the memory controller: it's the one that counts
  if found is None:
    return None
  path, version = found
  markers = ['kubepods']
  if environ.get('LSB_JOBID'):
    markers.append(environ['LSB_JOBID'])
  if environ.get('SLURM_JOB_ID'):
    markers.append(f"job_{environ['SLURM_JOB_ID']}")
  own = (path == '/' and in_container()) or any(marker in path for marker in markers)
  if not own:
    return None
  directory = (root if version == 2 else root / 'memory') / path.lstrip('/')
  cgroup = Cgroup(directory, version)
  return cgroup if cgroup.current() is not None else None


# --- GPUs ---------------------------------------------------------------------------------------------------------------
class GpuSample(dict):
  """index, uuid, name, utilization (%), memory_used and memory_total (bytes), temperature (°C), power and power_limit (W)"""


def visible_gpus(environ=os.environ) -> Optional[List[str]]:
  """
  The GPUs the run may use, from $CUDA_VISIBLE_DEVICES: their indexes or UUIDs (or UUIDs' beginnings). [] for none.
  None when it doesn't say: in a container, they're all the run's, else those its processes use.
  Indexes are in the order CUDA counts GPUs, the fastest first unless CUDA_DEVICE_ORDER=PCI_BUS_ID, and NVML in
  the PCI order: the same on most machines, whose GPUs are all the same model.
  """
  value = environ.get('CUDA_VISIBLE_DEVICES')
  if value is None:
    return None
  tokens = [token.strip() for token in value.split(',') if token.strip()]
  # CUDA stops at the first invalid one
  valid = []
  for token in tokens:
    if token in ('-1', 'NoDevFiles') or token.lower() == 'none' or token.startswith('MIG-'):
      break
    valid.append(token)
  return valid


def _number(text: str) -> Optional[float]:
  try:
    return float(text)
  except ValueError:  # "[N/A]", "[Not Supported]"
    return None


class NvidiaSmi:
  """GPUs from `nvidia-smi --query-...`: an extra process at each sample"""
  QUERY = 'index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit'

  def __init__(self, command: str):
    self.command = command

  def _query(self, *args: str) -> List[List[str]]:
    out = subprocess.run([self.command, *args, '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=GPU_TIMEOUT)
    if out.returncode != 0:
      raise RuntimeError(out.stderr.strip() or f"nvidia-smi exited with {out.returncode}")
    return [[cell.strip() for cell in line.split(',')] for line in out.stdout.splitlines() if line.strip()]

  def sample(self) -> Tuple[List[GpuSample], Dict[str, Dict[int, float]]]:
    """The GPUs, and the memory of the processes that use them: {uuid: {pid: bytes}}"""
    gpus = []
    for row in self._query(f'--query-gpu={self.QUERY}'):
      if len(row) < 9:
        continue
      index, uuid, name, utilization, used, total, temperature, power, limit = row[:9]
      gpus.append(GpuSample(
        index=int(index), uuid=uuid, name=name, utilization=_number(utilization),
        memory_used=None if _number(used) is None else _number(used) * MB,  # type: ignore[operator]
        memory_total=None if _number(total) is None else _number(total) * MB,  # type: ignore[operator]
        temperature=_number(temperature), power=_number(power), power_limit=_number(limit),
      ))
    processes: Dict[str, Dict[int, float]] = {}
    try:
      rows = self._query('--query-compute-apps=gpu_uuid,pid,used_memory')
    except Exception:
      rows = []
    for row in rows:
      if len(row) >= 3 and _number(row[1]) is not None:
        memory = _number(row[2])
        processes.setdefault(row[0], {})[int(row[1])] = (memory or 0.0) * MB
    return gpus, processes


class Nvml:
  """GPUs from NVML (`pip install nvidia-ml-py`, imported as pynvml): no extra process"""
  def __init__(self, nvml: Any):
    self.nvml = nvml
    nvml.nvmlInit()

  @staticmethod
  def _text(value: Any) -> str:
    return value.decode() if isinstance(value, bytes) else str(value)

  def _try(self, call: Callable[[], Any]) -> Any:
    try:
      return call()
    except Exception:  # NVMLError_NotSupported...
      return None

  def sample(self) -> Tuple[List[GpuSample], Dict[str, Dict[int, float]]]:
    nvml = self.nvml
    gpus: List[GpuSample] = []
    processes: Dict[str, Dict[int, float]] = {}
    for index in range(nvml.nvmlDeviceGetCount()):
      handle = nvml.nvmlDeviceGetHandleByIndex(index)
      uuid = self._text(nvml.nvmlDeviceGetUUID(handle))
      memory = self._try(lambda: nvml.nvmlDeviceGetMemoryInfo(handle))
      utilization = self._try(lambda: nvml.nvmlDeviceGetUtilizationRates(handle))
      power = self._try(lambda: nvml.nvmlDeviceGetPowerUsage(handle))
      limit = self._try(lambda: nvml.nvmlDeviceGetEnforcedPowerLimit(handle))
      gpus.append(GpuSample(
        index=index, uuid=uuid, name=self._text(self._try(lambda: nvml.nvmlDeviceGetName(handle)) or ''),
        utilization=None if utilization is None else float(utilization.gpu),
        memory_used=None if memory is None else float(memory.used),
        memory_total=None if memory is None else float(memory.total),
        temperature=self._try(lambda: float(nvml.nvmlDeviceGetTemperature(handle, nvml.NVML_TEMPERATURE_GPU))),
        power=None if power is None else power / 1000.0, power_limit=None if limit is None else limit / 1000.0,
      ))
      for process in self._try(lambda: nvml.nvmlDeviceGetComputeRunningProcesses(handle)) or []:
        processes.setdefault(uuid, {})[int(process.pid)] = float(getattr(process, 'usedGpuMemory', None) or 0.0)
    return gpus, processes

  def close(self) -> None:
    try:
      self.nvml.nvmlShutdown()
    except Exception:
      pass


def gpu_reader() -> Optional[Any]:
  """How we read GPUs here: NVML, nvidia-smi, or None when there are none"""
  try:
    import pynvml  # type: ignore[import-not-found]
    return Nvml(pynvml)
  except Exception:  # not installed, or no driver
    pass
  command = shutil.which('nvidia-smi')
  return NvidiaSmi(command) if command else None


class GpuStats:
  """What a GPU did while the run ran"""
  def __init__(self, gpu: GpuSample):
    self.index, self.uuid, self.name = gpu['index'], gpu['uuid'], gpu['name']
    self.memory_total = gpu.get('memory_total')
    self.power_limit = gpu.get('power_limit')
    self.utilization, self.memory, self.run_memory = Stat(), Stat(), Stat()
    self.temperature, self.power = Stat(), Stat()

  def add(self, gpu: GpuSample, run_memory: Optional[float]) -> None:
    self.utilization.add(gpu.get('utilization'))
    self.memory.add(gpu.get('memory_used'))
    self.run_memory.add(run_memory)
    self.temperature.add(gpu.get('temperature'))
    self.power.add(gpu.get('power'))
    self.memory_total = gpu.get('memory_total') or self.memory_total
    self.power_limit = gpu.get('power_limit') or self.power_limit

  def summary(self) -> Dict[str, Any]:
    return _compact({
      "index": self.index, "uuid": self.uuid, "name": self.name or None,
      "utilization_mean": _round(self.utilization.mean), "utilization_peak": _round(self.utilization.peak),
      "memory_peak_mb": _mb(self.memory.peak), "memory_total_mb": _mb(self.memory_total),
      # the memory of the run's own processes: other runs may share the GPU
      "run_memory_peak_mb": _mb(self.run_memory.peak),
      "temperature_peak_c": _round(self.temperature.peak), "power_mean_w": _round(self.power.mean),
      "power_limit_w": _round(self.power_limit),
    })


# --- the sampler -------------------------------------------------------------------------------------------------------
class SystemMetrics:
  """
  Samples what the process `pid` and its subprocesses use, every `interval` seconds, from `start()` to `stop()`.
  `output_dir`: where system.series.json is written, None for none. Thread-safe. Never raises once created:
  what can't be measured here is left out.
  """
  def __init__(self, output_dir: Optional[Path] = None, pid: Optional[int] = None, interval: float = INTERVAL,
               write_every: float = WRITE_EVERY, gpus: Any = 'auto', cgroup: Any = 'auto'):
    self.interval = interval
    self.write_every = write_every
    self._lock = threading.Lock()
    self._stop = threading.Event()
    self._thread: Optional[threading.Thread] = None
    self._stopped = False
    self.started_at = time.time()
    self.updated_at: Optional[float] = None
    self.samples = 0
    self.memory, self.cpu, self.cgroup_memory = Stat(), Stat(), Stat()
    self.cpu_time: Optional[float] = None
    self.max_process_rss: Optional[float] = None
    self.gpus: Dict[str, GpuStats] = {}
    self._gpus_used: Set[str] = set()  # those our processes used, when we don't know which are the run's
    self._last_cpu: Optional[Tuple[float, float]] = None
    self._last_write = 0.0
    self._visible = visible_gpus()
    try:
      self.processes: Optional[ProcessTree] = ProcessTree(pid or os.getpid())
    except Exception:
      self.processes = None
    self.cgroup = job_cgroup() if cgroup == 'auto' else cgroup
    self.cgroup_limit = self.cgroup.limit() if self.cgroup is not None else None
    self._gpu_reader = (gpu_reader() if self._visible != [] else None) if gpus == 'auto' else gpus
    self._series: Any = None
    if output_dir is not None:
      from .series import SeriesWriter
      try:
        self._series = SeriesWriter(output_dir, name=SERIES_NAME, history=False)
      except Exception:
        self._series = None
    self.host = _compact({"name": socket.gethostname(), "cpus": os.cpu_count(), "memory_mb": self._host_memory()})

  def _host_memory(self) -> Optional[float]:
    try:
      import psutil
      return _mb(psutil.virtual_memory().total)
    except Exception:
      return None

  # --- lifecycle ---------------------------------------------------------------------------------------------------
  def start(self) -> 'SystemMetrics':
    with self._lock:
      if self._thread is None and not self._stopped:
        self._thread = threading.Thread(target=self._loop, name='qaboard-system-metrics', daemon=True)
        self._thread.start()
    return self

  def stop(self) -> Dict[str, Any]:
    """The last sample, then system.series.json is written for the last time. Returns the summary. Idempotent"""
    with self._lock:
      already = self._stopped
      self._stopped = True
    if not already:
      self._stop.set()
      # quick: LSF sends SIGKILL a few seconds after SIGTERM, and our caller still has to tell the server
      if self._thread is not None and self._thread is not threading.current_thread():
        self._thread.join(timeout=2.0)
      # the processes, not the GPUs: nvidia-smi can be slow, and their last samples tell the same
      self.sample(gpus=False)
      with self._lock:
        self.max_process_rss = max_process_rss()
        self._write(force=True)
        if self._series is not None:
          try:
            self._series.close()
          except Exception:
            pass
        if isinstance(self._gpu_reader, Nvml):
          self._gpu_reader.close()
    return self.summary()

  def _loop(self) -> None:
    self.sample()
    while not self._stop.wait(self.interval):
      self.sample()

  # --- sampling ----------------------------------------------------------------------------------------------------
  def sample(self, gpus: bool = True) -> None:
    """Measures once. Never raises"""
    try:
      self._sample(gpus)
    except Exception:
      pass

  def _sample(self, with_gpus: bool = True) -> None:
    now = time.time()
    rss, cpu_time, pids = self.processes.sample() if self.processes is not None else (None, None, set())
    cgroup_memory = None
    if self.cgroup is not None:
      cgroup_memory = self.cgroup.current()
    gpus, gpu_processes = self._sample_gpus() if with_gpus else ([], {})
    with self._lock:
      values: Dict[str, float] = {}
      if rss is not None:
        self.memory.add(rss)
        values['memory_mb'] = rss / MB
      if cpu_time is not None:
        if self._last_cpu is not None and now > self._last_cpu[0]:
          # subprocesses that ended without being waited for take their time with them: never below 0
          cores = max(0.0, (cpu_time - self._last_cpu[1]) / (now - self._last_cpu[0]))
          self.cpu.add(cores)
          values['cpu_cores'] = cores
        self._last_cpu = (now, cpu_time)
        self.cpu_time = cpu_time if self.cpu_time is None else max(self.cpu_time, cpu_time)
      if cgroup_memory is not None:
        self.cgroup_memory.add(cgroup_memory)
        values['cgroup_memory_mb'] = cgroup_memory / MB
      for gpu in gpus:
        ours = gpu_processes.get(gpu['uuid'], {})
        run_memory = sum(memory for pid, memory in ours.items() if pid in pids)
        if run_memory or any(pid in pids for pid in ours):
          self._gpus_used.add(gpu['uuid'])
        if not self._is_runs(gpu):
          continue
        stats = self.gpus.get(gpu['uuid'])
        if stats is None:
          stats = self.gpus[gpu['uuid']] = GpuStats(gpu)
        stats.add(gpu, run_memory)
        prefix = f"gpu{gpu['index']}"
        for key, value in (('utilization_percent', gpu.get('utilization')), ('memory_mb', gpu.get('memory_used')),
                           ('run_memory_mb', run_memory), ('temperature_c', gpu.get('temperature')), ('power_w', gpu.get('power'))):
          if value is not None:
            values[f"{prefix}/{key}"] = value / MB if key.endswith('memory_mb') else value
      self.samples += 1
      self.updated_at = now
      if values and self._series is not None:
        try:
          self._series.append(values, time=now)
        except Exception:
          self._series = None
      self._write()

  def _sample_gpus(self) -> Tuple[List[GpuSample], Dict[str, Dict[int, float]]]:
    reader = self._gpu_reader
    if reader is None:
      return [], {}
    try:
      return reader.sample()
    except Exception:
      # no driver, a hung nvidia-smi...: we don't try again
      self._gpu_reader = None
      return [], {}

  def _is_runs(self, gpu: GpuSample) -> bool:
    """Whether the run may use the GPU (visible_gpus), or used it"""
    if gpu['uuid'] in self._gpus_used:
      return True
    if self._visible is None:
      return in_container()
    return any(token == str(gpu['index']) or (not token.isdigit() and gpu['uuid'].startswith(token)) for token in self._visible)

  def _write(self, force: bool = False) -> None:
    """Writes system.series.json every `write_every` seconds. Callers hold the lock"""
    if self._series is None:
      return
    now = time.time()
    if not force and now - self._last_write < self.write_every:
      return
    self._last_write = now
    try:
      self._series.flush()
    except Exception:
      pass

  # --- what we tell the server ---------------------------------------------------------------------------------------
  def summary(self) -> Dict[str, Any]:
    """What the run used so far: small, whatever the length of the run (data.resources on the server)"""
    with self._lock:
      memory = _compact({
        "peak_mb": _mb(self.memory.peak), "mean_mb": _mb(self.memory.mean), "last_mb": _mb(self.memory.last),
        "max_process_mb": _mb(self.max_process_rss),
        "cgroup_peak_mb": _mb(self._cgroup_peak()), "cgroup_limit_mb": _mb(self.cgroup_limit),
      })
      cpu = _compact({"mean_cores": _round(self.cpu.mean, 2), "peak_cores": _round(self.cpu.peak, 2), "time_s": _round(self.cpu_time)})
      return _compact({
        "version": VERSION,
        "started_at": _iso(self.started_at),
        "updated_at": _iso(self.updated_at) if self.updated_at else None,
        "interval_s": self.interval,
        "samples": self.samples,
        "host": self.host,
        "memory": memory or None,
        "cpu": cpu or None,
        "gpus": [stats.summary() for stats in sorted(self.gpus.values(), key=lambda s: s.index)] or None,
      })

  def _cgroup_peak(self) -> Optional[float]:
    if self.cgroup is None:
      return None
    peak = self.cgroup.peak()
    sampled = self.cgroup_memory.peak
    if peak is None:
      return sampled
    return max(peak, sampled) if sampled is not None else peak
