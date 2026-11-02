"""
What the server asks runners to do, with options it can trust: stop batches, and start `qa batch` on Kubernetes.

1. Stopping batches (Batch.stop). `qa batch` registers its commands in batch.data.commands, with its runner and what
   is needed to stop its jobs. They are written by unauthenticated API calls (POST /api/v1/batch), and the runners use
   them in shell commands (e.g. `bkill` through the LSF bridge) or to choose which cluster to talk to. So we forward
   only a few options, after validating them (stop_job_options). What we can't stop is a warning, never an error: users
   can still stop and delete the batch.

2. Starting `qa batch` from the web app (api/tuning.py, redo.py) with QABOARD_TUNING_RUNNER=kubernetes. The script
   runs in a "driver" pod (a 1-pod Job named qa-<command_id[:8]>-driver, the kubernetes runner's submit_detached), as
   the signed-in user's UID/GID (or QABOARD_KUBERNETES_RUN_AS). The `qa batch` it runs starts the runs' Jobs with the
   pod's ServiceAccount (in-cluster config). The driver's command id is the batch's (QA_BATCH_COMMAND_ID) and every Job
   is labeled with it and the project: stopping the batch deletes them all.

The admins' settings:
- QABOARD_KUBERNETES_NAMESPACES: the namespaces where the server may start and stop runs, comma-separated. Empty (the
  default): none, Kubernetes batches can't be started or stopped from QA-Board. The server's credentials need the
  runner's Role there (the helm chart's runners.kubernetes creates it). The first namespace is where batches go when
  the commit's runners.kubernetes.namespace is not set.
- QABOARD_KUBERNETES_CONTEXTS: the kubeconfig contexts the server may use, comma-separated. Others are ignored, and the
  server uses its default: in a pod its ServiceAccount, else its kubeconfig's current context.
- QABOARD_KUBERNETES_SERVICE_ACCOUNT: the ServiceAccount of the driver pods, allowed to create the runs' Jobs (the
  helm chart creates one in each namespace, `<release>-qaboard-runs`). Unset: the namespace's default ServiceAccount.
- QABOARD_KUBERNETES_SERVER_URL: how pods reach QA-Board, e.g. http://qaboard-proxy.qaboard.svc (the helm chart sets
  it). Else QABOARD_HOST and QABOARD_PROTOCOL, if set. Else whatever `qa` uses in the image (e.g. a site package).
- QABOARD_KUBERNETES_RUN_AS: `user` (default): driver pods run as the signed-in user's UID/GID, from the server's
  accounts (accounts.py). `<uid>:<gid>`: all of them run as this account, e.g. a team account.
- QABOARD_KUBERNETES_MIN_UID (default 1000): with `user`, users whose UID is lower can't start batches on Kubernetes.
- QABOARD_KUBERNETES_TRUST_LOCAL_ACCOUNTS=1: with `user`, also map the UIDs of local accounts (anyone may sign up and
  pick a user name). By default only users who signed in with the directory (LDAP, SAML, OIDC) are mapped to its UIDs.
- QABOARD_KUBERNETES_ALLOW_RUN_AS_IMAGE=1: projects with `run_as: image` may run as the image's user even if it's
  root. By default their pods get runAsNonRoot.
- QABOARD_KUBERNETES_ALLOW_HOST_PATH=1: allows `host_path` mounts in driver pods. Off by default.
- QABOARD_KUBERNETES_DRIVER_RESOURCES: the driver pod's resources requests, as JSON. Default: {"cpu": "500m", "memory": "2Gi"}

Trust model: **a namespace is a trust domain**. The driver runs the commit's code (`qa batch`, its .envrc,
iter_inputs...) with the namespace's runs ServiceAccount, that can create Jobs: any pod the namespace accepts, as any
UID it accepts. So everyone who can start batches from the web app in a namespace can act as anyone else in it, and
an admission policy keyed on the `qaboard.io/user` label can't tell them apart (they share the ServiceAccount). Use one
namespace per team, like the queues of W&B Launch or ClearML. For a deployment whose users must not act as each other,
see "Follow-ups" in docs/design/kubernetes-runner.md. QABOARD_KUBERNETES_RUN_AS=<uid>:<gid>, with a
ValidatingAdmissionPolicy that pins runAsUser for the runs ServiceAccount, isolates a namespace's batches from other
namespaces' users.

What the server still checks, since qaboard.yaml is written by whoever can push to the project: driver pods never run
as root or as a UID/GID from qaboard.yaml; the commit's `job_template` and `forward_env` (the server's environment
has its secrets) are not used; mounts are only PVCs and NFS (host_path with QABOARD_KUBERNETES_ALLOW_HOST_PATH=1);
env can't change how bash, Python, `qa` or the Kubernetes client behave. What runs may do (users, volumes,
privileges) must be enforced by the admins with the namespace's Pod Security Standard and admission policies, and
quotas with ResourceQuota or Kueue.
"""
import os
import re
import json
from pathlib import Path
from shlex import quote
from typing import Any, Callable, Dict, List, Optional, Tuple
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
  """Valid as the name of most objects (secrets, priority classes, PVCs...)"""
  return isinstance(value, str) and len(value) <= 253 and all(is_dns1123_label(part) for part in value.split('.'))

_label_value = re.compile(r'^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$')

def is_label_value(value) -> bool:
  return isinstance(value, str) and len(value) <= 63 and bool(_label_value.match(value))

# What `qa batch` and the server use as command ids: str(uuid.uuid4())
_command_id = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')

def is_command_id(value) -> bool:
  return isinstance(value, str) and bool(_command_id.fullmatch(value))


def allowed_namespace(namespace) -> str:
  """The namespace, if the server may start and stop runs there (QABOARD_KUBERNETES_NAMESPACES). Raises NotAllowed."""
  allowed = env_list('QABOARD_KUBERNETES_NAMESPACES')
  if not allowed:
    raise NotAllowed(
      "This QA-Board server can't start or stop runs on Kubernetes: its admins didn't set QABOARD_KUBERNETES_NAMESPACES, "
      "the namespaces where it may (comma-separated, with permissions for the server there: see runners.kubernetes in the helm chart)."
    )
  if not namespace:
    raise NotAllowed(
      "QA-Board doesn't know in which Kubernetes namespace these runs are, so it can't start or stop them: "
      f"set runners.kubernetes.namespace in qaboard.yaml (QA-Board may use: {', '.join(allowed)})."
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


def stop_job_options(command_id, command, project_id: Optional[str] = None) -> Dict[str, Any]:
  """
  The job options the runner of a `qa batch` command (from batch.data.commands, untrusted) needs to stop its jobs.
  With Kubernetes, `project` (the batch's project, as the server knows it) limits what is deleted to that project's
  objects: the runner selects them with the labels qaboard.io/command-id and qaboard.io/project, both sanitized with
  qaboard.runners.labels.label_value.
  Raises ValueError if we can't stop them, NotAllowed if the server's settings don't let it.
  """
  if not isinstance(command, dict):
    raise ValueError(f"invalid command {command!r}")
  runner = command.get('runner')
  if runner not in STOPPABLE_RUNNERS:
    raise ValueError(f"cannot stop jobs for runner {runner!r}")
  if not is_command_id(command_id):
    raise ValueError(f"invalid command id {command_id!r}: QA-Board only stops commands with ids like qa batch's (uuid4)")
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
        # `qa batch` sends {"kubernetes": {"namespace", "context"}}, like the dask runner's job options
        kubernetes = command.get('kubernetes')
        job_options['kubernetes'] = kubernetes_location(kubernetes if isinstance(kubernetes, dict) else {})
        if project_id:
          job_options['kubernetes']['project'] = project_id
    # Other cluster types are stopped with their scheduler's command (scancel, qdel...): it must be installed on the server
  if runner == "kubernetes":
    job_options.update(kubernetes_location(command))
    if project_id:
      job_options['project'] = project_id
  return job_options


DRIVER_STOPPABLE_STATUSES = ("submitting", "submitted", "failed")

def kubernetes_drivers(data) -> Dict[str, dict]:
  """
  The driver pods of the batches started from QA-Board on Kubernetes that may still exist: {command_id: submission}.
  We record them before submitting them, so they may exist even if the submission is still "submitting" or "failed".
  """
  submissions = (data or {}).get('submissions') or {}
  if not isinstance(submissions, dict):
    return {}
  return {
    id: submission for id, submission in submissions.items()
    if isinstance(submission, dict)
    and submission.get('runner') == 'kubernetes'
    and submission.get('status') in DRIVER_STOPPABLE_STATUSES
    and submission.get('kubernetes_job')
    and not submission.get('driver_stopped')
  }


def is_not_found(error: Exception) -> bool:
  """The Kubernetes API said 404: what we wanted to delete is already gone"""
  return getattr(error, 'status', None) == 404


def stop_batch_jobs(data, has_pending_runs: bool, project_id: Optional[str] = None) -> Optional[Dict[str, list]]:
  """
  Stops the jobs of a batch (batch.data, of the project `project_id`): its `qa batch` commands, and the driver pods of
  the batches started from QA-Board on Kubernetes (their Jobs, and the runs' Jobs in the same namespace: they have
  the same command id).
  Returns None when there is nothing to stop, else {"errors": [...], "warnings": [...], "stopped_drivers": [ids]}.
  Errors are the runners' (e.g. the cluster refused): the runs may still run. Warnings are commands we won't stop.
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
  warnings: List[str] = []
  stopped_drivers = []
  done = set()
  for command_id, command, is_driver in targets:
    runner = command.get('runner') if isinstance(command, dict) else None
    print(f"stopping {runner} {command_id}")
    try:
      job_options = stop_job_options(command_id, command, project_id)
    except (NotAllowed, ValueError) as e:
      print(f"WARNING: cannot stop jobs for command {command_id!r}: {e}")
      warnings.append(f"Could not stop the jobs of {str(command_id)[:8]}: {e}")
      continue
    # a driver and its `qa batch` in the same namespace: their jobs have the same command id
    key = json.dumps({k: v for k, v in job_options.items() if k != 'user'}, sort_keys=True)
    if key not in done:
      done.add(key)
      try:
        deleted = JobGroup(job_options=job_options).stop()
        if runner == 'kubernetes' and deleted == 0 and not is_driver and has_pending_runs:
          # e.g. the runs are in another cluster than the server's (kubeconfig context not allowed): they may still run
          warnings.append(f"No Kubernetes job of {str(command_id)[:8]} was found in namespace {job_options.get('namespace')}: if its runs are still running, they are elsewhere.")
      except Exception as e:
        if not (is_driver and is_not_found(e)):
          print(e)
          errors.append(str(e))
          continue
    if is_driver:
      stopped_drivers.append(command_id)
  return {"errors": errors, "warnings": warnings, "stopped_drivers": stopped_drivers}


def mark_drivers_stopped(data, command_ids) -> dict:
  """batch.data, where these drivers are deleted: we won't try to stop them again"""
  if not command_ids:
    return data
  submissions = {**data.get('submissions', {})}
  for command_id in command_ids:
    submission = {**submissions[command_id], "driver_stopped": True}
    if submission.get('status') in ('submitting', 'submitted'):
      submission['status'] = 'stopped'
    submissions[command_id] = submission
  return {**data, "submissions": submissions}


# ==========================================
# Starting `qa batch` on Kubernetes
# ==========================================

DEFAULT_DRIVER_RESOURCES = {"cpu": "500m", "memory": "2Gi"}
_env_name = re.compile(r'^[-._a-zA-Z][-._a-zA-Z0-9]*$')
# Variables that change how bash, Python, the dynamic linker, the Kubernetes client or `qa` behave
_forbidden_env = re.compile(r'^(BASH_ENV|ENV|PATH|LD_.*|PYTHON.*|KUBERNETES_.*|QA.*)$', re.IGNORECASE)
# What the signed-in user's identity comes from: the directory's UIDs are theirs. Anyone may create a local account.
DIRECTORY_LOGIN_TYPES = ("LDAP", "SAML", "OIDC")
MOUNT_KEYS = ("path", "pvc", "nfs", "read_only", "sub_path")


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


def commit_kubernetes_config(ci_commit) -> dict:
  """
  runners.kubernetes from the commit's own qaboard.yaml: the batch runs the commit's code, with its config. Only if
  `qa` never sent it, the project's (like api/tuning.py's commit_qaboard_config).
  """
  qatools_config = (ci_commit.data or {}).get('qatools_config') or (ci_commit.project.data or {}).get('qatools_config') or {}
  runners_config = qatools_config.get('runners', qatools_config) if isinstance(qatools_config, dict) else {}
  config = runners_config.get('kubernetes') if isinstance(runners_config, dict) else None
  return config if isinstance(config, dict) else {}


def fixed_run_as() -> Optional[Dict[str, int]]:
  """QABOARD_KUBERNETES_RUN_AS=<uid>:<gid>, the account of all the driver pods. None for `user` (the default)."""
  value = os.environ.get('QABOARD_KUBERNETES_RUN_AS', '').strip()
  if value in ('', 'user'):
    return None
  match = re.match(r'^(\d+):(\d+)$', value)
  if not match or int(match.group(1)) == 0 or int(match.group(2)) == 0:
    raise NotAllowed(f"This QA-Board server is misconfigured: QABOARD_KUBERNETES_RUN_AS should be `user` or `<uid>:<gid>` (not root), not {value!r}. Tell its admins.")
  return {"uid": int(match.group(1)), "gid": int(match.group(2))}


def driver_run_as(config: dict, user_info: dict, notes: List[str]) -> Tuple[Any, bool]:
  """
  The run_as and run_as_non_root job options of driver pods: QABOARD_KUBERNETES_RUN_AS's account, else the signed-in
  user's UID/GID (and groups) if their identity comes from the directory, or "image" if the commit asks.
  Raises NotAllowed.
  """
  user = user_info['user_name']
  run_as = config.get('run_as', 'user')
  fixed = fixed_run_as()
  if fixed:
    if run_as != 'user':
      notes.append(f"runners.kubernetes.run_as={json.dumps(run_as)} is ignored: this QA-Board server starts batches as uid {fixed['uid']}.")
    return fixed, True
  if run_as == 'image':
    # unless the admins allow it, the image's user must not be root
    return 'image', not env_flag('QABOARD_KUBERNETES_ALLOW_RUN_AS_IMAGE')
  if run_as != 'user':
    notes.append(f"runners.kubernetes.run_as={json.dumps(run_as)} is ignored for batches started from QA-Board: they run as {user}.")
  login_type = str(user_info.get('login_type') or 'LOCAL').upper()
  if login_type not in DIRECTORY_LOGIN_TYPES and not env_flag('QABOARD_KUBERNETES_TRUST_LOCAL_ACCOUNTS'):
    raise NotAllowed(
      f"QA-Board starts batches on Kubernetes as their user's Unix account, and only for users who signed in with the "
      f"directory (LDAP, SAML, OIDC): {user} has a {login_type.lower()} account, whose name anyone could have chosen. "
      "Sign in with the directory, or ask your QA-Board admins (QABOARD_KUBERNETES_TRUST_LOCAL_ACCOUNTS=1 if they "
      "create the local accounts themselves, or QABOARD_KUBERNETES_RUN_AS)."
    )
  from . import accounts
  account = accounts.account(user)
  if not account:
    raise NotAllowed(
      f"QA-Board doesn't know the Unix account of {user}: it starts batches on Kubernetes as their user (UID/GID), "
      "from its accounts (/etc/passwd or QABOARD_ACCOUNTS_COMMAND). Ask your QA-Board admins, "
      "or set `run_as: image` in runners.kubernetes in qaboard.yaml to run as the image's user."
    )
  try:
    min_uid = int(os.environ.get('QABOARD_KUBERNETES_MIN_UID', 1000))
  except ValueError:
    min_uid = 1000
  if account.uid == 0 or account.gid == 0:
    raise NotAllowed(f"QA-Board never starts batches on Kubernetes as root, and {user} is uid {account.uid}, gid {account.gid}.")
  if account.uid < min_uid:
    raise NotAllowed(f"QA-Board doesn't start batches on Kubernetes as system accounts: {user} is uid {account.uid}, below {min_uid} (QABOARD_KUBERNETES_MIN_UID).")
  groups = sorted(gid for gid in accounts.group_ids(user, account.gid) if gid not in (0, account.gid))
  return {"uid": account.uid, "gid": account.gid, **({"groups": groups} if groups else {})}, True


def driver_job_options(config: dict, user_info: dict, command_id: str, project_id: str) -> Tuple[Dict[str, Any], List[str]]:
  """
  The job options of the driver pod that runs `qa batch` for a batch started from QA-Board, from the commit's
  runners.kubernetes (semi-trusted, see the module's docstring) and the server's settings.
  `user` and `project` are labels: the runner sanitizes them with qaboard.runners.labels.label_value.
  Returns (job_options, notes): notes tell users what from their config was not used. Raises NotAllowed.
  """
  notes: List[str] = []
  user = safe_user_name(user_info.get('user_name'))
  allowed = env_list('QABOARD_KUBERNETES_NAMESPACES')
  namespace = config.get('namespace') or (allowed[0] if allowed else None)
  run_as, run_as_non_root = driver_run_as(config, {**user_info, "user_name": user}, notes)
  job_options: Dict[str, Any] = {
    "type": "kubernetes",
    "command_id": command_id,
    # labels
    "user": user,
    "project": project_id,
    **kubernetes_location({"namespace": namespace, "context": config.get('context')}, notes),
    "run_as": run_as,
    "run_as_non_root": run_as_non_root,
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
      job_options['env'] = {}
      for name, value in env.items():
        if not (isinstance(name, str) and _env_name.match(name) and isinstance(value, (str, int, float, bool))):
          notes.append(f"runners.kubernetes.env.{name} is not used: invalid name or value.")
        elif _forbidden_env.match(name):
          notes.append(f"runners.kubernetes.env.{name} is not used for the pod that starts the batch: it would change how bash, Python, qa or the Kubernetes client behave.")
        else:
          job_options['env'][name] = str(value)
    else:
      ignored('env', "it should map names to values")
  if config.get('mounts') is not None:
    job_options['mounts'] = driver_mounts(config['mounts'])
  if config.get('job_template'):
    ignored('job_template', "QA-Board only starts pods from the options it checks")
  return job_options, notes


def _is_absolute_path(value) -> bool:
  return isinstance(value, str) and value.startswith('/') and '..' not in value.split('/')


def driver_mounts(mounts) -> List[dict]:
  """
  The commit's mounts, for the driver pod: {path, pvc | nfs: {server, path}, read_only, sub_path}. host_path mounts
  only with QABOARD_KUBERNETES_ALLOW_HOST_PATH. Raises NotAllowed.
  """
  example = "e.g. [{path: /algo, pvc: algo-nfs}, {path: /home, nfs: {server: nas1, path: /export/home}}]"
  if not isinstance(mounts, list):
    raise NotAllowed(f"runners.kubernetes.mounts should be a list, {example}")
  allow_host_path = env_flag('QABOARD_KUBERNETES_ALLOW_HOST_PATH')
  for mount in mounts:
    if not isinstance(mount, dict) or not _is_absolute_path(mount.get('path')):
      raise NotAllowed(f"Invalid mount in runners.kubernetes.mounts: {mount!r}. Each needs an absolute `path`, {example}")
    if 'host_path' in mount or 'hostPath' in mount:
      if not allow_host_path:
        raise NotAllowed(
          f"QA-Board doesn't start pods with host_path mounts ({mount['path']}): mount the storage with a PersistentVolumeClaim "
          "or NFS (`pvc:` or `nfs:` in runners.kubernetes.mounts), or ask your QA-Board admins to set QABOARD_KUBERNETES_ALLOW_HOST_PATH=1."
        )
      if set(mount) - {*MOUNT_KEYS, 'host_path'} or not _is_absolute_path(mount.get('host_path')):
        raise NotAllowed(f"Invalid mount in runners.kubernetes.mounts: {mount!r}, e.g. {{path: /data, host_path: /data}}")
      continue
    unknown = set(mount) - set(MOUNT_KEYS)
    if unknown:
      raise NotAllowed(f"QA-Board doesn't start pods with these mount settings: {', '.join(sorted(map(str, unknown)))} ({mount['path']}). It supports {', '.join(MOUNT_KEYS)}.")
    if ('pvc' in mount) == ('nfs' in mount):
      raise NotAllowed(f"Each mount in runners.kubernetes.mounts needs one of `pvc` or `nfs` ({mount['path']}), {example}")
    if 'pvc' in mount and not is_dns1123_subdomain(mount['pvc']):
      raise NotAllowed(f"Invalid PersistentVolumeClaim name in runners.kubernetes.mounts: {mount['pvc']!r}")
    if 'nfs' in mount:
      nfs = mount['nfs']
      if not (isinstance(nfs, dict) and set(nfs) <= {'server', 'path', 'read_only'}
              and isinstance(nfs.get('server'), str) and re.match(r'^[A-Za-z0-9.:\[\]-]+$', nfs['server'])
              and _is_absolute_path(nfs.get('path')) and isinstance(nfs.get('read_only', False), bool)):
        raise NotAllowed(f"Invalid NFS mount in runners.kubernetes.mounts: {nfs!r}, e.g. {{server: nas1, path: /export/home}}")
    if not isinstance(mount.get('read_only', False), bool):
      raise NotAllowed(f"runners.kubernetes.mounts: read_only should be true or false ({mount['path']})")
    if 'sub_path' in mount:
      sub_path = mount['sub_path']
      if not (isinstance(sub_path, str) and sub_path and not sub_path.startswith('/') and '..' not in sub_path.split('/')):
        raise NotAllowed(f"runners.kubernetes.mounts: sub_path should be a relative path, without '..' ({mount['path']})")
  return mounts


def server_address() -> Tuple[Optional[str], Optional[str]]:
  """(protocol, host[:port]) where pods reach QA-Board: QABOARD_KUBERNETES_SERVER_URL, else QABOARD_PROTOCOL/QABOARD_HOST"""
  url = os.environ.get('QABOARD_KUBERNETES_SERVER_URL', '').strip()
  if url:
    # "host:8080" has no scheme: urlparse would read "host" as one
    parsed = urlparse(url if '://' in url else f"http://{url}")
    return parsed.scheme or 'http', parsed.netloc or None
  return os.environ.get('QABOARD_PROTOCOL'), os.environ.get('QABOARD_HOST')


def server_env_script(notes: List[str]) -> str:
  """Bash lines that tell `qa` in the pod where QA-Board is, and print the notes in the logs"""
  protocol, host = server_address()
  lines = []
  if host:
    hostname = urlparse(f"//{host}").hostname or host
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


def driver_name(command_id: str) -> str:
  return f"qa-{command_id[:8]}-driver"


def submit_driver(script_path: Path, log_dir: Path, user_info: dict, ci_commit, command_id: str,
                  on_prepared: Optional[Callable[[Dict[str, Any]], None]] = None) -> Dict[str, Any]:
  """
  Runs the bash script `script_path` (a `qa batch`, see api/tuning.py and redo.py) on Kubernetes, in a driver pod named
  qa-<command_id[:8]>-driver, as the signed-in user (`user_info`, g.user). Its output goes to log_dir/log.txt, and the
  job is labeled with command_id and the project: stopping the batch deletes it, with the runs' Jobs.
  `on_prepared({"kubernetes_job", "namespace"})` is called before the job is submitted: record it, so that the batch
  can be stopped even if we don't get to record what happened next.
  Returns {"kubernetes_job", "namespace"}. Raises if the pod could not be started, after writing why in log_dir/log.txt.
  """
  log_path = Path(log_dir) / 'log.txt'
  Runner, job_options = None, None
  try:
    config = commit_kubernetes_config(ci_commit)
    job_options, notes = driver_job_options(config, user_info, command_id, ci_commit.project_id)
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
    if 'kubernetes' not in runners:
      raise NotAllowed("This QA-Board server can't start Kubernetes runs: its `qa` has no kubernetes runner (it needs qaboard[kubernetes]).")
    record = {"kubernetes_job": driver_name(command_id), "namespace": job_options['namespace']}
    if on_prepared:
      on_prepared(record)
    Runner = runners['kubernetes']
    result = Runner.submit_detached(script, record['kubernetes_job'], log_path, job_options) or {}
    print(f"[kubernetes] started {result}")
    return {
      "kubernetes_job": result.get('kubernetes_job', record['kubernetes_job']),
      "namespace": result.get('namespace', record['namespace']),
    }
  except Exception as e:
    # Users see this log in QA-Board. Before the pod started, nothing else writes in it.
    with log_path.open('a') as log:
      log.write(f"ERROR: Could not start `qa batch` on Kubernetes: {e}\n")
    if Runner is not None and job_options is not None:
      # It may have been created before it failed
      try:
        stop_options = {k: job_options[k] for k in ('type', 'command_id', 'namespace', 'context', 'project', 'user') if k in job_options}
        Runner.stop_jobs([], stop_options)
      except Exception as cleanup_error:
        print(f"WARNING: could not delete {driver_name(command_id)}: {cleanup_error}")
    raise
