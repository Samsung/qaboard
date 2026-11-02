"""
What the server asks runners to do, with options it can trust: stop batches, and start `qa batch` on Kubernetes.

1. Stopping batches (Batch.stop). `qa batch` registers its commands in batch.data.commands, with its runner and what
   is needed to stop its jobs. They are written by unauthenticated API calls (POST /api/v1/batch), and the runners use
   them in shell commands (e.g. `bkill` through the LSF bridge) or to choose which cluster to talk to. So we forward
   only a few options, after validating them (stop_job_options).

2. Starting `qa batch` from the web app (api/tuning.py, redo.py) with QABOARD_TUNING_RUNNER=kubernetes. The script
   runs in a "driver" pod (a 1-pod Job, the kubernetes runner's submit_detached), as the signed-in user's UID/GID. The
   `qa batch` it runs starts the runs' Jobs with the pod's ServiceAccount (in-cluster config), and they're stopped
   together: the driver's command id is the batch's (QA_BATCH_COMMAND_ID), and every Job is labeled with it.

The admins' settings:
- QABOARD_KUBERNETES_NAMESPACES: the namespaces where the server may start and stop runs, comma-separated. Empty (the
  default): none, Kubernetes batches can't be started or stopped from QA-Board. The server's credentials need the
  runner's Role there (the helm chart's runners.kubernetes creates it). The first namespace is where batches go when
  the project's runners.kubernetes.namespace is not set.
- QABOARD_KUBERNETES_CONTEXTS: the kubeconfig contexts the server may use, comma-separated. Others are ignored, and the
  server uses its default: in a pod its ServiceAccount, else its kubeconfig's current context.
- QABOARD_KUBERNETES_SERVICE_ACCOUNT: the ServiceAccount of the driver pods, allowed to create the runs' Jobs (the
  helm chart creates one in each namespace, `qaboard-runs`). Unset: the namespace's default ServiceAccount.
- QABOARD_KUBERNETES_SERVER_URL: how pods reach QA-Board, e.g. http://qaboard-proxy.qaboard.svc (the helm chart sets
  it). Else QABOARD_HOST and QABOARD_PROTOCOL, if set. Else whatever `qa` uses in the image (e.g. a site package).
- QABOARD_KUBERNETES_DRIVER_RESOURCES: the driver pod's resources requests, as JSON. Default: {"cpu": "500m", "memory": "2Gi"}
- QABOARD_KUBERNETES_ALLOW_HOST_PATH=1: allows `host_path` mounts in driver pods. Off by default.

Security: the project's runners.kubernetes comes from its qaboard.yaml, in commits that anyone who can push may write.
The server never gives driver pods more than the namespace allows:
- they run as the signed-in user (never as root), or with `run_as: image` as the image's user, never as a UID/GID
  from qaboard.yaml. The project's `job_template` (a whole Job spec) and `forward_env` (the server's environment has
  its secrets) are not used, nor `host_path` mounts unless QABOARD_KUBERNETES_ALLOW_HOST_PATH=1.
- but the driver runs the project's code (`qa batch`, its .envrc, iter_inputs...), and its ServiceAccount can create
  Jobs: any pod the namespace accepts. What runs may do (users, volumes, privileges) must be enforced by the admins
  with the namespace's Pod Security Standard and admission policies (e.g. a ValidatingAdmissionPolicy that ties
  runAsUser to the `qaboard.io/user` label), and quotas with ResourceQuota or Kueue.
"""
import os
import re
import json
from pathlib import Path
from shlex import quote
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

from .shell_utils import shell_safe, safe_user_name


class NotAllowed(Exception):
  """The server's settings don't allow it. The message says why, and what to do: users see it."""


def env_list(name: str) -> List[str]:
  return [value.strip() for value in os.environ.get(name, '').split(',') if value.strip()]


def env_flag(name: str) -> bool:
  return os.environ.get(name, '').strip().lower() not in ('', '0', 'false', 'no', 'off')


_dns1123_label = re.compile(r'^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')

def is_dns1123_label(value) -> bool:
  """Valid as a namespace name (RFC 1123 label): lowercase alphanumerics and '-', at most 63 characters"""
  return isinstance(value, str) and len(value) <= 63 and bool(_dns1123_label.match(value))

def is_dns1123_subdomain(value) -> bool:
  """Valid as the name of most objects (secrets, priority classes...)"""
  return isinstance(value, str) and len(value) <= 253 and all(is_dns1123_label(part) for part in value.split('.'))

_label_value = re.compile(r'^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$')

def is_label_value(value) -> bool:
  return isinstance(value, str) and len(value) <= 63 and bool(_label_value.match(value))


def allowed_namespace(namespace) -> str:
  """The namespace, if the server may start and stop runs there (QABOARD_KUBERNETES_NAMESPACES). Raises NotAllowed."""
  allowed = env_list('QABOARD_KUBERNETES_NAMESPACES')
  if not allowed:
    raise NotAllowed(
      "This QA-Board server can't start or stop runs on Kubernetes: its admins didn't set QABOARD_KUBERNETES_NAMESPACES, "
      "the namespaces where it may (comma-separated, with permissions for the server there: see runners.kubernetes in the helm chart)."
    )
  if not is_dns1123_label(namespace):
    raise NotAllowed(f"Invalid Kubernetes namespace: {namespace!r}")
  if namespace not in allowed:
    raise NotAllowed(
      f"QA-Board may not start or stop runs in the Kubernetes namespace {namespace!r}, only in: {', '.join(allowed)}. "
      "Use one of them (runners.kubernetes.namespace in qaboard.yaml), or ask your QA-Board admins to add it to QABOARD_KUBERNETES_NAMESPACES."
    )
  return namespace


def allowed_context(context) -> Optional[str]:
  """The kubeconfig context, if the server may use it (QABOARD_KUBERNETES_CONTEXTS). Else None: the server's default."""
  if not context:
    return None
  if isinstance(context, str) and context in env_list('QABOARD_KUBERNETES_CONTEXTS'):
    return context
  return None


def kubernetes_location(options: dict, notes: Optional[List[str]] = None) -> Dict[str, str]:
  """{"namespace", "context"} from untrusted options, validated. Raises NotAllowed for namespaces we may not use."""
  location = {"namespace": allowed_namespace(options.get('namespace'))}
  context = options.get('context')
  if allowed_context(context):
    location['context'] = context
  elif context:
    message = (f"The kubeconfig context {context!r} is not one QA-Board may use (QABOARD_KUBERNETES_CONTEXTS): "
               "it uses its default cluster.")
    print(f"WARNING: {message}")
    if notes is not None:
      notes.append(message)
  return location


# ==========================================
# Stopping batches
# ==========================================

STOPPABLE_RUNNERS = ("lsf", "dask", "local", "celery", "kubernetes")
# runners.dask.cluster.type
DASK_CLUSTER_TYPES = ("lsf", "slurm", "pbs", "sge", "htcondor", "oar", "moab", "kubernetes", "local")


def stop_job_options(command_id, command) -> Dict[str, Any]:
  """
  The job options the runner of a `qa batch` command (from batch.data.commands, untrusted) needs to stop its jobs.
  Raises ValueError if we can't stop them, NotAllowed if the server's settings don't let it (users should know).
  """
  if not isinstance(command, dict):
    raise ValueError(f"invalid command {command!r}")
  runner = command.get('runner')
  if runner not in STOPPABLE_RUNNERS:
    raise ValueError(f"cannot stop jobs for runner {runner!r}")
  job_options = {
    "type": runner,
    "command_id": shell_safe(command_id, "command_id"),
    "bridge": os.environ.get("QA_RUNNERS_LSF_BRIDGE", ""),
  }
  if command.get('user'):
    job_options['user'] = safe_user_name(command['user'])
  if runner == "dask":
    # We only connect to Dask schedulers we trust
    trusted_schedulers = env_list("QABOARD_DASK_SCHEDULERS")
    if command.get('scheduler_address') in trusted_schedulers:
      job_options['scheduler_address'] = command['scheduler_address']
    # Where the workers are (runners.dask.cluster.type). Unset: LSF, like before it was sent
    cluster_type = command.get('cluster_type')
    if cluster_type is not None:
      if cluster_type not in DASK_CLUSTER_TYPES:
        raise ValueError(f"unknown Dask cluster type {cluster_type!r}")
      job_options['cluster_type'] = cluster_type
      if cluster_type == "kubernetes":
        job_options.update(kubernetes_location(command))
  if runner == "kubernetes":
    job_options.update(kubernetes_location(command))
  return job_options


def kubernetes_drivers(data) -> Dict[str, dict]:
  """
  The driver pods of the batches started from QA-Board on Kubernetes that may still run: {command_id: submission}.
  Like batch.data.commands, batch.data.submissions can be written by unauthenticated API calls: we validate them too.
  """
  submissions = (data or {}).get('submissions') or {}
  if not isinstance(submissions, dict):
    return {}
  return {
    id: submission for id, submission in submissions.items()
    if isinstance(submission, dict)
    and submission.get('runner') == 'kubernetes'
    and submission.get('status') == 'submitted'
    and submission.get('kubernetes_job')
  }


def stop_batch_jobs(data, has_pending_runs: bool) -> Optional[Dict[str, list]]:
  """
  Stops the jobs of a batch (batch.data): its `qa batch` commands, and the driver pods of the batches started from
  QA-Board on Kubernetes (their Jobs, and the runs' Jobs in the same namespace: they have the same command id).
  Returns None when there is nothing to stop, else {"errors": [...], "stopped_drivers": [command ids]}.
  """
  data = data or {}
  drivers = kubernetes_drivers(data)
  if not has_pending_runs and not drivers:
    return None
  from qaboard.runners.job import JobGroup

  commands = data.get('commands') or {}
  targets: List[Tuple[str, Any, bool]] = [(id, command, False) for id, command in commands.items()] if isinstance(commands, dict) else []
  for command_id, submission in drivers.items():
    targets.append((command_id, {"runner": "kubernetes", "namespace": submission.get('namespace'), "user": submission.get('user')}, True))

  errors: List[str] = []
  stopped_drivers = []
  done = set()
  for command_id, command, is_driver in targets:
    runner = command.get('runner') if isinstance(command, dict) else None
    print(f"stopping {runner} {command_id}")
    try:
      job_options = stop_job_options(command_id, command)
    except NotAllowed as e:
      # The runs keep running: users should know
      print(f"WARNING: cannot stop the jobs of command {command_id!r}: {e}")
      errors.append(f"Could not stop the Kubernetes jobs of {command_id[:8]}: {e}")
      continue
    except ValueError as e:
      print(f"WARNING: cannot stop jobs for command {command_id!r}: {e}")
      continue
    # a driver and its `qa batch` in the same namespace: their jobs have the same command id
    key = (job_options['type'], job_options['command_id'], job_options.get('namespace'), job_options.get('context'))
    if key not in done:
      done.add(key)
      try:
        JobGroup(job_options=job_options).stop()
      except Exception as e:
        print(e)
        errors.append(str(e))
        continue
    if is_driver:
      stopped_drivers.append(command_id)
  return {"errors": errors, "stopped_drivers": stopped_drivers}


def mark_drivers_stopped(data, command_ids) -> dict:
  """batch.data, where these drivers' submissions are "stopped": we won't try to stop them again"""
  if not command_ids:
    return data
  submissions = {**data.get('submissions', {})}
  for command_id in command_ids:
    submissions[command_id] = {**submissions[command_id], "status": "stopped"}
  return {**data, "submissions": submissions}


# ==========================================
# Starting `qa batch` on Kubernetes
# ==========================================

DEFAULT_DRIVER_RESOURCES = {"cpu": "500m", "memory": "2Gi"}
_env_name = re.compile(r'^[-._a-zA-Z][-._a-zA-Z0-9]*$')


def driver_resources() -> Dict[str, Any]:
  value = os.environ.get('QABOARD_KUBERNETES_DRIVER_RESOURCES')
  if not value:
    return dict(DEFAULT_DRIVER_RESOURCES)
  try:
    resources = json.loads(value)
    if isinstance(resources, dict) and resources:
      return resources
  except ValueError:
    pass
  print(f"WARNING: QABOARD_KUBERNETES_DRIVER_RESOURCES should be a JSON object, e.g. {json.dumps(DEFAULT_DRIVER_RESOURCES)}, not {value!r}")
  return dict(DEFAULT_DRIVER_RESOURCES)


def project_kubernetes_config(ci_commit) -> dict:
  """The project's runners.kubernetes, like _dispatch_lsf reads runners.lsf"""
  qatools_config = (ci_commit.project.data or {}).get('qatools_config') or {}
  runners_config = qatools_config.get('runners', qatools_config) if isinstance(qatools_config, dict) else {}
  config = runners_config.get('kubernetes') if isinstance(runners_config, dict) else None
  return config if isinstance(config, dict) else {}


def driver_run_as(config: dict, user: str, notes: List[str]):
  """The run_as job option of driver pods: the signed-in user's UID/GID (and groups), or "image". Raises NotAllowed."""
  run_as = config.get('run_as', 'user')
  if run_as == 'image':
    return 'image'
  if run_as != 'user':
    notes.append(f"runners.kubernetes.run_as={json.dumps(run_as)} is ignored for batches started from QA-Board: they run as {user}.")
  from . import accounts
  account = accounts.account(user)
  if not account:
    raise NotAllowed(
      f"QA-Board doesn't know the Unix account of {user}: it starts batches on Kubernetes as their user (UID/GID), "
      "from its accounts (/etc/passwd or QABOARD_ACCOUNTS_COMMAND). Ask your QA-Board admins, "
      "or set `run_as: image` in runners.kubernetes in qaboard.yaml to run as the image's user."
    )
  if account.uid == 0 or account.gid == 0:
    raise NotAllowed(f"QA-Board never starts batches on Kubernetes as root, and {user} is uid {account.uid}, gid {account.gid}.")
  groups = sorted(gid for gid in accounts.group_ids(user, account.gid) if gid not in (0, account.gid))
  return {"uid": account.uid, "gid": account.gid, **({"groups": groups} if groups else {})}


def driver_job_options(config: dict, user: str, command_id: str, project_id: str) -> Tuple[Dict[str, Any], List[str]]:
  """
  The job options of the driver pod that runs `qa batch` for a batch started from QA-Board, from the project's
  runners.kubernetes (semi-trusted, see the module's docstring) and the server's settings.
  Returns (job_options, notes): notes tell users what from their config was not used. Raises NotAllowed.
  """
  notes: List[str] = []
  allowed = env_list('QABOARD_KUBERNETES_NAMESPACES')
  namespace = config.get('namespace') or (allowed[0] if allowed else None)
  job_options: Dict[str, Any] = {
    "type": "kubernetes",
    "command_id": command_id,
    # labels
    "user": safe_user_name(user),
    "project": project_id,
    **kubernetes_location({"namespace": namespace, "context": config.get('context')}, notes),
    "run_as": driver_run_as(config, user, notes),
    # The server's environment has its secrets
    "forward_env": False,
    # `qa optimize` runs as long as its experiment
    "timeout": 0,
    # it only starts the runs
    "resources": driver_resources(),
  }
  service_account = os.environ.get('QABOARD_KUBERNETES_SERVICE_ACCOUNT')
  if service_account:
    job_options['service_account'] = service_account

  def ignored(key, why):
    notes.append(f"runners.kubernetes.{key} is not used for the pod that starts the batch: {why}.")

  if config.get('image') is not None:
    image = config['image']
    if isinstance(image, str) and image and len(image) < 512 and not re.search(r'\s', image):
      job_options['image'] = image
    else:
      raise NotAllowed(f"Invalid runners.kubernetes.image: {image!r}")
  if config.get('image_pull_secrets') is not None:
    secrets = config['image_pull_secrets']
    if isinstance(secrets, str):
      secrets = [secrets]
    if isinstance(secrets, list) and all(is_dns1123_subdomain(s) for s in secrets):
      job_options['image_pull_secrets'] = secrets
    else:
      ignored('image_pull_secrets', "they should be a list of secret names")
  if config.get('queue') is not None:
    if is_label_value(config['queue']):
      job_options['queue'] = config['queue']
    else:
      ignored('queue', "invalid queue name")
  if config.get('priority_class') is not None:
    if is_dns1123_subdomain(config['priority_class']):
      job_options['priority_class'] = config['priority_class']
    else:
      ignored('priority_class', "invalid priority class name")
  if config.get('ttl_seconds_after_finished') is not None:
    ttl = config['ttl_seconds_after_finished']
    if isinstance(ttl, int) and not isinstance(ttl, bool) and ttl >= 0:
      job_options['ttl_seconds_after_finished'] = ttl
    else:
      ignored('ttl_seconds_after_finished', "it should be a number of seconds")
  if config.get('node_selector') is not None:
    selector = config['node_selector']
    if isinstance(selector, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in selector.items()):
      job_options['node_selector'] = selector
    else:
      ignored('node_selector', "it should map labels to values")
  if config.get('tolerations') is not None:
    tolerations = config['tolerations']
    if isinstance(tolerations, list) and all(isinstance(t, dict) for t in tolerations):
      job_options['tolerations'] = tolerations
    else:
      ignored('tolerations', "it should be a list of tolerations")
  if config.get('env') is not None:
    env = config['env']
    if isinstance(env, dict):
      job_options['env'] = {str(k): str(v) for k, v in env.items()
                            if isinstance(k, str) and _env_name.match(k) and isinstance(v, (str, int, float, bool))}
      if len(job_options['env']) != len(env):
        notes.append("Some variables of runners.kubernetes.env are not used: invalid names or values.")
    else:
      ignored('env', "it should map names to values")
  if config.get('mounts') is not None:
    job_options['mounts'] = driver_mounts(config['mounts'])
  if config.get('job_template'):
    ignored('job_template', "QA-Board only starts pods from the options it checks")
  return job_options, notes


def driver_mounts(mounts) -> List[dict]:
  """The project's mounts, for the driver pod. host_path mounts only with QABOARD_KUBERNETES_ALLOW_HOST_PATH. Raises NotAllowed."""
  if not isinstance(mounts, list):
    raise NotAllowed("runners.kubernetes.mounts should be a list, e.g. [{path: /algo, pvc: algo-nfs}]")
  for mount in mounts:
    if not isinstance(mount, dict) or not isinstance(mount.get('path'), str) or not mount['path'].startswith('/'):
      raise NotAllowed(f"Invalid mount in runners.kubernetes.mounts: {mount!r}. Each needs an absolute `path`, e.g. {{path: /algo, pvc: algo-nfs}}")
    if ('host_path' in mount or 'hostPath' in mount) and not env_flag('QABOARD_KUBERNETES_ALLOW_HOST_PATH'):
      raise NotAllowed(
        f"QA-Board doesn't start pods with host_path mounts ({mount['path']}): mount the storage with a PersistentVolumeClaim "
        "or NFS (`pvc:` or `nfs:` in runners.kubernetes.mounts), or ask your QA-Board admins to set QABOARD_KUBERNETES_ALLOW_HOST_PATH=1."
      )
  return mounts


def server_env_script(notes: List[str]) -> str:
  """Bash lines that tell `qa` in the pod where QA-Board is, and print the notes in the logs"""
  url = os.environ.get('QABOARD_KUBERNETES_SERVER_URL')
  if url:
    parsed = urlparse(url)
    protocol, host = parsed.scheme or 'http', parsed.netloc or parsed.path
  else:
    protocol, host = os.environ.get('QABOARD_PROTOCOL'), os.environ.get('QABOARD_HOST')
  lines = []
  if host:
    hostname = host.rsplit(':', 1)[0] if not host.endswith(']') else host
    lines += [
      f"export QABOARD_PROTOCOL={quote(protocol or 'http')}",
      f"export QABOARD_HOST={quote(host)}",
      # they would win over QABOARD_HOST
      "unset QABOARD_HOSTNAME QABOARD_PORT",
      f'export no_proxy="${{no_proxy:+$no_proxy,}}"{quote(hostname)}',
      f'export NO_PROXY="${{NO_PROXY:+$NO_PROXY,}}"{quote(hostname)}',
    ]
  lines += [f"echo {quote(f'[qaboard] {note}')}" for note in notes]
  return "".join(f"{line}\n" for line in lines)


def submit_driver(script_path: Path, log_dir: Path, user: str, ci_commit, command_id: str) -> Dict[str, Any]:
  """
  Runs the bash script `script_path` (a `qa batch`, see api/tuning.py and redo.py) on Kubernetes, in a driver pod named
  qa-<command_id[:8]>-driver, as `user`. Its output goes to log_dir/log.txt, and the job is labeled with command_id:
  stopping the batch deletes it, with the runs' Jobs.
  Returns {"kubernetes_job", "namespace"}. Raises if the pod could not be started, after writing why in log_dir/log.txt.
  """
  log_path = Path(log_dir) / 'log.txt'
  try:
    config = project_kubernetes_config(ci_commit)
    job_options, notes = driver_job_options(config, user, command_id, ci_commit.project_id)
    for note in notes:
      print(f"[kubernetes] {note}")
    # Like _dispatch_celery, at the top of the script
    script = Path(script_path).read_text()
    header = server_env_script(notes)
    if script.startswith("#!/bin/bash\n"):
      script = script.replace("#!/bin/bash\n", f"#!/bin/bash\n{header}", 1)
    else:
      script = header + script
    Path(script_path).write_text(script)

    from qaboard.runners import runners
    Runner = runners.get('kubernetes')
    if Runner is None:
      raise NotAllowed("This QA-Board server can't start Kubernetes runs: its `qa` has no kubernetes runner (it needs qaboard[kubernetes]).")
    name = f"qa-{command_id[:8]}-driver"
    result = Runner.submit_detached(script, name, log_path, job_options) or {}
    print(f"[kubernetes] started {result}")
    return {
      "kubernetes_job": result.get('kubernetes_job', name),
      "namespace": result.get('namespace', job_options['namespace']),
    }
  except Exception as e:
    # Users see this log in QA-Board. Before the pod started, nothing else writes in it.
    with log_path.open('a') as log:
      log.write(f"ERROR: Could not start `qa batch` on Kubernetes: {e}\n")
    raise
