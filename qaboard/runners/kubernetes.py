"""
Run `qa run` commands as Kubernetes Jobs.

Each run is a pod of an Indexed Job (several runs per pod with `runs_per_pod`). The runs' commands are in a ConfigMap
owned by the Job: the pods run `sh /etc/qaboard/run-$JOB_COMPLETION_INDEX.sh`, which runs where `qa batch` runs and
writes each run's output live to <output_dir>/log.k8s.txt (pod logs vanish with the pod).
We assume the pods see the code, inputs and outputs at the same paths as the machine running `qa batch` (`mounts`).

Setup: `pip install "qaboard[kubernetes]"`. We use your kubeconfig (the `context` option, or the current context),
or, in a pod without kubeconfig, the pod's ServiceAccount. `qa doctor --runner kubernetes` checks everything,
including the permissions you need in the namespace (and gives a Role to send your admins).

qaboard.yaml:
  runners:
    default: kubernetes
    kubernetes:
      namespace: algo-qa           # default: the context's namespace, else "default"
      # context: my-cluster        # kubeconfig context. Default: current
      image: registry.example.com/algo/qa-env:2026.11  # must have `qa` and your code's dependencies
      # image_pull_secrets: [registry-creds]
      # queue: algo-gpu            # Kueue LocalQueue
      # priority_class: batch-low
      concurrency: 50              # pods at the same time, per `qa batch` (Job parallelism). 0: all
      # runs_per_pod: 1            # >1: each pod does several runs, one after the other
      # timeout: 3600              # seconds, per pod. 0: none
      resources: {cpu: 4, memory: 16Gi}  # requests. memory and extended resources (nvidia.com/gpu) also as limits
      # node_selector: {pool: gpu}
      # tolerations: [{key: nvidia.com/gpu, operator: Exists, effect: NoSchedule}]
      # run_as: user               # user (default): your UID/GID/groups, never root | image | {uid: 1000, gid: 1000, groups: [...]}
      # run_as_non_root: true      # with run_as: image, refuse images that run as root
      # service_account: qa-runs   # the pods' ServiceAccount
      mounts:                      # the shared filesystem, at the same paths in the pods. Optional: read_only, sub_path
        - {path: /algo, pvc: algo-nfs}
        # - {path: /home, nfs: {server: nas1, path: /export/home}}
        # - {path: /data, host_path: /data}
      # env: {OMP_NUM_THREADS: "4"}
      # forward_env: true          # qa's environment, minus secrets and host-specific variables (PATH, HOME, locale...)
      # job_template: k8s/qa-job.yaml  # a batch/v1 Job, merged with what QA-Board generates (see job_body)
      # ttl_seconds_after_finished: 86400

Notes:
- Secrets (variables named like *TOKEN*, *SECRET*...) are not forwarded: the environment is stored in a ConfigMap.
  To give runs a QA-Board token, use a Kubernetes Secret in `job_template` (env.valueFrom.secretKeyRef).
- HOME is yours if it's under `mounts`, else /tmp. USER/LOGNAME are yours: pods' UIDs rarely are in the image's /etc/passwd.
  CA bundle variables (SSL_CERT_FILE...) are forwarded only if under `mounts`, proxies on localhost are not.
- Names and labels: Jobs are named qa-<command_id[:8]>-<group>-<chunk>, labeled app.kubernetes.io/managed-by=qaboard,
  qaboard.io/command-id, qaboard.io/user and qaboard.io/project. Stopping a batch deletes the Jobs with its command-id.
"""
import os
import re
import sys
import json
import time
import shlex
import shutil
import signal
import uuid
from pathlib import Path
from copy import deepcopy
from dataclasses import dataclass, field, fields, replace
from typing import Optional, List, Dict, Any, Tuple, Iterable, Iterator, Union, Callable

from click import secho

from .base import BaseRunner
from .job import Job
from .env import forwarded_env
from .labels import label_value
from ..run import RunContext
from ..checks import Check, OK, WARNING, ERROR, SKIPPED


@dataclass
class KubernetesOptions():
  namespace: Optional[str] = None
  context: Optional[str] = None
  image: Optional[str] = None
  image_pull_secrets: List[str] = field(default_factory=list)
  # Kueue LocalQueue
  queue: Optional[str] = None
  priority_class: Optional[str] = None
  # Max number of pods of a `qa batch` running at the same time (Job parallelism). 0: all.
  concurrency: int = 0
  runs_per_pod: int = 1
  # seconds, per pod (activeDeadlineSeconds). 0: none
  timeout: float = 0
  resources: Dict[str, Any] = field(default_factory=dict)
  node_selector: Dict[str, str] = field(default_factory=dict)
  tolerations: List[Dict[str, Any]] = field(default_factory=list)
  # "user" | "image" | {"uid": 1000, "gid": 1000, "groups": [...]}
  run_as: Union[str, Dict[str, Any]] = 'user'
  # e.g. with run_as: image, refuse images that run as root
  run_as_non_root: bool = False
  service_account: Optional[str] = None
  # [{"path": "/algo", "pvc": "algo-nfs"} | {"path", "nfs": {"server", "path"}} | {"path", "host_path": "/algo"}], with optional read_only, sub_path
  mounts: List[Dict[str, Any]] = field(default_factory=list)
  env: Dict[str, Any] = field(default_factory=dict)
  forward_env: bool = True
  # Path to a batch/v1 Job YAML
  job_template: Optional[str] = None
  ttl_seconds_after_finished: int = 86400
  # Set by `qa batch`
  command_id: str = ''
  batch_dir: Optional[str] = None
  user: Optional[str] = None
  project: Optional[str] = None

kubernetes_option_names = set(f.name for f in fields(KubernetesOptions))

def dict_to_KubernetesOptions(job_options: Dict[str, Any]) -> KubernetesOptions:
  filtered_options = {k: v for k, v in job_options.items() if k in kubernetes_option_names and v is not None}
  return replace(KubernetesOptions(), **filtered_options)

# Options that change the pods' spec. Runs that differ (e.g. per input type) go in different Jobs.
pod_option_names = (
  'image', 'image_pull_secrets', 'queue', 'priority_class', 'resources', 'node_selector', 'tolerations', 'run_as',
  'run_as_non_root', 'service_account', 'mounts', 'env', 'forward_env', 'job_template', 'ttl_seconds_after_finished',
)

# A ConfigMap must be under 1MiB
max_configmap_bytes = 900 * 1024
# How often we look at the Jobs while waiting
poll_interval = 5 # seconds
# ErrImagePull can be a registry hiccup, but not for that long
image_pull_grace = 300 # seconds
scripts_dir = '/etc/qaboard'

def install_hint() -> str:
  return 'pip install "qaboard[kubernetes]"   # or: uv add "qaboard[kubernetes]"'

def import_kubernetes():
  try:
    import kubernetes # type: ignore
  except ImportError:
    raise Exception(f'The kubernetes runner needs the kubernetes Python client: {install_hint()}') from None
  return kubernetes


###
### Names and labels
###
def dns_name(value: str) -> str:
  """A valid object name (DNS label, so that it works for Jobs: their pods get a label with it)."""
  value = re.sub(r'[^a-z0-9-]+', '-', value.lower())[:63]
  return value.strip('-')

def batch_selector(command_id: str, project: Optional[str] = None) -> str:
  """The label selector of a batch's objects. command_id may come from untrusted input: it must already be a valid label value."""
  # valid label values are the ones label_value() keeps
  if not isinstance(command_id, str) or not command_id or label_value(command_id) != command_id:
    raise ValueError(f'Invalid command id: {command_id!r}')
  selector = f'qaboard.io/command-id={command_id}'
  if project:
    selector += f',qaboard.io/project={label_value(project)}'
  return selector

def object_labels(options: KubernetesOptions) -> Dict[str, str]:
  labels = {
    'app.kubernetes.io/managed-by': 'qaboard',
    'qaboard.io/command-id': label_value(options.command_id),
    'qaboard.io/user': label_value(options.user or ''),
    'qaboard.io/project': label_value(options.project or ''),
  }
  return {k: v for k, v in labels.items() if v}


###
### The scripts the pods run
###
k8s_excluded_env = {
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'DISPLAY', 'LANG', 'LANGUAGE', 'MAIL', 'PS1',
  'LD_LIBRARY_PATH', 'VIRTUAL_ENV', 'PYTHONHOME', 'KUBECONFIG',
}
k8s_excluded_env_prefixes = ('LC_', 'XDG_', 'SSH_', 'KUBERNETES_', 'CONDA_', 'DBUS_')
# Paths to CA bundles: forwarded only if the pods see them
ca_bundle_env = ('SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'PIP_CERT', 'NODE_EXTRA_CA_CERTS', 'GIT_SSL_CAINFO', 'AWS_CA_BUNDLE')
proxy_env = ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')

def run_env(options: KubernetesOptions) -> Dict[str, str]:
  """The runs' environment. The pods run another image: what is specific to our machine (PATH, locale...) stays here."""
  def is_shared(path: str) -> bool:
    return any(is_under(path, m.get('path', '')) for m in options.mounts)
  home = os.environ.get('HOME', '')
  user = options.user or os.environ.get('USER') or os.environ.get('LOGNAME')
  if not user and options.forward_env:
    import getpass
    try:
      user = getpass.getuser()
    except Exception:
      pass
  env = {
    # click needs a UTF-8 locale, C.UTF-8 is in all images
    'LANG': 'C.UTF-8',
    'LC_ALL': 'C.UTF-8',
    # Runs are headless
    'MPLBACKEND': 'agg',
    # The pods' user often has no home: tools would fail writing their caches in /
    'HOME': home if options.forward_env and home and is_shared(home) else '/tmp',
    # Nor an entry in the image's /etc/passwd: without them, getpass.getuser() fails (qa uses it)
    **({'USER': user, 'LOGNAME': user} if user else {}),
  }
  if options.forward_env:
    for k, v in forwarded_env(k8s_excluded_env, k8s_excluded_env_prefixes).items():
      if k in ca_bundle_env and not is_shared(v):
        continue
      # e.g. a proxy on our machine
      if k.upper() in proxy_env and re.search(r'//(localhost|127\.|\[::1\])', v):
        continue
      env[k] = v
  env.update({k: str(v) for k, v in options.env.items()})
  return env

def is_under(path: str, directory: str) -> bool:
  directory = directory.rstrip('/')
  return bool(directory) and (path == directory or path.startswith(directory + '/'))

def env_script(env: Dict[str, str]) -> str:
  lines = [f'export {k}={shlex.quote(v)}' for k, v in sorted(env.items()) if re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', k)]
  return '\n'.join(lines) + '\n'

def run_script(runs: List[Dict[str, Any]]) -> str:
  """
  Runs a pod's runs one after the other, each with its output live in <output_dir>/log.k8s.txt, even if one fails.
  Fails if any failed. `runs`: [{"command", "cwd", "output_dir"}]
  Note: `qa run` cleans its output directory but keeps the file its output goes to.
  """
  lines = [
    '#!/bin/sh',
    '# QA-Board runs, see qaboard/runners/kubernetes.py',
    '. "$(dirname "$0")/env.sh"',
    'failed=0',
  ]
  for index, run in enumerate(runs, start=1):
    output_dir = run.get('output_dir')
    name = shlex.quote(output_dir or run['command'])
    lines.append(f'echo "[qaboard] run {index}/{len(runs)}:" {name}')
    lines.append('(')
    if output_dir:
      lines.append(f'  mkdir -p {shlex.quote(output_dir)} && exec > {shlex.quote(output_dir + "/log.k8s.txt")} 2>&1 || exit 1')
    lines.append(f'  cd {shlex.quote(run["cwd"])} || exit 1')
    lines.append(f'  {run["command"]}')
    lines.append(f') || {{ code=$?; failed=$((failed + 1)); echo "[qaboard] run {index}/{len(runs)} failed with exit code $code:" {name}; }}')
  lines.append('[ "$failed" -eq 0 ]')
  return '\n'.join(lines) + '\n'

def job_to_run(job: Job) -> Dict[str, Any]:
  output_dir = job.run_context.output_dir
  return {
    "command": job.run_context.command or 'echo OK',
    # Like other runners, we run where `qa batch` runs: the root of the project (it changes directory there).
    # Commands start with "cd {subproject}" if needed.
    "cwd": os.getcwd(),
    "output_dir": str(output_dir.resolve()) if output_dir else None,
  }


###
### Specs
###
def deep_merge(base: Any, override: Any) -> Any:
  """
  `override` merged into `base`:
  - dicts are merged key by key,
  - lists of named objects (containers, volumes, env...) are merged by name,
  - other lists of objects (tolerations...) are concatenated,
  - otherwise (values, lists of strings like a command) `override` wins.
  """
  if isinstance(base, dict) and isinstance(override, dict):
    merged = dict(base)
    for k, v in override.items():
      merged[k] = deep_merge(base[k], v) if k in base else deepcopy(v)
    return merged
  if isinstance(base, list) and isinstance(override, list) and all(isinstance(x, dict) for x in base + override):
    if all('name' in x for x in base + override):
      merged_list = [dict(x) for x in base]
      for item in override:
        index = next((i for i, x in enumerate(merged_list) if x['name'] == item['name']), None)
        if index is None:
          merged_list.append(deepcopy(item))
        else:
          merged_list[index] = deep_merge(merged_list[index], item)
      return merged_list
    return [*base, *[deepcopy(x) for x in override if x not in base]]
  return deepcopy(override)

def load_job_template(path: Optional[str]) -> Dict[str, Any]:
  if not path:
    return {}
  import yaml
  try:
    with open(path) as f:
      template = yaml.safe_load(f) or {}
  except OSError as e:
    raise Exception(f"Can't read runners.kubernetes.job_template ({e}). Relative paths are relative to the project's root.") from None
  if not isinstance(template, dict):
    raise Exception(f'runners.kubernetes.job_template ({path}) must be a batch/v1 Job, as YAML.')
  return template

def run_as_ids(run_as: Union[str, Dict[str, Any]]) -> Tuple[Optional[int], Optional[int], List[int]]:
  """(uid, gid, supplemental groups) the pods run as. None: the image's."""
  if run_as == 'image':
    return None, None, []
  if run_as == 'user':
    if not hasattr(os, 'getuid'):
      raise Exception('runners.kubernetes.run_as: "user" needs a POSIX system. Use run_as: image, or {uid: ..., gid: ...}.')
    uid = os.getuid()
    if uid == 0:
      raise Exception('runners.kubernetes.run_as is "user" but you are root: we never start pods as root. Use run_as: image (the image\'s user), or {uid: ..., gid: ...}.')
    gid = os.getgid()
    return uid, gid, sorted(set(g for g in os.getgroups() if g != 0))
  if isinstance(run_as, dict) and 'uid' in run_as:
    explicit_gid = run_as.get('gid')
    return int(run_as['uid']), int(explicit_gid) if explicit_gid is not None else None, [int(g) for g in run_as.get('groups') or []]
  raise Exception(f'Unknown runners.kubernetes.run_as: {run_as!r}. Use "user", "image" or {{uid: 1000, gid: 1000}}.')

def security_context(run_as: Union[str, Dict[str, Any], None]) -> Dict[str, Any]:
  """The pod's securityContext for `run_as`. We never set fsGroup: it would chown the shared volumes."""
  uid, gid, groups = run_as_ids(run_as or 'user')
  context: Dict[str, Any] = {}
  if uid is not None:
    context.update({'runAsUser': uid, 'runAsNonRoot': uid != 0})
  if gid is not None:
    context['runAsGroup'] = gid
  if groups:
    context['supplementalGroups'] = groups
  return context

def resources_spec(resources: Optional[Dict[str, Any]]) -> Dict[str, Any]:
  """{cpu: 4, memory: 16Gi, nvidia.com/gpu: 1} are requests, and all but cpu also limits. {requests, limits} are kept as-is."""
  if not resources:
    return {}
  if set(resources) <= {'requests', 'limits'}:
    return resources
  requests = {k: str(v) for k, v in resources.items()}
  # Memory over the request gets the pod OOM-killed anyway, better know it. Extended resources need limits.
  limits = {k: v for k, v in requests.items() if k != 'cpu'}
  return {'requests': requests, **({'limits': limits} if limits else {})}

mount_keys = {'path', 'pvc', 'nfs', 'host_path', 'read_only', 'sub_path'}

def mounts_spec(mounts: Optional[List[Dict[str, Any]]]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
  """
  The shared filesystem, at the same paths in the pods: [{path, pvc | nfs: {server, path} | host_path, read_only, sub_path}]
  -> volumes, volumeMounts. Other keys are refused: mounts are the only volumes options can add.
  """
  volumes, volume_mounts = [], []
  for index, mount in enumerate(mounts or []):
    usage = f'runners.kubernetes.mounts[{index}]: {mount!r} needs an absolute `path`, and one of `pvc`, `nfs: {{server, path}}` or `host_path`'
    if not isinstance(mount, dict):
      raise ValueError(usage)
    unknown = set(mount) - mount_keys
    if unknown:
      raise ValueError(f"{usage}. Unknown: {', '.join(sorted(unknown))}.")
    sources = [k for k in ('pvc', 'nfs', 'host_path') if mount.get(k)]
    nfs = mount.get('nfs')
    if len(sources) != 1 or not str(mount.get('path', '')).startswith('/') or (nfs and not (isinstance(nfs, dict) and set(nfs) == {'server', 'path'})):
      raise ValueError(usage + '.')
    volume: Dict[str, Any] = {'name': f'qa-mount-{index}'}
    if mount.get('pvc'):
      volume['persistentVolumeClaim'] = {'claimName': str(mount['pvc'])}
    elif nfs:
      volume['nfs'] = {'server': str(nfs['server']), 'path': str(nfs['path'])}
    else:
      volume['hostPath'] = {'path': str(mount['host_path'])}
    volumes.append(volume)
    volume_mounts.append({
      'name': volume['name'], 'mountPath': mount['path'],
      **({'readOnly': True} if mount.get('read_only') else {}),
      **({'subPath': str(mount['sub_path'])} if mount.get('sub_path') else {}),
    })
  return volumes, volume_mounts

def job_body(options: KubernetesOptions, name: str, namespace: str, command: List[str], completions: int = 1, indexed: bool = False, timeout: float = 0) -> Dict[str, Any]:
  """
  The Job we create. With a `job_template`, from lowest to highest precedence:
  1. QA-Board's defaults: no retries (except when pods are evicted), TTL, a restricted-compatible security context...
  2. the template: it can change any of those defaults, and add anything (init containers, env from Secrets, affinity...),
  3. what the qaboard.yaml options set (image, resources, run_as, mounts...),
  4. what QA-Board must control: name, our labels, the command, completions/parallelism, the scripts' ConfigMap.
  Objects are merged recursively, lists of named objects (containers, volumes, env) by name. Our container is the
  template's first container.
  """
  template = load_job_template(options.job_template)
  template_containers = template.get('spec', {}).get('template', {}).get('spec', {}).get('containers') or []
  container_name = template_containers[0].get('name', 'qa') if template_containers else 'qa'
  labels = object_labels(options)

  pod_failure_policy = {'rules': [
    # Evicted or preempted pods (node drained, Kueue preemption...) are retried
    {'action': 'Ignore', 'onPodConditions': [{'type': 'DisruptionTarget'}]},
  ]}
  defaults = {
    'spec': {
      **({'backoffLimitPerIndex': 0} if indexed else {'backoffLimit': 0}),
      'podFailurePolicy': pod_failure_policy,
      'ttlSecondsAfterFinished': options.ttl_seconds_after_finished,
      'template': {'spec': {
        'restartPolicy': 'Never',
        # What the "restricted" Pod Security Standard needs, it doesn't get in the way of `qa run`
        'securityContext': {'seccompProfile': {'type': 'RuntimeDefault'}},
        'containers': [{
          'name': container_name,
          'securityContext': {'allowPrivilegeEscalation': False, 'capabilities': {'drop': ['ALL']}},
        }],
      }},
    },
  }

  run_as = security_context(options.run_as)
  if options.run_as_non_root:
    run_as['runAsNonRoot'] = True
  container: Dict[str, Any] = {'name': container_name}
  if options.image:
    container['image'] = options.image
  if options.resources:
    container['resources'] = resources_spec(options.resources)
  volumes, volume_mounts = mounts_spec(options.mounts)
  if volume_mounts:
    container['volumeMounts'] = volume_mounts
  pod_spec: Dict[str, Any] = {'containers': [container]}
  if run_as:
    pod_spec['securityContext'] = run_as
  if volumes:
    pod_spec['volumes'] = volumes
  if options.image_pull_secrets:
    pod_spec['imagePullSecrets'] = [{'name': s} for s in options.image_pull_secrets]
  if options.node_selector:
    pod_spec['nodeSelector'] = {k: str(v) for k, v in options.node_selector.items()}
  if options.tolerations:
    pod_spec['tolerations'] = options.tolerations
  if options.priority_class:
    pod_spec['priorityClassName'] = options.priority_class
  if options.service_account:
    pod_spec['serviceAccountName'] = options.service_account
  if timeout:
    pod_spec['activeDeadlineSeconds'] = int(timeout)
  from_options = {'spec': {'template': {'spec': pod_spec}}}

  job_labels = {**labels, **({'kueue.x-k8s.io/queue-name': options.queue} if options.queue else {})}
  controlled: Dict[str, Any] = {
    'apiVersion': 'batch/v1',
    'kind': 'Job',
    'metadata': {'name': name, 'namespace': namespace, 'labels': job_labels},
    'spec': {
      'completions': completions,
      'template': {
        'metadata': {'labels': labels},
        'spec': {
          'containers': [{
            'name': container_name,
            'command': command,
            'args': [],
            'volumeMounts': [{'name': 'qaboard-scripts', 'mountPath': scripts_dir, 'readOnly': True}],
          }],
          'volumes': [{'name': 'qaboard-scripts', 'configMap': {'name': name}}],
        },
      },
    },
  }
  if indexed:
    controlled['spec'].update({'completionMode': 'Indexed', 'maxFailedIndexes': completions})
  merged = deep_merge(deep_merge(deep_merge(defaults, template), from_options), controlled)
  if 'image' not in merged['spec']['template']['spec']['containers'][0]:
    raise Exception('Set runners.kubernetes.image in qaboard.yaml: an image with `qa` and what your code needs.')
  return merged

def configmap_body(name: str, namespace: str, labels: Dict[str, str], data: Dict[str, str], owner: Dict[str, Any]) -> Dict[str, Any]:
  return {
    'apiVersion': 'v1', 'kind': 'ConfigMap',
    'metadata': {'name': name, 'namespace': namespace, 'labels': labels, 'ownerReferences': [owner]},
    # What the pods run can't change
    'immutable': True,
    'data': data,
  }

def size(data: Dict[str, str]) -> int:
  return sum(len(k) + len(v.encode('utf-8')) for k, v in data.items())

def chunk_pods(pods: List[List[Dict[str, Any]]], env_sh: str, max_bytes: Optional[int] = None) -> List[List[List[Dict[str, Any]]]]:
  """Pods (lists of runs) by Jobs whose ConfigMap stays under max_bytes."""
  max_bytes = max_bytes or max_configmap_bytes
  chunks: List[List[List[Dict[str, Any]]]] = []
  current: List[List[Dict[str, Any]]] = []
  current_size = len(env_sh)
  for pod in pods:
    pod_size = len(run_script(pod).encode('utf-8')) + 16
    if current and current_size + pod_size > max_bytes:
      chunks.append(current)
      current, current_size = [], len(env_sh)
    current.append(pod)
    current_size += pod_size
  if current:
    chunks.append(current)
  return chunks


###
### Talking to the cluster
###
def kubeconfig_location() -> str:
  # The client reads $KUBECONFIG when it's imported: we read it when we connect
  return os.environ.get('KUBECONFIG') or '~/.kube/config'

def kubeconfig_paths() -> List[Path]:
  return [Path(p).expanduser() for p in kubeconfig_location().split(os.pathsep) if p and Path(p).expanduser().exists()]

def in_cluster() -> bool:
  """In a pod (e.g. a driver started from the web app) without kubeconfig, we use the pod's ServiceAccount"""
  return not kubeconfig_paths() and bool(os.environ.get('KUBERNETES_SERVICE_HOST'))

service_account_namespace = Path('/var/run/secrets/kubernetes.io/serviceaccount/namespace')

def kubeconfig_context(context: Optional[str]) -> Dict[str, Any]:
  """The kubeconfig's context: {"name", "context": {"cluster", "user", "namespace"}}"""
  kubernetes = import_kubernetes()
  contexts, active = kubernetes.config.list_kube_config_contexts(config_file=kubeconfig_location())
  if not context:
    return active
  for c in contexts:
    if c['name'] == context:
      return c
  raise Exception(f'No context "{context}" in your kubeconfig. Available: {", ".join(c["name"] for c in contexts)}. Fix runners.kubernetes.context.')


class Kube():
  """The Kubernetes API, with the results as plain dicts (like YAML). Reconnects on 401: tokens expire during long batches."""
  def __init__(self, context: Optional[str] = None):
    self.context = context
    self.kubernetes = import_kubernetes()
    self.connect()

  def connect(self):
    k = self.kubernetes
    configuration = k.client.Configuration()
    if in_cluster():
      k.config.load_incluster_config(client_configuration=configuration)
      self.default_namespace = service_account_namespace.read_text().strip() if service_account_namespace.exists() else 'default'
    else:
      if not kubeconfig_paths():
        raise Exception('No kubeconfig: ask your cluster admins for one, save it as ~/.kube/config or set $KUBECONFIG. Then check with `kubectl get pods`.')
      k.config.load_kube_config(config_file=kubeconfig_location(), context=self.context, client_configuration=configuration)
      self.default_namespace = kubeconfig_context(self.context).get('context', {}).get('namespace') or 'default'
    self.host = configuration.host
    self.api_client = k.client.ApiClient(configuration)
    self.apis = {
      'core': k.client.CoreV1Api(self.api_client),
      'batch': k.client.BatchV1Api(self.api_client),
      'custom': k.client.CustomObjectsApi(self.api_client),
      'authz': k.client.AuthorizationV1Api(self.api_client),
      'authn': k.client.AuthenticationV1Api(self.api_client),
      'version': k.client.VersionApi(self.api_client),
    }

  def call(self, api: str, method: str, *args, **kwargs) -> Any:
    for attempt in range(2):
      try:
        result = getattr(self.apis[api], method)(*args, **kwargs)
        return result if isinstance(result, str) else self.api_client.sanitize_for_serialization(result)
      except self.kubernetes.client.ApiException as e:
        if e.status == 401 and attempt == 0:
          self.connect()
          continue
        raise ApiError(e.status, api_error_message(e), method) from None

def connect(options: KubernetesOptions) -> Kube:
  return Kube(options.context)


class ApiError(Exception):
  def __init__(self, status: Optional[int], message: str, method: str = ''):
    super().__init__(f'{method}: {status} {message}' if method else f'{status} {message}')
    self.status = status
    self.message = message

def api_error_message(e) -> str:
  try:
    return json.loads(e.body)['message']
  except Exception:
    return str(e.reason)

def namespace_of(kube: Kube, options: KubernetesOptions) -> str:
  return options.namespace or kube.default_namespace

def batch_target(job_options: Dict[str, Any]) -> Dict[str, str]:
  """Where a batch's Jobs are: {"namespace", "context"}, so that the server can stop it. Reads the kubeconfig, no network."""
  options = dict_to_KubernetesOptions(job_options)
  target = {'context': options.context} if options.context else {}
  namespace = options.namespace
  if not namespace:
    try:
      if in_cluster():
        namespace = service_account_namespace.read_text().strip()
      else:
        namespace = kubeconfig_context(options.context).get('context', {}).get('namespace') or 'default'
    except Exception:
      pass # `qa batch` will say what's wrong
  return {**target, **({'namespace': namespace} if namespace else {})}


###
### Why pods are pending
###
@dataclass
class Finding():
  # The Job, and the pod's completion index, or None if about the whole Job (e.g. it can't create pods)
  job: str
  index: Optional[int]
  reason: str
  message: str
  hint: str
  fatal: bool = False

  def __str__(self):
    where = f'{self.job}' + (f' (pod {self.index})' if self.index is not None else '')
    return f'{where}: {self.reason}: {self.message}' + (f'\n  → {self.hint}' if self.hint else '')

image_pull_reasons = ('ErrImagePull', 'ImagePullBackOff')

def classify(reason: str, message: str) -> Tuple[str, bool]:
  """What to do about a pod that is pending, or a Job that can't create pods. Returns (hint, whether it won't fix itself)."""
  m = message or ''
  if reason == 'InvalidImageName':
    return 'The image name is invalid: fix runners.kubernetes.image.', True
  if reason in image_pull_reasons or (reason in ('Failed', 'BackOff') and 'pull' in m.lower()):
    return "Kubernetes can't pull the image: check runners.kubernetes.image (name and tag), and that the nodes can reach its registry. Private registries need `image_pull_secrets`.", False
  if reason == 'CreateContainerConfigError':
    return "The pod can't start: a Secret or ConfigMap it uses is missing, or the image runs as root while the pod must not (use `run_as`).", True
  if 'exceeded quota' in m:
    return "The namespace's ResourceQuota is used up: pods start when others end. Lower `concurrency` or `resources`, or ask your admins for more quota.", False
  if reason == 'FailedCreate' or 'forbidden' in m or 'violates PodSecurity' in m or 'denied the request' in m:
    return "The cluster refused the pods (admission policy, Pod Security Standard...). Ask your admins what pods may do in the namespace: `run_as`, `mounts` (host_path, nfs), resources...", True
  if reason == 'FailedScheduling':
    hints = []
    if 'Insufficient' in m:
      hints.append('No node has enough free ' + ', '.join(sorted(set(re.findall(r'Insufficient ([\w./-]+)', m)))) + ' right now: pods start when resources free up. If none ever could, lower `resources`.')
    if 'node affinity/selector' in m:
      hints.append('Check `node_selector` (`kubectl get nodes --show-labels`).')
    if 'taint' in m:
      hints.append('Nodes have taints the pods do not tolerate: add `tolerations`.')
    if 'persistentvolumeclaim' in m.lower() and 'not found' in m:
      hints.append('A PVC in `mounts` does not exist in the namespace.')
    if 'unbound' in m:
      hints.append('A PVC in `mounts` is not bound to a volume yet.')
    return ' '.join(hints) or 'No node can run the pods for now.', False
  if reason in ('FailedMount', 'FailedAttachVolume'):
    return 'A volume could not be mounted: check `mounts` (PVC names, NFS server and path, host paths).', False
  if reason == 'Kueue':
    return '', False
  return '', False


def clean_message(message: str) -> str:
  # Events about containers start with "spec.containers{qa}: "
  return re.sub(r'^spec\.\w+\{[^}]*\}: ', '', (message or '').strip())


class PendingDiagnostics():
  """Why the pods of our Jobs are pending, from their status and events."""
  def __init__(self):
    self.image_pull_since: Dict[str, float] = {}

  def check(self, jobs: List[Dict[str, Any]], pods: List[Dict[str, Any]], events: List[Dict[str, Any]], now: Optional[float] = None) -> List[Finding]:
    now = now if now is not None else time.time()
    findings: List[Finding] = []
    job_names = {j['metadata']['name'] for j in jobs}
    # pod name -> (job name, completion index)
    pending_pods: Dict[str, Tuple[str, Optional[int]]] = {}
    for pod in pods:
      labels = pod['metadata'].get('labels') or {}
      job_name = labels.get('batch.kubernetes.io/job-name') or labels.get('job-name') or ''
      if job_name not in job_names or pod.get('status', {}).get('phase') != 'Pending':
        continue
      index_label = labels.get('batch.kubernetes.io/job-completion-index')
      index = int(index_label) if index_label is not None else None
      pending_pods[pod['metadata']['name']] = (job_name, index)
      for condition in pod.get('status', {}).get('conditions') or []:
        if condition.get('type') == 'PodScheduled' and condition.get('status') == 'False' and condition.get('message'):
          findings.append(self.finding(job_name, index, 'FailedScheduling', condition['message'], now))
      for status in pod.get('status', {}).get('containerStatuses') or []:
        waiting = (status.get('state') or {}).get('waiting') or {}
        if waiting.get('reason') and waiting['reason'] not in ('ContainerCreating', 'PodInitializing'):
          findings.append(self.finding(job_name, index, waiting['reason'], waiting.get('message', ''), now))
    for job in jobs:
      queue = (job['metadata'].get('labels') or {}).get('kueue.x-k8s.io/queue-name')
      if queue and job.get('spec', {}).get('suspend'):
        findings.append(Finding(job['metadata']['name'], None, 'Kueue', f'waiting for Kueue to admit the Job in the queue "{queue}"', ''))
    for event in events:
      involved = event.get('involvedObject') or {}
      if event.get('type') != 'Warning':
        continue
      if involved.get('kind') == 'Pod' and involved.get('name') in pending_pods:
        # We create the scripts' ConfigMap right after the Job: the first pods may not find it, then do
        if event.get('reason') == 'FailedMount' and '"qaboard-scripts"' in (event.get('message') or '') and 'not found' in event['message']:
          continue
        job_name, index = pending_pods[involved['name']]
        findings.append(self.finding(job_name, index, event.get('reason', ''), event.get('message', ''), now))
      elif involved.get('kind') == 'Job' and involved.get('name') in job_names:
        findings.append(self.finding(involved['name'], None, event.get('reason', ''), event.get('message', ''), now))
    for job_name in job_names - {f.job for f in findings if f.reason in image_pull_reasons}:
      self.image_pull_since.pop(job_name, None)
    # The same problem is often both in the status and in events
    unique: Dict[Tuple[str, Optional[int], str], Finding] = {}
    for f in findings:
      unique.setdefault((f.job, f.index, f.hint or f.message), f)
    return list(unique.values())

  def finding(self, job: str, index: Optional[int], reason: str, message: str, now: float) -> Finding:
    message = clean_message(message)
    hint, fatal = classify(reason, message)
    if reason in image_pull_reasons:
      since = self.image_pull_since.setdefault(job, now)
      if now - since >= image_pull_grace:
        fatal = True
        hint = f'{hint} (failing for {int(now - since) // 60} minutes)'
    return Finding(job, index, reason, message, hint, fatal)


###
### The runner
###
@dataclass
class BatchJob():
  """A Job we created: the runs of each of its pods"""
  namespace: str
  name: str
  pods: List[List[Dict[str, Any]]]

  def runs(self, index: Optional[int]) -> List[Dict[str, Any]]:
    if index is None:
      return [run for pod in self.pods for run in pod]
    return self.pods[index] if 0 <= index < len(self.pods) else []


def create_job(kube: Kube, options: KubernetesOptions, namespace: str, name: str, data: Dict[str, str], command: List[str], completions: int = 1, indexed: bool = False, parallelism: Optional[int] = None, timeout: float = 0) -> Dict[str, Any]:
  """
  Creates the Job, then its scripts' ConfigMap, owned by the Job (deleted with it), and immutable.
  The pods wait for the ConfigMap a moment: creating it first would need a patch to set its owner.
  """
  body = job_body(options, name, namespace, command, completions=completions, indexed=indexed, timeout=timeout)
  if parallelism:
    body['spec']['parallelism'] = parallelism
  try:
    job = kube.call('batch', 'create_namespaced_job', namespace, body)
  except ApiError as e:
    raise Exception(f"Could not create the Job {name} in namespace {namespace}: {e.message}.{permissions_hint(e)}") from None
  owner = {'apiVersion': 'batch/v1', 'kind': 'Job', 'name': name, 'uid': job['metadata']['uid']}
  try:
    kube.call('core', 'create_namespaced_config_map', namespace, configmap_body(name, namespace, object_labels(options), data, owner))
  except ApiError as e:
    delete_quietly(kube, 'batch', 'delete_namespaced_job', name, namespace, propagation_policy='Background')
    raise Exception(f"Could not create the ConfigMap {name} in namespace {namespace}: {e.message}.{permissions_hint(e)}") from None
  return job

def permissions_hint(e: ApiError) -> str:
  if e.status in (401, 403):
    return ' Check your access with `qa doctor --runner kubernetes`.'
  return ''

def delete_quietly(kube: Kube, api: str, method: str, name: str, namespace: str, **kwargs):
  try:
    kube.call(api, method, name, namespace, **kwargs)
  except ApiError as e:
    if e.status != 404:
      secho(f'WARNING: could not delete {name}: {e.message}', fg='yellow', err=True)

def delete_jobs(kube: Kube, namespace: str, names: Iterable[str]):
  for name in names:
    # The pods and the ConfigMap go with the Job. If we failed to make it own the ConfigMap, we delete it too.
    delete_quietly(kube, 'batch', 'delete_namespaced_job', name, namespace, propagation_policy='Background')
    delete_quietly(kube, 'core', 'delete_namespaced_config_map', name, namespace)

def count_indexes(indexes: Optional[str]) -> int:
  """Number of indexes in "1,3-5" (Job.status.completedIndexes)"""
  count = 0
  for part in (indexes or '').split(','):
    if '-' in part:
      start, end = part.split('-')
      count += int(end) - int(start) + 1
    elif part:
      count += 1
  return count

def is_finished(job: Dict[str, Any]) -> bool:
  return any(c.get('type') in ('Complete', 'Failed') and c.get('status') == 'True' for c in job.get('status', {}).get('conditions') or [])


def with_signals_ignored(f: Callable):
  from ..utils import ignored_signals
  with ignored_signals():
    return f()


def create_group(kube: Kube, job_options: Dict[str, Any], jobs: List[Job], group_index: int, created: List[BatchJob]):
  """
  Creates the Jobs of a group, and adds them to `created`: one Job per set of runs with the same pod spec
  (e.g. per input type), split so that their ConfigMap stays small enough.
  """
  group_options = dict_to_KubernetesOptions(job_options)
  namespace = namespace_of(kube, group_options)
  by_pod_spec: Dict[str, List[Job]] = {}
  for job in jobs:
    own = {k: v for k, v in job.run_context.job_options.items() if k in pod_option_names}
    by_pod_spec.setdefault(json.dumps(own, sort_keys=True, default=str), []).append(job)
  nb_jobs = 0
  for same_pod_spec in by_pod_spec.values():
    own = {k: v for k, v in same_pod_spec[0].run_context.job_options.items() if k in pod_option_names}
    options = dict_to_KubernetesOptions({**job_options, **own})
    runs = [job_to_run(job) for job in same_pod_spec]
    runs_per_pod = max(1, int(options.runs_per_pod))
    pods = [runs[i:i + runs_per_pod] for i in range(0, len(runs), runs_per_pod)]
    env_sh = env_script(run_env(options))
    for chunk in chunk_pods(pods, env_sh):
      name = dns_name(f'qa-{options.command_id[:8]}-{group_index}-{nb_jobs}')
      nb_jobs += 1
      data = {'env.sh': env_sh, **{f'run-{i}.sh': run_script(pod) for i, pod in enumerate(chunk)}}
      concurrency = int(options.concurrency or 0)
      create_job(
        kube, options, namespace, name, data,
        command=['sh', '-c', f'exec sh {scripts_dir}/run-$JOB_COMPLETION_INDEX.sh'],
        completions=len(chunk), indexed=True, parallelism=min(concurrency, len(chunk)) if concurrency > 0 else len(chunk),
        timeout=options.timeout,
      )
      created.append(BatchJob(namespace, name, chunk))
  if nb_jobs > 1 and group_options.concurrency:
    secho(f"WARNING: The runs need {nb_jobs} Kubernetes Jobs (different pod specs, or too many runs for 1 ConfigMap). The concurrency limit ({group_options.concurrency}) applies to each Job.", fg='yellow', err=True)


def wait_jobs(kube: Kube, created: List[BatchJob], selector: str):
  """Waits until all the Jobs are finished, printing progress, and why pods are pending. Exits if they can't run."""
  by_name = {j.name: j for j in created}
  namespaces = sorted(set(j.namespace for j in created))
  total = sum(len(j.pods) for j in created)
  diagnostics = PendingDiagnostics()
  reported: set = set()
  logged: set = set()
  last_progress = None
  events_read_at = 0.0
  while True:
    jobs: List[Dict[str, Any]] = []
    for namespace in namespaces:
      namespace_jobs = [j for j in kube.call('batch', 'list_namespaced_job', namespace, label_selector=selector)['items'] if j['metadata']['name'] in by_name]
      jobs.extend(namespace_jobs)
      unfinished = [j for j in namespace_jobs if not is_finished(j)]
      if not unfinished:
        continue
      pods = kube.call('core', 'list_namespaced_pod', namespace, label_selector=selector)['items']
      # A Job's "active" pods include the pending ones: without, it can't create them (quota, admission...) or Kueue holds it
      has_pending = any(p.get('status', {}).get('phase') == 'Pending' for p in pods) or any(not j.get('status', {}).get('active') for j in unfinished)
      events = []
      if has_pending and time.time() - events_read_at > 3 * poll_interval:
        events_read_at = time.time()
        events = kube.call('core', 'list_namespaced_event', namespace)['items']
      for finding in diagnostics.check(unfinished, pods, events):
        report(finding, by_name[finding.job], reported, logged)
        if finding.fatal:
          secho(f"ERROR: The runs can't start ({finding.reason}). Deleting the batch's Jobs.", fg='red', bold=True, err=True)
          with_signals_ignored(lambda: [delete_jobs(kube, j.namespace, [j.name]) for j in created])
          sys.exit(1)

    missing = set(by_name) - {j['metadata']['name'] for j in jobs}
    failed = sum(count_indexes(j.get('status', {}).get('failedIndexes')) for j in jobs)
    done = failed + sum(count_indexes(j.get('status', {}).get('completedIndexes')) for j in jobs)
    active = sum(j.get('status', {}).get('active') or 0 for j in jobs)
    progress = (done, failed, active)
    if progress != last_progress:
      last_progress = progress
      secho(f"Kubernetes: {done}/{total} pods done" + (f", {failed} failed" if failed else '') + f", {active} running or pending", err=True)
    if all(is_finished(j) for j in jobs):
      if missing:
        # e.g. the batch was stopped from the web app
        secho(f"WARNING: Some of the batch's Kubernetes Jobs were deleted: {', '.join(sorted(missing))}", fg='yellow', err=True)
      return
    time.sleep(poll_interval)


def wait_until_started(kube: Kube, namespace: str, job: Dict[str, Any], log_file: Path, polls: int = 10):
  """
  Nobody watches a detached job: we wait a little (polls * 2s) for its pod to start. If it's pending, we write why in
  its log file, where users look. If it can't ever start, we delete it and raise.
  """
  name = job['metadata']['name']
  selector = f'batch.kubernetes.io/job-name={name}'
  diagnostics = PendingDiagnostics()
  findings: List[Finding] = []
  for _ in range(polls):
    time.sleep(2)
    pods = kube.call('core', 'list_namespaced_pod', namespace, label_selector=selector)['items']
    if any(p.get('status', {}).get('phase') not in (None, 'Pending') for p in pods):
      return
    events = kube.call('core', 'list_namespaced_event', namespace)['items']
    findings = diagnostics.check([job], pods, events)
    if any(f.fatal for f in findings):
      break
  if not findings:
    return
  message = '\n'.join(str(f) for f in findings)
  try:
    with log_file.open('a') as f:
      f.write(f"[qaboard] The Kubernetes Job {name} is pending:\n{message}\n")
  except OSError:
    pass
  if any(f.fatal for f in findings):
    delete_jobs(kube, namespace, [name])
    raise Exception(f"The Kubernetes Job {name} can't start, we deleted it:\n{message}")
  secho(f"Kubernetes: pending: {message}", fg='yellow', err=True)


def report(finding: Finding, batch_job: BatchJob, reported: set, logged: set):
  """Prints why pods are pending, once, and writes it in their runs' log.k8s.txt so that it shows in QA-Board."""
  key = (finding.reason, finding.hint or finding.message)
  if key not in reported:
    reported.add(key)
    color = 'red' if finding.fatal else ('blue' if finding.reason == 'Kueue' else 'yellow')
    secho(f"Kubernetes: pending: {finding}", fg=color, err=True)
  for run in batch_job.runs(finding.index):
    if not run.get('output_dir') or (run['output_dir'], key) in logged:
      continue
    logged.add((run['output_dir'], key))
    try:
      Path(run['output_dir']).mkdir(parents=True, exist_ok=True)
      # When the pod starts, the run's output replaces it
      with (Path(run['output_dir']) / 'log.k8s.txt').open('a') as f:
        f.write(f"[qaboard] {time.strftime('%Y-%m-%d %H:%M:%S')} the run's pod is pending. {finding}\n")
    except OSError:
      pass


###
### qa doctor
###
needed_permissions: List[Tuple[str, str, List[str]]] = [
  # (api group, resource, verbs)
  ('batch', 'jobs', ['create', 'get', 'list', 'watch', 'delete']),
  ('', 'configmaps', ['create', 'get', 'delete']),
  ('', 'pods', ['get', 'list', 'watch']),
  ('', 'events', ['get', 'list', 'watch']),
  ('', 'pods/log', ['get']),
]
kueue_permissions = ('kueue.x-k8s.io', 'localqueues', ['get'])

def rbac_yaml(namespace: str, username: Optional[str], with_queue: bool = False) -> str:
  """A Role with what the kubernetes runner needs in the namespace, and its RoleBinding for the user."""
  import yaml
  permissions = needed_permissions + ([kueue_permissions] if with_queue else [])
  role = {
    'apiVersion': 'rbac.authorization.k8s.io/v1',
    'kind': 'Role',
    'metadata': {'name': 'qaboard-runner', 'namespace': namespace},
    'rules': [{'apiGroups': [group], 'resources': [resource], 'verbs': verbs} for group, resource, verbs in permissions],
  }
  service_account = re.match(r'^system:serviceaccount:([^:]+):([^:]+)$', username or '')
  if service_account:
    subject = {'kind': 'ServiceAccount', 'name': service_account.group(2), 'namespace': service_account.group(1)}
  else:
    subject = {'kind': 'User', 'name': username or '<your user name>', 'apiGroup': 'rbac.authorization.k8s.io'}
  binding_name = f'qaboard-runner-{label_value(username or "user")}'[:63]
  binding = {
    'apiVersion': 'rbac.authorization.k8s.io/v1',
    'kind': 'RoleBinding',
    'metadata': {'name': binding_name, 'namespace': namespace},
    'subjects': [subject],
    'roleRef': {'apiGroup': 'rbac.authorization.k8s.io', 'kind': 'Role', 'name': 'qaboard-runner'},
  }
  return yaml.safe_dump_all([role, binding], sort_keys=False)

def exec_command(context: Dict[str, Any]) -> Optional[str]:
  """The credential plugin (e.g. kubelogin, gke-gcloud-auth-plugin) of the context's user, from the kubeconfig files."""
  import yaml
  user = context.get('context', {}).get('user')
  for path in kubeconfig_paths():
    try:
      kubeconfig = yaml.safe_load(path.read_text()) or {}
    except Exception:
      continue
    for u in kubeconfig.get('users') or []:
      if u.get('name') == user:
        return ((u.get('user') or {}).get('exec') or {}).get('command')
  return None

def doctor_test_script(options: KubernetesOptions) -> str:
  lines = [
    'echo "user: $(id)"',
    'failed=0',
  ]
  for mount in options.mounts:
    path = shlex.quote(mount['path'])
    lines.append(f'if [ -d {path} ]; then echo "mount {mount["path"]}: ok"; else echo "mount {mount["path"]}: MISSING"; failed=1; fi')
  if options.batch_dir:
    # In the closest folder that exists: we leave nothing behind
    lines.append(f'd={shlex.quote(options.batch_dir)}; while [ ! -d "$d" ] && [ "$d" != / ]; do d=$(dirname "$d"); done')
    lines.append('probe="$d/.qaboard-doctor-$HOSTNAME-$$"')
    lines.append(f'if touch "$probe" && rm "$probe"; then echo "outputs: can write in $d"; else echo "outputs: can NOT write in $d (for {options.batch_dir})"; failed=1; fi')
  # Older qa have no --version
  lines.append('if qa --version 2>/dev/null || qa --help > /dev/null; then echo "qa: ok"; else echo "qa: NOT working in the image"; failed=1; fi')
  lines.append('exit $failed')
  return '\n'.join(lines) + '\n'


class Doctor():
  """The checks of `qa doctor` for the kubernetes runner"""
  def __init__(self, job_options: Dict[str, Any], test_job: bool):
    self.options = dict_to_KubernetesOptions(job_options)
    if not self.options.command_id:
      self.options.command_id = str(uuid.uuid4())
    self.test_job = test_job
    self.kube: Optional[Kube] = None
    self.namespace = self.options.namespace or 'default'
    self.namespace_labels: Dict[str, str] = {}
    self.username: Optional[str] = None
    # Once a check fails, those that need it are skipped
    self.blocked = False

  def checks(self) -> Iterator[Check]:
    for check in (self.check_client, self.check_kubeconfig, self.check_exec_plugin, self.check_api, self.check_namespace,
                  self.check_permissions, self.check_queue, self.check_image, self.check_pull_secrets, self.check_mounts,
                  self.check_run_as, self.check_test_job):
      try:
        yield from check()
      except Exception as e:
        self.blocked = True
        yield Check(f'Kubernetes: {check.__name__.replace("check_", "").replace("_", " ")}', ERROR, f'Unexpected error: {type(e).__name__}: {e}')

  def check_client(self):
    try:
      import kubernetes # type: ignore
    except ImportError:
      self.blocked = True
      yield Check('Kubernetes: Python client', ERROR, 'The kubernetes Python client is not installed.', fix=install_hint())
      return
    yield Check('Kubernetes: Python client', OK, f'kubernetes {kubernetes.__version__}')

  def check_kubeconfig(self):
    if self.blocked:
      return
    if in_cluster():
      self.kube = connect(self.options)
      self.namespace = namespace_of(self.kube, self.options)
      yield Check('Kubernetes: credentials', OK, f"In a pod, with its ServiceAccount (namespace {self.kube.default_namespace})")
      return
    if not kubeconfig_paths():
      self.blocked = True
      yield Check('Kubernetes: kubeconfig', ERROR, f"No kubeconfig: {os.environ.get('KUBECONFIG') or '~/.kube/config'} doesn't exist.",
                  fix='Ask your cluster admins for a kubeconfig, save it as ~/.kube/config (or set $KUBECONFIG), then check with `kubectl get pods`.')
      return
    try:
      context = kubeconfig_context(self.options.context)
    except Exception as e:
      self.blocked = True
      yield Check('Kubernetes: kubeconfig', ERROR, str(e), fix='List the contexts with `kubectl config get-contexts`.')
      return
    self.context = context
    self.kube = connect(self.options)
    self.namespace = namespace_of(self.kube, self.options)
    c = context.get('context', {})
    yield Check('Kubernetes: kubeconfig', OK, f"context {context['name']} (cluster {c.get('cluster')}, user {c.get('user')}), namespace {self.namespace}")

  def check_exec_plugin(self):
    if self.blocked or in_cluster():
      return
    command = exec_command(self.context)
    if not command:
      return
    found = os.path.exists(command) if os.path.isabs(command) else shutil.which(command)
    if not found:
      self.blocked = True
      yield Check('Kubernetes: credential plugin', ERROR, f"Your kubeconfig gets credentials with `{command}`, which is not on the PATH.",
                  fix=f'Install {command} (your admins know where to get it: kubelogin, gke-gcloud-auth-plugin, aws...), then check with `kubectl get pods`.')
      return
    yield Check('Kubernetes: credential plugin', OK, f'{command}: {found}')

  def check_api(self):
    if self.blocked or not self.kube:
      return
    try:
      version = self.kube.call('version', 'get_code')
    except ApiError as e:
      self.blocked = True
      fix = 'Your credentials expired or are refused: sign in again (e.g. run `kubectl get pods`), or ask your admins.' if e.status in (401, 403) else None
      yield Check('Kubernetes: API', ERROR, f"The API server refused us: {e}", fix=fix)
      return
    except Exception as e:
      self.blocked = True
      host = self.kube.host
      yield Check('Kubernetes: API', ERROR, f"Can't reach the API server at {host}: {type(e).__name__}: {e}",
                  fix='Check your network (VPN, proxy: NO_PROXY), and that the cluster is up: `kubectl version`.')
      return
    yield Check('Kubernetes: API', OK, f"Kubernetes {version.get('gitVersion')} at {self.kube.host}")

  def check_namespace(self):
    if self.blocked or not self.kube:
      return
    try:
      namespace = self.kube.call('core', 'read_namespace', self.namespace)
    except ApiError as e:
      if e.status == 404:
        self.blocked = True
        yield Check(f'Kubernetes: namespace {self.namespace}', ERROR, "The namespace doesn't exist.",
                    fix='Set runners.kubernetes.namespace to a namespace where you can run pods: `kubectl get namespaces`, or ask your admins for one.')
      else:
        # Users often can't read namespaces: the permission checks below tell more
        yield Check(f'Kubernetes: namespace {self.namespace}', SKIPPED, f"Can't read it ({e.message}).")
      return
    self.namespace_labels = namespace['metadata'].get('labels') or {}
    yield Check(f'Kubernetes: namespace {self.namespace}', OK, 'exists')

  def can(self, group: str, resource: str, verb: str) -> bool:
    assert self.kube
    resource, _, subresource = resource.partition('/')
    review = {
      'apiVersion': 'authorization.k8s.io/v1',
      'kind': 'SelfSubjectAccessReview',
      'spec': {'resourceAttributes': {'namespace': self.namespace, 'verb': verb, 'group': group, 'resource': resource, **({'subresource': subresource} if subresource else {})}},
    }
    return bool(self.kube.call('authz', 'create_self_subject_access_review', review).get('status', {}).get('allowed'))

  def check_permissions(self):
    if self.blocked or not self.kube:
      return
    try:
      review = self.kube.call('authn', 'create_self_subject_review', {'apiVersion': 'authentication.k8s.io/v1', 'kind': 'SelfSubjectReview'})
      self.username = review.get('status', {}).get('userInfo', {}).get('username')
    except Exception:
      pass # Kubernetes <1.28
    permissions = needed_permissions + ([kueue_permissions] if self.options.queue else [])
    missing = [f'{verb} {resource}' for group, resource, verbs in permissions for verb in verbs if not self.can(group, resource, verb)]
    who = self.username or 'you'
    if missing:
      fix = '\n'.join([
        f'Ask your cluster admins to give {who} these permissions in the namespace {self.namespace}, e.g. with (kubectl apply -f):',
        rbac_yaml(self.namespace, self.username, with_queue=bool(self.options.queue)),
      ])
      yield Check(f'Kubernetes: permissions in namespace {self.namespace}', ERROR, f"{who} can't: {', '.join(missing)}", fix=fix)
      return
    yield Check(f'Kubernetes: permissions in namespace {self.namespace}', OK, f'{who} can create and watch Jobs')

  def check_queue(self):
    if self.blocked or not self.kube or not self.options.queue:
      return
    error = None
    for version in ('v1beta2', 'v1beta1'):
      try:
        self.kube.call('custom', 'get_namespaced_custom_object', 'kueue.x-k8s.io', version, self.namespace, 'localqueues', self.options.queue)
        yield Check(f'Kubernetes: Kueue queue {self.options.queue}', OK, 'exists')
        return
      except ApiError as e:
        error = e
    assert error
    if error.status == 404:
      yield Check(f'Kubernetes: Kueue queue {self.options.queue}', ERROR, f"No LocalQueue {self.options.queue} in namespace {self.namespace} (or Kueue isn't installed).",
                  fix=f'List the queues with `kubectl get localqueues -n {self.namespace}` and fix runners.kubernetes.queue, or remove it.')
    else:
      yield Check(f'Kubernetes: Kueue queue {self.options.queue}', WARNING, f"Can't check it: {error.message}")

  def check_image(self):
    if not self.options.image:
      yield Check('Kubernetes: image', ERROR, 'No image: the pods need one with `qa` and what your code needs.',
                  fix='runners:\n  kubernetes:\n    image: registry.example.com/your/image:tag')
      return
    yield Check('Kubernetes: image', OK, self.options.image)

  def check_pull_secrets(self):
    if self.blocked or not self.kube:
      return
    for secret in self.options.image_pull_secrets:
      try:
        self.kube.call('core', 'read_namespaced_secret', secret, self.namespace)
        yield Check(f'Kubernetes: image pull secret {secret}', OK, 'exists')
      except ApiError as e:
        if e.status == 404:
          yield Check(f'Kubernetes: image pull secret {secret}', ERROR, f"No Secret {secret} in namespace {self.namespace}.",
                      fix=f'kubectl create secret docker-registry {secret} -n {self.namespace} --docker-server=... --docker-username=... --docker-password=...')
        else:
          yield Check(f'Kubernetes: image pull secret {secret}', SKIPPED, f"Can't check it: {e.message}")

  def check_mounts(self):
    try:
      mounts_spec(self.options.mounts)
    except ValueError as e:
      yield Check('Kubernetes: mounts', ERROR, str(e), fix='mounts:\n  - {path: /algo, pvc: algo-nfs}   # or nfs: {server, path}, or host_path. Optional: read_only, sub_path')
      return
    for mount in self.options.mounts:
      if not mount.get('pvc') or self.blocked or not self.kube:
        continue
      name = f"Kubernetes: mount {mount['path']} (PVC {mount['pvc']})"
      try:
        pvc = self.kube.call('core', 'read_namespaced_persistent_volume_claim', mount['pvc'], self.namespace)
      except ApiError as e:
        if e.status == 404:
          yield Check(name, ERROR, f"No PersistentVolumeClaim {mount['pvc']} in namespace {self.namespace}.", fix=f'List them with `kubectl get pvc -n {self.namespace}`, or ask your admins to create it.')
        else:
          yield Check(name, SKIPPED, f"Can't check it: {e.message}")
        continue
      phase = pvc.get('status', {}).get('phase')
      if phase == 'Bound':
        yield Check(name, OK, 'Bound')
      else:
        yield Check(name, WARNING, f'{phase}: pods will wait until it is bound to a volume (fine with a WaitForFirstConsumer storage class).')
    # The pods run where `qa batch` runs, and write the outputs: they must see both
    for what, path in (('the project', os.getcwd()), ('the outputs', self.options.batch_dir)):
      if path and not any(is_under(str(path), m.get('path', '')) for m in self.options.mounts):
        yield Check('Kubernetes: mounts', WARNING, f"The pods won't see {what} ({path}): it's not under `mounts` (unless the image has it, at the same path).",
                    fix='Add the shared filesystem to runners.kubernetes.mounts, at the same path.')

  def check_run_as(self):
    try:
      uid, gid, groups = run_as_ids(self.options.run_as)
    except Exception as e:
      yield Check('Kubernetes: run as', ERROR, str(e))
      return
    level = self.namespace_labels.get('pod-security.kubernetes.io/enforce')
    who = f'uid {uid}, gid {gid}' + (f', groups {groups}' if groups else '') if uid is not None else "the image's user"
    problems = []
    if level in ('baseline', 'restricted') and any(m.get('host_path') for m in self.options.mounts):
      problems.append(f'host_path mounts are refused by the "{level}" Pod Security Standard of the namespace: use a PVC.')
    if level == 'restricted' and any(m.get('nfs') for m in self.options.mounts):
      problems.append('nfs mounts are refused by the "restricted" Pod Security Standard of the namespace: use a PVC.')
    if problems:
      yield Check('Kubernetes: run as', ERROR, f'Pods run as {who}. ' + ' '.join(problems), fix='Ask your admins for a PVC of the shared filesystem, or an exemption.')
      return
    if level == 'restricted' and uid is None:
      yield Check('Kubernetes: run as', WARNING, f'Pods run as {who}: the "restricted" Pod Security Standard refuses pods whose image runs as root.', fix='Use run_as: user, or {uid: ..., gid: ...}.')
      return
    yield Check('Kubernetes: run as', OK, f'Pods run as {who}' + (f' (Pod Security Standard: {level})' if level else ''))

  def check_test_job(self, timeout: float = 300):
    if not self.test_job:
      return
    name = 'Kubernetes: test job'
    if self.blocked or not self.kube or not self.options.image:
      yield Check(name, SKIPPED, 'Fix the errors above first.')
      return
    kube = self.kube
    job_name = dns_name(f'qa-{self.options.command_id[:8]}-doctor')
    data = {'env.sh': env_script(run_env(self.options)), 'run.sh': '. "$(dirname "$0")/env.sh"\n' + doctor_test_script(self.options)}
    # Same pod as the runs, with the resources they request, so that scheduling is realistic
    create_job(kube, self.options, self.namespace, job_name, data, command=['sh', f'{scripts_dir}/run.sh'], timeout=timeout)
    try:
      diagnostics = PendingDiagnostics()
      findings: Dict[str, Finding] = {}
      start = time.time()
      job: Dict[str, Any] = {}
      selector = f'batch.kubernetes.io/job-name={job_name}'
      while time.time() - start < timeout:
        job = kube.call('batch', 'read_namespaced_job', job_name, self.namespace)
        if is_finished(job):
          break
        pods = kube.call('core', 'list_namespaced_pod', self.namespace, label_selector=selector)['items']
        events = kube.call('core', 'list_namespaced_event', self.namespace)['items']
        current = diagnostics.check([job], pods, events)
        for finding in current:
          findings.setdefault(finding.hint or finding.message, finding)
        if any(f.fatal for f in current):
          break
        time.sleep(poll_interval)
      pods = kube.call('core', 'list_namespaced_pod', self.namespace, label_selector=selector)['items']
      log = ''
      for pod in pods:
        try:
          log += kube.call('core', 'read_namespaced_pod_log', pod['metadata']['name'], self.namespace)
        except ApiError:
          pass
      pending = '\n'.join(str(f) for f in findings.values())
      succeeded = bool(job.get('status', {}).get('succeeded'))
      if succeeded:
        yield Check(name, OK, f"The test pod ran (it requested the runs' resources):\n{log.strip()}")
      elif not is_finished(job):
        yield Check(name, ERROR, f"The test pod didn't finish in {int(timeout)}s." + (f"\n{pending}" if pending else '') + (f"\n{log.strip()}" if log.strip() else ''),
                    fix=f'See `kubectl describe pods -n {self.namespace} -l {selector}`')
      else:
        yield Check(name, ERROR, "The test pod failed:\n" + (log.strip() or pending or '(no logs)'), fix=f'See `kubectl describe pods -n {self.namespace} -l {selector}`')
    finally:
      delete_jobs(kube, self.namespace, [job_name])



class KubernetesRunner(BaseRunner):
  """Start runs as pods of Kubernetes Indexed Jobs."""
  type = "kubernetes"
  # Batches with their own get their own Jobs
  group_options = ('concurrency', 'runs_per_pod', 'timeout')

  def __init__(self, run_context: RunContext):
    self.run_context = run_context

  def start(self, blocking=True):
    raise NotImplementedError("Use start_jobs")

  @staticmethod
  def start_jobs(jobs: List[Job], job_options: Dict[str, Any], blocking=True):
    KubernetesRunner.start_groups([(job_options, jobs)], blocking)

  @classmethod
  def start_groups(cls, groups: List[Tuple[Dict[str, Any], List[Job]]], blocking=True):
    """Creates the Jobs of all groups, then waits for all of them."""
    groups = [(o, j) for o, j in groups if j]
    if not groups:
      return
    options = dict_to_KubernetesOptions(groups[0][0])
    kube = connect(options)
    created: List[BatchJob] = []
    if blocking:
      # When `qa batch` is stopped, we delete the Jobs we created, then exit: JobGroup marks the stopped runs as failed
      def abort(_signo=None, _stackframe=None):
        print('Aborted.')
        with_signals_ignored(lambda: [delete_jobs(kube, j.namespace, [j.name]) for j in created])
        sys.exit(1)
      signal.signal(signal.SIGTERM, abort)
      signal.signal(signal.SIGINT, abort)

    for group_index, (job_options, jobs) in enumerate(groups):
      create_group(kube, job_options, jobs, group_index, created)
    selector = batch_selector(options.command_id)
    nb_runs = sum(len(jobs) for _, jobs in groups)
    secho(f"Started {nb_runs} run(s) in {sum(len(j.pods) for j in created)} pod(s), {len(created)} Kubernetes Job(s). See them with:", err=True)
    for namespace in sorted(set(j.namespace for j in created)):
      secho(f"  kubectl get jobs -n {namespace} -l {selector}", err=True)
    if blocking:
      wait_jobs(kube, created, selector)

  @staticmethod
  def stop_jobs(jobs: List[Job], job_options: Dict[str, Any]):
    """
    Deletes the Jobs with the batch's command-id (and project, if given).
    The server calls it with few options: type, command_id, maybe namespace, context, project.
    """
    options = dict_to_KubernetesOptions(job_options)
    # before connecting: the command id may come from untrusted input
    selector = batch_selector(options.command_id, options.project)
    kube = connect(options)
    namespace = namespace_of(kube, options)
    batch_jobs = kube.call('batch', 'list_namespaced_job', namespace, label_selector=selector)['items']
    names = [j['metadata']['name'] for j in batch_jobs]
    secho(f"Deleting {len(names)} Kubernetes Job(s) in namespace {namespace}: {' '.join(names)}", err=True)
    delete_jobs(kube, namespace, names)

  @classmethod
  def submit_detached(cls, script: str, name: str, log_file: Path, job_options: Dict[str, Any]) -> Dict[str, Any]:
    """A 1-pod Job running the bash `script`, named qa-<name>, with the batch's labels. No timeout."""
    options = dict_to_KubernetesOptions(job_options)
    kube = connect(options)
    namespace = namespace_of(kube, options)
    job_name = dns_name(name if name.startswith('qa-') else f'qa-{name}')
    log_file = Path(log_file)
    run_sh = '\n'.join([
      f'mkdir -p {shlex.quote(str(log_file.parent))} && exec > {shlex.quote(str(log_file))} 2>&1',
      '. "$(dirname "$0")/env.sh"',
      script,
    ]) + '\n'
    data = {'env.sh': env_script(run_env(options)), 'run.sh': run_sh}
    job = create_job(kube, options, namespace, job_name, data, command=['bash', f'{scripts_dir}/run.sh'])
    secho(f"Started the Kubernetes Job {job_name} in namespace {namespace}. Logs: {log_file}", err=True)
    wait_until_started(kube, namespace, job, log_file)
    return {'kubernetes_job': job_name, 'namespace': namespace, **({'context': options.context} if options.context else {})}

  @classmethod
  def doctor(cls, job_options: Dict[str, Any], test_job: bool = False) -> Iterator[Check]:
    return Doctor(job_options, test_job).checks()
