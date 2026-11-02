"""
Run `qa run` commands on a pool of long-lived Dask workers.

Why? With the LSF (or Kubernetes...) runner each run is 1 job, and pays the scheduling/allocation overhead.
Here we ask the scheduler for a few worker jobs, and each worker executes many runs, with a bounded concurrency.

Where the workers run: `cluster.type`
- `lsf` (default): dask_jobqueue.LSFCluster, with defaults from `runners.lsf` (queue, project, resources, max_memory, options).
- `slurm`, `pbs`, `sge`, `htcondor`, `oar`, `moab`: the matching dask_jobqueue class (SLURMCluster...).
  The rest of `cluster` are its kwargs. Defaults: cores=1, processes=1, memory=4GB (htcondor: disk=1GB), and no
  walltime directive (the queue decides, set `walltime` to choose; OAR keeps dask-jobqueue's default).
  `cores // processes` runs at the same time per worker, `cores` per job.
- `kubernetes`: dask_kubernetes.operator.KubeCluster (needs the Dask operator in the cluster: `qa doctor` checks it).
  Image, namespace, resources, env, run_as, mounts, image_pull_secrets, node_selector, tolerations default
  to `runners.kubernetes` (`cluster` can override image, namespace, resources, env). The image needs qa and distributed.
  The rest of `cluster` are KubeCluster kwargs (e.g. resource_timeout, idle_timeout, scheduler_service_type).
  `threads_per_worker` (default 1) runs per worker pod. The DaskCluster is named "qa-{command_id[:8]}-dask" and
  labeled qaboard.io/command-id. The scheduler pod requests 1 CPU and 2Gi, without the workers' mounts or node_selector.
  KubeCluster always uses the current kubeconfig context (in a pod, its ServiceAccount): a different `context` is an error.
  Runs get qa's environment, minus PATH, HOME... (none with `runners.kubernetes.forward_env: false`).
  `pip install qaboard[dask-kubernetes]` (Python 3.10+).
- `local`: distributed.LocalCluster, on the machine running `qa batch`, for tests and big machines.
  `n_workers`/`threads_per_worker` default to 1 worker with `concurrency` threads. Other LocalCluster kwargs work too.

Modes:
- By default, `qa batch` starts a Dask scheduler in-process (Kubernetes: a scheduler pod), and starts worker jobs
  named "{command_id[:8]}_dask". They are stopped when the batch ends.
- With --no-wait, the same logic runs in a "driver" job named "{command_id[:8]}_dask_driver", sent with:
  - lsf, kubernetes: the matching runner's submit_detached(). `driver` are options of that runner for this job
    (e.g. a CPU queue). Default: `runners.lsf` / `runners.kubernetes`. On Kubernetes the driver pod creates the
    DaskCluster: its ServiceAccount needs the permissions `qa doctor` lists.
  - slurm, pbs...: the scheduler's submit command (sbatch, qsub...), with a job script made by dask-jobqueue from
    the same kwargs as the workers, with cores=1, processes=1, memory=2GB, overridden by `driver`.
    The driver then submits the workers from the node it runs on: it must be allowed to (it usually is).
  - local: a background process on this machine. Its PID is in the logs directory, in driver.pid.
- If `scheduler_address` is set, we connect to an existing Dask cluster (started by you, e.g. `dask scheduler`
  + `dask worker` sent via bsub/sbatch). With --no-wait, the driver job connects to it. If we can't send a driver
  (e.g. no bsub/sbatch here), we send all runs at once and `concurrency` is not enforced.

Stopping a batch (from QA-Board, which calls stop_jobs with the command's `cluster_type`, `scheduler_address`...):
- `scheduler_address`: we tell `qa batch` (or its driver) to stop, and kill the runs on the workers.
- lsf: `bkill -J "{command_id[:8]}*"` (via QA_RUNNERS_LSF_BRIDGE if set).
- slurm: `scancel --name`. sge: `qdel` with a job name pattern. pbs, moab: `qselect -N` then `qdel` (moab: if it
  runs on Torque/PBS). oar: `oardel --sql`. htcondor: `condor_rm -constraint` on JobBatchName.
  These run where stop_jobs runs: the QA-Board server needs the scheduler's command line tools.
- kubernetes: deletes the batch's DaskCluster(s) and its Jobs (the driver), by label `qaboard.io/command-id`.
- local: can't be stopped remotely, kill the driver (driver.pid) or `qa batch`.

Logs (driver, workers, list of runs) are saved in the batch directory, under dask/{command_id[:8]}.
Each run's output is in its output directory, in log.dask.txt.

Setup: `pip install qaboard[dask]`. Workers need the same python environment and see the same files (shared filesystem).

qaboard.yaml:
  runners:
    default: dask
    dask:
      concurrency: 20                # max runs in flight for a `qa batch`
      # scheduler_address: tcp://my-host:8786
      cluster:                       # type, then kwargs for its cluster class, they override the defaults
        type: lsf                    # default
        cores: 4                     # runs per worker job (each run is a thread in the worker)
        memory: 32GB                 # per worker job, so it should cover `cores` runs
        # walltime: "24:00"
        # interface: ib0
      driver:                        # LSF options for the --no-wait driver job. Default: runners.lsf
        queue: some_cpu_queue
        max_memory: 2000

  # Slurm
  runners:
    dask:
      cluster:
        type: slurm
        queue: gpu                   # partition
        account: algo
        cores: 4
        memory: 32GB
        walltime: "12:00:00"
        job_extra_directives: ["--gres=gpu:1"]
      driver:                        # kwargs for the --no-wait driver job, over the above with cores=1, memory=2GB
        queue: cpu
        job_extra_directives: []

  # Kubernetes
  runners:
    kubernetes:                      # also used by the kubernetes runner
      namespace: algo-qa
      image: registry.example.com/algo/qa-env:2026.11   # with qa, distributed, and your code's dependencies
      resources: {cpu: 4, memory: 16Gi}
      mounts: [{path: /algo, pvc: algo-nfs}]
    dask:
      concurrency: 20
      cluster:
        type: kubernetes
        threads_per_worker: 4        # runs per worker pod
        # resource_timeout: 300      # seconds to wait for the scheduler pod
"""
import os
import re
import sys
import json
import math
import shutil
import asyncio
import getpass
import time
import signal
import threading
import subprocess
from pathlib import Path
from dataclasses import dataclass, field, replace, fields
from typing import Optional, List, Dict, Any, Set, Tuple, Iterable, Iterator

from click import secho

from .base import BaseRunner
from .job import Job
from ..run import RunContext
from ..checks import Check, OK, WARNING, ERROR, SKIPPED


@dataclass
class DaskOptions():
  # Max number of runs from a single `qa batch` running at the same time
  concurrency: int = 10
  # Connect to an existing cluster. If not set, we start worker jobs with `cluster`
  scheduler_address: Optional[str] = None
  # `type` (lsf, slurm, pbs, sge, htcondor, oar, moab, kubernetes, local), then kwargs for its cluster class
  cluster: Dict[str, Any] = field(default_factory=dict)
  # defaults for the LSF worker jobs, taken from `runners.lsf`: queue, project, resources, max_memory, options
  lsf: Dict[str, Any] = field(default_factory=dict)
  # defaults for the Kubernetes workers, taken from `runners.kubernetes`: namespace, context, image, resources, run_as, mounts...
  kubernetes: Dict[str, Any] = field(default_factory=dict)
  # Where we save logs. Set by `qa batch` to its batch directory
  batch_dir: Optional[str] = None
  # For --no-wait, options of the job running the scheduler and sending runs:
  # for lsf/kubernetes the runner's options (defaults: `lsf`/`kubernetes`), for the others cluster kwargs.
  driver: Dict[str, Any] = field(default_factory=dict)
  # If all workers are gone for that long (e.g. killed by LSF), we give up. Before the first worker starts we wait forever, like LSF.
  no_worker_timeout: float = 600 # seconds
  # When the QA-Board server stops a batch, it gives the cluster type instead of `cluster`
  cluster_type: Optional[str] = None

dask_option_names = set(f.name for f in fields(DaskOptions))

def dict_to_DaskOptions(job_options: Dict[str, Any]) -> DaskOptions:
  filtered_options = {k: v for k, v in job_options.items() if k in dask_option_names and v is not None}
  return replace(DaskOptions(), **filtered_options)


# cluster.type -> dask_jobqueue class
jobqueue_classes = {
  'lsf': 'LSFCluster',
  'slurm': 'SLURMCluster',
  'pbs': 'PBSCluster',
  'sge': 'SGECluster',
  'htcondor': 'HTCondorCluster',
  'oar': 'OARCluster',
  'moab': 'MoabCluster',
}
# Same as dask_jobqueue's Job.submit_command, without having to import it
submit_commands = {
  'lsf': 'bsub',
  'slurm': 'sbatch',
  'pbs': 'qsub',
  'sge': 'qsub',
  'htcondor': 'condor_submit',
  'oar': 'oarsub',
  'moab': 'msub',
}
cluster_types = (*jobqueue_classes, 'kubernetes', 'local')
display_names = {
  'lsf': 'LSF', 'slurm': 'Slurm', 'pbs': 'PBS', 'sge': 'SGE', 'htcondor': 'HTCondor', 'oar': 'OAR', 'moab': 'Moab',
  'kubernetes': 'Kubernetes', 'local': 'this machine',
}


def get_cluster_type(options: DaskOptions) -> str:
  cluster_type = str(options.cluster.get('type') or options.cluster_type or 'lsf').lower()
  if cluster_type not in cluster_types:
    raise ValueError(f"Unknown runners.dask.cluster.type: {cluster_type!r}. Use one of: {', '.join(cluster_types)}.")
  return cluster_type


def cluster_kwargs(options: DaskOptions) -> Dict[str, Any]:
  return {k: v for k, v in options.cluster.items() if k != 'type'}


# The client's environment is forwarded to the runs, minus what is specific to the client's host or LSF job
excluded_env = {'HOSTNAME', 'PWD', 'OLDPWD', 'SHLVL', 'TMPDIR', 'TMP', 'TEMP', 'CUDA_VISIBLE_DEVICES', '_'}
excluded_env_prefixes = ('LSB_', 'LSF_', 'DASK_')
# Pods run an image: they keep its paths and user
excluded_pod_env = {'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LD_LIBRARY_PATH', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'PYTHONHOME', 'KUBECONFIG'}
def forwarded_env(cluster_type: str = 'lsf', kubernetes: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
  if cluster_type == 'kubernetes':
    if not (kubernetes or {}).get('forward_env', True):
      return {}
    excluded = excluded_env | excluded_pod_env
  else:
    excluded = excluded_env
  return {k: v for k, v in os.environ.items() if k not in excluded and not k.startswith(excluded_env_prefixes)}


def run_env(env: Dict[str, str]) -> Dict[str, str]:
  """The environment of a run on a worker. Like with the LSF runner, runs are headless."""
  environment = {**os.environ, **env, "MPLBACKEND": "agg"}
  # Otherwise runs that use matplotlib, OpenCV or Qt open X11 connections back to the submitter's display
  environment.pop("DISPLAY", None)
  return environment


###
### What runs on the workers.
###
# command_id -> running processes. Used to kill runs, since Dask can't cancel a task that already started.
_processes: Dict[str, Set[subprocess.Popen]] = {}
_processes_lock = threading.Lock()


def run_command(command: str, cwd: Optional[str], env: Dict[str, str], log_path: Optional[str], command_id: str) -> int:
  """Executed on a worker thread. Returns the command's return code."""
  # Goes to the worker's logs
  print(f"[qaboard] start: {command}\n          logs: {log_path}", file=sys.stderr, flush=True)
  return_code = _run_command(command, cwd, env, log_path, command_id)
  print(f"[qaboard] end (return code {return_code}): {log_path}", file=sys.stderr, flush=True)
  return return_code


def _run_command(command: str, cwd: Optional[str], env: Dict[str, str], log_path: Optional[str], command_id: str) -> int:
  if log_path:
    Path(log_path).parent.mkdir(parents=True, exist_ok=True)
  with open(log_path if log_path else os.devnull, 'w') as log:
    process = subprocess.Popen(
      command,
      shell=True,
      cwd=cwd,
      env=run_env(env),
      stdout=log,
      stderr=subprocess.STDOUT,
    )
    with _processes_lock:
      _processes.setdefault(command_id, set()).add(process)
    try:
      return process.wait()
    finally:
      with _processes_lock:
        _processes[command_id].discard(process)
        if not _processes[command_id]:
          del _processes[command_id]


def kill_command(command_id: str) -> int:
  """Executed on each worker via client.run: kills the process trees of the runs from a given `qa batch`."""
  import psutil # type: ignore
  with _processes_lock:
    processes = list(_processes.get(command_id, []))
  for process in processes:
    try:
      descendants = psutil.Process(process.pid).children(recursive=True)
    except psutil.NoSuchProcess:
      continue
    for p in descendants:
      try:
        p.terminate()
      except psutil.NoSuchProcess:
        pass
    process.terminate()
    # Only Popen must reap its child: if psutil did, Popen.wait() would see ECHILD and return 0, as if the run succeeded
    _, alive = psutil.wait_procs(descendants, timeout=10)
    try:
      process.wait(timeout=10)
    except subprocess.TimeoutExpired:
      process.kill()
    for p in alive:
      try:
        p.kill()
      except psutil.NoSuchProcess:
        pass
  return len(processes)


def doctor_probe(cwd: str) -> Dict[str, Any]:
  """Executed on a worker by `qa doctor --test-job`: where and as whom runs execute, and whether they see the project."""
  import socket
  out = subprocess.run('id; hostname', shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding='utf-8', env=run_env({}))
  return {
    "host": socket.gethostname(),
    "output": out.stdout.strip(),
    "sees_cwd": os.path.isdir(cwd),
    "qa": shutil.which('qa'),
  }


# How often `qa batch` checks whether it was stopped, or if workers are gone
poll_interval = 5 # seconds


def stop_event_name(command_id: str) -> str:
  return f"qaboard-stop-{command_id}"


###
### Clusters
###
def logs_dir(options: DaskOptions, command_id: str) -> Path:
  if options.batch_dir:
    directory = Path(options.batch_dir) / 'dask' / command_id[:8]
  else:
    directory = Path.home() / '.qaboard' / 'dask-logs' / command_id[:8]
  directory.mkdir(parents=True, exist_ok=True)
  return directory


# Runs may be long: by default the queue decides the time limit, not dask-jobqueue's default walltime (30 minutes).
# These directives are on their own line. OAR's walltime is on the same line as the cores: we keep it.
walltime_directives = {'lsf': '#BSUB -W', 'slurm': '#SBATCH -t', 'pbs': 'walltime=', 'moab': 'walltime=', 'sge': 'h_rt='}


def jobqueue_kwargs(options: DaskOptions, cluster_type: str, job_name: str, log_directory: Path, overrides: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
  """kwargs for the dask_jobqueue class. Jobs are named `job_name` so that we can stop them."""
  user_kwargs = {**cluster_kwargs(options), **(overrides or {})}
  kwargs: Dict[str, Any]
  if cluster_type == 'lsf':
    lsf = options.lsf
    job_extra_directives = []
    if lsf.get('resources'):
      job_extra_directives.append(f'-R "{lsf["resources"]}"')
    if lsf.get('options'):
      job_extra_directives.append(lsf['options'])
    kwargs = {
      "job_name": job_name, # so that `bkill -J "{batch_prefix}*"` stops the workers
      "queue": lsf.get('queue'),
      "project": lsf.get('project'),
      "cores": 1,
      "processes": 1,
      "memory": f"{lsf['max_memory']}MB" if lsf.get('max_memory') else "4GB",
      "job_extra_directives": job_extra_directives,
      # Otherwise LSF sends emails with the worker logs...
      "log_directory": str(log_directory),
      **user_kwargs,
    }
  else:
    kwargs = {
      "cores": 1,
      "processes": 1,
      "memory": "4GB",
      **({"disk": "1GB"} if cluster_type == 'htcondor' else {}),
      "log_directory": str(log_directory),
      **user_kwargs,
    }
    if cluster_type == 'htcondor':
      # HTCondor jobs have no name, but a batch name
      kwargs['job_extra_directives'] = {**(kwargs.get('job_extra_directives') or {}), 'batch_name': job_name}
    else:
      kwargs['job_name'] = job_name
  if cluster_type in walltime_directives and 'walltime' not in user_kwargs and 'job_directives_skip' not in user_kwargs:
    kwargs['job_directives_skip'] = [walltime_directives[cluster_type]]
  return {k: v for k, v in kwargs.items() if v is not None}


def make_jobqueue_cluster(options: DaskOptions, cluster_type: str, batch_prefix: str, nb_runs: int, log_directory: Path):
  import dask_jobqueue # type: ignore
  cluster_class = getattr(dask_jobqueue, jobqueue_classes[cluster_type])
  kwargs = jobqueue_kwargs(options, cluster_type, f"{batch_prefix}_dask", log_directory)
  Path(kwargs['log_directory']).mkdir(parents=True, exist_ok=True)
  cluster = cluster_class(**kwargs)

  # Each job has `processes` workers, each running `cores // processes` runs at the same time
  runs_per_worker = max(1, kwargs['cores'] // kwargs['processes'])
  runs_per_job = runs_per_worker * kwargs['processes']
  nb_worker_jobs = math.ceil(nb_runs / runs_per_job)
  if 'QA_BATCH_VERBOSE' in os.environ:
    secho(cluster.job_script(), dim=True, err=True)
  secho(f"Starting {nb_worker_jobs} dask worker(s) on {display_names[cluster_type]} ({runs_per_job} runs each). Logs: {kwargs['log_directory']}", err=True)
  cluster.scale(jobs=nb_worker_jobs)
  return cluster


def make_local_cluster(options: DaskOptions, nb_runs: int):
  from distributed import LocalCluster # type: ignore
  kwargs = cluster_kwargs(options)
  threads = kwargs.pop('threads_per_worker', None)
  if kwargs.get('n_workers'):
    n_workers = kwargs.pop('n_workers')
    threads = threads or math.ceil(nb_runs / n_workers)
  else:
    kwargs.pop('n_workers', None)
    threads = threads or nb_runs
    n_workers = math.ceil(nb_runs / threads)
  # Runs are subprocesses: threads in our process are enough. No dashboard, its port may be taken.
  kwargs = {"processes": False, "dashboard_address": None, **kwargs}
  secho(f"Starting {n_workers} local dask worker(s) ({threads} runs each).", err=True)
  return LocalCluster(n_workers=n_workers, threads_per_worker=threads, **kwargs)


###
### Kubernetes
###
DASK_GROUP, DASK_VERSION, DASK_PLURAL = 'kubernetes.dask.org', 'v1', 'daskclusters'
OPERATOR_FIX = """Install the Dask operator in the cluster (needs cluster admin rights), see https://kubernetes.dask.org/en/latest/installing.html:
  helm install --repo https://helm.dask.org --create-namespace -n dask-operator --generate-name dask-kubernetes-operator"""


def kubernetes_label_value(value: str) -> str:
  value = re.sub(r'[^A-Za-z0-9_.-]', '-', value)[:63]
  return re.sub(r'^[^A-Za-z0-9]+|[^A-Za-z0-9]+$', '', value)


def kubernetes_cluster_name(command_id: str) -> str:
  """A DNS-1123 name starting with "qa-{command_id[:8]}", like the kubernetes runner's Jobs."""
  prefix = re.sub(r'[^a-z0-9-]', '-', command_id[:8].lower())
  return re.sub(r'-+$', '', f"qa-{prefix}-dask")


def kubernetes_labels(command_id: str) -> Dict[str, str]:
  return {
    "app.kubernetes.io/managed-by": "qaboard",
    "qaboard.io/command-id": kubernetes_label_value(command_id),
    "qaboard.io/user": kubernetes_label_value(getpass.getuser()),
  }


def kubernetes_resources(resources: Optional[Dict[str, Any]]) -> Dict[str, Any]:
  """Like the kubernetes runner: {cpu: 4, memory: 16Gi, nvidia.com/gpu: 1} are requests, memory and extended resources also limits."""
  if not resources:
    return {}
  if set(resources) <= {'requests', 'limits'}:
    return resources
  requests = {k: str(v) for k, v in resources.items()}
  return {"requests": requests, "limits": {k: v for k, v in requests.items() if k != 'cpu'}}


def kubernetes_security_context(run_as: Any) -> Dict[str, Any]:
  """run_as: user (default, our UID/GID and groups) | image (the image's user) | {uid, gid}"""
  if run_as in (None, 'user'):
    if not hasattr(os, 'getuid'):
      return {}
    return {"runAsUser": os.getuid(), "runAsGroup": os.getgid(), "supplementalGroups": sorted(set(os.getgroups()))}
  if run_as == 'image':
    return {}
  if isinstance(run_as, dict) and 'uid' in run_as:
    context = {"runAsUser": int(run_as['uid'])}
    if run_as.get('gid') is not None:
      context["runAsGroup"] = int(run_as['gid'])
    return context
  raise ValueError(f"Unknown run_as: {run_as!r}. Use user, image, or {{uid: 1000, gid: 1000}}.")


def kubernetes_mounts(mounts: Optional[List[Dict[str, Any]]]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
  """The shared filesystem, at the same paths in the pods: [{path, pvc | nfs: {server, path} | host_path}] -> volumes, volumeMounts"""
  volumes, volume_mounts = [], []
  for index, mount in enumerate(mounts or []):
    volume: Dict[str, Any] = {"name": f"qa-mount-{index}"}
    if mount.get('pvc'):
      volume['persistentVolumeClaim'] = {"claimName": mount['pvc']}
    elif mount.get('nfs'):
      volume['nfs'] = mount['nfs']
    elif mount.get('host_path'):
      volume['hostPath'] = {"path": mount['host_path']}
    else:
      raise ValueError(f"mounts[{index}]: set pvc, nfs or host_path: {mount}")
    volumes.append(volume)
    volume_mounts.append({"name": volume['name'], "mountPath": mount['path'], **({"readOnly": True} if mount.get('read_only') else {})})
  return volumes, volume_mounts


def kubernetes_cluster_spec(options: DaskOptions, command_id: str, nb_runs: int) -> Tuple[Dict[str, Any], Dict[str, Any], int, int]:
  """The DaskCluster resource, the other KubeCluster kwargs, runs per worker, and how many workers."""
  from dask_kubernetes.operator import make_cluster_spec # type: ignore
  k8s = options.kubernetes
  kwargs = cluster_kwargs(options)
  threads = int(kwargs.pop('threads_per_worker', 1))
  n_workers = math.ceil(nb_runs / threads)
  image = kwargs.pop('image', None) or k8s.get('image')
  if not image:
    raise ValueError("Set runners.kubernetes.image (or runners.dask.cluster.image): an image with qa, distributed and your code's dependencies.")
  resources = kubernetes_resources(kwargs.pop('resources', None) or k8s.get('resources'))
  env = {k: str(v) for k, v in {**(k8s.get('env') or {}), **(kwargs.pop('env', None) or {})}.items()}
  # dask-kubernetes' defaults, `dask-worker` and `dask-scheduler`, were removed from recent versions of distributed
  worker_command = kwargs.pop('worker_command', 'dask worker')
  if isinstance(worker_command, str):
    worker_command = worker_command.split()
  spec = make_cluster_spec(
    name=kubernetes_cluster_name(command_id),
    image=image,
    n_workers=n_workers,
    resources=resources,
    env=env,
    worker_command=[*worker_command, '--nthreads', str(threads)],
    **{k: kwargs.pop(k) for k in ('scheduler_service_type', 'idle_timeout') if k in kwargs},
  )
  spec['metadata']['labels'] = kubernetes_labels(command_id)
  security_context = kubernetes_security_context(k8s.get('run_as', 'user'))
  pull_secrets = [{"name": name} for name in k8s.get('image_pull_secrets') or []]
  volumes, volume_mounts = kubernetes_mounts(k8s.get('mounts'))
  worker, scheduler = spec['spec']['worker']['spec'], spec['spec']['scheduler']['spec']
  scheduler_args = scheduler['containers'][0]['args']
  if scheduler_args[0] == 'dask-scheduler':
    scheduler['containers'][0]['args'] = ['dask', 'scheduler', *scheduler_args[1:]]
  for pod in (worker, scheduler):
    if security_context:
      pod['securityContext'] = security_context
    if pull_secrets:
      pod['imagePullSecrets'] = pull_secrets
  # Only the workers run the runs: they need the files, and the nodes with e.g. GPUs
  if volumes:
    worker['volumes'] = volumes
    worker['containers'][0]['volumeMounts'] = volume_mounts
  if k8s.get('node_selector'):
    worker['nodeSelector'] = k8s['node_selector']
  if k8s.get('tolerations'):
    worker['tolerations'] = k8s['tolerations']
  # The scheduler only holds `concurrency` tasks at a time: it doesn't need the workers' resources
  if resources:
    scheduler['containers'][0]['resources'] = {"requests": {"cpu": "1", "memory": "2Gi"}, "limits": {"memory": "2Gi"}}
  kwargs['namespace'] = kwargs.get('namespace') or k8s.get('namespace')
  return spec, kwargs, threads, n_workers


def check_kubernetes_context(context: Optional[str]):
  """KubeCluster always uses the current kubeconfig context (or, in a pod, its ServiceAccount)."""
  if not context:
    return
  try:
    from kubernetes import config # type: ignore
    _, active = config.list_kube_config_contexts()
  except Exception: # no kubeconfig, e.g. in a pod
    return
  if active and active.get('name') != context:
    raise ValueError(f"Dask's KubeCluster uses the current kubeconfig context ({active.get('name')}), not `context: {context}`. Run `kubectl config use-context {context}`, or remove `context`.")


def make_kubernetes_cluster(options: DaskOptions, command_id: str, nb_runs: int):
  from dask_kubernetes.operator import KubeCluster # type: ignore
  spec, kwargs, threads, n_workers = kubernetes_cluster_spec(options, command_id, nb_runs)
  check_kubernetes_context(options.kubernetes.get('context'))
  if 'QA_BATCH_VERBOSE' in os.environ:
    secho(json.dumps(spec, indent=2), dim=True, err=True)
  secho(f"Starting {n_workers} dask worker pod(s) on Kubernetes ({threads} runs each), DaskCluster {spec['metadata']['name']}.", err=True)
  return KubeCluster(custom_cluster_spec=spec, **{"quiet": True, **kwargs})


def make_cluster(options: DaskOptions, command_id: str, nb_runs: int, log_directory: Path):
  """Starts the workers for `nb_runs` runs, at most `concurrency` at the same time."""
  cluster_type = get_cluster_type(options)
  nb_runs = max(1, min(nb_runs, options.concurrency) if options.concurrency > 0 else nb_runs)
  if cluster_type == 'local':
    return make_local_cluster(options, nb_runs)
  if cluster_type == 'kubernetes':
    return make_kubernetes_cluster(options, command_id, nb_runs)
  return make_jobqueue_cluster(options, cluster_type, command_id[:8], nb_runs, log_directory)


###
### What runs in `qa batch`
###
def job_to_task(job: Job, job_options: Dict[str, Any]) -> Dict[str, Any]:
  """What we need to execute a run. Plain data, so that the --no-wait driver can read it from a JSON file."""
  output_dir = job.run_context.output_dir
  return {
    "command": job.run_context.command,
    # Like other runners, we run where `qa batch` runs: the root of the project (it changes directory there).
    # Commands start with "cd {subproject}" if needed. Note: job_options['cwd'] is where the user called `qa` from.
    "cwd": os.getcwd(),
    "output_dir": str(output_dir.resolve()) if output_dir else None,
  }


def run_tasks(tasks: List[Dict[str, Any]], job_options: Dict[str, Any], env: Optional[Dict[str, str]] = None):
  """Executes the tasks on dask workers, with at most `concurrency` in flight. Blocks until all are done."""
  from distributed import Client, Event, wait # type: ignore
  options = dict_to_DaskOptions(job_options)
  command_id = job_options['command_id']
  if env is None:
    env = forwarded_env(get_cluster_type(options), options.kubernetes)
  quiet = 'QA_BATCH_QUIET' in os.environ

  cluster = None
  if options.scheduler_address:
    client = Client(options.scheduler_address)
  else:
    cluster = make_cluster(options, command_id, nb_runs=len(tasks), log_directory=logs_dir(options, command_id))
    client = Client(cluster)

  def submit(index: int, task: Dict[str, Any]):
    log_path = str(Path(task['output_dir']) / "log.dask.txt") if task['output_dir'] else None
    return client.submit(
      run_command,
      task['command'],
      task['cwd'],
      env,
      log_path,
      command_id,
      key=f"qaboard-{command_id}-{index}",
      pure=False,
    )

  try:
    in_flight: Dict[Any, Dict[str, Any]] = {}
    def abort(_signo=None, _stackframe=None):
      print('Aborted.')
      client.cancel(list(in_flight))
      client.run(kill_command, command_id)
      # sys.exit: the finally clause below closes the cluster (and stops the workers)
      sys.exit(1)
    signal.signal(signal.SIGTERM, abort)
    signal.signal(signal.SIGINT, abort)

    # Lets `qa` in the backend stop the batch
    stop_event = Event(stop_event_name(command_id), client=client)

    # Sliding window of `concurrency` runs
    pending = list(enumerate(tasks))
    concurrency = options.concurrency if options.concurrency > 0 else len(tasks)
    # Tasks can also have the concurrency of their group, e.g. their batch's (see DaskRunner.start_groups)
    def can_start(task: Dict[str, Any]) -> bool:
      limit = task.get('concurrency') or 0
      return limit <= 0 or sum(1 for t in in_flight.values() if t.get('group') == task.get('group')) < limit
    nb_done, nb_failed = 0, 0
    seen_workers, no_worker_since = False, None
    while pending or in_flight:
      if stop_event.is_set():
        secho("The batch was stopped.", fg='red', err=True)
        abort()
      while len(in_flight) < concurrency:
        startable = next((i for i, (_, task) in enumerate(pending) if can_start(task)), None)
        if startable is None:
          break
        index, task = pending.pop(startable)
        in_flight[submit(index, task)] = task
      try:
        done, _ = wait(list(in_flight), timeout=poll_interval, return_when="FIRST_COMPLETED")
      except (TimeoutError, asyncio.TimeoutError): # unlike concurrent.futures.wait, it raises. Different classes before python 3.11
        done = set()
      for future in done:
        task = in_flight.pop(future)
        nb_done += 1
        try:
          return_code = future.result()
          error = f"return code {return_code}" if return_code != 0 else None
        except Exception as e: # e.g. KilledWorker, if the worker died several times while running it
          error = f"{type(e).__name__}: {e}"
        if error:
          nb_failed += 1
          secho(f"[{nb_done}/{len(tasks)}] Failed ({error}): {task['output_dir']}", fg='red', err=True)
        elif not quiet:
          secho(f"[{nb_done}/{len(tasks)}] Done: {task['output_dir']}", dim=True, err=True)
      if client.scheduler_info()['workers']:
        seen_workers, no_worker_since = True, None
      elif seen_workers:
        no_worker_since = no_worker_since or time.time()
        if time.time() - no_worker_since > options.no_worker_timeout:
          secho(f"ERROR: No dask worker for {options.no_worker_timeout}s, giving up.", fg='red', err=True)
          abort()
    secho(f"{len(tasks)} runs done, {nb_failed} failed.", err=True)
  finally:
    client.close()
    if cluster is not None:
      cluster.close()


###
### The --no-wait driver
###
def can_start_driver(options: DaskOptions) -> bool:
  """Whether we can send the --no-wait driver job from here."""
  cluster_type = get_cluster_type(options)
  if cluster_type == 'local':
    return True
  if cluster_type == 'kubernetes':
    from . import runners
    return 'kubernetes' in runners
  if cluster_type == 'lsf' and os.environ.get('QA_RUNNERS_LSF_BRIDGE'):
    return True
  return bool(shutil.which(submit_commands[cluster_type]))


def write_tasks(path: Path, data: Dict[str, Any]):
  # It has the environment of the runs: only for us
  fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
  with os.fdopen(fd, 'w') as f:
    json.dump(data, f, indent=2, default=str)


# JobQueueCluster kwargs that its Job class doesn't take
_cluster_only_kwargs = {
  'n_workers', 'job_cls', 'loop', 'security', 'shared_temp_directory', 'silence_logs', 'name', 'asynchronous',
  'dashboard_address', 'host', 'scheduler_options', 'scheduler_cls',
}


def submit_jobqueue_driver(options: DaskOptions, cluster_type: str, script: str, name: str, log_directory: Path) -> Dict[str, Any]:
  """
  Submits `script` with the scheduler's submit command (sbatch, qsub...), reusing dask-jobqueue's Job class:
  it makes the job script's header from the same kwargs as the workers, and knows how to call the submit command.
  """
  import dask_jobqueue # type: ignore
  cluster_class = getattr(dask_jobqueue, jobqueue_classes[cluster_type])
  overrides = {"cores": 1, "processes": 1, "memory": "2GB", **options.driver}
  kwargs = jobqueue_kwargs(options, cluster_type, name, log_directory, overrides=overrides)
  job = cluster_class.job_cls(
    scheduler="tcp://unused:8786",
    name=name,
    **{k: v for k, v in kwargs.items() if k not in _cluster_only_kwargs},
  )
  # Instead of a dask worker, the job runs the driver
  command = script
  if cluster_type == 'htcondor' and job._job_script_prologue:
    command = "; ".join([*job._job_script_prologue, script]) # HTCondor jobs are a single command
  job._command_template = command
  if 'QA_BATCH_VERBOSE' in os.environ:
    secho(job.job_script(), dim=True, err=True)
  try:
    with job.job_file() as script_path:
      out = asyncio.run(job._submit_job(script_path))
  except RuntimeError as e: # dask-jobqueue's error has the command, its exit code and output
    raise Exception(f"Failed to submit the dask driver job with `{job.submit_command}`.\n{e}") from e
  try:
    return {"job_id": job._job_id_from_submit_output(out)}
  except ValueError:
    return {}


def start_local_driver(tasks_path: Path, directory: Path) -> Dict[str, Any]:
  """A process that keeps running after `qa batch` exits."""
  with (directory / 'driver.log').open('w') as log:
    process = subprocess.Popen(
      [sys.executable, '-m', 'qaboard.runners.dask_runner', str(tasks_path)],
      stdin=subprocess.DEVNULL,
      stdout=log,
      stderr=subprocess.STDOUT,
      start_new_session=True, # Ctrl-C on the terminal doesn't stop it
    )
  (directory / 'driver.pid').write_text(f"{process.pid}\n")
  return {"pid": process.pid}


def start_driver(tasks: List[Dict[str, Any]], job_options: Dict[str, Any]) -> Dict[str, Any]:
  """For --no-wait: sends a job that sends the runs, after starting a scheduler and workers unless we use an existing cluster."""
  options = dict_to_DaskOptions(job_options)
  cluster_type = get_cluster_type(options)
  command_id = job_options['command_id']
  directory = logs_dir(options, command_id)
  tasks_path = directory / 'tasks.json'
  # Not every scheduler gives jobs our environment, so the driver gets it from the file
  write_tasks(tasks_path, {"tasks": tasks, "job_options": job_options, "env": forwarded_env(cluster_type, options.kubernetes)})

  name = f"{command_id[:8]}_dask_driver"
  if cluster_type == 'local':
    info = start_local_driver(tasks_path, directory)
    secho(f"Started the dask driver in the background (PID {info['pid']}). Logs: {directory}", err=True)
    return info

  # Pods use the image's python
  python = 'python3' if cluster_type == 'kubernetes' else f'"{sys.executable}"'
  # The driver writes its own logs: on LSF the job's output is only written at the end
  script = f'cd "{os.getcwd()}" && {python} -m qaboard.runners.dask_runner "{tasks_path}" > "{directory}/driver.log" 2>&1'
  if cluster_type in ('lsf', 'kubernetes'):
    from . import runners
    Runner = runners.get(cluster_type)
    if Runner is None:
      raise Exception(f"Can't send the dask driver: the {cluster_type} runner is not available. Try `pip install qaboard[{cluster_type}]`.")
    if cluster_type == 'lsf':
      driver_options = {**options.lsf, **options.driver}
      log_file = directory / 'driver.lsf.log'
    else:
      driver_options = {"type": "kubernetes", **options.kubernetes, **options.driver}
      log_file = directory / 'driver.k8s.log'
    info = Runner.submit_detached(script, name, log_file, {**driver_options, "command_id": command_id})
  else:
    info = submit_jobqueue_driver(options, cluster_type, script, name, directory)
  secho(f"Sent the dask driver to {display_names[cluster_type]} ({name}). Logs: {directory}", err=True)
  return info


###
### Stopping
###
def stop_jobqueue_jobs(cluster_type: str, batch_prefix: str):
  """Cancels the workers and driver by name: "{batch_prefix}_dask" and "{batch_prefix}_dask_driver"."""
  workers, driver = f"{batch_prefix}_dask", f"{batch_prefix}_dask_driver"
  pbs = f'ids=$(qselect -N "{workers}") && ids2=$(qselect -N "{driver}") && if [ -n "$ids$ids2" ]; then qdel $ids $ids2; fi'
  # The commands, the tools they need, and what they say when the jobs are already gone
  commands: Dict[str, Tuple[List[str], List[str], Tuple[str, ...]]] = {
    'slurm': ([f'scancel --name "{workers}"', f'scancel --name "{driver}"'], ['scancel'], ()),
    'sge': ([f'qdel "{batch_prefix}_dask*"'], ['qdel'], ('does not exist',)),
    'pbs': ([pbs], ['qselect', 'qdel'], ('Unknown Job',)),
    'moab': ([pbs], ['qselect', 'qdel'], ('Unknown Job',)),
    'oar': ([f"oardel --sql \"job_name like '{batch_prefix}_dask%'\""], ['oardel'], ('No job',)),
    'htcondor': ([f"condor_rm -constraint 'JobBatchName =?= \"{workers}\" || JobBatchName =?= \"{driver}\"'"], ['condor_rm'], ("Couldn't find",)),
  }
  cancel_commands, tools, already_gone = commands[cluster_type]
  missing = [tool for tool in tools if not shutil.which(tool)]
  if missing:
    raise ValueError(f"Can't stop the dask jobs on {display_names[cluster_type]}: `{'`, `'.join(missing)}` not found. It must be on the PATH where the batch is stopped (for the QA-Board server: in its container).")
  for command in cancel_commands:
    secho(command, bold=True, err=True)
    out = subprocess.run(command, shell=True, encoding="utf-8", capture_output=True)
    print(out.stdout)
    print(out.stderr)
    output = f"{out.stdout}\n{out.stderr}"
    if out.returncode != 0 and not any(message.lower() in output.lower() for message in already_gone):
      raise ValueError(f"`{command}` failed (exit code {out.returncode}): {output.strip()}")


def kubernetes_api_client(context: Optional[str]):
  """From the kubeconfig (and its context), else, in a pod (e.g. the QA-Board server), the ServiceAccount."""
  from kubernetes import client, config # type: ignore
  from kubernetes.config.config_exception import ConfigException # type: ignore
  try:
    return config.new_client_from_config(context=context)
  except ConfigException:
    if not os.environ.get('KUBERNETES_SERVICE_HOST'):
      raise
    config.load_incluster_config()
    return client.ApiClient()


def kubernetes_namespace(namespace: Optional[str], context: Optional[str]) -> str:
  """The given namespace, else the kubeconfig context's, else, in a pod, the ServiceAccount's, else "default"."""
  if namespace:
    return namespace
  try:
    from kubernetes import config # type: ignore
    contexts, active = config.list_kube_config_contexts()
    current = next((c for c in contexts if c['name'] == context), None) if context else active
    if current:
      return current['context'].get('namespace') or 'default'
  except Exception:
    pass
  service_account_namespace = Path('/var/run/secrets/kubernetes.io/serviceaccount/namespace')
  if service_account_namespace.exists():
    return service_account_namespace.read_text().strip()
  return 'default'


def stop_kubernetes(command_id: str, namespace: Optional[str], context: Optional[str]):
  """Deletes the batch's DaskCluster(s) (the operator deletes their pods) and its Jobs (the --no-wait driver)."""
  from kubernetes import client # type: ignore
  from kubernetes.client.rest import ApiException # type: ignore
  api_client = kubernetes_api_client(context)
  namespace = kubernetes_namespace(namespace, context)
  label = kubernetes_label_value(command_id)
  name = kubernetes_cluster_name(command_id)
  custom: Any = client.CustomObjectsApi(api_client)
  try:
    clusters = custom.list_namespaced_custom_object(DASK_GROUP, DASK_VERSION, namespace, DASK_PLURAL)['items']
  except ApiException as e:
    if e.status != 404: # 404: the operator isn't installed, so there is no DaskCluster
      raise
    clusters = []
  for cluster in clusters:
    metadata = cluster['metadata']
    if (metadata.get('labels') or {}).get('qaboard.io/command-id') == label or metadata['name'].startswith(name):
      secho(f"Deleting DaskCluster {metadata['name']} in namespace {namespace}", bold=True, err=True)
      custom.delete_namespaced_custom_object(DASK_GROUP, DASK_VERSION, namespace, DASK_PLURAL, metadata['name'])
  batch: Any = client.BatchV1Api(api_client)
  for job in batch.list_namespaced_job(namespace, label_selector=f"qaboard.io/command-id={label}").items:
    secho(f"Deleting Job {job.metadata.name} in namespace {namespace}", bold=True, err=True)
    batch.delete_namespaced_job(job.metadata.name, namespace, propagation_policy='Background')


###
### qa doctor
###
def doctor_scheduler(options: DaskOptions, test_job: bool) -> Iterator[Check]:
  from distributed import Client # type: ignore
  address = options.scheduler_address
  name = f"Dask: scheduler {address}"
  try:
    client = Client(address, timeout=10)
  except Exception as e:
    yield Check(name, ERROR, f"Can't connect: {type(e).__name__}: {e}",
                fix="Check that the scheduler runs (`dask scheduler`), and that this host can reach it (address, port 8786, firewall).")
    return
  with client:
    nthreads = client.nthreads()
    if nthreads:
      yield Check(name, OK, f"Reachable, {len(nthreads)} worker(s), {sum(nthreads.values())} thread(s) in all: as many runs at the same time.")
    else:
      yield Check(name, WARNING, "Reachable, but it has no workers: runs will wait for them.",
                  fix=f"Start workers, e.g. `dask worker {address}` sent as jobs to your cluster.")
    if test_job:
      if not nthreads:
        yield Check("Dask: test job", SKIPPED, "No worker to run it.")
      else:
        yield probe_check(client)
  if not can_start_driver(options):
    cluster_type = get_cluster_type(options)
    yield Check("Dask: --no-wait driver", WARNING,
                f"Can't send a driver job to {display_names[cluster_type]} from here: with --no-wait, all runs are sent at once and `concurrency` is not enforced.",
                fix=f"Run `qa batch` where `{submit_commands.get(cluster_type, cluster_type)}` works, or set runners.dask.cluster.type to the scheduler you have.")


def probe_check(client, timeout: float = 120) -> Check:
  result = client.submit(doctor_probe, os.getcwd(), pure=False).result(timeout=timeout)
  message = f"A worker on {result['host']} ran `id; hostname`:\n{result['output']}"
  if not result['sees_cwd']:
    return Check("Dask: test job", ERROR, f"{message}\nbut it doesn't see the project directory {os.getcwd()}: runs would fail.",
                 fix="The workers must see the same files as `qa batch`, at the same paths (shared filesystem, or mounts on Kubernetes).")
  if not result['qa']:
    return Check("Dask: test job", WARNING, f"{message}\nbut `qa` is not on its PATH: runs would fail.",
                 fix="The workers must use a python environment with qaboard installed.")
  return Check("Dask: test job", OK, message)


def doctor_test_job(options: DaskOptions, timeout: float = 300) -> Check:
  """Starts a 1-worker cluster, runs `id; hostname` on it, and closes it."""
  import uuid
  from distributed import Client # type: ignore
  command_id = f"doctor{uuid.uuid4().hex}"
  test_options = replace(options, concurrency=1)
  cluster = make_cluster(test_options, command_id, nb_runs=1, log_directory=logs_dir(test_options, command_id))
  try:
    with Client(cluster) as client:
      try:
        client.wait_for_workers(1, timeout=timeout)
      except (TimeoutError, asyncio.TimeoutError):
        return Check("Dask: test job", WARNING, f"No worker started within {timeout}s: it may still be waiting in the queue.",
                     fix=f"Check the worker job's status and logs in {logs_dir(test_options, command_id)}.")
      return probe_check(client)
  finally:
    cluster.close()


def doctor_kubernetes(options: DaskOptions) -> Iterator[Check]:
  k8s = options.kubernetes
  if not (options.cluster.get('image') or k8s.get('image')):
    yield Check("Dask: image", ERROR, "No image for the scheduler and worker pods.",
                fix="Set runners.kubernetes.image: an image with qa, distributed and your code's dependencies.")
  try:
    check_kubernetes_context(k8s.get('context'))
  except ValueError as e:
    yield Check("Dask: kubeconfig context", ERROR, str(e))
  from kubernetes import client # type: ignore
  from kubernetes.client.rest import ApiException # type: ignore
  namespace = kubernetes_namespace(options.cluster.get('namespace') or k8s.get('namespace'), k8s.get('context'))
  name = f"Dask: DaskCluster resources in namespace {namespace}"
  try:
    custom = client.CustomObjectsApi(kubernetes_api_client(k8s.get('context')))
    custom.list_namespaced_custom_object(DASK_GROUP, DASK_VERSION, namespace, DASK_PLURAL, limit=1, _request_timeout=10)
  except ApiException as e:
    if e.status == 404:
      yield Check(name, ERROR, "The Dask operator is not installed: there is no daskclusters.kubernetes.dask.org CustomResourceDefinition.", fix=OPERATOR_FIX)
    elif e.status == 403:
      yield Check(name, ERROR, f"Not allowed to list DaskClusters in namespace {namespace}.", fix=f"""Ask the cluster admins for a Role like this one in namespace {namespace}, bound to you:
rules:
- apiGroups: [kubernetes.dask.org]
  resources: [daskclusters, daskworkergroups]
  verbs: [get, list, watch, create, patch, delete]
- apiGroups: [""]
  resources: [pods, services]
  verbs: [get, list, watch]
- apiGroups: [""]
  resources: [pods/portforward]
  verbs: [create]""")
    else:
      yield Check(name, ERROR, f"{e.status} {e.reason}")
    return
  except Exception as e: # no kubeconfig, API unreachable...
    yield Check(name, ERROR, f"Can't reach the Kubernetes API: {type(e).__name__}: {e}",
                fix=f"Check your kubeconfig and credentials, e.g. with `kubectl get pods -n {namespace}`.")
    return
  yield Check(name, OK, "The Dask operator is installed, and you can list DaskClusters.")


def _doctor(job_options: Dict[str, Any], test_job: bool) -> Iterator[Check]:
  options = dict_to_DaskOptions(job_options)
  try:
    cluster_type = get_cluster_type(options)
  except ValueError as e:
    yield Check("Dask: cluster type", ERROR, str(e))
    return
  try:
    import distributed # type: ignore
  except ImportError:
    yield Check("Dask: distributed installed", ERROR, "The dask runner needs the `distributed` package.", fix='pip install "qaboard[dask]"')
    return
  yield Check("Dask: distributed installed", OK, f"distributed {distributed.__version__}")

  if options.scheduler_address:
    yield from doctor_scheduler(options, test_job)
    return

  if cluster_type == 'kubernetes':
    try:
      import dask_kubernetes # type: ignore
      yield Check("Dask: dask-kubernetes installed", OK, f"dask-kubernetes {dask_kubernetes.__version__}")
    except ImportError:
      yield Check("Dask: dask-kubernetes installed", ERROR, "Dask clusters on Kubernetes need the `dask-kubernetes` package (Python 3.10+).", fix='pip install "qaboard[dask-kubernetes]"')
      return
    checks = list(doctor_kubernetes(options))
    yield from checks
    if any(c.failed for c in checks):
      return
  elif cluster_type == 'local':
    yield Check("Dask: local cluster", OK, f"Workers run on this machine ({os.cpu_count()} CPUs).")
  else:
    try:
      import dask_jobqueue # type: ignore
      yield Check("Dask: dask-jobqueue installed", OK, f"dask-jobqueue {dask_jobqueue.__version__}")
    except ImportError:
      yield Check("Dask: dask-jobqueue installed", ERROR, f"Dask workers on {display_names[cluster_type]} need the `dask-jobqueue` package.", fix='pip install "qaboard[dask]"')
      return
    submit = submit_commands[cluster_type]
    name = f"Dask: `{submit}` available"
    if shutil.which(submit):
      yield Check(name, OK, shutil.which(submit) or '')
    elif cluster_type == 'lsf' and os.environ.get('QA_RUNNERS_LSF_BRIDGE'):
      yield Check(name, WARNING, "Only via QA_RUNNERS_LSF_BRIDGE: `qa batch --no-wait` works (the driver job starts the workers), but not blocking batches: dask-jobqueue runs bsub itself.",
                  fix="Run blocking batches from a host with `bsub`, or use --no-wait.")
    else:
      yield Check(name, ERROR, f"dask-jobqueue starts the workers with `{submit}`, which is not on the PATH.",
                  fix=f"Run `qa batch` from a host that can submit {display_names[cluster_type]} jobs (e.g. a login node), or set runners.dask.cluster.type.")
      return
    # Builds a worker job script, to check the kwargs
    cluster_class = getattr(dask_jobqueue, jobqueue_classes[cluster_type])
    import tempfile
    with tempfile.TemporaryDirectory() as log_directory:
      kwargs = jobqueue_kwargs(options, cluster_type, "doctor_dask", Path(log_directory))
      try:
        job = cluster_class.job_cls(scheduler="tcp://scheduler:8786", name="doctor", **{k: v for k, v in kwargs.items() if k not in _cluster_only_kwargs})
        yield Check("Dask: worker job options", OK, f"Worker jobs will be submitted with:\n{job.job_header}")
      except Exception as e:
        yield Check("Dask: worker job options", ERROR, f"{type(e).__name__}: {e}",
                    fix=f"Check runners.dask.cluster: besides `type`, they are kwargs of dask_jobqueue.{jobqueue_classes[cluster_type]}, see https://jobqueue.dask.org")
        return

  if test_job:
    try:
      yield doctor_test_job(options)
    except Exception as e:
      yield Check("Dask: test job", ERROR, f"{type(e).__name__}: {e}")


class DaskRunner(BaseRunner):
  """Execute runs on Dask workers, by default started as LSF jobs."""
  type = "dask"
  # Batches with their own share the workers, with their own limit (see start_groups)
  group_options = ('concurrency',)

  def __init__(self, run_context: RunContext):
    self.run_context = run_context

  def start(self, blocking=True):
    raise NotImplementedError("Use start_jobs")

  @staticmethod
  def start_jobs(jobs: List[Job], job_options: Dict[str, Any], blocking=True):
    return DaskRunner.start_tasks([job_to_task(job, job_options) for job in jobs], job_options, blocking)

  @classmethod
  def start_groups(cls, groups: List[Tuple[Dict[str, Any], List[Job]]], blocking=True):
    """
    The runs of all groups share the same workers, but each group has at most its own `concurrency` in flight.
    In all, we never have more in flight than the largest concurrency.
    """
    if len(groups) == 1:
      job_options, jobs = groups[0]
      return DaskRunner.start_jobs(jobs, job_options, blocking)
    tasks: List[Dict[str, Any]] = []
    limits = []
    for index, (job_options, jobs) in enumerate(groups):
      concurrency = dict_to_DaskOptions(job_options).concurrency
      limits.append(concurrency if concurrency > 0 else len(jobs))
      tasks.extend({**job_to_task(job, job_options), "group": index, "concurrency": concurrency} for job in jobs)
    # Not more than the groups can run, so that we don't start useless workers
    concurrency = min(max(limits), sum(min(limit, len(jobs)) for limit, (_, jobs) in zip(limits, groups)))
    return DaskRunner.start_tasks(tasks, {**groups[0][0], "concurrency": concurrency}, blocking)

  @staticmethod
  def start_tasks(tasks: List[Dict[str, Any]], job_options: Dict[str, Any], blocking=True):
    from distributed import Client, fire_and_forget # type: ignore
    options = dict_to_DaskOptions(job_options)
    if blocking:
      return run_tasks(tasks, job_options)
    # The driver sends the runs `concurrency` at a time. With an existing cluster, it connects to it.
    if not options.scheduler_address or can_start_driver(options):
      return start_driver(tasks, job_options)

    cluster_type = get_cluster_type(options)
    secho(f"WARNING: with --no-wait and a `scheduler_address`, but no {display_names[cluster_type]} to send a driver job, all runs are sent at once, and `concurrency` is not enforced.", fg='yellow', err=True)
    command_id = job_options['command_id']
    env = forwarded_env(cluster_type, options.kubernetes)
    with Client(options.scheduler_address) as client:
      futures = [
        client.submit(
          run_command,
          task['command'],
          task['cwd'],
          env,
          str(Path(task['output_dir']) / "log.dask.txt") if task['output_dir'] else None,
          command_id,
          key=f"qaboard-{command_id}-{index}",
          pure=False,
        )
        for index, task in enumerate(tasks)
      ]
      fire_and_forget(futures)

  @staticmethod
  def stop_jobs(jobs: List[Job], job_options: Dict[str, Any]):
    """
    Also called by the QA-Board server, with few job options: type, command_id, bridge, maybe user,
    scheduler_address (if trusted), cluster_type, and for kubernetes {"kubernetes": {namespace, context}}.
    """
    options = dict_to_DaskOptions(job_options)
    command_id = job_options['command_id']
    if options.scheduler_address:
      from distributed import Client, Event # type: ignore
      with Client(options.scheduler_address, timeout=30) as client:
        # The `qa batch` process stops sending runs...
        Event(stop_event_name(command_id), client=client).set()
        # ...and we kill those that are running
        client.run(kill_command, command_id)
      return

    cluster_type = get_cluster_type(options)
    if cluster_type == 'lsf':
      # The workers (and --no-wait driver) are LSF jobs with the batch prefix.
      from .lsf import LsfRunner
      lsf_options = {**job_options, 'bridge': job_options.get('bridge') or os.environ.get('QA_RUNNERS_LSF_BRIDGE', '')}
      LsfRunner.stop_jobs(jobs, lsf_options)
    elif cluster_type == 'kubernetes':
      namespace = options.cluster.get('namespace') or options.kubernetes.get('namespace')
      stop_kubernetes(command_id, namespace, options.kubernetes.get('context'))
    elif cluster_type == 'local':
      # Like the local runner, we don't raise: the server then marks the pending runs as stopped.
      secho("Dask local clusters run on the machine that started them: stop `qa batch`, or kill the --no-wait driver (its PID is in driver.pid, in the batch's dask logs).", fg='yellow', err=True)
    else:
      stop_jobqueue_jobs(cluster_type, command_id[:8])

  @classmethod
  def doctor(cls, job_options: Dict[str, Any], test_job: bool = False) -> Iterable[Check]:
    try:
      yield from _doctor(job_options, test_job)
    except Exception as e:
      yield Check("Dask", ERROR, f"Unexpected error: {type(e).__name__}: {e}")


if __name__ == '__main__':
  # The --no-wait driver.
  # We import from the module: functions defined in __main__ would be pickled by value, with their own copy of the globals.
  from qaboard.runners.dask_runner import run_tasks as _run_tasks
  with open(sys.argv[1]) as f:
    data = json.load(f)
  _run_tasks(data['tasks'], data['job_options'], env=data.get('env'))
