"""
Tests for the kubernetes runner, with a fake Kubernetes API.
We check the Jobs we would create, execute the pods' scripts with sh, and how we explain pending pods.
The real thing runs on a kind cluster in CI: .github/scripts/kubernetes_runner_e2e.py
"""
import os
import json
import shutil
import tempfile
import unittest
import subprocess
from copy import deepcopy
from pathlib import Path
from unittest import mock

from qaboard.checks import OK, ERROR, WARNING

try:
  import kubernetes # type: ignore # noqa: F401
  has_kubernetes = True
except ImportError:
  has_kubernetes = False


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
      job_options={"type": "kubernetes", "command_id": "abcdefgh-1234", "image": "qa:1", **job_options},
      output_dir=output_root / f'output{index}',
      command=command,
    )
    jobs.append(Job(run_context))
  return jobs


# Like BusyBox's timeout: no --version (it prints its usage, exit 1), and it only signals the command it runs
busybox_timeout = '''#!/bin/sh
case "$1" in --version|--help) echo "BusyBox v1.36.1 (2024-06-10 07:11:47 UTC) multi-call binary." >&2; echo "Usage: timeout [-s SIG] [-k KILL_SECS] SECS PROG ARGS" >&2; exit 1;; esac
[ "$1" = -k ] && shift 2
shift
exec "$@"
'''


def matches(labels, selector):
  return all(labels.get(k) == v for k, v in (part.split('=') for part in selector.split(',')))


class FakeKube():
  """Implements the API calls the runner makes, with dicts like the real Kube.call returns."""
  def __init__(self, namespace='team'):
    self.default_namespace = namespace
    self.host = 'https://k8s.example.com'
    self.configmaps = {}
    self.jobs = {}
    self.pods = []
    self.events = []
    self.calls = []
    self.deleted = []
    self.retry_for = 300
    # (group, resource, verb) -> allowed
    self.allowed = lambda attributes: True
    self.on_list = None

  def call(self, api, method, *args, **kwargs):
    self.calls.append(method)
    return getattr(self, method)(*args, **kwargs)

  def not_found(self, name):
    from qaboard.runners.kubernetes import ApiError
    return ApiError(404, f'"{name}" not found')

  def already_exists(self, name):
    from qaboard.runners.kubernetes import ApiError
    return ApiError(409, f'"{name}" already exists')

  def create_namespaced_config_map(self, namespace, body):
    if body['metadata']['name'] in self.configmaps:
      raise self.already_exists(body['metadata']['name'])
    self.configmaps[body['metadata']['name']] = deepcopy(body)
    return body

  def read_namespaced_config_map(self, name, namespace):
    if name not in self.configmaps:
      raise self.not_found(name)
    return self.configmaps[name]

  def create_namespaced_job(self, namespace, body):
    if body['metadata']['name'] in self.jobs:
      raise self.already_exists(body['metadata']['name'])
    job = {**deepcopy(body), 'status': {}}
    job['metadata']['uid'] = f"uid-{body['metadata']['name']}"
    self.jobs[body['metadata']['name']] = job
    return job

  def list_namespaced_job(self, namespace, label_selector):
    if self.on_list:
      self.on_list(self)
    return {'items': [j for j in self.jobs.values() if matches(j['metadata']['labels'], label_selector)]}

  def read_namespaced_job(self, name, namespace):
    if self.on_list:
      self.on_list(self)
    if name not in self.jobs:
      raise self.not_found(name)
    return self.jobs[name]

  def list_namespaced_pod(self, namespace, label_selector=None):
    return {'items': self.pods}

  def list_namespaced_event(self, namespace):
    return {'items': self.events}

  def delete_namespaced_job(self, name, namespace, propagation_policy=None):
    if name not in self.jobs:
      raise self.not_found(name)
    self.deleted.append(('job', name, propagation_policy))
    del self.jobs[name]

  def delete_namespaced_config_map(self, name, namespace):
    if name not in self.configmaps:
      raise self.not_found(name)
    self.deleted.append(('configmap', name, None))
    del self.configmaps[name]

  def read_namespaced_pod_log(self, name, namespace, **kwargs):
    return 'user: uid=1234\nqa: ok\n'

  def get_code(self):
    return {'gitVersion': 'v1.36.1'}

  def read_namespace(self, name):
    return {'metadata': {'name': name, 'labels': {'pod-security.kubernetes.io/enforce': 'baseline'}}}

  def create_self_subject_review(self, body):
    return {'status': {'userInfo': {'username': 'alice@example.com'}}}

  def create_self_subject_access_review(self, body):
    return {'status': {'allowed': self.allowed(body['spec']['resourceAttributes'])}}

  def read_namespaced_persistent_volume_claim(self, name, namespace):
    if name != 'algo-nfs':
      raise self.not_found(name)
    return {'status': {'phase': 'Bound'}}

  def read_namespaced_secret(self, name, namespace):
    raise self.not_found(name)

  def get_namespaced_custom_object(self, group, version, namespace, plural, name):
    raise self.not_found(name)


def finish(kube, failed_indexes=''):
  """Marks all Jobs as finished"""
  for job in kube.jobs.values():
    n = job['spec']['completions']
    job['status'] = {
      'completedIndexes': f'0-{n - 1}' if not failed_indexes else '',
      'failedIndexes': failed_indexes,
      'conditions': [{'type': 'Failed' if failed_indexes else 'Complete', 'status': 'True'}],
    }


class KubernetesTestCase(unittest.TestCase):
  def setUp(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.root = Path(tmp.name).resolve()
    self.kube = FakeKube()
    patches = [
      mock.patch('qaboard.runners.kubernetes.connect', return_value=self.kube),
      mock.patch('qaboard.runners.kubernetes.os.getuid', return_value=1234),
      mock.patch('qaboard.runners.kubernetes.os.getgid', return_value=500),
      mock.patch('qaboard.runners.kubernetes.os.getgroups', return_value=[500, 0, 600]),
      mock.patch('qaboard.runners.kubernetes.secho'),
      mock.patch('qaboard.runners.kubernetes.time.sleep'),
      mock.patch('qaboard.runners.kubernetes.unique_suffix', return_value='r4nd'),
    ]
    for p in patches:
      p.start()
      self.addCleanup(p.stop)

  def start(self, commands, blocking=False, **job_options):
    from qaboard.runners.kubernetes import KubernetesRunner
    jobs = make_jobs(commands, self.root, **job_options)
    with mock.patch('signal.signal'):
      KubernetesRunner.start_jobs(jobs, jobs[0].run_context.job_options, blocking=blocking)
    return jobs

  def pod_spec(self, job_name=None):
    job = self.kube.jobs[job_name] if job_name else next(iter(self.kube.jobs.values()))
    return job['spec']['template']['spec']


class TestSpec(KubernetesTestCase):
  def test_indexed_job(self):
    self.start(['qa run a', 'qa run b', 'qa run c'], concurrency=2, user='Alice Smith', project='algo/project', queue='gpu')
    self.assertEqual(list(self.kube.jobs), ['qa-abcdefgh-r4nd-0-0'])
    job = self.kube.jobs['qa-abcdefgh-r4nd-0-0']
    spec = job['spec']
    self.assertEqual(job['metadata']['namespace'], 'team')
    self.assertEqual((spec['completionMode'], spec['completions'], spec['parallelism']), ('Indexed', 3, 2))
    self.assertEqual((spec['backoffLimitPerIndex'], spec['maxFailedIndexes']), (0, 3))
    self.assertEqual(spec['podFailurePolicy']['rules'][0], {'action': 'Ignore', 'onPodConditions': [{'type': 'DisruptionTarget'}]})
    self.assertEqual(spec['ttlSecondsAfterFinished'], 86400)
    from qaboard.runners.labels import label_value
    labels = {
      'app.kubernetes.io/managed-by': 'qaboard',
      'qaboard.io/command-id': 'abcdefgh-1234',
      'qaboard.io/user': label_value('Alice Smith'),
      'qaboard.io/project': label_value('algo/project'),
    }
    self.assertRegex(labels['qaboard.io/project'], r'^algo-project-[0-9a-f]{8}$')
    self.assertEqual(job['metadata']['labels'], {**labels, 'kueue.x-k8s.io/queue-name': 'gpu'})
    self.assertEqual(spec['template']['metadata']['labels'], labels)
    pod = spec['template']['spec']
    self.assertEqual(pod['restartPolicy'], 'Never')
    container = pod['containers'][0]
    self.assertEqual(container['image'], 'qa:1')
    self.assertEqual(container['command'], ['sh', '-c', 'exec sh /etc/qaboard/run-$JOB_COMPLETION_INDEX.sh'])
    self.assertIn({'name': 'qaboard-scripts', 'configMap': {'name': 'qa-abcdefgh-r4nd-0-0'}}, pod['volumes'])
    # The ConfigMap has a script per pod, and is owned by the Job
    configmap = self.kube.configmaps['qa-abcdefgh-r4nd-0-0']
    self.assertEqual(sorted(configmap['data']), ['env.sh', 'run-0.sh', 'run-1.sh', 'run-2.sh'])
    self.assertEqual(configmap['metadata']['ownerReferences'], [{'apiVersion': 'batch/v1', 'kind': 'Job', 'name': 'qa-abcdefgh-r4nd-0-0', 'uid': 'uid-qa-abcdefgh-r4nd-0-0'}])
    self.assertEqual(configmap['metadata']['labels'], labels)
    self.assertTrue(configmap['immutable'])
    # owned from the start: no permission to patch ConfigMaps needed
    self.assertLess(self.kube.calls.index('create_namespaced_job'), self.kube.calls.index('create_namespaced_config_map'))
    self.assertNotIn('patch', ' '.join(self.kube.calls))

  def test_configmap_refused(self):
    """Without the scripts, the Job would wait forever: we delete it"""
    from qaboard.runners.kubernetes import ApiError
    def refuse(namespace, body):
      raise ApiError(403, 'configmaps is forbidden')
    self.kube.create_namespaced_config_map = refuse
    with self.assertRaisesRegex(Exception, 'Could not create the ConfigMap.*forbidden.*qa doctor'):
      self.start(['a'])
    self.assertEqual(self.kube.jobs, {})

  def test_run_as_non_root_and_mounts(self):
    self.start(['a'], run_as='image', run_as_non_root=True, mounts=[{'path': '/algo', 'pvc': 'algo', 'sub_path': 'qa', 'read_only': True}])
    pod = self.pod_spec()
    self.assertTrue(pod['securityContext']['runAsNonRoot'])
    self.assertNotIn('runAsUser', pod['securityContext'])
    self.assertEqual(pod['containers'][0]['volumeMounts'][0], {'name': 'qa-mount-0', 'mountPath': '/algo', 'readOnly': True, 'subPath': 'qa'})
    for mounts in ([{'path': '/a', 'pvc': 'x', 'volume': {'hostPath': {'path': '/'}}}], [{'path': '/a'}], [{'path': 'relative', 'pvc': 'x'}],
                   [{'path': '/a', 'pvc': 'x', 'host_path': '/a'}], [{'path': '/a', 'nfs': {'server': 's', 'path': '/', 'extra': 1}}]):
      with self.assertRaisesRegex(ValueError, 'runners.kubernetes.mounts'):
        self.start(['a'], mounts=mounts)

  def test_no_concurrency_limit(self):
    self.start(['a', 'b', 'c'], concurrency=0, namespace='other')
    job = self.kube.jobs['qa-abcdefgh-r4nd-0-0']
    self.assertEqual(job['spec']['parallelism'], 3)
    self.assertEqual(job['metadata']['namespace'], 'other')

  @unittest.skipUnless(has_kubernetes, "requires the kubernetes extra")
  def test_valid_for_the_client(self):
    """Every field we generate exists in the API: the client drops unknown fields when it reads them"""
    from kubernetes.client import ApiClient # type: ignore
    self.start(['a'], resources={'cpu': 2, 'memory': '4Gi'}, mounts=[{'path': '/algo', 'pvc': 'algo-nfs'}], tolerations=[{'key': 'k', 'operator': 'Exists'}],
               node_selector={'pool': 'gpu'}, image_pull_secrets=['creds'], priority_class='low', service_account='runs', pod_timeout=60, timeout=30, queue='q')
    body = deepcopy(self.kube.jobs['qa-abcdefgh-r4nd-0-0'])
    body.pop('status')
    client = ApiClient()
    # deserialize()'s signature changed across versions, not this
    job = client._ApiClient__deserialize(json.loads(json.dumps(body)), 'V1Job')
    self.assertEqual(client.sanitize_for_serialization(job), body)

  def test_run_as(self):
    from qaboard.runners.kubernetes import run_as_ids
    self.start(['a'])
    self.assertEqual(self.pod_spec()['securityContext'], {
      'seccompProfile': {'type': 'RuntimeDefault'},
      'runAsUser': 1234, 'runAsNonRoot': True, 'runAsGroup': 500,
      # no root group, and never fsGroup: it would chown the shared volumes
      'supplementalGroups': [500, 600],
    })
    self.assertEqual(self.pod_spec()['containers'][0]['securityContext'], {'allowPrivilegeEscalation': False, 'capabilities': {'drop': ['ALL']}})
    self.assertEqual(run_as_ids('image'), (None, None, []))
    self.assertEqual(run_as_ids({'uid': 1000, 'gid': 100, 'groups': [7, 8]}), (1000, 100, [7, 8]))
    self.assertEqual(run_as_ids({'uid': 1000}), (1000, None, []))
    with mock.patch('qaboard.runners.kubernetes.os.getuid', return_value=0):
      with self.assertRaisesRegex(Exception, 'never start pods as root.*run_as: image'):
        run_as_ids('user')
    with self.assertRaisesRegex(Exception, 'Unknown runners.kubernetes.run_as'):
      run_as_ids('someone')

  def test_run_as_image(self):
    self.start(['a'], run_as='image')
    self.assertEqual(self.pod_spec()['securityContext'], {'seccompProfile': {'type': 'RuntimeDefault'}})

  def test_mounts_resources_and_options(self):
    self.start(['a'], mounts=[
      {'path': '/algo', 'pvc': 'algo-nfs'},
      {'path': '/home', 'nfs': {'server': 'nas1', 'path': '/export/home'}},
      {'path': '/data', 'host_path': '/data'},
    ], resources={'cpu': 4, 'memory': '16Gi', 'nvidia.com/gpu': 1}, node_selector={'pool': 'gpu'}, service_account='qa-runs', pod_timeout=3600, image_pull_secrets='creds')
    pod = self.pod_spec()
    self.assertEqual(pod['volumes'][:3], [
      {'name': 'qa-mount-0', 'persistentVolumeClaim': {'claimName': 'algo-nfs'}},
      {'name': 'qa-mount-1', 'nfs': {'server': 'nas1', 'path': '/export/home'}},
      {'name': 'qa-mount-2', 'hostPath': {'path': '/data'}},
    ])
    container = pod['containers'][0]
    self.assertEqual([m['mountPath'] for m in container['volumeMounts']], ['/algo', '/home', '/data', '/etc/qaboard'])
    self.assertEqual(container['resources'], {
      'requests': {'cpu': '4', 'memory': '16Gi', 'nvidia.com/gpu': '1'},
      'limits': {'memory': '16Gi', 'nvidia.com/gpu': '1'},
    })
    self.assertEqual(pod['nodeSelector'], {'pool': 'gpu'})
    self.assertEqual(pod['serviceAccountName'], 'qa-runs')
    self.assertEqual(pod['activeDeadlineSeconds'], 3600)
    # one secret, as a string
    self.assertEqual(pod['imagePullSecrets'], [{'name': 'creds'}])

  def test_resources(self):
    from qaboard.runners.kubernetes import resources_spec
    self.assertEqual(resources_spec({'cpu': 4, 'memory': '16Gi'}), {'requests': {'cpu': '4', 'memory': '16Gi'}, 'limits': {'memory': '16Gi'}})
    self.assertEqual(resources_spec({'cpu': '500m'}), {'requests': {'cpu': '500m'}})
    explicit = {'requests': {'cpu': 4, 'memory': '16Gi'}, 'limits': {'memory': '32Gi'}}
    self.assertEqual(resources_spec(explicit), {'requests': {'cpu': '4', 'memory': '16Gi'}, 'limits': {'memory': '32Gi'}})
    self.assertEqual(resources_spec({'limits': {'nvidia.com/gpu': 1}}), {'limits': {'nvidia.com/gpu': '1'}})
    for invalid in ({'cpu': 4, 'limits': {'memory': '1Gi'}}, {'requests': 4}, {'cpu': {'request': 4}}, {'requests': {'cpu': [4]}}, '4 CPUs', {'gpu': True}):
      with self.assertRaisesRegex(ValueError, r'runners.kubernetes.resources.*requests: \{cpu: 4, memory: 16Gi\}, limits', msg=str(invalid)):
        resources_spec(invalid)
    # before creating anything
    with self.assertRaisesRegex(ValueError, 'mixes requests \\(cpu\\) with `limits`'):
      self.start(['a'], resources={'cpu': 4, 'limits': {'memory': '1Gi'}})
    self.assertEqual(self.kube.calls, [])
    self.start(['a'], resources=explicit)
    self.assertEqual(self.pod_spec()['containers'][0]['resources'], {'requests': {'cpu': '4', 'memory': '16Gi'}, 'limits': {'memory': '32Gi'}})

  def test_option_types(self):
    from qaboard.runners.kubernetes import option_errors
    self.assertEqual(option_errors({'image': 'qa:1', 'concurrency': 2, 'timeout': 1.5, 'image_pull_secrets': 'creds', 'run_as': {'uid': 1}, 'resources': None}), {})
    errors = option_errors({'concurrency': '2', 'runs_per_pod': True, 'mounts': {'path': '/a'}, 'image_pull_secrets': [{'name': 'x'}], 'pod_timeout': 'never', 'env': ['A=1']})
    self.assertEqual(sorted(errors), ['concurrency', 'env', 'image_pull_secrets', 'mounts', 'pod_timeout', 'runs_per_pod'])
    self.assertEqual(errors['concurrency'], "runners.kubernetes.concurrency should be an integer, not '2'.")
    self.assertIn('should be a number', errors['pod_timeout'])
    with self.assertRaisesRegex(ValueError, 'runners.kubernetes.mounts should be a list.*qa doctor'):
      self.start(['a'], mounts={'path': '/a'})
    self.assertEqual(self.kube.jobs, {})

  def test_timeouts(self):
    """`timeout` is per run, in the pods' scripts; `pod_timeout` is the pods' deadline, for all their runs"""
    from qaboard.runners.kubernetes import KubernetesRunner
    self.assertEqual(KubernetesRunner.group_options, ('concurrency', 'runs_per_pod', 'pod_timeout'))
    self.start(['qa run --input a', 'qa run --input b'], runs_per_pod=2, timeout=90.5)
    self.assertNotIn('activeDeadlineSeconds', self.pod_spec())
    script = self.kube.configmaps['qa-abcdefgh-r4nd-0-0']['data']['run-0.sh']
    self.assertEqual(script.count("timeout -k 60 91 sh -c 'qa run --input"), 2)

  def test_no_image(self):
    from qaboard.runners.kubernetes import KubernetesRunner
    jobs = make_jobs(['a'], self.root)
    del jobs[0].run_context.job_options['image']
    with self.assertRaisesRegex(Exception, 'Set runners.kubernetes.image'):
      KubernetesRunner.start_jobs(jobs, jobs[0].run_context.job_options, blocking=False)
    self.assertEqual(self.kube.jobs, {})

  def test_template(self):
    """Our spec wins on what we must control and on what options set, the template on everything else"""
    import yaml
    template = {
      'apiVersion': 'batch/v1', 'kind': 'Job',
      'metadata': {'name': 'theirs', 'labels': {'team': 'algo', 'qaboard.io/user': 'someone-else'}, 'annotations': {'a': 'b'}},
      'spec': {
        'completions': 100, 'parallelism': 100, 'backoffLimitPerIndex': 2, 'ttlSecondsAfterFinished': 60,
        'template': {'spec': {
          'containers': [{
            'name': 'main', 'image': 'template-image', 'command': ['theirs'], 'args': ['--theirs'],
            'env': [{'name': 'QABOARD_TOKEN', 'valueFrom': {'secretKeyRef': {'name': 'qa', 'key': 'token'}}}],
            'volumeMounts': [{'name': 'cache', 'mountPath': '/cache'}],
          }],
          'volumes': [{'name': 'cache', 'emptyDir': {}}],
          'tolerations': [{'key': 'theirs', 'operator': 'Exists'}],
          'affinity': {'nodeAffinity': {}},
        }},
      },
    }
    path = self.root / 'job.yaml'
    path.write_text(yaml.safe_dump(template))
    self.start(['a', 'b'], job_template=str(path), tolerations=[{'key': 'ours', 'operator': 'Exists'}], image='option-image', user='alice')
    job = self.kube.jobs['qa-abcdefgh-r4nd-0-0']
    self.assertEqual(job['metadata']['name'], 'qa-abcdefgh-r4nd-0-0')
    self.assertEqual(job['metadata']['labels']['team'], 'algo')
    self.assertEqual(job['metadata']['labels']['qaboard.io/command-id'], 'abcdefgh-1234')
    self.assertEqual(job['metadata']['labels']['qaboard.io/user'], 'alice')
    self.assertEqual(job['metadata']['annotations']['a'], 'b')
    self.assertRegex(job['metadata']['annotations']['qaboard.io/invocation'], '^[0-9a-f]{32}$')
    spec = job['spec']
    self.assertEqual((spec['completions'], spec['parallelism']), (2, 2))
    # our defaults lose
    self.assertEqual((spec['backoffLimitPerIndex'], spec['ttlSecondsAfterFinished']), (2, 60))
    pod = spec['template']['spec']
    self.assertEqual(len(pod['containers']), 1)
    container = pod['containers'][0]
    self.assertEqual(container['name'], 'main')
    self.assertEqual(container['image'], 'option-image')
    self.assertEqual(container['command'][0], 'sh')
    self.assertEqual(container['args'], [])
    self.assertEqual(container['env'][0]['name'], 'QABOARD_TOKEN')
    self.assertEqual([m['name'] for m in container['volumeMounts']], ['cache', 'qaboard-scripts'])
    self.assertEqual([v['name'] for v in pod['volumes']], ['cache', 'qaboard-scripts'])
    self.assertEqual([t['key'] for t in pod['tolerations']], ['theirs', 'ours'])
    self.assertIn('affinity', pod)
    # without the option, the template's image
    self.kube.jobs.clear()
    self.kube.configmaps.clear()
    from qaboard.runners.kubernetes import KubernetesRunner
    jobs = make_jobs(['a'], self.root, job_template=str(path))
    del jobs[0].run_context.job_options['image']
    KubernetesRunner.start_jobs(jobs, jobs[0].run_context.job_options, blocking=False)
    self.assertEqual(self.pod_spec()['containers'][0]['image'], 'template-image')

  def test_chunks(self):
    with mock.patch('qaboard.runners.kubernetes.max_configmap_bytes', 3000):
      self.start([f'qa run --input {"x" * 300}{i}' for i in range(10)], concurrency=3, forward_env=False)
    self.assertGreater(len(self.kube.jobs), 1)
    self.assertEqual(list(self.kube.jobs), [f'qa-abcdefgh-r4nd-0-{i}' for i in range(len(self.kube.jobs))])
    self.assertEqual(sum(j['spec']['completions'] for j in self.kube.jobs.values()), 10)
    for configmap in self.kube.configmaps.values():
      self.assertLess(sum(len(v) for v in configmap['data'].values()), 3000)
    for job in self.kube.jobs.values():
      self.assertLessEqual(job['spec']['parallelism'], 3)

  def test_jobs_by_pod_spec(self):
    """Runs with other options (e.g. per input type) get their own Job, and each group too"""
    from qaboard.runners import JobGroup
    from qaboard.runners.kubernetes import KubernetesRunner
    jobs = make_jobs(['a', 'b'], self.root)
    jobs += make_jobs(['c'], self.root / 'gpu', resources={'nvidia.com/gpu': 1})
    jobs += make_jobs(['d', 'e'], self.root / 'serial', concurrency=1)
    group = JobGroup(jobs=jobs, job_options={"type": "kubernetes", "command_id": "abcdefgh-1234", "image": "qa:1"})
    KubernetesRunner.start_groups(group.groups(), blocking=False)
    self.assertEqual({n: j['spec']['completions'] for n, j in self.kube.jobs.items()}, {'qa-abcdefgh-r4nd-0-0': 2, 'qa-abcdefgh-r4nd-0-1': 1, 'qa-abcdefgh-r4nd-1-0': 2})
    self.assertIn('resources', self.pod_spec('qa-abcdefgh-r4nd-0-1')['containers'][0])
    self.assertEqual(self.kube.jobs['qa-abcdefgh-r4nd-1-0']['spec']['parallelism'], 1)


class TestRobustness(KubernetesTestCase):
  def test_reused_command_id(self):
    """`qa optimize` runs its batches with the same command id"""
    with mock.patch('qaboard.runners.kubernetes.unique_suffix', side_effect=['a1b2', 'c3d4']):
      self.start(['a'])
      self.start(['a'])
    self.assertEqual(sorted(self.kube.jobs), ['qa-abcdefgh-a1b2-0-0', 'qa-abcdefgh-c3d4-0-0'])

  def test_retried_create(self):
    """A create whose response was lost, then retried, gets 409: the object is ours"""
    create_job, create_configmap = self.kube.create_namespaced_job, self.kube.create_namespaced_config_map
    def twice(create):
      def created_then_conflict(namespace, body):
        create(namespace, body)
        return create(namespace, body)
      return created_then_conflict
    self.kube.create_namespaced_job = twice(create_job)
    self.kube.create_namespaced_config_map = twice(create_configmap)
    self.start(['a'])
    self.assertEqual(list(self.kube.jobs), ['qa-abcdefgh-r4nd-0-0'])
    self.assertEqual(list(self.kube.configmaps), ['qa-abcdefgh-r4nd-0-0'])
    # someone else's
    self.kube.jobs['qa-abcdefgh-r4nd-0-0']['metadata']['labels']['qaboard.io/command-id'] = 'other'
    self.kube.create_namespaced_job = create_job
    with self.assertRaisesRegex(Exception, 'already exists'):
      self.start(['a'])

  def test_same_name_same_command_id(self):
    """A Job with our name and command id isn't ours unless this create made it: e.g. `qa optimize`'s iterations reuse command ids"""
    self.start(['echo old'])
    old_scripts = deepcopy(self.kube.configmaps['qa-abcdefgh-r4nd-0-0']['data'])
    with self.assertRaisesRegex(Exception, 'Could not create the Job qa-abcdefgh-r4nd-0-0.*already exists'):
      self.start(['echo new'])
    self.assertEqual(self.kube.configmaps['qa-abcdefgh-r4nd-0-0']['data'], old_scripts)
    # the ConfigMap too
    del self.kube.jobs['qa-abcdefgh-r4nd-0-0']
    with self.assertRaisesRegex(Exception, 'Could not create the ConfigMap qa-abcdefgh-r4nd-0-0.*already exists'):
      self.start(['echo new'])
    self.assertEqual(self.kube.jobs, {})

  def test_no_leaks_when_creation_fails(self):
    """Jobs created before an error or Ctrl-C are deleted: their pods would wait forever"""
    from qaboard.runners import JobGroup
    from qaboard.runners.kubernetes import KubernetesRunner
    create = self.kube.create_namespaced_job
    for error in (KeyboardInterrupt(), Exception('boom')):
      calls = []
      def fails_second(namespace, body):
        calls.append(body['metadata']['name'])
        if len(calls) == 2:
          raise error
        return create(namespace, body)
      self.kube.create_namespaced_job = fails_second
      jobs = make_jobs(['a'], self.root) + make_jobs(['b'], self.root / 'serial', concurrency=1)
      group = JobGroup(jobs=jobs, job_options={"type": "kubernetes", "command_id": "abcdefgh-1234", "image": "qa:1"})
      with self.assertRaises(type(error)):
        KubernetesRunner.start_groups(group.groups(), blocking=False)
      self.assertEqual(self.kube.jobs, {})
      self.assertEqual(self.kube.configmaps, {})
    # submit_detached too
    def interrupted(namespace, body):
      create(namespace, body)
      raise KeyboardInterrupt()
    self.kube.create_namespaced_job = interrupted
    with self.assertRaises(KeyboardInterrupt):
      KubernetesRunner.submit_detached('true', 'x', self.root / 'log.txt', {'command_id': 'abcdefgh-1234', 'image': 'qa:1'})
    self.assertEqual(self.kube.jobs, {})

  def test_old_clusters(self):
    """Before Kubernetes 1.29, backoffLimitPerIndex is dropped: one failed run would fail all"""
    create = self.kube.create_namespaced_job
    def drops_it(namespace, body):
      job = create(namespace, body)
      del job['spec']['backoffLimitPerIndex']
      return job
    self.kube.create_namespaced_job = drops_it
    with self.assertRaisesRegex(Exception, '1.29'):
      self.start(['a'])
    self.assertEqual(self.kube.jobs, {})

  def test_invalid_command_id(self):
    from qaboard.runners.kubernetes import KubernetesRunner
    jobs = make_jobs(['a'], self.root)
    with self.assertRaisesRegex(ValueError, 'Invalid command id'):
      KubernetesRunner.start_jobs(jobs, {**jobs[0].run_context.job_options, 'command_id': 'a b'}, blocking=False)
    self.assertEqual(self.kube.calls, [])

  def test_huge_pod(self):
    with mock.patch('qaboard.runners.kubernetes.max_configmap_bytes', 3000):
      with self.assertRaisesRegex(Exception, 'runs_per_pod'):
        self.start([f'qa run --input {"x" * 300}{i}' for i in range(20)], runs_per_pod=20, forward_env=False)
    self.assertEqual(self.kube.jobs, {})

  def test_namespace_per_run_is_per_batch(self):
    from qaboard.runners.kubernetes import KubernetesRunner
    jobs = make_jobs(['a'], self.root) + make_jobs(['b'], self.root / 'other', namespace='elsewhere')
    with mock.patch('qaboard.runners.kubernetes.secho') as secho:
      KubernetesRunner.start_jobs(jobs, jobs[0].run_context.job_options, blocking=False)
    self.assertIn('per batch', ' '.join(str(c) for c in secho.call_args_list))
    self.assertEqual({j['metadata']['namespace'] for j in self.kube.jobs.values()}, {'team'})

  def test_symlinks(self):
    """The pods see the mounts' paths, which qa may have resolved"""
    from qaboard.runners.kubernetes import logical_path, job_to_run
    real = self.root / 'nfs2' / 'algo'
    (real / 'project' / 'sub').mkdir(parents=True)
    (self.root / 'algo').symlink_to(real)
    with mock.patch.dict(os.environ, {'PWD': str(self.root / 'algo' / 'project' / 'sub')}):
      self.assertEqual(logical_path(real / 'project'), str(self.root / 'algo' / 'project'))
      self.assertEqual(logical_path(real / 'project' / 'output' / 'a'), str(self.root / 'algo' / 'project' / 'output' / 'a'))
      self.assertEqual(logical_path('/elsewhere'), '/elsewhere')
      job = make_jobs(['a'], real / 'project' / 'output')[0]
      with mock.patch('qaboard.runners.kubernetes.os.getcwd', return_value=str(real / 'project')):
        run = job_to_run(job)
      self.assertEqual(run['cwd'], str(self.root / 'algo' / 'project'))
      self.assertEqual(run['output_dir'], str(self.root / 'algo' / 'project' / 'output' / 'output0'))
    with mock.patch.dict(os.environ, {'PWD': str(real / 'project')}):
      self.assertEqual(logical_path(real / 'project'), str(real / 'project'))

  def test_cant_read_pods(self):
    """Without permissions to read pods or events, we just don't explain why pods are pending"""
    from qaboard.runners.kubernetes import ApiError
    polls = []
    def on_list(kube):
      polls.append(1)
      if len(polls) == 3:
        finish(kube)
    self.kube.on_list = on_list
    def forbidden(*args, **kwargs):
      raise ApiError(403, 'pods is forbidden')
    self.kube.list_namespaced_pod = forbidden
    self.start(['a'], blocking=True)
    self.assertEqual(len(polls), 3)


class TestScripts(KubernetesTestCase):
  """The pods' scripts, executed with sh"""
  def run_pods(self, commands, runs_per_pod, bin_files=None, **job_options):
    bin_dir = self.root / 'bin'
    bin_dir.mkdir()
    for name, content in (bin_files or {}).items():
      (bin_dir / name).write_text(content)
      (bin_dir / name).chmod(0o755)
    # A fake `qa`: prints where it runs and its environment, fails for the "fail" input
    qa = bin_dir / 'qa'
    qa.write_text('#!/bin/sh\necho "qa $* in $(pwd) with MPLBACKEND=$MPLBACKEND FROM_ENV=$FROM_ENV"\necho "to stderr" >&2\ncase "$*" in *fail*) exit 3;; esac\n')
    qa.chmod(0o755)
    self.cwd = self.root / 'project'
    self.cwd.mkdir(exist_ok=True)
    with mock.patch('qaboard.runners.kubernetes.os.getcwd', return_value=str(self.cwd)):
      self.start(commands, runs_per_pod=runs_per_pod, env={'FROM_ENV': 'yes', 'PATH': f'{bin_dir}:/usr/bin:/bin'}, **job_options)
    configmap = self.kube.configmaps['qa-abcdefgh-r4nd-0-0']
    scripts_dir = self.root / 'etc-qaboard'
    scripts_dir.mkdir()
    for name, content in configmap['data'].items():
      (scripts_dir / name).write_text(content)
    results = []
    for index in range(self.kube.jobs['qa-abcdefgh-r4nd-0-0']['spec']['completions']):
      out = subprocess.run(['sh', '-c', f'exec sh {scripts_dir}/run-$JOB_COMPLETION_INDEX.sh'], env={'JOB_COMPLETION_INDEX': str(index), 'PATH': '/usr/bin:/bin'},
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding='utf-8', cwd=str(self.root))
      results.append(out)
    return results

  def test_runs_per_pod(self):
    commands = ['qa run --input a', 'qa run --input fail', 'qa run --input c', 'cd sub && qa run --input d', 'qa run --input e']
    (self.root / 'project' / 'sub').mkdir(parents=True)
    results = self.run_pods(commands, runs_per_pod=2)
    self.assertEqual(len(results), 3)
    # the pod with a failed run fails, after doing all its runs
    self.assertEqual([r.returncode for r in results], [1, 0, 0])
    self.assertIn('run 2/2 failed with exit code 3', results[0].stdout)
    for index, command in enumerate(commands):
      log = (self.root / f'output{index}' / 'log.k8s.txt').read_text()
      cwd = self.cwd / 'sub' if 'cd sub' in command else self.cwd
      self.assertEqual(log, f"qa {command.split('qa ')[1]} in {cwd} with MPLBACKEND=agg FROM_ENV=yes\nto stderr\n")

  def test_pending_note_removed_and_unwritable_logs(self):
    (self.root / 'output0').mkdir()
    (self.root / 'output0' / 'log.pending.txt').write_text('pending')
    # can't be written: a directory
    (self.root / 'output1' / 'log.k8s.txt').mkdir(parents=True)
    results = self.run_pods(['qa run --input a', 'qa run --input b'], runs_per_pod=2)
    self.assertFalse((self.root / 'output0' / 'log.pending.txt').exists())
    self.assertEqual(results[0].returncode, 1)
    self.assertIn(f"[qaboard] ERROR: can not write {self.root / 'output1' / 'log.k8s.txt'} as uid", results[0].stdout)
    self.assertIn('run 2/2 failed with exit code 1', results[0].stdout)
    # bash too: a failed `exec >` doesn't exit it
    out = subprocess.run(['bash', str(self.root / 'etc-qaboard' / 'run-0.sh')], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding='utf-8')
    self.assertEqual(out.returncode, 1)
    self.assertIn('run 2/2 failed with exit code 1', out.stdout)

  def test_timeout(self):
    results = self.run_pods(['qa run --input a; sleep 30', 'qa run --input b'], runs_per_pod=2, timeout=1)
    self.assertEqual(results[0].returncode, 1)
    self.assertIn('run 1/2 failed with exit code 124', results[0].stdout)
    self.assertIn('the run timed out after 1s', (self.root / 'output0' / 'log.k8s.txt').read_text())
    self.assertNotIn('timed out', (self.root / 'output1' / 'log.k8s.txt').read_text())

  def test_timeout_needs_coreutils(self):
    """BusyBox's timeout may accept `-k`, but doesn't signal the process group, nor always exit with 124: we refuse it"""
    results = self.run_pods(['qa run --input a', 'qa run --input b'], runs_per_pod=2, timeout=5, bin_files={'timeout': busybox_timeout})
    self.assertEqual(results[0].returncode, 1)
    self.assertIn('run 1/2 failed with exit code 1', results[0].stdout)
    for index in (0, 1):
      log = (self.root / f'output{index}' / 'log.k8s.txt').read_text()
      self.assertIn("[qaboard] ERROR: runners.kubernetes.timeout needs the timeout command of GNU coreutils in the image, not BusyBox's", log)
      self.assertNotIn('qa run', log)

  def test_missing_cwd(self):
    results = self.run_pods(['qa run --input a', 'qa run --input b'], runs_per_pod=2)
    shutil.rmtree(self.cwd)
    out = subprocess.run(['sh', str(self.root / 'etc-qaboard' / 'run-0.sh')], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding='utf-8')
    self.assertEqual(results[0].returncode, 0)
    self.assertEqual(out.returncode, 1)
    self.assertIn('run 1/2 failed', out.stdout)
    self.assertIn('run 2/2 failed', out.stdout)
    self.assertIn(str(self.cwd), (self.root / 'output0' / 'log.k8s.txt').read_text())


class TestEnv(unittest.TestCase):
  def test_env(self):
    from qaboard.runners.kubernetes import run_env, dict_to_KubernetesOptions, env_script
    environ = {
      'QA_BATCH': 'true', 'MY_SETTING': "it's", 'PATH': '/home/me/bin', 'HOME': '/home/me', 'LANG': 'en_US.UTF-8', 'LC_CTYPE': 'x',
      'QABOARD_TOKEN': 'secret', 'AWS_SECRET_ACCESS_KEY': 'secret', 'GITLAB_ACCESS_TOKEN': 'secret', 'DB_PASSWORD': 'x',
      'KUBERNETES_SERVICE_HOST': '10.0.0.1', 'HOSTNAME': 'mine', 'LSB_JOBID': '1', 'BASH_FUNC_x%%': '() {}', 'USER': 'me',
      'SSL_CERT_FILE': '/etc/my-ca.crt', 'REQUESTS_CA_BUNDLE': '/home/me/ca.crt', 'HTTPS_PROXY': 'http://127.0.0.1:3128', 'http_proxy': 'http://proxy.corp:3128',
    }
    with mock.patch.dict(os.environ, environ, clear=True):
      env = run_env(dict_to_KubernetesOptions({'env': {'MY_SETTING': 'override', 'N': 4}}))
      self.assertEqual(env, {
        'QA_BATCH': 'true', 'MY_SETTING': 'override', 'N': '4', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'MPLBACKEND': 'agg', 'HOME': '/tmp', 'BASH_FUNC_x%%': '() {}',
        # the pods' uid has no /etc/passwd entry
        'USER': 'me', 'LOGNAME': 'me',
        'http_proxy': 'http://proxy.corp:3128',
      })
      # HOME and files are ours if the pods see them
      env = run_env(dict_to_KubernetesOptions({'mounts': [{'path': '/home', 'pvc': 'homes'}]}))
      self.assertEqual(env['HOME'], '/home/me')
      self.assertEqual(env['REQUESTS_CA_BUNDLE'], '/home/me/ca.crt')
      self.assertNotIn('SSL_CERT_FILE', env)
      # the server's environment stays out
      env = run_env(dict_to_KubernetesOptions({'forward_env': False, 'user': 'alice', 'mounts': [{'path': '/home', 'pvc': 'homes'}]}))
      self.assertNotIn('QA_BATCH', env)
      self.assertEqual((env['USER'], env['HOME']), ('alice', '/tmp'))
    script = env_script({'A': "it's", 'BASH_FUNC_x%%': '() {}'})
    self.assertEqual(script, "export A='it'\"'\"'s'\n")
    out = subprocess.run(['sh', '-c', f'{script}\necho "$A"'], stdout=subprocess.PIPE, encoding='utf-8')
    self.assertEqual(out.stdout, "it's\n")

  def test_secrets(self):
    from qaboard.runners.env import is_secret, forwarded_env
    for name, value in (('OPENAI_API_KEY', 'x'), ('DB_PASS', 'x'), ('GITHUB_TOKEN', 'x'), ('MY_JWT', 'x'), ('SESSION_COOKIE', 'x'),
                        ('SSH_PRIVATE_KEY_PATH', 'x'), ('DATABASE_URL', 'postgres://user:pw@db:5432/x'),
                        ('CI_REPOSITORY_URL', 'https://gitlab-ci-token:xyz@gitlab.example.com/a/b.git')):
      self.assertTrue(is_secret(name, value), name)
    self.assertTrue(is_secret('REDIS_URL', 'redis://:pw@redis:6379'))
    self.assertTrue(is_secret('REPO', 'https://ghp_0123456789abcdefghijklmnopqrstuv@github.com/a/b'))
    # a user name isn't a secret
    for name, value in (('QA_BATCH_ROOT_COMMAND_ID', 'x'), ('KEYBOARD_LAYOUT', 'us'), ('OMP_NUM_THREADS', '4'), ('CI_PROJECT_URL', 'https://gitlab.example.com/a/b'),
                        ('REPO_URL', 'ssh://git@gitlab.example.com/a/b.git'), ('PIP_INDEX_URL', 'https://alice@pypi.example.com/simple'), ('SERVER', 'http://host:8080/x')):
      self.assertFalse(is_secret(name, value), name)
    with mock.patch.dict(os.environ, {'DATABASE_URL': 'postgres://u:pw@db/x', 'OK': 'https://example.com'}, clear=True):
      self.assertEqual(forwarded_env(), {'OK': 'https://example.com'})
      self.assertEqual(forwarded_env(keep_secrets=True), {'DATABASE_URL': 'postgres://u:pw@db/x', 'OK': 'https://example.com'})

  def test_pods_defaults_win(self):
    """What pods need wins over qa's environment, `env` wins over both"""
    from qaboard.runners.kubernetes import run_env, dict_to_KubernetesOptions
    environ = {'MPLBACKEND': 'MacOSX', 'DISPLAY': ':0', 'PYTHONPATH': '/home/me/lib:/algo/lib', 'USER': 'me'}
    with mock.patch.dict(os.environ, environ, clear=True):
      env = run_env(dict_to_KubernetesOptions({'mounts': [{'path': '/algo', 'pvc': 'x'}]}))
      self.assertEqual(env['MPLBACKEND'], 'agg')
      self.assertNotIn('DISPLAY', env)
      # our PYTHONPATH would break the image's python, unless the pods see it all
      self.assertNotIn('PYTHONPATH', env)
      env = run_env(dict_to_KubernetesOptions({'mounts': [{'path': '/algo', 'pvc': 'x'}, {'path': '/home', 'pvc': 'y'}], 'env': {'MPLBACKEND': 'pdf'}}))
      self.assertEqual(env['PYTHONPATH'], '/home/me/lib:/algo/lib')
      self.assertEqual(env['MPLBACKEND'], 'pdf')

  def test_names(self):
    from qaboard.runners.kubernetes import dns_name
    from qaboard.runners.labels import label_value
    def is_label_value(value):
      import re
      return len(value) <= 63 and re.fullmatch(r'(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?', value)
    self.assertEqual(label_value('algo-project_1.2'), 'algo-project_1.2')
    self.assertEqual(label_value(''), '')
    self.assertRegex(label_value('algo/my project_'), r'^algo-my-project-[0-9a-f]{8}$')
    # different values, different labels
    self.assertNotEqual(label_value('a/b'), label_value('a b'))
    self.assertNotEqual(label_value('a/b'), 'a-b')
    for value in ('-x' * 50, 'a' * 100, '//', 'é', 'a' * 63 + '/'):
      self.assertTrue(is_label_value(label_value(value)), value)
      self.assertLessEqual(len(label_value(value)), 63)
    self.assertEqual(dns_name('qa-ABCDEFGH_dask_driver'), 'qa-abcdefgh-dask-driver')
    # random parts of names: no collisions between the Jobs kept for a day
    from qaboard.runners.kubernetes import unique_suffix
    self.assertRegex(unique_suffix(), '^[0-9a-f]{12}$')


class TestBlocking(KubernetesTestCase):
  def test_waits_until_finished(self):
    polls = []
    def on_list(kube):
      polls.append(1)
      if len(polls) == 3:
        finish(kube, failed_indexes='1')
    self.kube.on_list = on_list
    self.start(['a', 'b'], blocking=True)
    self.assertEqual(len(polls), 3)

  def test_stopped_batch_deletes_its_jobs(self):
    from qaboard.runners.kubernetes import KubernetesRunner
    jobs = make_jobs(['a', 'b'], self.root)
    handlers = {}
    def wait(kube, created, selector):
      handlers['SIGTERM']()
    with mock.patch('signal.signal', side_effect=lambda s, h: handlers.setdefault(s.name, h)), mock.patch('qaboard.runners.kubernetes.wait_jobs', wait):
      with self.assertRaises(SystemExit):
        KubernetesRunner.start_jobs(jobs, jobs[0].run_context.job_options, blocking=True)
    self.assertEqual(self.kube.jobs, {})
    self.assertIn(('job', 'qa-abcdefgh-r4nd-0-0', 'Background'), self.kube.deleted)

  def pending_pod(self, index, waiting=None, unschedulable=None):
    return {
      'metadata': {'name': f'qa-abcdefgh-r4nd-0-0-{index}-xyz', 'uid': f'pod-{index}', 'labels': {'batch.kubernetes.io/job-name': 'qa-abcdefgh-r4nd-0-0', 'batch.kubernetes.io/job-completion-index': str(index)}},
      'status': {
        'phase': 'Pending',
        'conditions': [{'type': 'PodScheduled', 'status': 'False', 'reason': 'Unschedulable', 'message': unschedulable}] if unschedulable else [],
        'containerStatuses': [{'state': {'waiting': waiting}}] if waiting else [],
      },
    }

  def test_pending_reasons_are_reported_in_the_runs_logs(self):
    message = '0/3 nodes are available: 3 Insufficient nvidia.com/gpu. preemption: 0/3 nodes are available.'
    def on_list(kube):
      kube.pods = [self.pending_pod(1, unschedulable=message)]
      if len(kube.calls) > 10:
        finish(kube)
    self.kube.on_list = on_list
    self.start(['a', 'b', 'c'], blocking=True, runs_per_pod=2)
    # Not in log.k8s.txt: the pods may run as another user, who could not replace our file
    self.assertFalse((self.root / 'output2' / 'log.k8s.txt').exists())
    log = (self.root / 'output2' / 'log.pending.txt').read_text()
    self.assertIn('pending', log)
    self.assertIn('Insufficient nvidia.com/gpu', log)
    self.assertIn('No node has enough free nvidia.com/gpu', log)
    # once
    self.assertEqual(log.count('pending'), 1)
    self.assertFalse((self.root / 'output0' / 'log.pending.txt').exists())

  def test_pending_reasons_when_pods_run_as_someone_else(self):
    """We don't create the output directories of pods that run as another user: they couldn't write in them"""
    message = '0/3 nodes are available: 3 Insufficient cpu.'
    def on_list(kube):
      kube.pods = [self.pending_pod(0, unschedulable=message), self.pending_pod(1, unschedulable=message)]
      if len(kube.calls) > 10:
        finish(kube)
    self.kube.on_list = on_list
    (self.root / 'output1').mkdir()
    self.start(['a', 'b'], blocking=True, run_as={'uid': 999, 'gid': 999})
    self.assertFalse((self.root / 'output0').exists())
    self.assertIn('Insufficient cpu', (self.root / 'output1' / 'log.pending.txt').read_text())

  def test_job_wide_findings_only_in_runs_not_started(self):
    def on_list(kube):
      job = kube.jobs['qa-abcdefgh-r4nd-0-0']
      job['status'] = {'completedIndexes': '0', 'active': 0}
      kube.pods = []
      kube.events = [{'type': 'Warning', 'reason': 'FailedCreate', 'count': 1, 'message': 'pods "x" is forbidden: exceeded quota: q',
                      'involvedObject': {'kind': 'Job', 'name': job['metadata']['name'], 'uid': job['metadata']['uid']}}]
      if len(kube.calls) > 10:
        finish(kube)
    self.kube.on_list = on_list
    self.start(['a', 'b', 'c'], blocking=True)
    self.assertFalse((self.root / 'output0' / 'log.pending.txt').exists())
    for index in (1, 2):
      self.assertIn('ResourceQuota', (self.root / f'output{index}' / 'log.pending.txt').read_text())

  def test_fails_fast_when_runs_cant_start(self):
    def on_list(kube):
      kube.pods = [self.pending_pod(0, waiting={'reason': 'InvalidImageName', 'message': 'couldn\'t parse image name "Qa:1"'})]
    self.kube.on_list = on_list
    with mock.patch('qaboard.runners.kubernetes.secho') as secho, self.assertRaises(SystemExit):
      self.start(['a'], blocking=True)
    self.assertEqual(self.kube.jobs, {})
    self.assertIn('InvalidImageName', (self.root / 'output0' / 'log.pending.txt').read_text())
    # it says that all the batch's Jobs are deleted
    self.assertIn('Deleting all its 1 Kubernetes Job(s)', '\n'.join(str(c[0][0]) for c in secho.call_args_list))

  def test_abort_is_quick(self):
    """
    Stopped, we delete the Jobs retrying API calls briefly. Stopped again, we exit at once, unless it's within 2s:
    LSF and some supervisors send SIGINT and SIGTERM together.
    """
    from qaboard.runners.kubernetes import KubernetesRunner
    jobs = make_jobs(['a', 'b'], self.root)
    handlers = {}
    def set_handler(signo, handler):
      previous = handlers.get(signo.name)
      handlers[signo.name] = handler
      return previous
    clock = [1000.0]
    retry_for, survived = [], []
    def deleting(name, namespace, propagation_policy=None):
      retry_for.append(self.kube.retry_for)
      # with the signal that stopped us
      clock[0] += 0.1
      handlers['SIGINT']()
      clock[0] += 1.5
      handlers['SIGTERM']()
      survived.append(clock[0])
      # later: users want to quit now
      clock[0] += 0.5
      handlers['SIGINT']()
    self.kube.delete_namespaced_job = deleting
    def wait(kube, created, selector):
      handlers['SIGTERM']()
    with mock.patch('signal.signal', side_effect=set_handler), mock.patch('qaboard.runners.kubernetes.wait_jobs', wait), \
         mock.patch('qaboard.runners.kubernetes.time.monotonic', side_effect=lambda: clock[0]), \
         mock.patch('qaboard.runners.kubernetes.os._exit', side_effect=SystemExit(1)) as exit_now, mock.patch('sys.stderr'), mock.patch('builtins.print'):
      with self.assertRaises(SystemExit):
        KubernetesRunner.start_jobs(jobs, jobs[0].run_context.job_options, blocking=True)
    exit_now.assert_called_once_with(1)
    self.assertEqual(survived, [1001.6])
    self.assertEqual(retry_for, [15])
    self.assertEqual(self.kube.retry_for, 300)


class TestDiagnostics(unittest.TestCase):
  def test_classify(self):
    from qaboard.runners.kubernetes import classify
    self.assertTrue(classify('InvalidImageName', '')[1])
    self.assertTrue(classify('CreateContainerConfigError', 'secret "x" not found')[1])
    # refusals: once they repeat
    refused = 'pods "qa-x" is forbidden: violates PodSecurity "restricted:latest": hostPath volumes'
    self.assertFalse(classify('FailedCreate', refused)[1])
    self.assertTrue(classify('FailedCreate', refused, count=3)[1])
    self.assertTrue(classify('FailedCreate', 'admission webhook "policy.example.com" denied the request: runAsUser', count=5)[1])
    # errors that pass
    for message in ('Internal error occurred: failed calling webhook "kueue": context deadline exceeded',
                    'pods "qa-x" is forbidden: Internal error occurred: please try again'):
      self.assertFalse(classify('FailedCreate', message, count=10)[1], message)
    self.assertFalse(classify('FailedMount', 'MountVolume.SetUp failed for volume "x": configmap "y" is forbidden: no relationship found between node "n" and this object', count=10)[1])
    hint, fatal = classify('FailedCreate', 'pods "qa-x" is forbidden: exceeded quota: compute, requested: cpu=4, used: cpu=8, limited: cpu=8', count=10)
    self.assertFalse(fatal)
    self.assertIn('ResourceQuota', hint)
    # a quota that no pod could ever fit in
    hint, fatal = classify('FailedCreate', 'pods "qa-x" is forbidden: exceeded quota: compute, requested: limits.memory=16Gi,requests.cpu=500m, used: limits.memory=0,requests.cpu=0, limited: limits.memory=8Gi,requests.cpu=2')
    self.assertTrue(fatal)
    self.assertIn('limits.memory', hint)
    self.assertNotIn('requests.cpu', hint)
    hint, fatal = classify('FailedScheduling', "0/2 nodes are available: 1 node(s) didn't match Pod's node affinity/selector, 1 node(s) had untolerated taint {gpu: true}.")
    self.assertFalse(fatal)
    self.assertIn('node_selector', hint)
    self.assertIn('tolerations', hint)
    self.assertIn('PVC', classify('FailedScheduling', '0/1 nodes are available: persistentvolumeclaim "algo" not found.')[0])
    self.assertIn('image_pull_secrets', classify('Failed', 'Failed to pull image "x": 401 Unauthorized')[0])

  def test_image_pull_fails_after_a_while(self):
    from qaboard.runners.kubernetes import PendingDiagnostics
    jobs = [{'metadata': {'name': 'j', 'uid': 'job-uid', 'labels': {}}}]
    pods = [{'metadata': {'name': 'j-0-x', 'uid': 'pod-uid', 'labels': {'job-name': 'j'}}, 'status': {'phase': 'Pending', 'containerStatuses': [{'state': {'waiting': {'reason': 'ImagePullBackOff', 'message': 'Back-off pulling image "qa:1"'}}}]}}]
    # As in a real event, with the "spec.containers{qa}: " prefix
    events = [{'type': 'Warning', 'reason': 'Failed', 'message': 'spec.containers{qa}: Failed to pull image "qa:1": not found', 'involvedObject': {'kind': 'Pod', 'name': 'j-0-x', 'uid': 'pod-uid'}}]
    diagnostics = PendingDiagnostics()
    findings = diagnostics.check(jobs, pods, events, now=1000)
    self.assertEqual(len(findings), 1)
    self.assertFalse(findings[0].fatal)
    self.assertEqual(findings[0].index, None)
    self.assertFalse(any(f.fatal for f in diagnostics.check(jobs, pods, [], now=1200)))
    self.assertTrue(any(f.fatal for f in diagnostics.check(jobs, pods, [], now=1300)))
    # it was fixed in the meantime
    diagnostics.check(jobs, [], [], now=1400)
    self.assertFalse(any(f.fatal for f in diagnostics.check(jobs, pods, [], now=1500)))

  def test_image_pulls_per_pod(self):
    """The grace period is per pod, and pulls are never fatal while other pods of the Job could pull the image"""
    from qaboard.runners.kubernetes import PendingDiagnostics
    jobs = [{'metadata': {'name': 'j', 'uid': 'job-uid', 'labels': {}}, 'status': {}}]
    def pod(index, phase='Pending'):
      waiting = {'reason': 'ErrImagePull', 'message': 'rpc error'} if phase == 'Pending' else {}
      return {'metadata': {'name': f'j-{index}', 'uid': f'pod-{index}', 'labels': {'job-name': 'j', 'batch.kubernetes.io/job-completion-index': str(index)}},
              'status': {'phase': phase, 'containerStatuses': [{'state': {'waiting': waiting}}]}}
    diagnostics = PendingDiagnostics()
    self.assertFalse(any(f.fatal for f in diagnostics.check(jobs, [pod(0)], [], now=1000)))
    # another pod starts pulling later: the first one's grace period isn't reset
    self.assertFalse(any(f.fatal for f in diagnostics.check(jobs, [pod(0), pod(1)], [], now=1200)))
    findings = diagnostics.check(jobs, [pod(0), pod(1)], [], now=1300)
    self.assertEqual({f.index: f.fatal for f in findings}, {0: True, 1: False})
    # a pod of the Job runs: it's a node's problem
    findings = diagnostics.check(jobs, [pod(0), pod(1), pod(2, 'Running')], [], now=1600)
    self.assertFalse(any(f.fatal for f in findings))
    self.assertIn("node's problem", findings[0].hint)
    jobs[0]['status'] = {'completedIndexes': '2'}
    self.assertFalse(any(f.fatal for f in diagnostics.check(jobs, [pod(0)], [], now=1700)))

  def test_image_pulls_are_reported_once(self):
    """How long a pull has been failing changes every minute: it's not what tells if we already said it"""
    from qaboard.runners.kubernetes import PendingDiagnostics, BatchJob, report
    with tempfile.TemporaryDirectory() as tmp:
      output_dir = Path(tmp) / 'output0'
      jobs = [{'metadata': {'name': 'j', 'uid': 'job-uid', 'labels': {}}, 'status': {}}]
      pulling = {'metadata': {'name': 'j-0', 'uid': 'pod-0', 'labels': {'job-name': 'j', 'batch.kubernetes.io/job-completion-index': '0'}},
                 'status': {'phase': 'Pending', 'containerStatuses': [{'state': {'waiting': {'reason': 'ErrImagePull', 'message': 'rpc error'}}}]}}
      running = {'metadata': {'name': 'j-1', 'uid': 'pod-1', 'labels': {'job-name': 'j', 'batch.kubernetes.io/job-completion-index': '1'}}, 'status': {'phase': 'Running'}}
      batch_job = BatchJob('team', 'j', [[{'output_dir': str(output_dir)}], [{'output_dir': str(Path(tmp) / 'output1')}]])
      diagnostics = PendingDiagnostics()
      reported, logged, printed = set(), set(), []
      with mock.patch('qaboard.runners.kubernetes.secho', side_effect=lambda message, **kwargs: printed.append(message)):
        for now in range(1000, 1000 + 15 * 60, 60):
          findings = diagnostics.check(jobs, [pulling, running], [], now=now)
          self.assertEqual(len(findings), 1)
          self.assertFalse(findings[0].fatal)
          report(findings[0], batch_job, reported, logged, started={1})
      # before the grace period, then after it: a node's problem, since another pod could pull it
      self.assertEqual(len(printed), 2, printed)
      self.assertNotIn('Failing for', printed[0])
      self.assertIn("node's problem. Failing for 5 minutes.", printed[1])
      self.assertIn('Failing for 14 minutes.', str(findings[0]))
      self.assertEqual(len((output_dir / 'log.pending.txt').read_text().splitlines()), 4)

  def test_old_events_are_not_fatal(self):
    """Refusals are fatal once they repeat, if they still happen: an event from before we last looked isn't"""
    from qaboard.runners.kubernetes import PendingDiagnostics
    jobs = [{'metadata': {'name': 'j', 'uid': 'job-uid', 'labels': {}, 'creationTimestamp': '2026-11-09T10:00:00Z'}}]
    def event(count, at, uid='job-uid'):
      return {'type': 'Warning', 'reason': 'FailedCreate', 'count': count, 'lastTimestamp': at, 'message': 'admission webhook "x" denied the request',
              'involvedObject': {'kind': 'Job', 'name': 'j', 'uid': uid}}
    diagnostics = PendingDiagnostics()
    self.assertFalse(diagnostics.check(jobs, [], [event(1, '2026-11-09T10:00:05Z')])[0].fatal)
    # no new refusal since: the count is old
    self.assertFalse(diagnostics.check(jobs, [], [event(3, '2026-11-09T10:00:05Z')])[0].fatal)
    # it happens again
    self.assertTrue(diagnostics.check(jobs, [], [event(3, '2026-11-09T10:01:00.123456Z')])[0].fatal)
    # events from before the Job was created aren't about it
    self.assertEqual(PendingDiagnostics().check(jobs, [], [event(5, '2026-11-09T09:59:00Z')]), [])
    self.assertTrue(PendingDiagnostics().check(jobs, [], [event(5, '2026-11-09T10:00:01Z')])[0].fatal)

  def test_events_of_previous_objects(self):
    """Events of a deleted Job or pod with the same name aren't about ours"""
    from qaboard.runners.kubernetes import PendingDiagnostics
    jobs = [{'metadata': {'name': 'j', 'uid': 'new', 'labels': {}}}]
    events = [{'type': 'Warning', 'reason': 'FailedCreate', 'count': 10, 'message': 'admission webhook "x" denied the request', 'involvedObject': {'kind': 'Job', 'name': 'j', 'uid': 'old'}}]
    self.assertEqual(PendingDiagnostics().check(jobs, [], events), [])
    events[0]['involvedObject']['uid'] = 'new'
    self.assertTrue(PendingDiagnostics().check(jobs, [], events)[0].fatal)

  def test_kueue_and_job_events(self):
    from qaboard.runners.kubernetes import PendingDiagnostics
    jobs = [{'metadata': {'name': 'j', 'uid': 'job-uid', 'labels': {'kueue.x-k8s.io/queue-name': 'gpu'}}, 'spec': {'suspend': True}}]
    events = [
      {'type': 'Warning', 'reason': 'FailedCreate', 'message': 'Error creating: pods "j-0" is forbidden: exceeded quota: q', 'involvedObject': {'kind': 'Job', 'name': 'j', 'uid': 'job-uid'}},
      {'type': 'Normal', 'reason': 'Suspended', 'message': 'Job suspended', 'involvedObject': {'kind': 'Job', 'name': 'j', 'uid': 'job-uid'}},
      {'type': 'Warning', 'reason': 'FailedCreate', 'message': 'not ours', 'involvedObject': {'kind': 'Job', 'name': 'other', 'uid': 'other-uid'}},
    ]
    findings = PendingDiagnostics().check(jobs, [], events)
    self.assertEqual(sorted(f.reason for f in findings), ['FailedCreate', 'Kueue'])
    self.assertFalse(any(f.fatal for f in findings))
    self.assertIn('"gpu"', next(f for f in findings if f.reason == 'Kueue').message)


class TestStop(KubernetesTestCase):
  def test_stop_by_label(self):
    from qaboard.runners.kubernetes import KubernetesRunner
    self.start(['a', 'b'])
    self.kube.create_namespaced_job('team', {'metadata': {'name': 'qa-other-0-0', 'labels': {'qaboard.io/command-id': 'other'}}})
    # what the server knows
    self.assertEqual(KubernetesRunner.stop_jobs([], {'type': 'kubernetes', 'command_id': 'abcdefgh-1234'}), 1)
    self.assertEqual(list(self.kube.jobs), ['qa-other-0-0'])
    self.assertEqual(self.kube.configmaps, {})
    self.assertEqual(self.kube.calls[-3:], ['list_namespaced_job', 'delete_namespaced_job', 'delete_namespaced_config_map'])
    # nothing left: we say so
    self.assertEqual(KubernetesRunner.stop_jobs([], {'type': 'kubernetes', 'command_id': 'abcdefgh-1234'}), 0)

  def test_stop_with_api_retry_seconds(self):
    from qaboard.runners import kubernetes
    kubernetes.KubernetesRunner.stop_jobs([], {'type': 'kubernetes', 'command_id': 'abcdefgh-1234', 'api_retry_seconds': 15})
    self.assertEqual(kubernetes.connect.call_args[0][0].api_retry_seconds, 15)
    kubernetes.KubernetesRunner.submit_detached('true', 'qa-abcdefgh-driver', self.root / 'log.txt', {'command_id': 'abcdefgh-1234', 'image': 'qa:1', 'api_retry_seconds': 15})
    self.assertEqual(kubernetes.connect.call_args[0][0].api_retry_seconds, 15)

  def test_stop_by_project_and_command_id(self):
    from qaboard.runners.kubernetes import KubernetesRunner
    self.start(['a'], project='algo/project')
    selectors = []
    list_jobs = self.kube.list_namespaced_job
    def recording(namespace, label_selector):
      selectors.append(label_selector)
      return list_jobs(namespace, label_selector)
    self.kube.list_namespaced_job = recording
    KubernetesRunner.stop_jobs([], {'type': 'kubernetes', 'command_id': 'abcdefgh-1234', 'project': 'other/project'})
    self.assertEqual(len(self.kube.jobs), 1)
    KubernetesRunner.stop_jobs([], {'type': 'kubernetes', 'command_id': 'abcdefgh-1234', 'project': 'algo/project'})
    self.assertEqual(self.kube.jobs, {})
    self.assertRegex(selectors[-1], r'^qaboard.io/command-id=abcdefgh-1234,qaboard.io/project=algo-project-[0-9a-f]{8}$')
    # never a selector from raw input
    for command_id in ('', 'a,qaboard.io/user!=x', 'x' * 64, None):
      with self.assertRaisesRegex(ValueError, 'Invalid command id'):
        KubernetesRunner.stop_jobs([], {'type': 'kubernetes', 'command_id': command_id})
    self.assertEqual(len(selectors), 2)

  def test_submit_detached(self):
    from qaboard.runners.kubernetes import KubernetesRunner
    log_file = self.root / 'logs' / 'driver.log'
    result = KubernetesRunner.submit_detached('echo "driver $X"', 'abcdefgh_dask_driver', log_file, {
      'command_id': 'abcdefgh-1234', 'image': 'qa:1', 'service_account': 'qaboard-batches', 'run_as': {'uid': 1000, 'gid': 1000}, 'env': {'X': 'ok'}, 'timeout': 10,
    })
    self.assertEqual(result, {'kubernetes_job': 'qa-abcdefgh-dask-driver-r4nd', 'namespace': 'team'})
    job = self.kube.jobs['qa-abcdefgh-dask-driver-r4nd']
    self.assertEqual(job['spec']['completions'], 1)
    self.assertEqual(job['spec']['backoffLimit'], 0)
    self.assertNotIn('completionMode', job['spec'])
    self.assertEqual(job['metadata']['labels']['qaboard.io/command-id'], 'abcdefgh-1234')
    pod = job['spec']['template']['spec']
    self.assertEqual(pod['serviceAccountName'], 'qaboard-batches')
    self.assertEqual(pod['securityContext']['runAsUser'], 1000)
    self.assertNotIn('activeDeadlineSeconds', pod)
    # only sh is needed
    self.assertEqual(pod['containers'][0]['command'], ['sh', '/etc/qaboard/run.sh'])
    data = self.kube.configmaps['qa-abcdefgh-dask-driver-r4nd']['data']
    scripts = self.write_scripts(data)
    # what qa batch wrote while it was pending is obsolete once it starts
    log_file.parent.mkdir()
    (log_file.parent / 'driver.pending.log').write_text('pending')
    subprocess.run(['sh', str(scripts / 'run.sh')], check=True)
    self.assertEqual(log_file.read_text(), 'driver ok\n')
    self.assertFalse((log_file.parent / 'driver.pending.log').exists())
    # the batch's stop deletes it
    KubernetesRunner.stop_jobs([], {'type': 'kubernetes', 'command_id': 'abcdefgh-1234'})
    self.assertEqual(self.kube.jobs, {})

  def test_stop_only_the_driver(self):
    """When the server's driver fails to start, it deletes only its Job (role=driver), not the runs' Jobs it started"""
    from qaboard.runners.kubernetes import KubernetesRunner
    KubernetesRunner.submit_detached('qa batch x', 'qa-abcdefgh-driver', self.root / 'log.txt', {'command_id': 'abcdefgh-1234', 'image': 'qa:1'})
    driver = self.kube.jobs['qa-abcdefgh-driver-r4nd']
    self.assertEqual(driver['metadata']['labels']['qaboard.io/role'], 'driver')
    self.assertEqual(driver['spec']['template']['metadata']['labels']['qaboard.io/role'], 'driver')
    self.assertEqual(self.kube.configmaps['qa-abcdefgh-driver-r4nd']['metadata']['labels']['qaboard.io/role'], 'driver')
    self.start(['a', 'b'])
    runs = [name for name in self.kube.jobs if name != 'qa-abcdefgh-driver-r4nd']
    self.assertEqual(len(runs), 1)
    self.assertNotIn('qaboard.io/role', self.kube.jobs[runs[0]]['metadata']['labels'])
    self.assertEqual(KubernetesRunner.stop_jobs([], {'type': 'kubernetes', 'command_id': 'abcdefgh-1234', 'role': 'driver'}), 1)
    self.assertEqual(list(self.kube.jobs), runs)
    for role in ('driver,qaboard.io/user!=x', ['driver'], 'x' * 64):
      with self.assertRaisesRegex(ValueError, 'Invalid role'):
        KubernetesRunner.stop_jobs([], {'type': 'kubernetes', 'command_id': 'abcdefgh-1234', 'role': role})
    # the batch's stop deletes them all
    self.assertEqual(KubernetesRunner.stop_jobs([], {'type': 'kubernetes', 'command_id': 'abcdefgh-1234'}), 1)
    self.assertEqual(self.kube.jobs, {})

  def write_scripts(self, data, name='scripts'):
    scripts = self.root / name
    scripts.mkdir()
    for key, content in data.items():
      (scripts / key).write_text(content)
    return scripts

  def test_submit_detached_interpreter(self):
    """Scripts run with sh, unless they start with #!: e.g. the server's bash scripts"""
    from qaboard.runners.kubernetes import KubernetesRunner
    log_file = self.root / 'logs' / 'log.txt'
    KubernetesRunner.submit_detached('#!/bin/bash\nset -o pipefail\necho "bash $BASH_VERSION" | cut -c1-4', 'qa-abcdefgh-driver', log_file, {'command_id': 'abcdefgh-1234', 'image': 'qa:1'})
    scripts = self.write_scripts(self.kube.configmaps['qa-abcdefgh-driver-r4nd']['data'])
    self.assertIn("exec /bin/bash \"$(dirname \"$0\")/script\"", (scripts / 'run.sh').read_text())
    subprocess.run(['sh', str(scripts / 'run.sh')], check=True)
    self.assertEqual(log_file.read_text(), 'bash\n')

  def test_submit_detached_cant_write_its_log(self):
    """If the pod can't write its log file (e.g. it runs as another user), it fails, saying why: not with the output lost"""
    from qaboard.runners.kubernetes import KubernetesRunner
    (self.root / 'a-file').write_text('')
    for log_file in (self.root / 'a-file' / 'log.txt', self.root):
      self.kube.jobs.clear()
      self.kube.configmaps.clear()
      KubernetesRunner.submit_detached('echo ran > ran.txt', 'qa-abcdefgh-driver', log_file, {'command_id': 'abcdefgh-1234', 'image': 'qa:1'})
      scripts = self.write_scripts(self.kube.configmaps['qa-abcdefgh-driver-r4nd']['data'], name=f'scripts-{log_file.name}')
      for shell in ('sh', 'bash'):
        out = subprocess.run([shell, str(scripts / 'run.sh')], stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding='utf-8', cwd=str(self.root))
        self.assertEqual(out.returncode, 1, shell)
        self.assertIn(f'[qaboard] ERROR: can not write {log_file} as uid', out.stderr)
        self.assertFalse((self.root / 'ran.txt').exists())

  def test_submit_detached_that_fails_as_it_starts(self):
    from qaboard.runners.kubernetes import KubernetesRunner
    def list_pods(namespace, label_selector=None):
      return {'items': [{'metadata': {'name': 'p', 'labels': {'batch.kubernetes.io/job-name': 'qa-abcdefgh-driver-r4nd'}}, 'status': {'phase': 'Failed'}}]}
    self.kube.list_namespaced_pod = list_pods
    self.kube.read_namespaced_pod_log = lambda name, namespace, **kwargs: '[qaboard] ERROR: can not write /logs/log.txt as uid 1000\n'
    with self.assertRaisesRegex(Exception, '(?s)failed as it started.*can not write /logs/log.txt'):
      KubernetesRunner.submit_detached('qa batch x', 'qa-abcdefgh-driver', self.root / 'log.txt', {'command_id': 'abcdefgh-1234', 'image': 'qa:1'})
    # it runs: we return after a little while
    polls = []
    def running(namespace, label_selector=None):
      polls.append(1)
      return {'items': [{'metadata': {'name': 'p'}, 'status': {'phase': 'Running'}}]}
    self.kube.list_namespaced_pod = running
    self.kube.jobs.clear()
    self.kube.configmaps.clear()
    KubernetesRunner.submit_detached('qa batch x', 'qa-abcdefgh-driver', self.root / 'log.txt', {'command_id': 'abcdefgh-1234', 'image': 'qa:1'})
    self.assertEqual(len(polls), 2)

  def test_submit_detached_from_the_server(self):
    """What the server sends: names already start with qa-, and its environment (with its secrets) stays out"""
    from qaboard.runners.kubernetes import KubernetesRunner
    with mock.patch.dict(os.environ, {'SERVER_SETTING': 'x', 'HOME': '/home/server'}):
      result = KubernetesRunner.submit_detached('qa batch x', 'qa-abcdefgh-driver', self.root / 'log.txt', {
        'type': 'kubernetes', 'command_id': 'abcdefgh-1234', 'namespace': 'algo', 'image': 'qa:1', 'forward_env': False, 'timeout': 0,
        'run_as': {'uid': 1000, 'gid': 1000, 'groups': [2000]}, 'user': 'alice', 'project': 'algo/project', 'resources': {'cpu': '500m', 'memory': '2Gi'},
        'mounts': [{'path': '/home', 'pvc': 'homes'}],
      })
    self.assertEqual(result, {'kubernetes_job': 'qa-abcdefgh-driver-r4nd', 'namespace': 'algo'})
    job = self.kube.jobs['qa-abcdefgh-driver-r4nd']
    self.assertRegex(job['metadata']['labels']['qaboard.io/project'], r'^algo-project-[0-9a-f]{8}$')
    self.assertEqual(job['spec']['template']['spec']['securityContext']['supplementalGroups'], [2000])
    env_sh = self.kube.configmaps['qa-abcdefgh-driver-r4nd']['data']['env.sh']
    self.assertNotIn('SERVER_SETTING', env_sh)
    self.assertIn("HOME=/tmp", env_sh)

  def test_submit_detached_that_cant_start(self):
    from qaboard.runners.kubernetes import KubernetesRunner
    log_file = self.root / 'log.txt'
    def list_pods(namespace, label_selector=None):
      return {'items': [{
        'metadata': {'name': 'p', 'labels': {'batch.kubernetes.io/job-name': 'qa-abcdefgh-driver-r4nd'}},
        'status': {'phase': 'Pending', 'containerStatuses': [{'state': {'waiting': {'reason': 'CreateContainerConfigError', 'message': 'secret "qa" not found'}}}]},
      }]}
    self.kube.list_namespaced_pod = list_pods
    with self.assertRaisesRegex(Exception, "(?s)can't start.*CreateContainerConfigError"):
      KubernetesRunner.submit_detached('qa batch x', 'qa-abcdefgh-driver', log_file, {'command_id': 'abcdefgh-1234', 'image': 'qa:1'})
    self.assertEqual(self.kube.jobs, {})
    # not in the log: the pod may run as someone else, who must be able to write it
    self.assertFalse(log_file.exists())
    self.assertIn('secret "qa" not found', (self.root / 'log.pending.txt').read_text())
    # pending for a reason that can go away: we say so and return
    self.kube.list_namespaced_pod = lambda namespace, label_selector=None: {'items': []}
    self.kube.events = [{'type': 'Warning', 'reason': 'FailedCreate', 'message': 'forbidden: exceeded quota: q', 'involvedObject': {'kind': 'Job', 'name': 'qa-abcdefgh-driver-r4nd', 'uid': 'uid-qa-abcdefgh-driver-r4nd'}}]
    self.kube.configmaps.clear()
    KubernetesRunner.submit_detached('qa batch x', 'qa-abcdefgh-driver', log_file, {'command_id': 'abcdefgh-1234', 'image': 'qa:1'})
    self.assertIn('ResourceQuota', (self.root / 'log.pending.txt').read_text())
    self.assertIn('qa-abcdefgh-driver-r4nd', self.kube.jobs)
    self.assertFalse(log_file.exists())


@unittest.skipUnless(has_kubernetes, "requires the kubernetes extra")
class TestDoctor(KubernetesTestCase):
  def setUp(self):
    super().setUp()
    import yaml
    self.kubeconfig = self.root / 'kubeconfig'
    self.kubeconfig.write_text(yaml.safe_dump({
      'apiVersion': 'v1', 'kind': 'Config', 'current-context': 'dev',
      'clusters': [{'name': 'c', 'cluster': {'server': 'https://k8s.example.com'}}],
      'users': [
        {'name': 'token', 'user': {'token': 'x'}},
        {'name': 'sso', 'user': {'exec': {'apiVersion': 'client.authentication.k8s.io/v1', 'command': 'kubelogin-not-installed'}}},
      ],
      'contexts': [
        {'name': 'dev', 'context': {'cluster': 'c', 'user': 'token', 'namespace': 'team'}},
        {'name': 'prod', 'context': {'cluster': 'c', 'user': 'sso'}},
      ],
    }))
    p = mock.patch.dict(os.environ, {'KUBECONFIG': str(self.kubeconfig)})
    p.start()
    self.addCleanup(p.stop)
    os.environ.pop('KUBERNETES_SERVICE_HOST', None)

  def doctor(self, test_job=False, **job_options):
    from qaboard.runners.kubernetes import KubernetesRunner
    return {c.name: c for c in KubernetesRunner.doctor({'type': 'kubernetes', 'image': 'qa:1', **job_options}, test_job=test_job)}

  def test_all_good(self):
    checks = self.doctor(mounts=[{'path': str(self.root), 'pvc': 'algo-nfs'}], batch_dir=str(self.root / 'out'))
    self.assertEqual({n: c.status for n, c in checks.items() if c.status != OK}, {'Kubernetes: mounts': WARNING}) # the project isn't in the mount
    self.assertIn('context dev', checks['Kubernetes: kubeconfig'].message)
    self.assertIn('v1.36.1', checks['Kubernetes: API'].message)
    self.assertIn('uid 1234, gid 500', checks['Kubernetes: run as'].message)

  def test_forbidden(self):
    self.kube.allowed = lambda a: not (a['resource'] == 'jobs' and a['verb'] == 'delete') and a['resource'] != 'pods'
    check = self.doctor(queue='gpu')['Kubernetes: permissions in namespace team']
    self.assertEqual(check.status, ERROR)
    self.assertIn("alice@example.com can't: delete jobs, get pods, list pods, watch pods, get pods/log", check.message)
    import yaml
    role, binding = yaml.safe_load_all(check.fix.split('\n', 1)[1])
    self.assertEqual(role['kind'], 'Role')
    self.assertEqual(role['metadata']['namespace'], 'team')
    self.assertIn({'apiGroups': ['batch'], 'resources': ['jobs'], 'verbs': ['create', 'get', 'list', 'watch', 'delete']}, role['rules'])
    self.assertIn({'apiGroups': [''], 'resources': ['pods/log'], 'verbs': ['get']}, role['rules'])
    self.assertIn({'apiGroups': ['kueue.x-k8s.io'], 'resources': ['localqueues'], 'verbs': ['get']}, role['rules'])
    self.assertEqual(binding['subjects'], [{'kind': 'User', 'name': 'alice@example.com', 'apiGroup': 'rbac.authorization.k8s.io'}])
    self.assertEqual(binding['roleRef']['name'], 'qaboard-runner')

  def test_service_account_binding(self):
    from qaboard.runners.kubernetes import rbac_yaml
    import yaml
    _, binding = yaml.safe_load_all(rbac_yaml('ns', 'system:serviceaccount:qaboard:server'))
    self.assertEqual(binding['subjects'], [{'kind': 'ServiceAccount', 'name': 'server', 'namespace': 'qaboard'}])

  def test_problems(self):
    checks = self.doctor(queue='gpu', image_pull_secrets=['creds'], mounts=[{'path': '/a', 'pvc': 'missing'}, {'path': '/b', 'host_path': '/b'}], run_as='image')
    self.assertEqual(checks['Kubernetes: Kueue queue gpu'].status, ERROR)
    self.assertEqual(checks['Kubernetes: image pull secret creds'].status, ERROR)
    self.assertEqual(checks['Kubernetes: mount /a (PVC missing)'].status, ERROR)
    # the namespace is "baseline"
    self.assertEqual(checks['Kubernetes: run as'].status, ERROR)
    self.assertIn('host_path', checks['Kubernetes: run as'].message)

  def test_no_image(self):
    from qaboard.runners.kubernetes import KubernetesRunner
    checks = {c.name: c for c in KubernetesRunner.doctor({'type': 'kubernetes'})}
    self.assertEqual(checks['Kubernetes: image'].status, ERROR)
    self.assertIn('image:', checks['Kubernetes: image'].fix)

  def test_old_cluster(self):
    self.kube.get_code = lambda: {'gitVersion': 'v1.28.9'}
    checks = self.doctor()
    self.assertEqual(checks['Kubernetes: API'].status, ERROR)
    self.assertIn('1.29', checks['Kubernetes: API'].message)
    self.assertNotIn('Kubernetes: permissions in namespace team', checks)

  def test_credential_plugin(self):
    checks = self.doctor(context='prod')
    self.assertEqual(checks['Kubernetes: credential plugin'].status, ERROR)
    self.assertIn('kubelogin-not-installed', checks['Kubernetes: credential plugin'].message)
    self.assertNotIn('Kubernetes: API', checks)

  def test_bad_context_and_no_kubeconfig(self):
    checks = self.doctor(context='nope')
    self.assertEqual(checks['Kubernetes: kubeconfig'].status, ERROR)
    self.assertIn('dev, prod', checks['Kubernetes: kubeconfig'].message)
    self.kubeconfig.unlink()
    checks = self.doctor()
    self.assertEqual(checks['Kubernetes: kubeconfig'].status, ERROR)
    self.assertIn('~/.kube/config', checks['Kubernetes: kubeconfig'].fix)

  def test_never_raises(self):
    self.kube.get_code = mock.Mock(side_effect=ConnectionRefusedError('nope'))
    self.kube.api_client = mock.Mock()
    self.kube.api_client.configuration.host = 'https://k8s.example.com'
    checks = self.doctor()
    self.assertEqual(checks['Kubernetes: API'].status, ERROR)
    self.kube.read_namespace = mock.Mock(side_effect=KeyError('boom'))
    self.kube.get_code = lambda: {'gitVersion': 'v1'}
    checks = self.doctor()
    self.assertEqual(checks['Kubernetes: namespace'].status, ERROR)
    self.assertIn('KeyError', checks['Kubernetes: namespace'].message)

  def test_client_missing(self):
    from qaboard.runners.kubernetes import KubernetesRunner
    with mock.patch.dict('sys.modules', {'kubernetes': None}):
      checks = list(KubernetesRunner.doctor({'type': 'kubernetes', 'image': 'qa:1'}))
    self.assertEqual(checks[0].status, ERROR)
    self.assertIn('qaboard[kubernetes]', checks[0].fix)

  def test_test_job(self):
    def on_list(kube):
      finish(kube)
      for job in kube.jobs.values():
        job['status']['succeeded'] = 1
      kube.pods = [{'metadata': {'name': 'pod', 'labels': {}}, 'status': {'phase': 'Succeeded'}}]
    self.kube.on_list = on_list
    checks = self.doctor(test_job=True, mounts=[{'path': '/algo', 'pvc': 'algo-nfs'}], batch_dir='/algo/out', resources={'cpu': 2})
    check = checks['Kubernetes: test job']
    self.assertEqual(check.status, OK, check)
    self.assertIn('uid=1234', check.message)
    # deleted
    self.assertEqual(self.kube.jobs, {})
    created = [d for d in self.kube.deleted if d[0] == 'job']
    self.assertEqual(len(created), 1)

  def test_test_job_script(self):
    from qaboard.runners.kubernetes import doctor_test_script, dict_to_KubernetesOptions
    bin_dir = self.root / 'bin'
    bin_dir.mkdir()
    (bin_dir / 'qa').write_text('#!/bin/sh\necho qa-help\n')
    (bin_dir / 'qa').chmod(0o755)
    (self.root / 'outputs').mkdir()
    script = doctor_test_script(dict_to_KubernetesOptions({'mounts': [{'path': str(self.root), 'pvc': 'x'}, {'path': '/nope', 'pvc': 'y'}], 'batch_dir': str(self.root / 'outputs' / 'not' / 'yet')}))
    out = subprocess.run(['sh', '-c', script], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding='utf-8', env={'PATH': f'{bin_dir}:/usr/bin:/bin', 'HOSTNAME': 'pod'})
    self.assertEqual(out.returncode, 1)
    self.assertIn(f'mount {self.root}: ok', out.stdout)
    self.assertIn('mount /nope: MISSING', out.stdout)
    self.assertIn(f'outputs: can write in {self.root}/outputs', out.stdout)
    self.assertIn('qa: ok', out.stdout)
    # it leaves nothing behind
    self.assertEqual(list((self.root / 'outputs').iterdir()), [])
    # runs with a timeout need coreutils' timeout
    self.assertNotIn('timeout', script)
    script = doctor_test_script(dict_to_KubernetesOptions({'timeout': 60}))
    out = subprocess.run(['sh', '-c', script], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding='utf-8', env={'PATH': f'{bin_dir}:/usr/bin:/bin'})
    self.assertIn('timeout: ok', out.stdout)
    (bin_dir / 'sh').symlink_to(shutil.which('sh'))
    out = subprocess.run([str(bin_dir / 'sh'), '-c', script], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding='utf-8', env={'PATH': str(bin_dir)})
    self.assertIn('timeout: MISSING', out.stdout)
    self.assertEqual(out.returncode, 1)
    # a timeout that isn't coreutils'
    (bin_dir / 'sh').unlink()
    (bin_dir / 'timeout').write_text(busybox_timeout)
    (bin_dir / 'timeout').chmod(0o755)
    out = subprocess.run(['sh', '-c', script], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding='utf-8', env={'PATH': f'{bin_dir}:/usr/bin:/bin'})
    self.assertIn("timeout: MISSING: runners.kubernetes.timeout needs the timeout command of GNU coreutils in the image, not BusyBox's", out.stdout)
    self.assertEqual(out.returncode, 1)

  def test_invalid_options(self):
    """An empty or mistyped option is an error, and the other checks still run"""
    checks = self.doctor(concurrency='2', mounts={'path': '/a'}, resources={'cpu': 1, 'limits': {'memory': '1Gi'}}, image_pull_secrets='creds')
    self.assertEqual(checks['Kubernetes: options'].status, ERROR)
    for option in ('concurrency', 'mounts', 'resources'):
      self.assertIn(f'runners.kubernetes.{option}', checks['Kubernetes: options'].message)
    self.assertNotIn('image_pull_secrets', checks['Kubernetes: options'].message)
    self.assertEqual(checks['Kubernetes: API'].status, OK)
    self.assertEqual(checks['Kubernetes: image pull secret creds'].status, ERROR)
    self.assertNotIn('Kubernetes: options', self.doctor())

  def test_pending_test_job(self):
    def on_list(kube):
      kube.pods = [{'metadata': {'name': 'p', 'labels': {'batch.kubernetes.io/job-name': next(iter(kube.jobs))}}, 'status': {'phase': 'Pending', 'containerStatuses': [{'state': {'waiting': {'reason': 'InvalidImageName', 'message': 'bad'}}}]}}]
    self.kube.on_list = on_list
    check = self.doctor(test_job=True)['Kubernetes: test job']
    self.assertEqual(check.status, ERROR)
    self.assertIn('InvalidImageName', check.message)
    self.assertEqual(self.kube.jobs, {})


@unittest.skipUnless(has_kubernetes, "requires the kubernetes extra")
class TestKube(unittest.TestCase):
  def test_reconnects_on_401(self):
    from kubernetes.client import ApiException # type: ignore
    from qaboard.runners.kubernetes import Kube, ApiError
    kube = Kube.__new__(Kube)
    import kubernetes as k
    kube.kubernetes = k
    kube.retry_for = 0
    calls = []
    def connect():
      calls.append('connect')
      api = mock.Mock()
      api.list_namespaced_job.side_effect = [ApiException(status=401, reason='Unauthorized'), {'items': []}] if len(calls) == 1 else [{'items': ['ok']}]
      kube.apis = {'batch': api}
      kube.api_client = mock.Mock()
      kube.api_client.sanitize_for_serialization.side_effect = lambda x: x
    kube.connect = connect
    connect()
    self.assertEqual(kube.call('batch', 'list_namespaced_job', 'ns'), {'items': ['ok']})
    self.assertEqual(calls, ['connect', 'connect'])
    kube.apis['batch'].list_namespaced_job.side_effect = ApiException(status=403, reason='Forbidden')
    with self.assertRaises(ApiError) as e:
      kube.call('batch', 'list_namespaced_job', 'ns')
    self.assertEqual(e.exception.status, 403)

  def test_retries(self):
    """A batch waits for hours: errors that pass don't stop it"""
    import urllib3 # type: ignore
    from kubernetes.client import ApiException # type: ignore
    from qaboard.runners.kubernetes import Kube, ApiError
    import kubernetes as k
    kube = Kube.__new__(Kube)
    kube.kubernetes = k
    kube.retry_for = 300
    kube.api_client = mock.Mock()
    kube.api_client.sanitize_for_serialization.side_effect = lambda x: x
    api = mock.Mock()
    api.list_namespaced_job.side_effect = [
      ApiException(status=503, reason='Unavailable'), ApiException(status=429, reason='Too Many Requests'),
      ConnectionResetError('reset'), urllib3.exceptions.MaxRetryError(None, '/', 'refused'), {'items': ['ok']},
    ]
    kube.apis = {'batch': api}
    clock = [0.0]
    with mock.patch('qaboard.runners.kubernetes.time.sleep', side_effect=lambda s: clock.__setitem__(0, clock[0] + s)), \
         mock.patch('qaboard.runners.kubernetes.time.monotonic', side_effect=lambda: clock[0]), mock.patch('qaboard.runners.kubernetes.secho'):
      self.assertEqual(kube.call('batch', 'list_namespaced_job', 'ns'), {'items': ['ok']})
      # until it's too long
      api.list_namespaced_job.side_effect = ApiException(status=500, reason='Internal')
      start = clock[0]
      with self.assertRaises(ApiError) as e:
        kube.call('batch', 'list_namespaced_job', 'ns')
      self.assertEqual(e.exception.status, 500)
      self.assertTrue(200 < clock[0] - start <= 300)
      # other errors aren't retried
      api.list_namespaced_job.side_effect = ApiException(status=404, reason='Not Found')
      start = clock[0]
      with self.assertRaises(ApiError):
        kube.call('batch', 'list_namespaced_job', 'ns')
      self.assertEqual(clock[0], start)

  def test_api_retry_seconds(self):
    """The server retries API calls briefly: users wait for it"""
    from qaboard.runners.kubernetes import connect, dict_to_KubernetesOptions
    with mock.patch('qaboard.runners.kubernetes.Kube') as Kube:
      connect(dict_to_KubernetesOptions({}))
      Kube.assert_called_with(None, retry_for=300)
      connect(dict_to_KubernetesOptions({'api_retry_seconds': 15, 'context': 'c'}))
      Kube.assert_called_with('c', retry_for=15)
      # qa doctor: at most 10s
      connect(dict_to_KubernetesOptions({}), retry_for=10)
      Kube.assert_called_with(None, retry_for=10)
      connect(dict_to_KubernetesOptions({'api_retry_seconds': 5}), retry_for=10)
      Kube.assert_called_with(None, retry_for=5)

  def test_in_cluster(self):
    from qaboard.runners import kubernetes
    with mock.patch.dict(os.environ, {'KUBECONFIG': '/nope', 'KUBERNETES_SERVICE_HOST': '10.0.0.1'}):
      self.assertTrue(kubernetes.in_cluster())
      with mock.patch('kubernetes.config.load_incluster_config') as load, mock.patch.object(kubernetes, 'service_account_namespace', Path('/nope')):
        kube = kubernetes.Kube()
      load.assert_called_once()
      self.assertEqual(kube.default_namespace, 'default')
    with mock.patch.dict(os.environ, {'KUBECONFIG': '/nope'}):
      os.environ.pop('KUBERNETES_SERVICE_HOST', None)
      self.assertFalse(kubernetes.in_cluster())
      with self.assertRaisesRegex(Exception, 'No kubeconfig'):
        kubernetes.Kube()

  def test_batch_target(self):
    from qaboard.runners.kubernetes import batch_target
    self.assertEqual(batch_target({'namespace': 'ns', 'context': 'c'}), {'namespace': 'ns', 'context': 'c'})
    with mock.patch.dict(os.environ, {'KUBECONFIG': '/nope'}):
      os.environ.pop('KUBERNETES_SERVICE_HOST', None)
      self.assertEqual(batch_target({}), {})
