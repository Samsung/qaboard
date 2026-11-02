#!/usr/bin/env python3
# /// script
# requires-python = ">=3.8"
# dependencies = []
# ///
"""
The kubernetes runner for real, on a kind cluster: `qa batch --runner kubernetes` (offline, no QA-Board server).
Usage: kubernetes_runner_e2e.py [--python "uv run --project . --extra kubernetes python"] [--keep]
Needs docker, kind and kubectl.

1. A kind cluster whose node sees a temporary folder at the same path: the pods mount it with host_path, like the
   shared filesystem of a real cluster. The project (a copy of qaboard/sample_project), inputs and outputs are there.
2. An image with this repository's qaboard, loaded in the node (no registry).
3. Checks that, with run_as: user (your UID; as root, an explicit UID, since pods never run as root as "user"):
   - runs succeed, 2 per pod (runs_per_pod), their outputs are owned by the user, their output in log.k8s.txt
   - a failed run fails `qa batch`, and the other run of its pod still runs
   - pods that can't start (invalid image) fail the batch quickly, and say why in the runs' log.k8s.txt
   - `qa batch --no-wait`, then KubernetesRunner.stop_jobs (what the server calls) deletes the Jobs
   - KubernetesRunner.submit_detached runs a script in a pod
   - KubernetesRunner.doctor(..., test_job=True) has no errors, and its test pod ran as the user
Behind a TLS-intercepting proxy, the CA bundle at $SSL_CERT_FILE (or $PIP_CERT) is added to the image build.
"""
import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CLUSTER = "qaboard-runner-e2e"
IMAGE = "qaboard-runner-e2e:dev"  # not :latest, so that pods don't try to pull it

# The node sees `shared` at the same path.
# - failCgroupV1: kubelets >=1.35 refuse cgroup v1 hosts by default
# - restrict_oom_score_adj: in containers without CAP_SYS_RESOURCE (e.g. some CI sandboxes), runc can't lower it
KIND_CONFIG = """kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
containerdConfigPatches:
  - |
    [plugins."io.containerd.grpc.v1.cri"]
      restrict_oom_score_adj = true
nodes:
  - role: control-plane
    extraMounts:
      - hostPath: {shared}
        containerPath: {shared}
    kubeadmConfigPatches:
      - |
        kind: KubeletConfiguration
        failCgroupV1: false
"""

DOCKERFILE = """ARG BASE=python:3.12-slim
FROM ${BASE}
COPY extra-ca.crt /tmp/extra-ca.crt
COPY src /src
RUN if [ -s /tmp/extra-ca.crt ]; then export PIP_CERT=/tmp/extra-ca.crt; fi \\
 && pip install --no-cache-dir --disable-pip-version-check /src && rm -rf /src
"""

failures = []


def log(message):
  print(f"\n=== {message}", flush=True)


def check(condition, message):
  print(f"{'ok  ' if condition else 'FAIL'} {message}", flush=True)
  if not condition:
    failures.append(message)
  return condition


def run(*command, check=True, **kwargs):
  print(f"$ {' '.join(shlex.quote(str(c)) for c in command)}", flush=True)
  return subprocess.run([str(c) for c in command], check=check, **kwargs)


def kubectl_json(*args):
  out = run('kubectl', *args, '-o', 'json', stdout=subprocess.PIPE, encoding='utf-8')
  return json.loads(out.stdout)


def create_cluster(shared: Path):
  run('kind', 'delete', 'cluster', '--name', CLUSTER, check=False)
  config = shared.parent / f"{shared.name}-kind.yaml"
  config.write_text(KIND_CONFIG.format(shared=shared))
  run('kind', 'create', 'cluster', '--name', CLUSTER, '--config', config, '--wait', '180s')
  config.unlink()


def build_image():
  with tempfile.TemporaryDirectory() as context:
    context = Path(context)
    src = context / 'src'
    src.mkdir()
    for name in ('pyproject.toml', 'README.md', 'LICENSE'):
      shutil.copy(REPO / name, src / name)
    ignore = shutil.ignore_patterns('__pycache__', 'output', '*.batches.yaml', '*.pyc')
    for name in ('qaboard', 'qatools'):
      shutil.copytree(REPO / name, src / name, ignore=ignore)
    ca = os.environ.get('SSL_CERT_FILE') or os.environ.get('PIP_CERT')
    (context / 'extra-ca.crt').write_bytes(Path(ca).read_bytes() if ca and Path(ca).is_file() else b'')
    (context / 'Dockerfile').write_text(DOCKERFILE)
    base = os.environ.get('E2E_BASE_IMAGE', 'python:3.12-slim')
    # host network: proxies listening on the host's loopback work
    run('docker', 'build', '--network', 'host', '--build-arg', f'BASE={base}', '-t', IMAGE, context)
  run('kind', 'load', 'docker-image', '--name', CLUSTER, IMAGE)


def make_project(shared: Path, kubernetes: dict) -> Path:
  project = shared / 'project'
  shutil.copytree(REPO / 'qaboard/sample_project', project, ignore=shutil.ignore_patterns('output', '*.batches.yaml', '__pycache__'))
  inputs = shared / 'inputs'
  inputs.mkdir()
  for name in ('a', 'b', 'c', 'ok'):
    (inputs / f'{name}.txt').write_text(f'{name}\n')
  (inputs / 'fail.txt').write_text('fail\n')
  database = f"{{linux: {inputs}}}"
  (project / 'e2e.batches.yaml').write_text('\n'.join([
    f"ok: {{database: {database}, inputs: [a.txt, b.txt, c.txt]}}",
    # in the same pod
    f"fails: {{database: {database}, inputs: [fail.txt, ok.txt]}}",
    f"slow: {{database: {database}, inputs: [a.txt]}}",
    f"invalid-image: {{database: {database}, inputs: [a.txt], kubernetes: {{image: 'INVALID::image'}}}}",
    '',
  ]))
  qaboard_yaml = project / 'qaboard.yaml'
  # JSON is YAML
  qaboard_yaml.write_text(qaboard_yaml.read_text().replace('runners:\n', f'runners:\n  default: kubernetes\n  kubernetes: {json.dumps(kubernetes)}\n', 1))
  return project


def main():
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  parser.add_argument('--python', default=f'uv run --project {REPO} --extra kubernetes python', help='A Python with qaboard[kubernetes]')
  parser.add_argument('--keep', action='store_true', help="Don't delete the cluster and the shared folder")
  args = parser.parse_args()
  python = shlex.split(args.python)
  for tool in ('docker', 'kind', 'kubectl'):
    if not shutil.which(tool):
      sys.exit(f"{tool} is needed")

  shared = Path(tempfile.mkdtemp(prefix='qaboard-k8s-e2e-', dir='/tmp')).resolve()
  uid = os.getuid() if os.getuid() != 0 else 1000
  gid = os.getgid() if os.getuid() != 0 else 1000
  run_as = 'user' if os.getuid() != 0 else {'uid': uid, 'gid': gid}
  if os.getuid() == 0:
    # the pods' user writes there
    shared.chmod(0o777)
  kubernetes = {
    'namespace': 'default',
    'image': IMAGE,
    'run_as': run_as,
    'runs_per_pod': 2,
    'concurrency': 2,
    'resources': {'cpu': '100m', 'memory': '256Mi'},
    'mounts': [{'path': str(shared), 'host_path': str(shared)}],
    'timeout': 600,
  }
  env = {**os.environ, 'QA_OFFLINE': 'true', 'QA_BATCH_QUIET': '1'}
  env.pop('QA_TESTING', None)
  # Not as the CI: in CI (CI=true, set by GitHub Actions) qa saves results in the storage, not in the shared folder
  for name in ('CI', 'GIT_COMMIT'):
    env.pop(name, None)

  try:
    log(f"kind cluster {CLUSTER}, shared folder {shared}")
    create_cluster(shared)
    log(f"image {IMAGE}")
    build_image()
    project = make_project(shared, kubernetes)
    if os.getuid() == 0:
      for path in [project, *project.rglob('*')]:
        os.chown(path, uid, gid)

    def qa_batch(*batch_args, command_id=None):
      run_env = {**env, **({'QA_BATCH_COMMAND_ID': command_id} if command_id else {})}
      start = time.time()
      out = run(*python, '-m', 'qaboard', 'batch', '--batches-file', 'e2e.batches.yaml', *batch_args, cwd=project, env=run_env, check=False)
      print(f"(exit code {out.returncode}, {time.time() - start:.0f}s)", flush=True)
      return out.returncode

    def output_dir(name):
      dirs = [p for p in (project / 'output').rglob(name) if p.is_dir()]
      return dirs[0] if dirs else project / 'output' / 'missing' / name

    def delete_jobs():
      run('kubectl', 'delete', 'jobs', '-l', 'app.kubernetes.io/managed-by=qaboard', '--wait=true', check=False)

    log("runs succeed, 2 per pod, as the user")
    reused_command_id = str(uuid.uuid4())
    returncode = qa_batch('ok', '--', 'cp {input_path} {output_dir}/out.txt && id -u > {output_dir}/uid.txt && echo from-the-run', command_id=reused_command_id)
    check(returncode == 0, "qa batch succeeds")
    for name in ('a', 'b', 'c'):
      out = output_dir(name)
      check((out / 'out.txt').is_file() and (out / 'out.txt').read_text() == f'{name}\n', f"{name}: the run wrote its output")
      check((out / 'uid.txt').is_file() and (out / 'uid.txt').read_text().strip() == str(uid), f"{name}: the run ran as uid {uid}")
      check((out / 'out.txt').is_file() and (out / 'out.txt').stat().st_uid == uid, f"{name}: its outputs are owned by uid {uid}")
      check((out / 'log.k8s.txt').is_file() and 'from-the-run' in (out / 'log.k8s.txt').read_text(), f"{name}: its output is in log.k8s.txt")
    jobs = kubectl_json('get', 'jobs', '-l', 'app.kubernetes.io/managed-by=qaboard')['items']
    check([(j['spec']['completionMode'], j['spec']['completions'], j['spec']['parallelism']) for j in jobs] == [('Indexed', 2, 2)], "1 Indexed Job: 3 runs in 2 pods")
    configmaps = kubectl_json('get', 'configmaps', '-l', 'app.kubernetes.io/managed-by=qaboard')['items']
    check(len(configmaps) == 1 and configmaps[0]['metadata']['ownerReferences'][0]['kind'] == 'Job', "the scripts' ConfigMap is owned by the Job")
    check(len(configmaps) == 1 and configmaps[0].get('immutable') is True, "and immutable")
    # `qa optimize` runs batches with the same command id, while the previous Jobs are kept (TTL)
    returncode = qa_batch('ok', '--', 'true', command_id=reused_command_id)
    check(returncode == 0, "a batch with the same command id succeeds too")
    check(len(kubectl_json('get', 'jobs', '-l', f'qaboard.io/command-id={reused_command_id}')['items']) == 2, "with its own Job")
    delete_jobs()

    log("a failed run fails the batch, the other run of its pod still runs")
    returncode = qa_batch('fails', '--', '! grep -q fail {input_path} && cp {input_path} {output_dir}/out.txt')
    check(returncode != 0, "qa batch fails")
    check((output_dir('ok') / 'out.txt').is_file(), "the run after the failed one, in the same pod, ran")
    check((output_dir('fail') / 'log.k8s.txt').is_file(), "the failed run has its log.k8s.txt")
    delete_jobs()

    log("pods that can't start fail the batch, and say why")
    start = time.time()
    returncode = qa_batch('invalid-image', '--', 'true')
    check(returncode != 0 and time.time() - start < 180, "qa batch fails quickly")
    log_k8s = output_dir('a') / 'log.k8s.txt'
    check(log_k8s.is_file() and 'InvalidImageName' in log_k8s.read_text(), "the run's log.k8s.txt says why its pod is pending")
    check(not kubectl_json('get', 'jobs', '-l', 'app.kubernetes.io/managed-by=qaboard')['items'], "its Jobs were deleted")

    log("qa batch --no-wait, then the server stops it")
    command_id = str(uuid.uuid4())
    selector = f'qaboard.io/command-id={command_id}'
    returncode = qa_batch('--no-wait', 'slow', '--', 'sleep 600', command_id=command_id)
    check(returncode == 0, "qa batch --no-wait returns")
    check(len(kubectl_json('get', 'jobs', '-l', selector)['items']) == 1, "its Job is labeled with the command id")
    stop = "from qaboard.runners.kubernetes import KubernetesRunner; KubernetesRunner.stop_jobs([], {'type': 'kubernetes', 'command_id': %r})" % command_id
    out = run(*python, '-c', stop, check=False, cwd=project)
    check(out.returncode == 0, "stop_jobs succeeds")
    check(not kubectl_json('get', 'jobs', '-l', selector)['items'], "the Jobs are deleted")
    for _ in range(60):
      if not kubectl_json('get', 'pods', '-l', selector)['items']:
        break
      time.sleep(2)
    check(not kubectl_json('get', 'pods', '-l', selector)['items'], "and their pods")

    log("submit_detached")
    detached_log = shared / 'detached' / 'log.txt'
    submit = "\n".join([
      "import json; from pathlib import Path; from qaboard.runners.kubernetes import KubernetesRunner",
      f"options = {{**{kubernetes!r}, 'command_id': {command_id!r}}}",
      f"print(json.dumps(KubernetesRunner.submit_detached('echo detached as $(id -u)', 'abcdefgh_e2e_driver', Path({str(detached_log)!r}), options)))",
    ])
    out = run(*python, '-c', submit, check=False, stdout=subprocess.PIPE, encoding='utf-8', cwd=project)
    print(out.stdout)
    info = json.loads(out.stdout.strip().splitlines()[-1]) if out.returncode == 0 else {}
    check(info.get('kubernetes_job', '').startswith('qa-abcdefgh-e2e-driver-'), "it returns the Job")
    for _ in range(90):
      if detached_log.is_file() and 'detached' in detached_log.read_text():
        break
      time.sleep(2)
    check(detached_log.is_file() and f'detached as {uid}' in detached_log.read_text(), "its script ran, and wrote its log")
    out = run(*python, '-c', stop, check=False, cwd=project)
    check(not kubectl_json('get', 'jobs', '-l', selector)['items'], "stop_jobs deletes it too")

    log("doctor, with a test job")
    doctor = "\n".join([
      "import json; from qaboard.runners.kubernetes import KubernetesRunner",
      f"options = {{**{kubernetes!r}, 'type': 'kubernetes', 'batch_dir': {str(shared / 'outputs')!r}}}",
      "checks = list(KubernetesRunner.doctor(options, test_job=True))",
      "print(json.dumps([c.__dict__ for c in checks]))",
    ])
    out = run(*python, '-c', doctor, check=False, stdout=subprocess.PIPE, encoding='utf-8', cwd=project)
    checks = json.loads(out.stdout.strip().splitlines()[-1]) if out.returncode == 0 else []
    for c in checks:
      print(f"  [{c['status']}] {c['name']}: {c['message']}" + (f"\n    fix: {c['fix']}" if c.get('fix') else ''))
    check(bool(checks) and not [c for c in checks if c['status'] == 'error'], "no errors")
    test_job = next((c for c in checks if c['name'] == 'Kubernetes: test job'), {})
    check(test_job.get('status') == 'ok' and f'uid={uid}' in test_job.get('message', ''), "the test pod ran as the user")
  finally:
    if failures:
      run('kubectl', 'get', 'jobs,pods', '-A', check=False)
    if not args.keep:
      run('kind', 'delete', 'cluster', '--name', CLUSTER, check=False)
      shutil.rmtree(shared, ignore_errors=True)

  if failures:
    print(f"\n{len(failures)} check(s) failed:\n" + "\n".join(f"- {f}" for f in failures))
    sys.exit(1)
  print("\nAll checks passed.")


if __name__ == '__main__':
  main()
