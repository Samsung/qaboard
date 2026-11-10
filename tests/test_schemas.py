"""
The JSON schemas of qaboard.yaml, the batch, metrics and benchmarks files (qaboard/schemas/) are valid, and accept the repository's files.
The web app checks the batch files with them too (webapp/src/components/tuning/batches_file.js).
"""
import re
import json
import unittest
from pathlib import Path

import yaml

root_dir = Path(__file__).parent.parent.resolve()
schemas_dir = root_dir / 'qaboard' / 'schemas'


def load_schemas():
  return {p.name: json.loads(p.read_text()) for p in sorted(schemas_dir.glob('*.schema.json'))}


class TestSchemas(unittest.TestCase):
  def setUp(self):
    try:
      import jsonschema  # noqa: F401
      from referencing import Registry, Resource
    except ImportError:
      self.skipTest("jsonschema is not installed (uv sync --extra dev)")
    self.schemas = load_schemas()
    self.registry = Registry().with_resources(
      (schema['$id'], Resource.from_contents(schema)) for schema in self.schemas.values()
    )

  def errors(self, schema_name, value):
    from jsonschema import Draft202012Validator
    validator = Draft202012Validator(self.schemas[schema_name], registry=self.registry)
    return [f"{'.'.join(str(p) for p in e.absolute_path)}: {e.message}" for e in validator.iter_errors(value)]

  def test_schemas_are_valid(self):
    from jsonschema import Draft202012Validator
    self.assertEqual(set(self.schemas), {'batches.schema.json', 'qaboard.schema.json', 'metrics.schema.json', 'metrics_definitions.schema.json', 'benchmarks.schema.json'})
    for name, schema in self.schemas.items():
      with self.subTest(name):
        Draft202012Validator.check_schema(schema)
        self.assertEqual(schema['$id'].split('/')[-1], name)

  def test_repository_files(self):
    files = {
      'qaboard.schema.json': [*root_dir.glob('examples/*/qaboard.yaml'), *root_dir.glob('qaboard/sample_project/**/qaboard.yaml'), root_dir / 'docs-media/tests/fixture/qaboard.yaml', root_dir / 'deployments/sirc/cli/qaboard_site_sirc/qaboard.yaml'],
      'batches.schema.json': [*root_dir.glob('examples/*/qa/batches.yaml'), root_dir / 'qaboard/sample_project/qa/batches.yaml', root_dir / 'docs-media/tests/fixture/qa/batches.yaml'],
      'metrics.schema.json': [*root_dir.glob('examples/*/qa/metrics.yaml'), root_dir / 'qaboard/sample_project/qa/metrics.yaml', root_dir / 'docs-media/tests/fixture/qa/metrics.yaml'],
    }
    for schema_name, paths in files.items():
      self.assertTrue(paths)
      for path in paths:
        with self.subTest(str(path.relative_to(root_dir))):
          self.assertEqual(self.errors(schema_name, yaml.safe_load(path.read_text())), [])

  def test_qa_init_files_declare_their_schema(self):
    # `qa init` copies them: editors using the YAML language server then check them
    sample = root_dir / 'qaboard/sample_project'
    for path, schema_name in [(sample / 'qaboard.yaml', 'qaboard.schema.json'), (sample / 'qa/batches.yaml', 'batches.schema.json'), (sample / 'qa/metrics.yaml', 'metrics.schema.json')]:
      with self.subTest(path.name):
        text = path.read_text()
        declared = re.search(r'^# yaml-language-server: \$schema=(\S+)$', text, re.MULTILINE)
        self.assertIsNotNone(declared)
        self.assertEqual(declared.group(1), self.schemas[schema_name]['$id'])
        self.assertEqual(self.errors(schema_name, yaml.safe_load(text)), [])
    # every file in qa/ is covered
    self.assertEqual({p.name for p in (sample / 'qa').glob('*.yaml')}, {'batches.yaml', 'metrics.yaml'})

  def test_metrics_definitions(self):
    # what runs write next to their metrics.json (qaboard/metrics.py)
    self.assertEqual(self.errors('metrics_definitions.schema.json', {
      'latency': {'suffix': ' ms', 'smaller_is_better': True, 'target': 15}, 'frames': {'smaller_is_better': None},
    }), [])
    for value in [{'latency': {'sufix': 'ms'}}, {'latency': 1}, []]:
      with self.subTest(value):
        self.assertNotEqual(self.errors('metrics_definitions.schema.json', value), [])

  def test_metrics(self):
    self.assertEqual(self.errors('metrics.schema.json', {
      'available_metrics': {'loss': {'label': 'Loss', 'smaller_is_better': True, 'target': 0.1, 'plot_scale': 'linear'}, '.anchors': {}},
      'default_metric': 'loss', 'main_metrics': ['loss'], 'summary_metrics': None,
    }), [])
    for value in [{'available_metric': {}}, {'available_metrics': {'loss': {'lable': 'Loss'}}}, {'main_metrics': 'loss'}]:
      with self.subTest(value):
        self.assertNotEqual(self.errors('metrics.schema.json', value), [])

  def test_benchmarks(self):
    # what qaboard.benchmarks.write_benchmarks writes, and the benchmark viewer reads
    paths = sorted((root_dir / 'tests/fixtures/benchmarks').glob('*.benchmarks.json'))
    self.assertTrue(paths)
    for path in paths:
      with self.subTest(path.name):
        self.assertEqual(self.errors('benchmarks.schema.json', json.loads(path.read_text())), [])
    for value in [{'benchmarks': []}, {'qaboard_benchmarks': 1, 'benchmarks': [{'name': 'a'}]},
                  {'qaboard_benchmarks': 1, 'benchmarks': [{'name': 'a', 'value': 1, 'stats': {'stdev': 1}}]}]:
      with self.subTest(value):
        self.assertNotEqual(self.errors('benchmarks.schema.json', value), [])

  def test_batches(self):
    valid = {
      'database': {'linux': '/mnt/data', 'windows': '//data'},
      'configs': ['base'],
      '.template': {'anything': 1},
      'a': {
        'inputs': ['a.jpg', ['b.jpg', 'low-light'], {'c.jpg': {'database': '/other', 'threshold': 2}}],
        'matrix': {'configs': [['base'], ['tuned']], 'size': [320, 416]},
        'lsf': {'queue': 'long', 'max_memory': 3000},
        'runner': 'lsf',
      },
      'b': {'inputs': {'d.jpg': None, 'e.jpg': ['tuned']}, 'type': 'movie', 'globs': '*.mp4'},
      'c': {'inputs': 'folder/*.jpg', 'only': {'iso': '>=800'}},
      'aliases': {'nightly': ['a', 'b'], 'single': 'c'},
    }
    self.assertEqual(self.errors('batches.schema.json', valid), [])
    self.assertEqual(self.errors('batches.schema.json', None), [])
    invalid = [
      {'a': {'inpts': ['a.jpg']}},
      {'a': {'inputs': [1]}},
      {'a': {'matrix': {'size': 320}}},
      {'a': {'runner': 'lfs'}},
      {'a': {'lsf': {'max_memmory': 1}}},
      {'a': ['a.jpg']},
      {'aliases': {'nightly': {'a': 1}}},
    ]
    for value in invalid:
      with self.subTest(value):
        self.assertNotEqual(self.errors('batches.schema.json', value), [])

  def test_qaboard_config(self):
    self.assertEqual(self.errors('qaboard.schema.json', {
      'project': {'name': 'group/repo', 'url': 'git@github.com:group/repo.git', 'entrypoint': 'qa/main.py'},
      'inputs': {'batches': ['qa/batches.yaml'], 'types': {'default': 'image', 'image': {'globs': ['*.jpg']}}, 'my_setting': 1},
      'outputs': {'visualizations': [{'path': 'out.jpg', 'my_viewer_option': 2}], 'action_on_existing': 'sync'},
      'runners': {'default': 'lsf', 'lsf': {'queue': 'normal'}, 'local': {'concurrency': -1}},
      'storage': {'outputs': '/mnt/qaboard', 'garbage': {'after': '1month'}},
    }), [])
    # the quality gate: labels, the batches it waits for, and rules for some batches or labels
    self.assertEqual(self.errors('qaboard.schema.json', {'gate': {
      'labels': ['default', 'nightly'], 'expect_batches': {'default': ['ci', 'perf'], 'nightly': 'all'},
      'rules': [{'metric': 'latency', 'max_regression': '10%', 'batch': 'perf'}, {'metric': 'accuracy', 'min': 0.9, 'label': ['nightly'], 'batch': ['perf-*']}],
    }}), [])
    self.assertEqual(self.errors('qaboard.schema.json', {'gate': {'batches': 'ci', 'expect_batches': ['ci']}}), [])
    for value in [{'gate': {'rules': [{'metric': 'a', 'min': 1, 'batch': []}]}}, {'gate': {'expect_batches': {'default': [1]}}}, {'gate': {'label': 'x'}}]:
      with self.subTest(value):
        self.assertNotEqual(self.errors('qaboard.schema.json', value), [])
    for value in [{'projet': {}}, {'project': {'entrypont': 'a.py'}}, {'runners': {'default': 'slurm'}}, {'outputs': {'action_on_existing': 'redo'}}]:
      with self.subTest(value):
        self.assertNotEqual(self.errors('qaboard.schema.json', value), [])

  def test_kubernetes_runner(self):
    for kubernetes in ({'image_pull_secrets': 'creds', 'timeout': 60, 'pod_timeout': 3600, 'api_retry_seconds': 15},
                       {'resources': {'cpu': 4, 'memory': '16Gi', 'nvidia.com/gpu': 1}},
                       {'resources': {'requests': {'cpu': 4}, 'limits': {'memory': '32Gi'}}}, {'resources': {'limits': {'nvidia.com/gpu': 1}}}):
      with self.subTest(kubernetes):
        self.assertEqual(self.errors('qaboard.schema.json', {'runners': {'kubernetes': kubernetes}}), [])
    # an empty key, or both forms of resources
    for kubernetes in (None, {'resources': {'cpu': 4, 'limits': {'memory': '1Gi'}}}, {'resources': {'requests': 4}}, {'concurrency': '4'}):
      with self.subTest(kubernetes):
        self.assertNotEqual(self.errors('qaboard.schema.json', {'runners': {'kubernetes': kubernetes}}), [])


if __name__ == '__main__':
  unittest.main()
